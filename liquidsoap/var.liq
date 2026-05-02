#!/usr/bin/liquidsoap
#
# All credentials, descriptions and behaviour flags are read from
# environment variables (provided via the project's root .env file, mounted
# into the liquidsoap container by docker-compose's `env_file: .env`).
#
# See .env.example for the full list of supported variables and their
# defaults.

# ---------------------------------------------------------------------------
# Helpers: read env with a default and parse as int / bool.
# ---------------------------------------------------------------------------
def env_or(name, default) =
  v = environment.get(name)
  if v == "" then default else v end
end

def env_int(name, default) =
  v = environment.get(name)
  if v == "" then default else int_of_string(v) end
end

def env_bool(name, default) =
  v = environment.get(name)
  if v == "" then
    default
  else
    lv = string.case(lower=true, v)
    lv == "true" or lv == "1" or lv == "yes" or lv == "on"
  end
end

# ---------------------------------------------------------------------------
# Harbor (DJ live input)
# ---------------------------------------------------------------------------
harbor_port     = env_int ("HARBOR_PORT",     4444)
harbor_user     = env_or  ("HARBOR_USER",     "harbor_user")
harbor_password = env_or  ("HARBOR_PASSWORD", "xxx")

# ---------------------------------------------------------------------------
# Station identity / descriptions
# ---------------------------------------------------------------------------
radio_name  = env_or("STATION_NAME",        "My Radio Station")
radio_desc  = env_or("STATION_DESCRIPTION", "My Station Description")
radio_genre = env_or("STATION_GENRE",       "freestyle")
radio_host  = env_or("STATION_HOST",        "snd.example.net")
radio_url   = "http://#{radio_host}"

# ---------------------------------------------------------------------------
# Schedule windows.
#
# The live / repeat windows are derived from two integer env vars (hours,
# 0..23):
#   INTERVAL_LIVE_START_HOUR  - hour at which the "live" branch takes over
#   INTERVAL_LIVE_END_HOUR    - hour at which the "live" branch ends and
#                               the "repeat" branch takes over again
#
# Wrap-around (end < start) is supported, so START=14 END=2 means
# live runs 14:00..02:00 and repeat runs 02:00..14:00 (the previous default).
#
# For a *repeat-only* instance set both vars to the same value (e.g. 0):
# the live window collapses to "never" and the repeat window covers 24/7.
# Equivalently you can set LIQ_ENABLE_REPEAT_SCHEDULE=false together with
# LIQ_LIVE_SOURCE_KIND=silence, but using equal hours keeps the schedule
# switch in place.
# ---------------------------------------------------------------------------
interval_live_start_hour = env_int("INTERVAL_LIVE_START_HOUR", 14)
interval_live_end_hour   = env_int("INTERVAL_LIVE_END_HOUR",    2)

# Predicate: is the current local hour inside [start, end) with optional
# wrap-around at midnight?
def _hour_in_window(start, stop) =
  h = time.local().hour
  if start == stop then
    false
  elsif start < stop then
    h >= start and h < stop
  else
    # wrap-around (e.g. 14..2)
    h >= start or h < stop
  end
end

interval_live   = fun () -> _hour_in_window(interval_live_start_hour, interval_live_end_hour)
interval_repeat = fun () -> not _hour_in_window(interval_live_start_hour, interval_live_end_hour)

# ---------------------------------------------------------------------------
# Icecast target
# ---------------------------------------------------------------------------
icecast_host     = env_or ("ICECAST_HOST",     "icecast2")
icecast_port     = env_int("ICECAST_PORT",     8000)
icecast_password = env_or ("ICECAST_PASSWORD", "xxx")

# ---------------------------------------------------------------------------
# Sources / mounts
# ---------------------------------------------------------------------------
main_stream_url     = env_or("MAIN_STREAM_URL",     "http://stream.example.net/live")
radio_legacy_mount  = env_or("RADIO_LEGACY_MOUNT",  "Radio")

# ---------------------------------------------------------------------------
# Filesystem layout
# ---------------------------------------------------------------------------
home_path     = "/tmp/liquidsoap"
exporter_filename_prefix = env_or("EXPORTER_FILENAME_PREFIX", "program_radio")
ignore(exporter_filename_prefix)
fallback_path     = env_or("LIQ_FALLBACK_PATH", "mp3/fallback.mp3")
default_wav_path  = "#{home_path}/#{fallback_path}"
repeats_check_interval = 0.5
repeats_dir       = "#{home_path}/repeat/"
# Lead time (seconds) before a scheduled repeat starts during which the
# file is resolved + decoded into a warm prefetch queue. Default 120s gives
# headroom for >1 GB FLACs on slow SD storage with parallel capture I/O.
repeats_prefetch_lead_seconds = float_of_int(env_int("REPEATS_PREFETCH_LEAD_SECONDS", 120))

# ---------------------------------------------------------------------------
# Behaviour flags consumed by radiobox.liq / mounts.liq.
# Tweak these via .env to switch between the former "light", "light-repeat"
# and "repeat-only" behaviours without touching any .liq file.
# ---------------------------------------------------------------------------
script_label             = env_or  ("LIQ_SCRIPT_LABEL",            "light-repeat")

# Source-graph flags
enable_harbor            = env_bool("LIQ_ENABLE_HARBOR",            true)
enable_repeat_schedule   = env_bool("LIQ_ENABLE_REPEAT_SCHEDULE",   true)
enable_repeat_crossfade  = env_bool("LIQ_ENABLE_REPEAT_CROSSFADE",  false)
live_source_kind         = env_or  ("LIQ_LIVE_SOURCE_KIND",         "main_stream")

# Mounts (see mounts.liq)
enable_mount_live        = env_bool("LIQ_ENABLE_MOUNT_LIVE",        true)
enable_mount_live_128k   = env_bool("LIQ_ENABLE_MOUNT_LIVE_128K",   true)
enable_mount_legacy      = env_bool("LIQ_ENABLE_MOUNT_LEGACY",      true)
enable_mount_lossless    = env_bool("LIQ_ENABLE_MOUNT_LOSSLESS",    false)
