#!/usr/bin/liquidsoap

# Include some sensitive configuration variables for icecast
%include "var.liq"

# Logging configuration to stdout and to the file
settings.log.file.path.set("/tmp/<script>.log")
settings.log.stdout.set(true)
log.level.set(2)

fallback_stream = mksafe(input.http(fallback_stream_url))

# configure security input
security = single(
    id="security_single",
    default_wav_path
)

# main source switcher
day=fallback(
    id="source_switcher_day",
    track_sensitive=false,
    [
        fallback_stream,
        security
    ]
)

# function that makes a safe radio
def saferadio(radio, n) =
    mksafe(
        id="radio_mksafe_#{n}",
        radio
    )
end

radio_mp3=saferadio(
    day,
    "mp3"
)

output.icecast(
    id="output_icecast_mp3",
    %ffmpeg(
        format="mp3",
        %audio(
            codec="libmp3lame",
            b="320k"
        )
    ),
    radio_mp3,
    host=icecast_host,
    port=icecast_port,
    password=icecast_password,
    mount="/stream.mp3",
    name="#{radio_name} (MP3)",
    genre=radio_genre,
    description=radio_desc,
    url="#{radio_url}/stream.mp3",
    send_icy_metadata=true,
    encoding="UTF-8",
    format="audio/mpeg",
    start=true
)

# Legacy URL
output.icecast(
    id="output_icecast_mp3_legacy",
    %ffmpeg(
        format="mp3",
        %audio(
            codec="libmp3lame",
            b="320k"
        )
    ),
    radio_mp3,
    host=icecast_host,
    port=icecast_port,
    password=icecast_password,
    mount="/#{radio_legacy_mount}",
    name="#{radio_name} (MP3)",
    genre=radio_genre,
    description=radio_desc,
    url="#{radio_url}/#{radio_legacy_mount}",
    send_icy_metadata=true,
    encoding="UTF-8",
    format="audio/mpeg",
    start=true
)
