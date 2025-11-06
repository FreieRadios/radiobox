#!/usr/bin/liquidsoap

# Include some sensitive configuration variables for icecast
%include "var.liq"

# Logging configuration to stdout and to the file
settings.log.file.path.set("#{home_path}/logs/<script>.log")
settings.log.stdout.set(true)
log.level.set(3)

log(">>>>>>>>>>>>>>> Running Script repeat-only")

silence_source = blank(duration=1.0)
security = single(
    id="security_single",
    default_wav_path
)

repeats_playlist = playlist(
    id="repeats_playlist",
    loop=true,
    mode="normal",
    reload_mode="never",
    repeats_txt_file
)

# Log tracks for different sources
def log_source_track(source_name, metadata) =
   log(">>>>> #{source_name} - Now playing: #{metadata['filename']}")
end

# For the repeats_playlist switcher
repeats_playlist.on_track(fun(m) -> log_source_track("repeats_playlist", m))

# Daily scheduled task to reload playlist and clear queue at 01:55 AM
def repeats_playlist_stop() =
    repeats_playlist.set_queue([])
    repeats_playlist.skip()

    log("repeats playlist stop completed")
end

def repeats_playlist_reload() =
    repeats_playlist.reload()

    log("repeats playlist reload completed")
end

thread.when(start_live, repeats_playlist_stop)
thread.when(start_prepare_repeat, repeats_playlist_reload)
thread.when(refresh_prepare_repeat, repeats_playlist_reload)

source_switcher= switch(
    track_sensitive=false,
    [
      (interval_repeat, repeats_playlist),
      (interval_live, silence_source)
    ]
)

# Add a fallback to make it infallible
safe_source_switcher = fallback([
    source_switcher,
    security
])

# Lossless FLAC output for WAV files
output.icecast(
    id="output_icecast_flac",
    %ffmpeg(
        format="ogg",
        %audio(
            codec="flac",
            ar=48000,
            ac=2,
            compression_level=0
        )
    ),
    safe_source_switcher,
    host=icecast_host,
    port=icecast_port,
    password=icecast_password,
    mount="/lossless",
    name="#{radio_name} (Lossless FLAC)",
    genre=radio_genre,
    description="#{radio_desc} - Lossless Audio",
    url="#{radio_url}/lossless",
    format="audio/ogg",
    start=true
)
