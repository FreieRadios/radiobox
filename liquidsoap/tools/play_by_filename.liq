r = regexp(flags=["g","i"], "(\\d{8})-(\\d{6})")

# ---------------------------------------------------------------------------
# Memos.
#
# played_files     : (filename, target_epoch) for files already pushed via the
#                    legacy on-time match path. Prevents the same file firing
#                    repeatedly within repeats_tolerance.
# prefetched_files : (filename, target_epoch) for files already pushed into
#                    q_prefetch. Prevents duplicate pushes on subsequent
#                    scan ticks while the lead window is still open.
# Both are pruned by cleanup_*() to entries within the last 300s.
# ---------------------------------------------------------------------------
played_files     = ref([])
prefetched_files = ref([])

def already_played(filename) =
  list.exists(fun (entry) -> fst(entry) == filename, played_files())
end

def remember_played(filename, target_epoch) =
  played_files := [(filename, target_epoch), ...played_files()]
end

def cleanup_played() =
  now_t = time()
  played_files := list.filter(
    fun (entry) -> (now_t - snd(entry)) < 300.,
    played_files()
  )
end

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
q_prefetch.on_track(fun (m) -> begin
  rid = m["rid"] ?? "?"
  fn  = m["filename"] ?? "?"
  log.important("repeat_prefetch event=switch_completed file=#{fn} rid=#{rid} now=#{time()}")
end)

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
        # Stale invalidation strategy: armed_prefetch is overwritten with
        # the latest target. The switch predicate ties activation to
        # target_epoch; obsolete entries already in q_prefetch will play
        # only if their predicate happens to be true, which it won't be
        # once armed_prefetch points elsewhere. (Liquidsoap 2.2.5's
        # request.queue does not expose a public "remove pending" API.)
        q_prefetch.push(req)
        armed_prefetch := (filename, full_path, target_epoch)
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

def prefetch_filename(filename) =
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

    # Today.
    te_today = target_epoch_for(year, month, day, hour, minute, second, 0)
    if te_today > 0. then
      try_prefetch(filename, full_path, te_today)
    end

    # Tomorrow: only relevant near midnight, otherwise the lead window
    # cannot reach a next-day target. Cheap to compute either way; we gate
    # by current hour to avoid spurious work and to avoid date arithmetic
    # across month boundaries (the date components must already match
    # tomorrow's calendar day for target_epoch_for to return non-zero).
    cur = time.local()
    if cur.hour >= 23 then
      te_tomorrow = target_epoch_for(year, month, day, hour, minute, second, 1)
      if te_tomorrow > 0. then
        try_prefetch(filename, full_path, te_tomorrow)
      end
    end
  end
end

# ---------------------------------------------------------------------------
# Legacy on-time match path. Retained as a safety net: it fires only if
# prefetch failed or could not run (e.g. file dropped at T-0).
#
# NOTE on repeats_tolerance: with prefetch in place, this check no longer
# means "tolerate match-detection imprecision" - the switch predicate uses
# time() >= target_epoch which is naturally tick-robust. The tolerance now
# means "accept slightly-late targets via the legacy fallback path". Any
# fire here with time_diff > 0 indicates prefetch missed the target and
# is logged as match_fallback for production monitoring.
# ---------------------------------------------------------------------------
def match_filename(filename) =
  m = r.exec(filename)
  if m != [] then
    date_str = m[1]
    time_str = m[2]

    year = int_of_string(string.sub(date_str, start=0, length=4))
    month = int_of_string(string.sub(date_str, start=4, length=2))
    day = int_of_string(string.sub(date_str, start=6, length=2))
    hour = int_of_string(string.sub(time_str, start=0, length=2))
    minute = int_of_string(string.sub(time_str, start=2, length=2))
    second = int_of_string(string.sub(time_str, start=4, length=2))

    current_time = time.local()
    current_year = current_time.year
    current_month = current_time.month
    current_day = current_time.day
    current_hour = current_time.hour
    current_min = current_time.min
    current_sec = current_time.sec

    if year == current_year and month == current_month and day == current_day then
      target_seconds = hour * 3600 + minute * 60 + second
      current_seconds = current_hour * 3600 + current_min * 60 + current_sec
      time_diff = abs(target_seconds - current_seconds)

      # See NOTE above: this check is now the late-fallback gate, not a
      # match-detection precision tuning knob.
      if time_diff <= repeats_tolerance then
        if not already_played(filename) then
          full_path = path.concat(repeats_dir, filename)

          if file.exists(full_path) then
            log("Match found! Playing file: #{filename}")
            current_meta_list = q.last_metadata() ?? []
            current_filename = current_meta_list["filename"] ?? ""

            # Only play if it's not the same file currently playing.
            if current_filename != full_path then
              # If we reach this branch with time_diff > 0, prefetch
              # missed the target. Emit a distinct line so production
              # can monitor whether the fallback ever fires.
              if time_diff > 0 then
                log.important("match_fallback file=#{filename} time_diff=#{time_diff} reason=prefetch_missed")
              end
              uri = "file://#{full_path}"
              play_request = request.create(uri)
              q.set_queue([play_request])
              q.skip()
              log(">>>>>>  Playing #{filename} now")
              remember_played(filename, time())
            end
          else
            log.important("File matched by pattern but not found on disk: #{full_path}")
          end
        end
      end
    end
  end
end

def scan_and_schedule() =
  cleanup_played()
  cleanup_prefetched()
  files = file.ls(repeats_dir)
  list.iter(prefetch_filename, files)   # NEW: future window
  list.iter(match_filename,    files)   # EXISTING: now ± tolerance (fallback)
  repeats_check_interval
end

thread.run.recurrent(delay=repeats_check_interval, scan_and_schedule)
