"""Post-production of a studiobox recording: remaster, transcript, Mediathek text.

The pipeline runs in steps that each leave their result in the work directory
and are skipped when it is already there (see `post.py --steps` / `--force`):

  decode   multitrack FLAC -> one f32 raw file per channel
  talker   who talks per 50 ms frame, from arrival time (GCC-PHAT) on the dry mics
  breath   breath envelopes per mic (-10 dB on every detected breath)
  mix      per-mic leveler, expander, compressor, breath reduction, gain-sharing automix
           -> the talk bus and the leveled single mics
  asr      per-speaker transcription (faster-whisper) of the gated single mics
  tokens   per-token timestamps on the talk bus (CrisperWhisper) for the filler cuts
  fillers  cut list of "äh"/"ähm" from the tokens
  render   the three versions (full, talk, words) with breaths, cuts and a timeline
  encode   MP3 with an oversampled true-peak limiter and tags, loudness check
  transcript  per-speaker transcript (md/txt/vtt) in the full version's time
  summary  Mediathek text draft via a local llama-server
"""

SR = 48000
