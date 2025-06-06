#!/usr/bin/liquidsoap

# Include some sensitive configuration variables for icecast
%include "var.liq"

# Logging configuration to stdout and to the file
settings.log.file.path.set("#{home_path}/logs/<script>.log")
settings.log.stdout.set(true)
log.level.set(3)

settings.osc.port.set(44444)
log(">>>> OSC Port #{settings.osc.port()}")

main_stream = input.http(main_stream_url, timeout=3.0)

# configure security input
security = single(
    id="security_single",
    default_wav_path
)

# main source switcher
radio_mp3=fallback(
    id="source_switcher_day",
    track_sensitive=false,
    [
        main_stream,
        security
    ]
)

# Create a source with a `insert_metadata` method
radio_mp3_meta = insert_metadata(radio_mp3)

# Handler for OSC events (gets pairs of strings)
def on_meta(m) =
  label = fst(m)
  value = snd(m)
  radio_mp3_meta.insert_metadata([(label,value)])
end

# Call the above handler when we have a pair of strings on /metadata
osc.on_string_pair("/metadata",on_meta)

output.icecast(
    id="output_icecast_mp3",
    %ffmpeg(
        format="mp3",
        %audio(
            codec="libmp3lame",
            b="256k"
        )
    ),
    radio_mp3_meta,
    host=icecast_host,
    port=icecast_port,
    password=icecast_password,
    mount="/live",
    name="#{radio_name} #{radio_desc}",
    genre=radio_genre,
    description=radio_desc,
    url="#{radio_url}/live",
    send_icy_metadata=true,
    encoding="UTF-8",
    format="audio/mpeg",
    start=true
)


output.icecast(
    id="output_icecast_mp3",
    %ffmpeg(
        format="mp3",
        %audio(
            codec="libmp3lame",
            b="128k"
        )
    ),
    radio_mp3_meta,
    host=icecast_host,
    port=icecast_port,
    password=icecast_password,
    mount="/live-128k",
    name="#{radio_name} #{radio_desc}",
    genre=radio_genre,
    description=radio_desc,
    url="#{radio_url}/live-128k",
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
            b="256k"
        )
    ),
    radio_mp3_meta,
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
