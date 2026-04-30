#!/usr/bin/liquidsoap
#
# Single, merged radiobox script.
#
# Behaviour is controlled entirely by flags defined in var.liq, so that the
# previous "light", "light-repeat" and "repeat-only" scripts can all be
# expressed as different flag combinations of this one file.
#
# Flags consumed (defined in var.liq):
#   script_label              - free-form text shown in the startup log line
#   enable_harbor             - accept a live harbor input on /live
#   enable_repeat_schedule    - use the time-based switch repeat/live
#   enable_repeat_crossfade   - apply a 2s crossfade on switch transitions
#   live_source_kind          - "main_stream" or "silence"
#                               source used during interval_live
#   enable_mount_live         - publish 256 kbps MP3 on /live
#   enable_mount_live_128k    - publish 128 kbps MP3 on /live-128k
#   enable_mount_legacy       - publish legacy mount under radio_legacy_mount
#   enable_mount_lossless     - publish lossless FLAC on /lossless

%include "var.liq"
%include "tools/logging.liq"

log(">>>>>>>>>>>>>>> Running Script #{script_label}")

settings.osc.port.set(44444)
log(">>>> OSC Port #{settings.osc.port()}")


%include "tools/security.liq"

# ---------------------------------------------------------------------------
# Live-side source (used during interval_live, or as the only source when
# enable_repeat_schedule is false).
# ---------------------------------------------------------------------------

# Optional harbor (DJ) input on /live
if enable_harbor then
  settings.harbor.bind_addrs.set(["0.0.0.0"])
end

raw_harbor_live =
  if enable_harbor then
    input.harbor(
        id="raw_harbor_live",
        port=harbor_port,
        user=harbor_user,
        password=harbor_password,
        buffer=2.0,
        replay_metadata=true,
        metadata_charset="UTF-8",
        icy=true,
        icy_metadata_charset="UTF-8",
        "/live"
    )
  else
    blank(id="raw_harbor_live_disabled")
  end

live_harbor = blank.strip(
    id="live_harbor_blank_stripper",
    stereo(
        id="live_harbor_stereo",
        raw_harbor_live
    )
)

# HTTP main stream. The repeat-only behaviour wraps it with stereo() to
# smooth out channel-layout differences; the others did not. We use
# stereo() unconditionally - it is a no-op for already-stereo input.
# (audio_to_stereo is deprecated since Liquidsoap 2.2.)
main_stream = stereo(input.http(main_stream_url, timeout=30.0))

silence_source = blank(duration=1.0)

# Build the "live" branch depending on which sources are enabled.
live_branch =
  if live_source_kind == "silence" then
    silence_source
  elsif enable_harbor then
    fallback(
        id="source_switcher_day",
        track_sensitive=false,
        [main_stream, live_harbor, security]
    )
  else
    fallback(
        id="source_switcher_day",
        track_sensitive=false,
        [main_stream, security]
    )
  end

# ---------------------------------------------------------------------------
# Repeat-side source (queue fed by play_by_filename.liq).
#
# q_prefetch - warm queue. Receives a request up to
#              repeats_prefetch_lead_seconds before the target time so that
#              resolution + FFmpeg decoder init + buffer fill happen ahead
#              of the on-air switch. Late drops (lead < a few seconds) use
#              the same path; the switch fires as soon as the source is ready.
#
# armed_queue holds an ordered list of (filename, full_path, target_epoch)
# entries primed for on-air, sorted ascending by target_epoch and matching
# q_prefetch's FIFO push order. The switch predicate prefetch_due() activates
# q_prefetch when wallclock >= head(armed_queue).target_epoch and q_prefetch
# is ready. Hard-cut transition (no inner crossfade) for punctuality.
# ---------------------------------------------------------------------------
q_prefetch = request.queue(id="repeat_prefetch_queue")
# Ordered list of armed prefetch entries: (filename, full_path, target_epoch).
# Pushed in target_epoch ascending order so q_prefetch FIFO matches schedule
# order. The head represents the *next* file due on-air; on_track shifts the
# head forward when a track actually starts producing audio.
armed_queue = ref([])
# Sticky flag: q_prefetch is currently on-air. Set on track start, cleared
# when q_prefetch becomes not-ready (end of current request, no successor).
# Without this, re-arming with a future target would make prefetch_due()
# return false and cause repeat_source to drop the running track mid-play,
# falling back to the live branch.
prefetch_playing = ref(false)

def prefetch_due() =
  ready = source.is_ready(q_prefetch)
  # Clear sticky flag once q_prefetch has nothing left to produce.
  if prefetch_playing() and not ready then
    prefetch_playing := false
  end
  # Head target = earliest armed-but-not-yet-started entry's target_epoch.
  head_target =
    if list.length(armed_queue()) > 0 then
      let (_f, _p, te) = list.hd(default=("", "", 0.), armed_queue())
      te
    else
      0.
    end
  (prefetch_playing() and ready)
    or (head_target > 0. and time() >= head_target and ready)
end

%include "tools/play_by_filename.liq"

repeat_source = switch(
    id="repeat_source",
    track_sensitive=false,
    [
      (prefetch_due, q_prefetch)
    ]
)

# When the repeat schedule is active we want to fall back to the public
# stream if the queue is empty (this is what radiobox-repeat-only did);
# light-repeat instead falls back to the security file. We model both with
# the same shape and rely on the live branch as the secondary fallback.
repeat_branch = fallback(
    id="repeat_branch",
    track_sensitive=false,
    [repeat_source, live_branch, security]
)

# ---------------------------------------------------------------------------
# Schedule.
# ---------------------------------------------------------------------------
%include "tools/crossfade.liq"

source_switcher =
  if enable_repeat_schedule then
    if enable_repeat_crossfade then
      switch(
          track_sensitive=false,
          transitions=[crossfade_transition, crossfade_transition],
          [
            (interval_repeat, repeat_branch),
            (interval_live, live_branch)
          ]
      )
    else
      switch(
          track_sensitive=false,
          [
            (interval_repeat, repeat_branch),
            (interval_live, live_branch)
          ]
      )
    end
  else
    live_branch
  end

# Add a fallback to make the switcher infallible.
safe_source_switcher = fallback([
    source_switcher,
    security
])

# ---------------------------------------------------------------------------
# Metadata + outputs.
# ---------------------------------------------------------------------------
metadata_input_source = safe_source_switcher
%include "tools/osc_metadata.liq"

%include "mounts.liq"
