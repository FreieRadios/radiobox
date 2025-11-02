#!/usr/bin/liquidsoap

# Include some sensitive configuration variables for icecast
%include "var.liq"

# Logging configuration to stdout and to the file
settings.log.file.path.set("#{home_path}/logs/<script>.log")
settings.log.stdout.set(true)
log.level.set(3)

log(">>>>>>>>>>>>>>> Running Script #{home_path}/logs/<script>.log")

settings.osc.port.set(44444)
log(">>>> OSC Port #{settings.osc.port()}")

settings.harbor.bind_addrs.set(["0.0.0.0"])

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


main_stream = input.http(main_stream_url, timeout=30.0)

# configure security input
security = single(
    id="security_single",
    default_wav_path
)

# main source switcher
radio_day=fallback(
    id="source_switcher_day",
    track_sensitive=true,
    [
        main_stream,
        live_harbor,
        security
    ]
)

# Log the playlist file content for debugging
def debug_playlist_file() =
    log(">>>>>>>>>>> Reading playlist file #{repeats_txt_file}:")
    try
        content = file.contents(repeats_txt_file)
        log("Repeats playlist file contents:")
        log(content)
        lines = string.split(separator="\n", content)
        log("Number of lines in playlist: #{list.length(lines)}")
    catch err do
        log("Error reading playlist file #{repeats_txt_file}: #{err}")
    end
end

# Call this at startup to see what's in the file
debug_playlist_file()

repeats_playlist = mksafe(
    playlist(
        id="repeats_playlist",
        mode="normal",
        reload_mode="watch",
        repeats_txt_file
    )
)

source_switcher= switch(
    track_sensitive=true,
    [
      ({2h-14h}, repeats_playlist),
      ({14h-2h}, radio_day)
    ]
)

# Add a fallback to make it infallible
safe_source_switcher = fallback([
    source_switcher,
    security  # This ensures there's always something playing
])

# Create a source with a `insert_metadata` method
radio_mp3_meta = insert_metadata(safe_source_switcher)

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
