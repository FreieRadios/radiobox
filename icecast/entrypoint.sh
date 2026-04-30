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

# Render config from template
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

# Detect actual install prefix used by this image. Debian packages use
# /usr/share/icecast2/, the deepcomp/icecast2 image uses /usr/share/icecast/.
# Rewrite the rendered config so <webroot>, <adminroot> and <basedir> point
# to the directory that actually exists.
if [ -d /usr/share/icecast/web.orig ] && [ ! -d /usr/share/icecast2 ]; then
    sed -i \
        -e 's|/usr/share/icecast2/web|/usr/share/icecast/web|g' \
        -e 's|/usr/share/icecast2/admin|/usr/share/icecast/admin|g' \
        -e 's|<basedir>/usr/share/icecast2</basedir>|<basedir>/usr/share/icecast</basedir>|g' \
        "$RENDERED"
fi

# Restore default XSLT templates if webroot is empty (image ships them in
# web.orig/ so a custom branding mount can override them).
WEBROOT="/usr/share/icecast/web"
WEBROOT_ORIG="/usr/share/icecast/web.orig"
if [ -d "$WEBROOT_ORIG" ] && [ -z "$(ls -A "$WEBROOT" 2>/dev/null)" ]; then
    echo "Populating $WEBROOT from $WEBROOT_ORIG"
    cp -r "$WEBROOT_ORIG/." "$WEBROOT/"
fi

LOGDIR="/var/log/icecast2"
mkdir -p "$LOGDIR"
chown -R 65534:65534 "$LOGDIR" 2>/dev/null || true

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
