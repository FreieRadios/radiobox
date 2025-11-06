#!/usr/bin/liquidsoap

# Include some sensitive configuration variables for icecast
%include "var.liq"

# Logging configuration to stdout and to the file
settings.log.file.path.set("#{home_path}/logs/<script>.log")
settings.log.stdout.set(true)
log.level.set(3)

log(">>>>>>>>>>>>>>> Running Script light-repeat")

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
    track_sensitive=false,
    [
        main_stream,
        live_harbor,
        security
    ]
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
      (interval_live, radio_day)
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
