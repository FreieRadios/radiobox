#!/usr/bin/env bash
# freeSoundcard.sh - Free the soundcard from blocking processes
#
# Finds all processes holding /dev/snd/* open and terminates them.
# By default they are asked politely (SIGTERM); with -9 they are killed hard.
#
# Usage:
#   ./freeSoundcard.sh           # SIGTERM, then SIGKILL if needed
#   ./freeSoundcard.sh -9        # SIGKILL immediately
#   ./freeSoundcard.sh --dry-run # only show, don't kill

set -u

DRY_RUN=0
HARD_KILL=0

for arg in "$@"; do
    case "$arg" in
        -9|--hard) HARD_KILL=1 ;;
        --dry-run|-n) DRY_RUN=1 ;;
        -h|--help)
            sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
    esac
done

echo "=== Soundcard: occupying processes ==="

# fuser shows PIDs that hold /dev/snd/* open
# 2>/dev/null suppresses header chatter
PIDS=$(sudo fuser /dev/snd/* 2>/dev/null | tr -s ' ' '\n' | sort -u | grep -E '^[0-9]+$' || true)

if [ -z "$PIDS" ]; then
    echo "No processes are holding /dev/snd/* open. Card is free."
    exit 0
fi

# Detailed view: which process is it?
echo
sudo fuser -v /dev/snd/* 2>&1 | grep -v "^$" || true
echo

if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] Would terminate the following PIDs: $PIDS"
    exit 0
fi

# Kill
for pid in $PIDS; do
    # Remember process info again for logging
    CMD=$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")

    if [ "$HARD_KILL" -eq 1 ]; then
        echo "SIGKILL  $pid ($CMD)"
        sudo kill -9 "$pid" 2>/dev/null || true
    else
        echo "SIGTERM  $pid ($CMD)"
        sudo kill -15 "$pid" 2>/dev/null || true
    fi
done

# On SIGTERM: wait briefly, then check again
if [ "$HARD_KILL" -eq 0 ]; then
    sleep 2
    REMAINING=$(sudo fuser /dev/snd/* 2>/dev/null | tr -s ' ' '\n' | sort -u | grep -E '^[0-9]+$' || true)
    if [ -n "$REMAINING" ]; then
        echo
        echo "Still there after SIGTERM, escalating to SIGKILL:"
        for pid in $REMAINING; do
            CMD=$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")
            echo "SIGKILL  $pid ($CMD)"
            sudo kill -9 "$pid" 2>/dev/null || true
        done
        sleep 1
    fi
fi

# Final check
echo
FINAL=$(sudo fuser /dev/snd/* 2>/dev/null | tr -s ' ' '\n' | sort -u | grep -E '^[0-9]+$' || true)
if [ -z "$FINAL" ]; then
    echo "Soundcard is now free."
    exit 0
else
    echo "Processes are still holding the card: $FINAL"
    exit 1
fi
