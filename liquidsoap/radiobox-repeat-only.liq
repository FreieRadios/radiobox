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

q = request.queue(id="repeat_queue")
%include "play_by_filename.liq"
time_based_source = fallback(track_sensitive=false, [q, security])

source_switcher= switch(
    track_sensitive=false,
    [
      (interval_repeat, time_based_source),
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
