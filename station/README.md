# station — turn a machine into a studiobox recording station

Power on, and the machine is a studio: studiobox runs, records when armed,
streams the programme, plays it out on whichever USB card is plugged in, and
opens its own WLAN for the tablets. Nothing to start by hand, nothing that
stops when a lid closes.

```
            studio WLAN (10.42.0.1)            cable (10.43.0.1)
 tablets ───────────────┐                  ┌──────────────── playout box (Pi)
 tech/host/guest views  │                  │  stream-relay ─► desk channel
                        ▼                  │
 Flow 8 ─USB─► studiobox.service ─► icecast :8000/studiobox (MP3)
                 │  records FLAC         └─► also: listen on the tablet
                 └─► USB card (MAYA22 / M4), if one is plugged in at start
```

## Which OS

**Debian 13 (trixie), minimal netinst, no desktop** ("SSH server" and
"standard system utilities" only). Stable for years, ships Node 20, ffmpeg
and NetworkManager, and without a desktop there is no PipeWire to grab the
sound cards and no power manager to suspend the box. A Raspberry Pi runs
Raspberry Pi OS Lite (64-bit), which is the same Debian. Avoid desktop
distributions for 24 h operation; a desktop machine works (maik does) but
needs the `desktop` step.

In the firmware (BIOS/UEFI): **power on after AC loss** ("Restore on AC power
loss: Power On"), so a power cut or a switched power strip brings the station
back by itself. Laptops often can't, then press the button.

## A blank machine

```bash
sudo apt install git
git clone https://github.com/FreieRadios/radiobox.git /opt/radiobox
cd /opt/radiobox
mkdir -p station/local
cp station/station.env.example station/local/$(hostname).env
editor station/local/$(hostname).env       # at least OUTPUT_CARDS
sudo station/install.sh --env station/local/$(hostname).env all
editor /var/lib/studiobox/studiobox.template.yaml   # the lines marked ADAPT
sudo systemctl restart studiobox
```

`all` runs these steps (each can be run on its own, and again):

| Step        | What it does                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages`  | ffmpeg, alsa-utils, git, NetworkManager, time zone, NTP                                                                                                                         |
| `node`      | Node 20 from apt (or `NODE_BIN`), yarn 1.22.22                                                                                                                                  |
| `repo`      | the `RUN_USER` (in group `audio`), a clone at `APP_DIR` if there is none                                                                                                        |
| `build`     | `yarn install` + build — skipped while the checkout has uncommitted changes                                                                                                     |
| `icecast`   | an Icecast on :8000 (apt `icecast2`; a running `icecast2` container is reused)                                                                                                  |
| `config`    | `STATE_DIR/studiobox.template.yaml`, created once; patched with the stream, random role tokens (≥ 12 chars), the recordings folder and the Nextcloud folder                     |
| `service`   | `studiobox.service`: starts at boot, restarts on failure, `Nice=-10`; picks the output card at every start (`bin/prestart.js`)                                                  |
| `power`     | never suspends; lid, suspend and hibernate keys ignored                                                                                                                         |
| `usb`       | no USB autosuspend (a sleeping audio interface drops out)                                                                                                                       |
| `journal`   | persistent journal, at most 1 GB                                                                                                                                                |
| `wifi`      | the Wi-Fi card becomes the access point `AP_SSID` at every boot; other Wi-Fi profiles stop joining by themselves; with `AP_FALLBACK_IFACE` a second card takes over (see below) |
| `lan`       | a second Ethernet port hands out addresses to a playout box on a cable                                                                                                          |
| `mdns`      | `<host>.local` resolves to the real network ports only, not to Docker's bridges (`MDNS_IFACES`, default: every port with hardware behind it)                                    |
| `desktop`   | only with a desktop: PipeWire leaves the studio cards alone                                                                                                                     |
| `nextcloud` | only with `NEXTCLOUD_ENABLED=yes`: asks for address, user and app password, then keeps `NEXTCLOUD_PATH` in sync with `NEXTCLOUD_DIR` every 5 minutes (`nextcloud-sync.timer`)   |
| `health`    | `studiobox-health.service`: the box's state as a page at `http://<AP_ADDRESS>:HEALTH_PORT/` (see below)                                                                         |
| `kiosk`     | only with `KIOSK_ENABLED=yes`: that page full screen on the box's own display (cage + Chromium on tty1)                                                                         |
| `card`      | `STATE_DIR/station-card.html`: QR codes for the WLAN, the technician and the host view — print it                                                                               |

Not in `all`: **`relay`**, for the receiving box at the desk (below).

What lives where: the station settings in `station/local/<host>.env`
(git-ignored) and their copy `/etc/studiobox/station.env`; the studiobox
config in `STATE_DIR/studiobox.template.yaml` (edit this one;
`studiobox.yaml` beside it is generated at every start); the live settings
(Einmessen, trims) in `STATE_DIR/session-state.json`.

## Day to day

```bash
journalctl -u studiobox -f            # what it does
sudo systemctl restart studiobox      # after a config change or a new build
studiobox doctor:  cd $APP_DIR/packages/studiobox && node dist/index.js doctor --config /var/lib/studiobox/studiobox.yaml
```

A new build is picked up at the next restart; a broken build is too, so build
and test before restarting during a show.

## A second Wi-Fi card as fallback

The studio WLAN is what the tablets hang on during a show. With
`AP_FALLBACK_IFACE` set, the `wifi` step makes two profiles with the same
name, password and address — `studiobox-ap` on `AP_IFACE` and
`studiobox-ap-fallback` on the second card — and neither joins by itself:
`studiobox-ap-watch.service` (`station/bin/ap-watch.sh`) keeps exactly one of
them up. The primary card while it is plugged in and works; the fallback
within ~5 s when it is pulled or fails; back to the primary once it has been
there for 15 s (a failed start waits 2 minutes). Tablets lose the WLAN for a
few seconds at each switch and join again by themselves; the printed card
stays valid. A typical pair: a USB stick with antennas on 5 GHz (`AP_BAND=a`,
`AP_CHANNEL=36`, `AP_COUNTRY` set), the built-in card on 2.4 GHz. Plug the
stick in directly, not through a hub: on a USB 2 hub an RTL8822BU threw
transfer errors (`-71`) until it was re-plugged.

```bash
journalctl -u studiobox-ap-watch -f            # which card, and why
nmcli -t -f NAME,DEVICE con show --active      # what is up now
```

## Health page and kiosk screen

`studiobox-health.service` (`station/bin/health.js`, `health.html`) serves
one page at `http://<AP_ADDRESS>:HEALTH_PORT/` (default 4446): studiobox (on
air, recording, stream, air delay), the WLAN (which card, band, channel,
devices joined; a warning while the fallback card carries it), the sound
cards the config names, temperatures, processor load, memory, room left for
recordings, Icecast, the Nextcloud sync and the clock. A banner on top says
in words whether everything is fine and names what is not. It is its own
process on purpose: when studiobox is down, this is what says so. It reads
studiobox's snapshots over the meters WebSocket (with the technician's token
from the rendered config, as a page would) and sends nothing. Numbers are
in `/health.json`.

In the WLAN panel, "QR-Codes & Passwort" folds out the WLAN's join QR code
with its name and password and the technician's link as a QR code
(`/codes.json`), the same as on the printed station card: whoever can open
the page gets them. On the box's own screen (the kiosk opens `localhost`) it
is open, the page shrinks to fit if needed, and it reloads itself when it
changes.

With `KIOSK_ENABLED=yes` the `kiosk` step puts the page full screen on the
box's own display: `studiobox-kiosk.service` runs cage (a Wayland compositor
for one app, no desktop) with Chromium on tty1, restarted if it dies. A text
login stays on tty2 (Ctrl+Alt+F2).

## Audio from Nextcloud

With `NEXTCLOUD_ENABLED=yes` the `nextcloud` step installs
`rclone` and asks for what the env file does not hold yet: the
address, the user and an app password (Nextcloud: Personal settings >
Security > Devices & sessions). It checks the login before it saves anything.
The password stays in `/etc/studiobox/nextcloud.env` (root only). Run the step
again to change it; a login that still works is kept without asking.

`nextcloud-sync.timer` syncs every 5 minutes and 2 minutes after boot, as
`RUN_USER`, at the lowest CPU and disk priority, so it never gets in the way
of a show. It is `rclone sync` over WebDAV, one way: the server's folder wins,
files deleted there are deleted on the box and nothing goes up. (Not
`nextcloudcmd`: a server may refuse older desktop clients — Nextcloud 33 can
demand 4.0.1, Debian 13 ships 3.16 — but it serves WebDAV to anything.) Recordings therefore go to `RECORDINGS_DIR`, never into the synced
folder. The `config` step puts the folder into the file browser
(`filePlayer.dirs`, labelled `NEXTCLOUD_LABEL`) unless a folder there already
holds it. `all` runs `config` before it starts the service; after a single
`config` step, restart studiobox.

```bash
journalctl -u nextcloud-sync -f               # what it syncs
sudo systemctl start nextcloud-sync            # sync now
```

## Programme output: USB, stream, or both

- **USB card:** whichever of `OUTPUT_CARDS` is plugged in **when studiobox
  starts** gets the programme. Plug it in before powering on, or restart
  the service after plugging it in.
- **Stream:** always on with `STREAM_ENABLED=yes`:
  `http://<box>:8000/studiobox`. A playout box plays it into the desk; a
  tablet or laptop on the studio WLAN can listen to it (MP3: Safari too).
  It carries the on-air programme, one air delay behind the room.

Both run at the same time; which one reaches the air is decided by what is
cabled to the desk. Stream and local output can also be switched on the page.

## The receiving box (Pi at the desk)

On the Pi, with a copy of `station/` and an env file holding at least
`RUN_USER`, `APP_DIR`, `RELAY_URL` (e.g. `http://10.43.0.1:8000/studiobox`)
and `RELAY_DEVICE` (its card, e.g. `plughw:CARD=Device,DEV=0`; `aplay -L`):

```bash
sudo station/install.sh --env pi.env relay
```

`stream-relay.service` plays the stream into the card from boot on,
reconnects by itself and replaces `studiobox.service` on that box (both want
the card). Back to playout:
`sudo systemctl disable --now stream-relay && sudo systemctl enable --now studiobox`.

Before a show, `station/bin/stream-test.sh` on the station checks this path:
`status` (format, listeners, the desk path), `beep [seconds]` drops a
timestamped beep into the scheduled folder to hear at the desk next to a
reference clock, `latency <ms>` sets `output.serve.latencyMs` from that and
restarts, `flac` / `mp3` switch the stream format, `cleanup` removes the beeps.

The two machines' clocks differ slightly; the Icecast burst (~1.6 s at
320 kbit/s) covers that for many hours. Over a long day an occasional
dropout or a slowly growing delay is possible (roadmap M1c.2 solves it
properly).
