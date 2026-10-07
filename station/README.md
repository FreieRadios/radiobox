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

| Step        | What it does                                                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages`  | ffmpeg, alsa-utils, git, NetworkManager, time zone, NTP                                                                                                                       |
| `node`      | Node 20 from apt (or `NODE_BIN`), yarn 1.22.22                                                                                                                                |
| `repo`      | the `RUN_USER` (in group `audio`), a clone at `APP_DIR` if there is none                                                                                                      |
| `build`     | `yarn install` + build — skipped while the checkout has uncommitted changes                                                                                                   |
| `icecast`   | an Icecast on :8000 (apt `icecast2`; a running `icecast2` container is reused)                                                                                                |
| `config`    | `STATE_DIR/studiobox.template.yaml`, created once; patched with the stream, random role tokens (≥ 12 chars) and the recordings folder                                         |
| `service`   | `studiobox.service`: starts at boot, restarts on failure, `Nice=-10`; picks the output card at every start (`bin/prestart.js`)                                                |
| `power`     | never suspends; lid, suspend and hibernate keys ignored                                                                                                                       |
| `usb`       | no USB autosuspend (a sleeping audio interface drops out)                                                                                                                     |
| `journal`   | persistent journal, at most 1 GB                                                                                                                                              |
| `wifi`      | the Wi-Fi card becomes the access point `AP_SSID` at every boot; other Wi-Fi profiles stop joining by themselves                                                              |
| `lan`       | a second Ethernet port hands out addresses to a playout box on a cable                                                                                                        |
| `desktop`   | only with a desktop: PipeWire leaves the studio cards alone                                                                                                                   |
| `nextcloud` | only with `NEXTCLOUD_ENABLED=yes`: asks for address, user and app password, then keeps `NEXTCLOUD_PATH` in sync with `NEXTCLOUD_DIR` every 5 minutes (`nextcloud-sync.timer`) |
| `card`      | `STATE_DIR/station-card.html`: QR codes for the WLAN, the technician and the host view — print it                                                                             |

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

## Audio from Nextcloud

With `NEXTCLOUD_ENABLED=yes` the `nextcloud` step installs
`nextcloud-desktop-cmd` and asks for what the env file does not hold yet: the
address, the user and an app password (Nextcloud: Personal settings >
Security > Devices & sessions). It checks the login before it saves anything.
The password stays in `/etc/studiobox/nextcloud.env` (root only). Run the step
again to change it; a login that still works is kept without asking.

`nextcloud-sync.timer` syncs every 5 minutes and 2 minutes after boot, as
`RUN_USER`, at the lowest CPU and disk priority, so it never gets in the way
of a show. The sync goes both ways: files deleted on the server are deleted on
the box. Recordings therefore go to `RECORDINGS_DIR`, never into the synced
folder. To play from the folder, add `NEXTCLOUD_DIR` to `filePlayer.dirs` in the
template.

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

The two machines' clocks differ slightly; the Icecast burst (~1.6 s at
320 kbit/s) covers that for many hours. Over a long day an occasional
dropout or a slowly growing delay is possible (roadmap M1c.2 solves it
properly).
