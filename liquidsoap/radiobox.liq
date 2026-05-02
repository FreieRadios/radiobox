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

# ---------------------------------------------------------------------------
# Request / scheduler tuning.
#
# On weaker hardware, very large lossless files (e.g. multi-hour FLACs played
# from the repeat queue by tools/play_by_filename.liq) could get stuck mid
# playout: a single decoder/IO task could starve other request preparation
# work, and the source silently fell back to live_branch / security.
#
# Adding extra generic / fast scheduler queues gives the file decoder more
# headroom while a huge lossless track is being decoded in the background.
# ---------------------------------------------------------------------------
settings.scheduler.generic_queues.set(4)
settings.scheduler.fast_queues.set(2)

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

# HTTP main stream. The repeat-only behaviour wraps it with audio_to_stereo
# to smooth out channel-layout differences; the others did not. We use
# audio_to_stereo unconditionally - it is a no-op for already-stereo input.
main_stream = audio_to_stereo(input.http(main_stream_url, timeout=30.0))

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
# ---------------------------------------------------------------------------
# Allow a long resolution timeout so that resolving / extracting metadata
# of a multi-hour lossless file on slow disks does not abort the request.
q_prefetch = request.queue(id="repeat_queue", prefetch=1, timeout=120.0)
%include "tools/play_by_filename.liq"

# Decouple disk/decoder jitter from the output clock. On weaker hardware,
# decoding a huge FLAC track from the queue can briefly stall (slow I/O,
# CPU spikes); without an internal buffer such a stall is interpreted as
# end-of-track and the source silently falls back to live_branch / security
# in the middle of playout. A small buffer absorbs these hiccups.
q_buffered = buffer(
    id="repeat_queue_buffer",
    buffer=10.0,
    max=20.0,
    q_prefetch
)

# When the repeat schedule is active we want to fall back to the public
# stream if the queue is empty (this is what radiobox-repeat-only did);
# light-repeat instead falls back to the security file. We model both with
# the same shape and rely on the live branch as the secondary fallback.
repeat_branch = fallback(
    id="repeat_branch",
    track_sensitive=false,
    [q_buffered, live_branch, security]
)

# ---------------------------------------------------------------------------
# Schedule.
# ---------------------------------------------------------------------------
%include "tools/crossfade.liq"

source_switcher =
  if enable_repeat_schedule then
    switch(
        track_sensitive=false,
        [
          (interval_repeat, repeat_branch),
          (interval_live, live_branch)
        ]
    )
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
