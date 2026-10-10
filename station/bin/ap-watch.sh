#!/usr/bin/env bash
# Keeps exactly one studiobox access point up: studiobox-ap on the primary card
# (AP_IFACE, e.g. a USB stick with antennas) while it is plugged in and works,
# else studiobox-ap-fallback on the built-in card. Both have the same name,
# password and address, so the tablets and the printed card don't care which.
#
#   ap-watch.sh <primary iface> <fallback iface> [country]
#
# Run by studiobox-ap-watch.service (root, for nmcli). A card that comes back
# must be there for SETTLE seconds before the AP moves to it (a loose plug
# doesn't flap the network). A start that fails is not tried again until the
# card is unplugged and plugged back in (or the service restarts): every try
# takes the working fallback down for half a minute, so no retries on a timer.
#
# A card that stops its AP can make the kernel drop the country to "world"
# for a few seconds (until the driver sets it again); 5 GHz channels may not
# send then and the primary's start fails. So after the fallback goes down it
# waits for the country before starting the primary.
set -u
PRIMARY_IF="$1"
FALLBACK_IF="$2"
COUNTRY="${3:-}"
P=studiobox-ap
F=studiobox-ap-fallback
SETTLE=15
TICK=5

log() { echo "ap-watch: $*"; }
present() { [ -e "/sys/class/net/$1" ]; }
active() { nmcli -t -f NAME con show --active | grep -qxF "$1"; }
up() { nmcli -w 45 con up "$1" >/dev/null 2>&1; }
down() { nmcli -w 20 con down "$1" >/dev/null 2>&1; }
# The global country (first block of `iw reg get`) is COUNTRY again, 10 s at most.
country_back() {
  [ -n "$COUNTRY" ] || return 0
  local i
  for i in $(seq 20); do
    /usr/sbin/iw reg get | sed '/^$/q' | grep -q "^country $COUNTRY:" && return 0
    [ "$i" = 4 ] && /usr/sbin/iw reg set "$COUNTRY"
    sleep 0.5
  done
  log "country still not $COUNTRY - trying anyway"
}

# At boot a card that is already there counts as settled: no detour over the
# fallback.
seen=0
present "$PRIMARY_IF" && seen=$SETTLE
failed=0
log "primary $PRIMARY_IF, fallback $FALLBACK_IF"
while :; do
  if present "$PRIMARY_IF"; then
    seen=$((seen + TICK))
  else
    [ "$failed" = 1 ] && log "$PRIMARY_IF unplugged - will try it again when it is back"
    seen=0
    failed=0
  fi

  if active "$P"; then
    active "$F" && down "$F" && log "both were up - fallback down"
  elif [ "$seen" -ge "$SETTLE" ] && [ "$failed" = 0 ]; then
    # Same address on both: the fallback has to go before the primary comes up.
    active "$F" && down "$F" && log "$PRIMARY_IF is back - fallback down"
    country_back
    if up "$P"; then
      log "access point on $PRIMARY_IF"
    else
      log "access point on $PRIMARY_IF failed - staying on $FALLBACK_IF until it is plugged in again"
      failed=1
    fi
  fi

  if ! active "$P" && ! active "$F"; then
    if up "$F"; then
      log "access point on $FALLBACK_IF (fallback)"
    else
      log "fallback on $FALLBACK_IF failed too"
    fi
  fi
  sleep "$TICK"
done
