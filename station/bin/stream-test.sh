#!/usr/bin/env bash
# Pre-show checks for a programme that reaches the desk over the stream
# (a playout box, e.g. the Pi, pulling Icecast). See station/README.md.
#
#   station/bin/stream-test.sh status            stream format, listeners, desk path
#   station/bin/stream-test.sh beep [seconds]    a beep in the scheduled folder, due in
#                                                N seconds (default 120): listen at the
#                                                desk next to a reference clock
#   sudo station/bin/stream-test.sh latency <ms> set output.serve.latencyMs, restart
#   sudo station/bin/stream-test.sh flac         stream as Ogg/FLAC (lossless), restart
#   sudo station/bin/stream-test.sh mp3          back to MP3 320, restart
#   station/bin/stream-test.sh cleanup           remove the test beeps
#
# Order before a show: status -> beep (adjust with latency, beep again) ->
# optionally flac, then on the playout box `ffprobe <RELAY_URL>` and its relay
# log (journalctl -u stream-relay -f) for 15 min, and beep again: the burst,
# and with it the delay, differs per format. mp3 is the way back.
set -euo pipefail

ENV=/etc/studiobox/station.env
[ -r "$ENV" ] || {
  echo "no $ENV - is this a station?" >&2
  exit 1
}
set -a
# shellcheck disable=SC1090
. "$ENV"
set +a
: "${APP_DIR:=/opt/radiobox}" "${STATE_DIR:=/var/lib/studiobox}" "${STREAM_MOUNT:=/studiobox}"
: "${NODE_BIN:=/usr/bin/node}"
TPL="$STATE_DIR/studiobox.template.yaml"
CFG="$STATE_DIR/studiobox.yaml"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\033[1;32m[stream-test]\033[0m %s\n' "$*"; }
die() {
  printf '\033[1;31m[stream-test]\033[0m %s\n' "$*" >&2
  exit 1
}
root() { [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"; }

# Read a value from the rendered config: yq-like, `path.to.key`.
cfg_get() {
  "$NODE_BIN" -e '
const yaml = require(require.resolve("js-yaml", { paths: [process.argv[1]] }));
let v = yaml.load(require("fs").readFileSync(process.argv[2], "utf8"));
for (const k of process.argv[3].split(".")) v = v == null ? undefined : v[k];
if (v !== undefined) console.log(typeof v === "object" ? JSON.stringify(v) : v);
' "$APP_DIR" "$1" "$2"
}

# The first file-player folder scanned for timestamps.
scheduled_dir() {
  "$NODE_BIN" -e '
const yaml = require(require.resolve("js-yaml", { paths: [process.argv[1]] }));
const c = yaml.load(require("fs").readFileSync(process.argv[2], "utf8"));
const d = ((c.filePlayer || {}).dirs || []).find((d) => d && d.hasScheduled);
if (d) console.log(require("path").resolve(process.argv[1] + "/packages/studiobox", d.path));
' "$APP_DIR" "$CFG"
}

restart() {
  systemctl restart studiobox
  say "studiobox restarted - the stream is back in a few seconds"
}

cmd_status() {
  say "harbor format: $(cfg_get "$CFG" output.harbor.format || true)"
  local ms
  ms="$(cfg_get "$CFG" output.serve.latencyMs || true)"
  say "serve.latencyMs: ${ms:-default (2600)}"
  journalctl -u studiobox --since -12h --no-pager -o cat | grep -E 'studiobox prestart:' | tail -1 |
    sed 's/^/[stream-test] /' || true
  curl -s --max-time 5 http://127.0.0.1:8000/status-json.xsl | "$NODE_BIN" -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let src;
  try { src = JSON.parse(s).icestats.source; } catch { return console.log("[stream-test] icecast: no answer on :8000"); }
  for (const x of [].concat(src || []))
    console.log(`[stream-test] icecast ${x.listenurl}: ${x.listeners} listener(s), ${x.server_type || "?"}`);
});'
}

cmd_beep() {
  local ahead="${1:-120}" dir at name
  dir="$(scheduled_dir)"
  [ -n "$dir" ] || die "no file-player folder with hasScheduled: true"
  at="$(date -d "@$(($(date +%s) + ahead))" +%Y%m%d-%H%M%S)"
  name="$dir/$at stream-test beep.flac"
  # 3 short beeps, the first on the second: the first one counts.
  ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=frequency=1000:duration=0.15,apad=pad_dur=0.85" \
    -af "aloop=loop=2:size=48000" -ar 48000 -ac 2 -c:a flac -y "$name"
  say "beep due on air at ${at:9:2}:${at:11:2}:${at:13:2} -> $name"
  say "listen at the desk next to a reference clock (e.g. time.is): early = lower"
  say "serve.latencyMs by that much, late = raise it ($0 latency <ms>)"
}

cmd_latency() {
  root
  local ms="${1:-}"
  [[ "$ms" =~ ^[0-9]+$ ]] || die "latency <milliseconds>, e.g. 2400"
  TPL="$TPL" MS="$ms" "$NODE_BIN" -e '
const fs = require("fs");
const yaml = require(require.resolve("js-yaml", { paths: [process.argv[1]] }));
const c = yaml.load(fs.readFileSync(process.env.TPL, "utf8"));
c.output = c.output || {};
c.output.serve = { ...(c.output.serve || {}), latencyMs: Number(process.env.MS) };
fs.writeFileSync(process.env.TPL, yaml.dump(c, { lineWidth: 120 }), { mode: 0o600 });
' "$APP_DIR"
  say "serve.latencyMs = $ms in $TPL"
  restart
}

cmd_format() {
  root
  local fmt="$1" src
  # The station's env file in the checkout (station/local/<host>.env) is the
  # source; install.sh writes it back and copies it to /etc.
  src="$(grep -lsx "APP_DIR=.*" "$HERE"/local/*.env | head -1 || true)"
  src="${STATION_ENV_SRC:-${src:-$ENV}}"
  if grep -q '^STREAM_FORMAT=' "$src"; then
    sed -i "s/^STREAM_FORMAT=.*/STREAM_FORMAT=$fmt/" "$src"
  else
    echo "STREAM_FORMAT=$fmt" >>"$src"
  fi
  say "STREAM_FORMAT=$fmt in $src"
  "$HERE/install.sh" --env "$src" config service
  say "now on the playout box: ffprobe http://<this box>:8000$STREAM_MOUNT, restart its stream-relay,"
  say "watch journalctl -u stream-relay -f for xruns, and beep again (the delay changes with the format)"
}

cmd_cleanup() {
  local dir
  dir="$(scheduled_dir)"
  [ -n "$dir" ] || return 0
  find "$dir" -maxdepth 1 -name '*stream-test beep.flac' -print -delete
}

case "${1:-}" in
  status) cmd_status ;;
  beep) cmd_beep "${2:-}" ;;
  latency) cmd_latency "${2:-}" ;;
  flac) cmd_format ogg-flac ;;
  mp3) cmd_format mp3 ;;
  cleanup) cmd_cleanup ;;
  *) sed -n '2,17p' "$0" ;;
esac
