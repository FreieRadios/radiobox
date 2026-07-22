#!/bin/bash
set -e

# Farben
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[setup]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }

log "System aktualisieren..."
sudo apt-get update -qq
sudo apt-get upgrade -y -qq

# --- Git ---
log "Git installieren..."
sudo apt-get install -y -qq git

# --- Docker ---
log "Docker installieren..."
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
warn "Docker: Gruppe wird erst nach erneutem Login aktiv (oder: newgrp docker)"

# --- Audio ---
log "Audio-Pakete installieren..."
sudo apt-get install -y -qq \
    alsa-utils \
    pulseaudio \
    pulseaudio-utils \
    ffmpeg \
    python3-pyaudio \
    libportaudio2

# PulseAudio für aktuellen User aktivieren
systemctl --user enable pulseaudio 2>/dev/null || true
systemctl --user start pulseaudio 2>/dev/null || true

# --- Versionen ausgeben ---
echo ""
log "Installierte Versionen:"
echo "  git:    $(git --version)"
echo "  docker: $(docker --version)"
echo "  ffmpeg: $(ffmpeg -version 2>&1 | head -1)"
echo ""
log "Fertig. Bitte einmal neu einloggen damit Docker-Gruppe aktiv wird."
