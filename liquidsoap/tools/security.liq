# Security fallback source: a single audio file used whenever no other
# source is available so that the streams are infallible.
# Requires: default_wav_path (from var.liq)
security = single(
    id="security_single",
    default_wav_path
)
