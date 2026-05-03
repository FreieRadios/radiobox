r = regexp(flags=["g","i"], "(\\d{8})-(\\d{6})")

# ---------------------------------------------------------------------------
# Memo.
#
# prefetched_files : (filename, target_epoch) for files already pushed into
#                    q_prefetch. Prevents duplicate pushes on subsequent
#                    scan ticks while the lead window is still open.
# Pruned by cleanup_prefetched() to entries within the last 300s.
# ---------------------------------------------------------------------------
prefetched_files = ref([])

def already_prefetched(filename) =
  list.exists(fun (entry) -> fst(entry) == filename, prefetched_files())
end

def remember_prefetched(filename, target_epoch) =
  prefetched_files := [(filename, target_epoch), ...prefetched_files()]
end

def cleanup_prefetched() =
  now_t = time()
  prefetched_files := list.filter(
    fun (entry) -> (now_t - snd(entry)) < 300.,
    prefetched_files()
  )
end

# ---------------------------------------------------------------------------
# Structured logging helper. Every prefetch / switch lifecycle event goes
# through plog() so production logs are greppable by event= key.
# ---------------------------------------------------------------------------
def plog(event, filename, target_epoch) =
  log.important("repeat_prefetch event=#{event} file=#{filename} target_epoch=#{target_epoch} now=#{time()}")
end

# ---------------------------------------------------------------------------
# Compute the wallclock epoch (seconds since epoch, float) for a filename's
# Y/M/D/H/M/S taken on the *current* local day. We derive it by adjusting
# time() by the delta between the filename's seconds-of-day and the current
# seconds-of-day. This avoids relying on a strptime/mktime variant that may
# not be present in 2.2.5.
#
# day_offset = 0 -> today, 1 -> tomorrow (used near midnight, hour >= 23, to
# allow prefetch of next-day targets like 02:00 from 23:30).
# ---------------------------------------------------------------------------
def target_epoch_for(year, month, day, hour, minute, second, day_offset) =
  cur = time.local()
  # Seconds-of-day for filename and now.
  file_sod = float_of_int(hour * 3600 + minute * 60 + second)
  now_sod  = float_of_int(cur.hour * 3600 + cur.min * 60 + cur.sec)
  # Only honour today/tomorrow if the date components match; otherwise return
  # 0. so the caller skips this file.
  if year == cur.year and month == cur.month and day == (cur.day + day_offset) then
    time() + (file_sod - now_sod) + float_of_int(day_offset) * 86400.
  else
    0.
  end
end

# ---------------------------------------------------------------------------
# Hook q_prefetch lifecycle so we get exactly-once switch_completed and
# end-of-track events without polling. on_track fires when the queue's track
# actually starts producing audio, which is the natural "switch_completed"
# moment from the audience's perspective.
# ---------------------------------------------------------------------------
# Tracks the full_path of the file q_prefetch is currently producing.
# Used by the preemption check in scan_and_schedule to detect when a later
# armed entry has reached its target_epoch while an earlier (over-running)
# track is still on-air, so we can q_prefetch.skip() to honour the schedule.
currently_playing_path = ref("")

# True while q_prefetch is actively producing audio. Set in on_track,
# cleared when the queue becomes not-ready (see prefetch_due / scan loop).
prefetch_playing = ref(false)

# Pending entries armed for on-air switching: (filename, full_path,
# target_epoch). Pushed by try_prefetch, popped by on_track when the
# corresponding track starts producing.
armed_queue = ref([])

# Predicate that gates the on-air switch to the repeat queue:
# - true once the queue is actively producing audio (so we keep playing
#   through the whole track, even past the next armed entry's target),
# - or true once the head of armed_queue has reached its target_epoch
#   (the moment we want to flip to repeat).
# Used by radiobox.liq to wrap q_buffered in a switch(predicate=...) so a
# prefetched-but-not-yet-due track does not start playing the moment its
# request becomes ready (which previously made huge FLACs go on-air up to
# `repeats_prefetch_lead_seconds` early).
def prefetch_due() =
  if prefetch_playing() then
    true
  elsif list.length(armed_queue()) > 0 then
    let (head_fn, _, head_te) = list.hd(default=("", "", 0.), armed_queue())
    if head_te > 0. and time() >= head_te then
      # Latch: the head's target time arrived. From now on we want to keep
      # the repeat queue selected for the whole track even if armed_queue
      # is mutated by subsequent prefetches. on_track may have already
      # fired (track is decoding into the buffer); flip the latch and pop
      # the head here so the predicate stays true until the track ends.
      prefetch_playing := true
      currently_playing_path := head_fn
      armed_queue := list.tl(armed_queue())
      log.important("repeat_prefetch event=gate_open file=#{head_fn} target_epoch=#{head_te} now=#{time()}")
      true
    else
      false
    end
  else
    false
  end
end

q_prefetch.on_track(fun (m) -> begin
  rid = m["rid"] ?? "?"
  fn  = m["filename"] ?? "?"
  # Determine whether this track is actually due to go on-air now. The head
  # of armed_queue corresponds to the track that just started producing in
  # q_prefetch (FIFO + insertion in target order).
  head_te =
    if list.length(armed_queue()) > 0 then
      let (_, _, te) = list.hd(default=("", "", 0.), armed_queue())
      te
    else
      0.
    end
  is_due = head_te > 0. and time() >= head_te
  # Only mark q_prefetch as on-air when the track is actually due. If the
  # queue starts producing before target_epoch (e.g. immediately after a
  # previous track ended ~2min before the next target), we leave
  # prefetch_playing=false so prefetch_due() keeps repeat_branch on the
  # live_branch fallback until time() catches up to head_te. The buffered
  # queue will keep decoding silently in the meantime.
  if is_due then
    prefetch_playing := true
    currently_playing_path := fn
    # Pop the head of armed_queue: this entry has now started playing, so
    # the *next* head becomes the upcoming due target for prefetch_due().
    armed_queue := list.tl(armed_queue())
    log.important(">>>>>>> repeat_prefetch event=now_playing file=#{fn} rid=#{rid} now=#{time()}")
    log.important("repeat_prefetch event=switch_completed file=#{fn} rid=#{rid} now=#{time()}")
  else
    prefetch_playing := false
    currently_playing_path := ""
    log.important("repeat_prefetch event=track_ready_waiting file=#{fn} rid=#{rid} target_epoch=#{head_te} now=#{time()}")
  end
end)

# Helper: is this filename already pending in armed_queue?
def already_armed(filename) =
  list.exists(fun (entry) -> begin
    let (f, _, _) = entry
    f == filename
  end, armed_queue())
end

# ---------------------------------------------------------------------------
# Prefetch path: if a filename's target_epoch is in (now, now + lead], push
# the request into q_prefetch so resolution + decoding start now.
#
# Late-drop case (file appears with lead < repeats_prefetch_lead_seconds) is
# the same code path: lead is just smaller. A lead of 0..1s still pushes;
# the on-air switch will fire as soon as the source becomes ready.
# ---------------------------------------------------------------------------
def try_prefetch(filename, full_path, target_epoch) =
  lead = target_epoch - time()
  if lead > 0. and lead <= repeats_prefetch_lead_seconds then
    if not already_prefetched(filename) then
      if file.exists(full_path) then
        plog("prefetch_scheduled", filename, target_epoch)
        log.important("repeat_prefetch event=prefetch_scheduled file=#{filename} lead=#{lead}")
        uri = "file://#{full_path}"
        req = request.create(uri)
        # Push to q_prefetch (FIFO). Caller (scan_and_schedule) ensures
        # try_prefetch is invoked in target_epoch ascending order so the
        # FIFO matches the schedule. armed_queue tracks the same order
        # and is used by prefetch_due() to gate the on-air switch.
        q_prefetch.push(req)
        # Insert into armed_queue in target_epoch ascending order, so that
        # head(armed_queue) always points to the *next* file due on-air.
        # NOTE: q_prefetch is FIFO, so we must also push to it in target
        # order; that is enforced by sorting candidates in scan_and_schedule
        # before calling try_prefetch.
        new_entry = (filename, full_path, target_epoch)
        armed_queue := list.append(armed_queue(), [new_entry])
        remember_prefetched(filename, target_epoch)
        plog("prefetch_started", filename, target_epoch)

        # Watch this request's lifecycle to emit ready/failed exactly once.
        # We use a small recurrent poll because request.on_resolved is not
        # available in 2.2.5; the poll runs at most ~lead/0.5 ticks and is
        # cheap. It self-terminates once a terminal status is seen.
        done = ref(false)
        def poll_status() =
          if done() then
            (-1.)
          else
            st = request.status(req)
            if st == "ready" then
              plog("prefetch_ready", filename, target_epoch)
              done := true
              (-1.)
            elsif st == "failed" or st == "destroyed" then
              plog("prefetch_failed", filename, target_epoch)
              log.important("repeat_prefetch event=prefetch_failed file=#{filename} status=#{st}")
              done := true
              (-1.)
            else
              0.5
            end
          end
        end
        thread.run.recurrent(delay=0.5, poll_status)
      else
        log.important("File matched for prefetch but not found on disk: #{full_path}")
      end
    end
  end
end

# Returns a list of (filename, full_path, target_epoch) candidates parsed
# from the filename (today and, near midnight, tomorrow). Returning rather
# than pushing directly lets scan_and_schedule sort across files by
# target_epoch before queueing - critical so q_prefetch FIFO matches the
# schedule order when several files arm in the same scan tick.
def prefetch_candidates(filename) =
  m = r.exec(filename)
  if m != [] then
    date_str = m[1]
    time_str = m[2]
    year   = int_of_string(string.sub(date_str, start=0, length=4))
    month  = int_of_string(string.sub(date_str, start=4, length=2))
    day    = int_of_string(string.sub(date_str, start=6, length=2))
    hour   = int_of_string(string.sub(time_str, start=0, length=2))
    minute = int_of_string(string.sub(time_str, start=2, length=2))
    second = int_of_string(string.sub(time_str, start=4, length=2))

    full_path = path.concat(repeats_dir, filename)

    out = ref([])

    te_today = target_epoch_for(year, month, day, hour, minute, second, 0)
    if te_today > 0. then
      out := list.append(out(), [(filename, full_path, te_today)])
    end

    # Tomorrow: only relevant near midnight (see original NOTE).
    cur = time.local()
    if cur.hour >= 23 then
      te_tomorrow = target_epoch_for(year, month, day, hour, minute, second, 1)
      if te_tomorrow > 0. then
        out := list.append(out(), [(filename, full_path, te_tomorrow)])
      end
    end
    out()
  else
    []
  end
end

def scan_and_schedule() =
  cleanup_prefetched()
  files = file.ls(repeats_dir)

  # Collect prefetch candidates from all matched files, then sort by
  # target_epoch ascending. file.ls returns filenames in arbitrary order,
  # so without this sort q_prefetch (FIFO) could play files in push-order
  # rather than time-order when two targets fall in the lead window in the
  # same scan tick (e.g. a 11:38:00 target armed after a 11:39:00 target).
  candidates = ref([])
  list.iter(fun (fn) -> begin
    candidates := list.append(candidates(), prefetch_candidates(fn))
  end, files)
  sorted = list.sort(
    fun (a, b) -> begin
      let (_, _, ta) = a
      let (_, _, tb) = b
      if ta < tb then -1 elsif ta > tb then 1 else 0 end
    end,
    candidates()
  )
  list.iter(fun (entry) -> begin
    let (fn, fp, te) = entry
    try_prefetch(fn, fp, te)
  end, sorted)

  # Preemption: if the head of armed_queue has reached its target_epoch but
  # q_prefetch is still producing an earlier (over-running) track, skip the
  # current track so the queue advances to the next request and the new
  # scheduled file goes on-air on time. Without this, request.queue waits
  # for the current request to finish on its own, which causes a long file
  # (e.g. a multi-minute repeat) to push subsequent scheduled files past
  # their target times.
  if list.length(armed_queue()) > 0 then
    let (head_fn, head_path, head_te) = list.hd(default=("", "", 0.), armed_queue())
    if head_te > 0. and time() >= head_te
       and prefetch_playing()
       and currently_playing_path() != head_path
       and currently_playing_path() != "" then
      log.important("repeat_prefetch event=preempt file=#{head_fn} target_epoch=#{head_te} now=#{time()} reason=overrun_previous=#{currently_playing_path()}")
      q_prefetch.skip()
    end
  end

  repeats_check_interval
end

thread.run.recurrent(delay=repeats_check_interval, scan_and_schedule)
