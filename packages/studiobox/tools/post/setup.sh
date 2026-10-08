#!/bin/sh
# Creates the Python environment for post.py next to this script.
set -e
cd "$(dirname "$0")"
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
echo "ready: $(pwd)/.venv/bin/python -I post.py --help"
