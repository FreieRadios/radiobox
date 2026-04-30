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
# Schedule windows (kept in code: they are time literals, not strings)
# ---------------------------------------------------------------------------
start_live       = {14h}
interval_live    = {14h-02h}
interval_repeat  = {02h-14h}

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
current_date  = time.string("%Y-%m-%d")
exporter_filename_prefix = env_or("EXPORTER_FILENAME_PREFIX", "program_radio")
repeats_txt_file  = "#{home_path}/repeat/#{exporter_filename_prefix}.m3u"
default_wav_path  = "#{home_path}/mp3/fallback.mp3"
archive_dir       = "#{home_path}/mp3/Archiv"
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
