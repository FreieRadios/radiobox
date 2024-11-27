#!/usr/bin/liquidsoap

# Include some sensitive configuration variables for icecast
%include "var.liq"

# Logging configuration to stdout and to the file
settings.log.file.path.set("/tmp/<script>.log")
settings.log.stdout.set(true)
log.level.set(4)

settings.harbor.bind_addrs.set(["0.0.0.0"])

# configure security input
security = single(
    id="security_single",
    default_wav_path
)

# (optional) configure live harbor input
raw_harbor_live=input.harbor(
    id="raw_harbor_live",
    port=harbor_port,
    #transport=harbor_transport,
    user=harbor_user,
    password=harbor_password,
    buffer=2.0,
    replay_metadata=true,
    metadata_charset="UTF-8",
    icy=true,
    icy_metadata_charset="UTF-8",
    "/live"
)

# process live harbor input
live_harbor=blank.strip(
    id="live_harbor_blank_stripper",
    stereo(
        id="live_harbor_stereo",
        raw_harbor_live
    )
)

# main source switcher
day=fallback(
    id="source_switcher_day",
    track_sensitive=false,
    [
        live_harbor,
        security
    ]
)

repeats_playlist = playlist(mode="normal", reload=60, repeats_txt_path)
repeats=fallback(
    id="source_switcher_repeats",
    track_sensitive=false,
    [
        repeats_playlist,
        security
    ]
)


source_switcher= switch([
	({2h-14h}, repeats),
	({14h-2h}, day)
])


# function that makes a safe radio
def saferadio(radio, n) =
    mksafe(
        id="radio_mksafe_#{n}",
        radio
    )
end

radio_ogg=saferadio(
    source_switcher,
    "ogg"
)
radio_opus=saferadio(
    source_switcher,
    "opus"
)
radio_mp3=saferadio(
    source_switcher,
    "mp3"
)
radio_flac=saferadio(
    source_switcher,
    "flac"
)

output.icecast(
    id="output_icecast_ogg",
    %ffmpeg(
        format="ogg",
        %audio(
            codec="libvorbis",
            global_quality="9"
        )
    ),
    radio_ogg,
    host=icecast_host,
    port=icecast_port,
    password=icecast_password,
    mount="/stream.ogg",
    name="#{radio_name} (OGG)",
    genre=radio_genre,
    description=radio_desc,
    url="#{radio_url}/stream.ogg",
    send_icy_metadata=true,
    encoding="UTF-8",
    format="audio/ogg",
    start=true
)

output.icecast(
    id="output_icecast_opus",
    %ffmpeg(
        format="opus",
        %audio(
            codec="libopus",
            b="327680",
            ar="48000"
        )
    ),
    radio_opus,
    host=icecast_host,
    port=icecast_port,
    password=icecast_password,
    mount="/stream.opus",
    name="#{radio_name} (OPUS)",
    genre=radio_genre,
    description=radio_desc,
    url="#{radio_url}/stream.opus",
    send_icy_metadata=true,
    encoding="UTF-8",
    format="audio/ogg",
    start=true
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

output.icecast(
    id="output_icecast_flac",
    %ffmpeg(
       format="ogg",
       %audio(
           codec="flac",
           ar=48000,
           ac=2,
           compression_level=8
       )
    ),
    radio_flac,
    host=icecast_host,
    port=icecast_port,
    password=icecast_password,
    mount="/stream.flac",
    name="#{radio_name} (FLAC)",
    genre=radio_genre,
    description=radio_desc,
    url="#{radio_url}/stream.flac",
    send_icy_metadata=true,
    encoding="UTF-8",
    format="audio/ogg",
    start=true
)
