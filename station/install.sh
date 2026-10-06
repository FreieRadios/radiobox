#!/usr/bin/env bash
# Turn a machine into a studiobox station (see station/README.md).
#
#   sudo station/install.sh --env station/local/<host>.env all
#   sudo station/install.sh --env … wifi service        # single steps
#
# Steps (all = in this order): packages node repo build icecast config service
# power usb journal wifi lan desktop card. Not in `all`: relay (the receiving
# box at the desk).
# Every step can be run again; it converges instead of piling up.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALL_STEPS=(packages node repo build icecast config service power usb journal wifi lan desktop card)

say() { printf '\033[1;32m[station]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[station]\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31m[station]\033[0m %s\n' "$*" >&2
  exit 1
}

ENV_SRC=""
STEPS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --env)
      ENV_SRC="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    all)
      STEPS+=("${ALL_STEPS[@]}")
      shift
      ;;
    *)
      STEPS+=("$1")
      shift
      ;;
  esac
done
[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
[ -n "$ENV_SRC" ] || die "--env <station.env> is required (copy station/station.env.example)"
[ -f "$ENV_SRC" ] || die "no such file: $ENV_SRC"
[ ${#STEPS[@]} -gt 0 ] || die "name the steps, or 'all'"
ENV_SRC="$(realpath "$ENV_SRC")"

load_env() {
  set -a
  # shellcheck disable=SC1090
  . "$ENV_SRC"
  set +a
  : "${RUN_USER:=studiobox}" "${APP_DIR:=/opt/radiobox}" "${STATE_DIR:=/var/lib/studiobox}"
  : "${REPO_URL:=https://github.com/FreieRadios/radiobox.git}" "${REPO_REF:=main}"
  : "${NODE_BIN:=/usr/bin/node}" "${TIMEZONE:=Europe/Berlin}"
  : "${STREAM_ENABLED:=yes}" "${STREAM_SERVER:=local}" "${STREAM_MOUNT:=/studiobox}" "${STREAM_FORMAT:=mp3}"
  : "${AP_ENABLED:=yes}" "${AP_SSID:=studiobox}" "${AP_BAND:=bg}" "${AP_CHANNEL:=6}" "${AP_ADDRESS:=10.42.0.1/24}"
  : "${LAN_SHARE_ENABLED:=no}" "${LAN_ADDRESS:=10.43.0.1/24}"
  NODE_DIR="$(dirname "$NODE_BIN")"
}

# Write KEY='value' back into the env file (and the installed copy).
set_env() {
  local key="$1" val="$2" f content
  for f in "$ENV_SRC" /etc/studiobox/station.env; do
    [ -f "$f" ] || continue
    content="$(K="$key" V="$val" awk 'BEGIN { k = ENVIRON["K"]; line = k "=\047" ENVIRON["V"] "\047" }
      index($0, k "=") == 1 { print line; done = 1; next } { print } END { if (!done) print line }' "$f")"
    printf '%s\n' "$content" >"$f"
  done
  export "$key=$val"
}

as_user() { runuser -u "$RUN_USER" -- env PATH="$NODE_DIR:/usr/local/bin:/usr/bin:/bin" HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)" "$@"; }
rand() { tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1" || true; }

install_env() {
  install -d -m 0755 /etc/studiobox
  local grp
  grp="$(id -gn "$RUN_USER" 2>/dev/null || echo root)"
  if [ "$ENV_SRC" != /etc/studiobox/station.env ]; then
    install -m 0640 -o root -g "$grp" "$ENV_SRC" /etc/studiobox/station.env
  fi
}

step_packages() {
  say "packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ffmpeg alsa-utils git curl ca-certificates network-manager dnsmasq-base iw rfkill
  timedatectl set-timezone "$TIMEZONE" || true
  timedatectl set-ntp true || true
}

step_node() {
  if [ -x "$NODE_BIN" ] && [ "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then
    say "node: $("$NODE_BIN" -v) at $NODE_BIN"
  else
    say "node: installing nodejs from apt"
    apt-get install -y -qq nodejs npm
    NODE_BIN=/usr/bin/node
    NODE_DIR=/usr/bin
    [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] ||
      die "this distribution ships Node $(node -v); studiobox needs 20+ (use Debian 13, or set NODE_BIN)"
    set_env NODE_BIN /usr/bin/node
  fi
  if ! [ -x "$NODE_DIR/yarn" ] && ! command -v yarn >/dev/null; then
    say "yarn 1.22.22"
    npm install -g yarn@1.22.22
  fi
}

step_repo() {
  if ! id "$RUN_USER" >/dev/null 2>&1; then
    say "user $RUN_USER"
    useradd --system --create-home --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$RUN_USER"
  fi
  usermod -aG audio "$RUN_USER"
  if [ -d "$APP_DIR/.git" ]; then
    say "repo: $APP_DIR exists, left as it is (update it with git yourself)"
  else
    say "repo: clone $REPO_URL ($REPO_REF) to $APP_DIR"
    install -d -o "$RUN_USER" "$APP_DIR"
    as_user git clone --branch "$REPO_REF" "$REPO_URL" "$APP_DIR"
  fi
}

step_build() {
  if [ -n "$(as_user git -C "$APP_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    warn "build: $APP_DIR has uncommitted changes - not building over someone's work."
    warn "       build yourself when it is in a good state: yarn workspace @freieradios/studiobox build"
    return
  fi
  say "build"
  (cd "$APP_DIR" && as_user yarn install --frozen-lockfile && as_user yarn workspace @freieradios/studiobox build)
}

# The config template: created once, then the station's settings (stream,
# roles, recordings) are patched in. Everything else in it is yours to edit.
step_config() {
  install -d -o "$RUN_USER" -m 0750 "$STATE_DIR"
  local tpl="$STATE_DIR/studiobox.template.yaml"
  if [ ! -f "$tpl" ]; then
    local from="${TEMPLATE_FROM:-$APP_DIR/packages/studiobox/config/studiobox.flow8-session.example.yaml}"
    say "config: template from $from"
    install -o "$RUN_USER" -m 0600 "$from" "$tpl"
    warn "config: check the lines marked ADAPT in $tpl (devices, folders)"
  fi
  local url=""
  if [ "$STREAM_ENABLED" = yes ]; then
    if [ "$STREAM_SERVER" = local ]; then
      [ -n "${ICECAST_SOURCE_PASSWORD:-}" ] || die "config: no ICECAST_SOURCE_PASSWORD yet - run the icecast step first"
      url="icecast://source:$(node_enc "$ICECAST_SOURCE_PASSWORD")@127.0.0.1:8000${STREAM_MOUNT}"
    else
      url="$STREAM_SERVER"
    fi
  fi
  say "config: stream ${url:+on (${STREAM_FORMAT}, mount ${STREAM_MOUNT})}${url:-off}, role tokens, recordings"
  as_user env TPL="$tpl" URL="$url" FMT="$STREAM_FORMAT" REC="${RECORDINGS_DIR:-$STATE_DIR/recordings}" \
    "$NODE_BIN" -e '
const fs = require("fs"), crypto = require("crypto");
const yaml = require(require.resolve("js-yaml", { paths: [process.argv[1]] }));
const { TPL, URL, FMT, REC } = process.env;
const c = yaml.load(fs.readFileSync(TPL, "utf8"));
c.output = c.output || {};
c.output.harbor = URL
  ? { enabled: true, url: URL, format: FMT, contentType: FMT === "mp3" ? "audio/mpeg" : "application/ogg" }
  : { ...(c.output.harbor || {}), enabled: false };
c.output.backup = c.output.backup || { enabled: true };
if (!c.output.backup.dir || !c.output.backup.dir.startsWith("/")) c.output.backup.dir = REC;
fs.mkdirSync(c.output.backup.dir, { recursive: true });
c.meters = c.meters || { enabled: true, port: 4445 };
const r = (c.meters.roles = c.meters.roles || {});
r.enabled = true;
r.tokens = r.tokens || {};
// Guests share the WLAN: a token they can guess is a technician they become.
for (const k of ["tech", "host", "guest"])
  if (!r.tokens[k] || String(r.tokens[k]).length < 12) r.tokens[k] = crypto.randomBytes(12).toString("base64url");
fs.writeFileSync(TPL, yaml.dump(c, { lineWidth: 120 }), { mode: 0o600 });
' "$APP_DIR"
}

node_enc() { "$NODE_BIN" -p 'encodeURIComponent(process.argv[1])' "$1"; }

step_icecast() {
  [ "$STREAM_ENABLED" = yes ] && [ "$STREAM_SERVER" = local ] || {
    say "icecast: not needed"
    return
  }
  if command -v docker >/dev/null && [ "$(docker inspect -f '{{.State.Running}}' icecast2 2>/dev/null)" = true ]; then
    local restart
    restart="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' icecast2)"
    [ "$restart" = always ] || [ "$restart" = unless-stopped ] || docker update --restart unless-stopped icecast2 >/dev/null
    systemctl enable docker >/dev/null 2>&1 || true
    if [ -z "${ICECAST_SOURCE_PASSWORD:-}" ]; then
      local pw
      pw="$(docker exec icecast2 sh -c 'sed -n "s:.*<source-password>\(.*\)</source-password>.*:\1:p" /tmp/icecast.xml /etc/icecast.xml 2>/dev/null | head -1')"
      [ -n "$pw" ] || die "icecast: running container icecast2, but its source password could not be read"
      set_env ICECAST_SOURCE_PASSWORD "$pw"
    fi
    say "icecast: reusing the running container icecast2 (restarts with docker)"
    return
  fi
  say "icecast: apt icecast2"
  [ -n "${ICECAST_SOURCE_PASSWORD:-}" ] || set_env ICECAST_SOURCE_PASSWORD "$(rand 20)"
  local admin
  admin="$(rand 20)"
  echo "icecast2 icecast2/icecast-setup boolean false" | debconf-set-selections
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq icecast2
  local x=/etc/icecast2/icecast.xml
  sed -i -e "s:<source-password>[^<]*</source-password>:<source-password>${ICECAST_SOURCE_PASSWORD}</source-password>:" \
    -e "s:<relay-password>[^<]*</relay-password>:<relay-password>$(rand 20)</relay-password>:" \
    -e "s:<admin-password>[^<]*</admin-password>:<admin-password>${admin}</admin-password>:" "$x"
  [ -f /etc/default/icecast2 ] && sed -i 's/^ENABLE=.*/ENABLE=true/' /etc/default/icecast2
  systemctl enable icecast2 >/dev/null 2>&1 || true
  systemctl restart icecast2
  say "icecast: admin password (http://<box>:8000/admin/): $admin"
}

step_service() {
  install_env
  say "service: /etc/systemd/system/studiobox.service"
  sed -e "s|@RUN_USER@|$RUN_USER|g" -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@STATE_DIR@|$STATE_DIR|g" \
    -e "s|@NODE_BIN@|$NODE_BIN|g" -e "s|@NODE_DIR@|$NODE_DIR|g" \
    "$HERE/systemd/studiobox.service.in" >/etc/systemd/system/studiobox.service
  systemctl daemon-reload
  systemctl enable studiobox.service >/dev/null
  if pgrep -u "$RUN_USER" -f 'node .*dist/index.js' >/dev/null && ! systemctl is-active -q studiobox; then
    warn "service: a studiobox started by hand is running - stop it, then: sudo systemctl start studiobox"
  elif [ ! -f "$APP_DIR/packages/studiobox/dist/index.js" ]; then
    warn "service: no build yet ($APP_DIR/packages/studiobox/dist) - build, then: sudo systemctl start studiobox"
  else
    systemctl restart studiobox
    say "service: started (journalctl -u studiobox -f)"
  fi
}

step_power() {
  say "power: never suspend, lid closed is fine"
  install -d /etc/systemd/logind.conf.d
  cat >/etc/systemd/logind.conf.d/50-studiobox.conf <<'EOF'
# studiobox station: a closed lid or an idle desktop must not stop a show.
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
HandleSuspendKey=ignore
HandleHibernateKey=ignore
IdleAction=ignore
EOF
  systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target suspend-then-hibernate.target >/dev/null
  # logind reads the file at the next boot; restarting it now can end a desktop session.
}

step_usb() {
  say "usb: no autosuspend (a sleeping USB audio interface drops out)"
  cat >/etc/udev/rules.d/90-studiobox-usb-power.rules <<'EOF'
# studiobox station: keep every USB device awake.
ACTION=="add|change", SUBSYSTEM=="usb", TEST=="power/control", ATTR{power/control}="on"
EOF
  udevadm control --reload
  udevadm trigger --subsystem-match=usb --action=change
}

step_journal() {
  say "journal: persistent, at most 1 GB"
  install -d /etc/systemd/journald.conf.d
  cat >/etc/systemd/journald.conf.d/50-studiobox.conf <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=1G
EOF
  systemctl restart systemd-journald
}

step_wifi() {
  [ "$AP_ENABLED" = yes ] || {
    say "wifi: AP off"
    return
  }
  local ifc="${AP_IFACE:-}"
  [ -n "$ifc" ] || ifc="$(nmcli -t -f DEVICE,TYPE dev | awk -F: '$2=="wifi"{print $1; exit}')"
  [ -n "$ifc" ] || die "wifi: no Wi-Fi card found"
  iw list 2>/dev/null | grep -q '^\s*\* AP$' || warn "wifi: the card does not list AP mode - this may fail"
  if [ -z "${AP_PASSPHRASE:-}" ]; then
    set_env AP_PASSPHRASE "$(rand 12)"
  fi
  install_env
  say "wifi: access point '$AP_SSID' on $ifc ($AP_BAND ch $AP_CHANNEL), box at ${AP_ADDRESS%/*}"
  rfkill unblock wifi || true
  nmcli -t -f NAME con show | grep -qx studiobox-ap && nmcli con delete studiobox-ap >/dev/null
  nmcli con add type wifi ifname "$ifc" con-name studiobox-ap autoconnect yes ssid "$AP_SSID" \
    connection.autoconnect-priority 100 \
    802-11-wireless.mode ap 802-11-wireless.band "$AP_BAND" 802-11-wireless.channel "$AP_CHANNEL" \
    802-11-wireless.powersave 2 \
    wifi-sec.key-mgmt wpa-psk wifi-sec.proto rsn wifi-sec.pairwise ccmp wifi-sec.group ccmp \
    wifi-sec.psk "$AP_PASSPHRASE" \
    ipv4.method shared ipv4.addresses "$AP_ADDRESS" ipv6.method disabled >/dev/null
  # The card can only be one thing: other Wi-Fi profiles stay, but only by hand.
  local name
  while IFS=: read -r name type; do
    [ "$type" = 802-11-wireless ] && [ "$name" != studiobox-ap ] || continue
    nmcli con modify "$name" connection.autoconnect no && say "wifi: '$name' no longer joins by itself"
  done < <(nmcli -t -f NAME,TYPE con show)
  nmcli con up studiobox-ap >/dev/null && say "wifi: up"
}

step_lan() {
  [ "$LAN_SHARE_ENABLED" = yes ] || {
    say "lan: off"
    return
  }
  [ -n "${LAN_IFACE:-}" ] || die "lan: set LAN_IFACE (the port the playout box is cabled to)"
  say "lan: $LAN_IFACE hands out addresses, box at ${LAN_ADDRESS%/*}"
  nmcli -t -f NAME con show | grep -qx studiobox-lan && nmcli con delete studiobox-lan >/dev/null
  nmcli con add type ethernet ifname "$LAN_IFACE" con-name studiobox-lan autoconnect yes \
    connection.autoconnect-priority 100 \
    ipv4.method shared ipv4.addresses "$LAN_ADDRESS" ipv6.method disabled >/dev/null
  nmcli con up studiobox-lan >/dev/null 2>&1 && say "lan: up" || say "lan: waits for a cable"
}

# A desktop session's PipeWire must not hold the studio cards.
step_desktop() {
  command -v wireplumber >/dev/null || {
    say "desktop: no WirePlumber, nothing to do"
    return
  }
  local home d
  home="$(getent passwd "$RUN_USER" | cut -d: -f6)"
  d="$home/.config/wireplumber/wireplumber.conf.d"
  say "desktop: PipeWire leaves ${PIPEWIRE_IGNORE_CARDS:-Behringer_FLOW_8 MAYA22} alone"
  as_user mkdir -p "$d"
  {
    echo "# studiobox station: these cards belong to studiobox (ALSA direct), not to the desktop."
    echo "monitor.alsa.rules = ["
    for n in ${PIPEWIRE_IGNORE_CARDS:-Behringer_FLOW_8 MAYA22}; do
      echo "  { matches = [ { device.name = \"~alsa_card.*${n}.*\" } ], actions = { update-props = { device.disabled = true } } }"
    done
    echo "]"
  } | as_user tee "$d/51-studiobox-cards.conf" >/dev/null
}

step_card() {
  local out="$STATE_DIR/station-card.html"
  "$NODE_BIN" "$HERE/bin/station-card.js" /etc/studiobox/station.env >"$out"
  chown "$RUN_USER" "$out"
  say "card: $out (print it, or open it on the technician's device)"
}

step_relay() {
  install_env
  say "relay: /etc/systemd/system/stream-relay.service ($RELAY_URL -> $RELAY_DEVICE)"
  sed -e "s|@RUN_USER@|$RUN_USER|g" -e "s|@APP_DIR@|$APP_DIR|g" \
    "$HERE/systemd/stream-relay.service.in" >/etc/systemd/system/stream-relay.service
  systemctl daemon-reload
  systemctl disable --now studiobox.service >/dev/null 2>&1 || true
  systemctl enable --now stream-relay.service
}

load_env
for s in "${STEPS[@]}"; do
  declare -F "step_$s" >/dev/null || die "unknown step: $s"
  "step_$s"
done
say "done: ${STEPS[*]}"
