# OSC-driven metadata insertion.
# Wraps the given source with `insert_metadata` and exposes the result as
# `radio_mp3_meta`. Metadata pairs received over OSC on /metadata are
# forwarded to the source.
# Requires: a source variable named `metadata_input_source` to be defined
# before including this file.
radio_mp3_meta = insert_metadata(metadata_input_source)

# Handler for OSC events (gets pairs of strings)
def on_meta(m) =
  label = fst(m)
  value = snd(m)
  radio_mp3_meta.insert_metadata([(label,value)])
end

# Call the above handler when we have a pair of strings on /metadata
osc.on_string_pair("/metadata", on_meta)
