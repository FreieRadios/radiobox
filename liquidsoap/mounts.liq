# All Icecast mounts in one place.
#
# Each mount is gated by a boolean flag defined in var.liq so that the same
# merged script can serve the "light", "light-repeat" and "repeat-only"
# behaviours by toggling flags.
#
# Required variables (from var.liq):
#   icecast_host, icecast_port, icecast_password
#   radio_name, radio_desc, radio_genre, radio_url, radio_legacy_mount
#   radio_mp3_meta        - lossy MP3 source (with metadata)
#   safe_source_switcher  - lossless/raw source for the FLAC mount
#   enable_mount_live, enable_mount_live_128k,
#   enable_mount_legacy, enable_mount_lossless

# 256 kbps MP3 - main live mount
if enable_mount_live then
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
end

# 128 kbps MP3 - low bitrate live mount
if enable_mount_live_128k then
  output.icecast(
      id="output_icecast_mp3_128k",
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
end

# Legacy mount (mirror of the 256 kbps stream under the historical URL)
if enable_mount_legacy then
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
end

# Lossless FLAC output (for WAV-quality repeat playback)
if enable_mount_lossless then
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
end
