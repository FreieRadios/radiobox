#!/usr/bin/liquidsoap

# Include some sensitive configuration variables for icecast
%include "var.liq"

# Logging configuration to stdout and to the file
settings.log.file.path.set("#{home_path}/logs/<script>.log")
settings.log.stdout.set(true)
log.level.set(2)

log(">>>>>>>>>>>>>>> Running Script #{home_path}/logs/<script>.log")

settings.osc.port.set(44444)
log(">>>> OSC Port #{settings.osc.port()}")

# configure security input
security = single(
    id="security_single",
    default_wav_path
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
        loop=false,
        mode="normal",
        reload_mode="watch",
        repeats_txt_file
    )
)

# Create a silence source for 14h-2h period
silence_source = blank(duration=1.0)

source_switcher= switch(
    track_sensitive=false,
    [
      ({14h-02h}, silence_source),    # 14:00 to 02:00 next day - main stream
      ({02h-14h}, repeats_playlist)   # 02:00 to 14:00 - playlist
    ]
)

# Add a fallback to make it infallible
safe_source_switcher = fallback([
    source_switcher,
    security  # This ensures there's always something playing
])

# Create a source with a `insert_metadata` method
radio_meta = insert_metadata(safe_source_switcher)

# Handler for OSC events (gets pairs of strings)
def on_meta(m) =
  label = fst(m)
  value = snd(m)
  radio_meta.insert_metadata([(label,value)])
end

# Call the above handler when we have a pair of strings on /metadata
osc.on_string_pair("/metadata",on_meta)

# Lossless FLAC output for WAV files
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
    radio_meta,
    host=icecast_host,
    port=icecast_port,
    password=icecast_password,
    mount="/lossless",
    name="#{radio_name} (Lossless FLAC)",
    genre=radio_genre,
    description="#{radio_desc} - Lossless Audio",
    url="#{radio_url}/lossless",
    send_icy_metadata=true,
    encoding="UTF-8",
    format="audio/ogg",
    start=true
)
