#!/bin/sh
# Render icecast.xml from a template, substituting variables coming from
# the root .env file (passed in via docker-compose `env_file`).
#
# Required env vars:
#   ICECAST_PASSWORD          -> <source-password> and <relay-password>
#   ICECAST_ADMIN_PASSWORD    -> <admin-password>
#   ICECAST_HOSTNAME          -> <hostname>
set -eu

TEMPLATE="${ICECAST_TEMPLATE:-/etc/icecast.xml.tpl}"
RENDERED="${ICECAST_CONFIG:-/tmp/icecast.xml}"

: "${ICECAST_PASSWORD:?ICECAST_PASSWORD is required (set it in .env)}"
: "${ICECAST_ADMIN_PASSWORD:=hackme}"
: "${ICECAST_HOSTNAME:=localhost}"

export ICECAST_PASSWORD ICECAST_ADMIN_PASSWORD ICECAST_HOSTNAME

if command -v envsubst >/dev/null 2>&1; then
    envsubst '${ICECAST_PASSWORD} ${ICECAST_ADMIN_PASSWORD} ${ICECAST_HOSTNAME}' \
        < "$TEMPLATE" > "$RENDERED"
else
    # Fallback: pure-sh substitution if envsubst (gettext) is not installed.
    sed -e "s|\${ICECAST_PASSWORD}|${ICECAST_PASSWORD}|g" \
        -e "s|\${ICECAST_ADMIN_PASSWORD}|${ICECAST_ADMIN_PASSWORD}|g" \
        -e "s|\${ICECAST_HOSTNAME}|${ICECAST_HOSTNAME}|g" \
        "$TEMPLATE" > "$RENDERED"
fi

chmod 0644 "$RENDERED" || true

LOGDIR="/var/log/icecast2"
mkdir -p "$LOGDIR"
chown -R 65534:65534 "$LOGDIR" 2>/dev/null || tr

# The binary may be installed as either `icecast` or `icecast2` depending on
# the base image / distro packaging.
if command -v icecast >/dev/null 2>&1; then
    exec icecast -c "$RENDERED"
elif command -v icecast2 >/dev/null 2>&1; then
    exec icecast2 -c "$RENDERED"
else
    echo "ERROR: neither 'icecast' nor 'icecast2' binary found in PATH" >&2
    exit 127
fi
