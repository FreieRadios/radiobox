# RADIOBOX

### A box of tools for free radio stations

This library provides a set of simple typescript classes to help community radio stations.

## Roles a Radiobox instance can play

A single Radiobox deployment is a small toolbox; depending on which services you
enable in `docker-compose.yml` and which flags you set in `.env`, the same
codebase can take on very different roles. The most common ones are:

- **Schedule manager / exporter** — uses `BroadcastSchema` + `BroadcastSchedule`
  to turn a weekly `.xlsx` programme into machine-readable schedules
  (`m3u`, `json`) that drive the player and the WeLocal CMMS.
- **Recorder** — `BroadcastRecorder` captures the live stream into well-named,
  per-broadcast `.mp3`/`.flac` files for the archive (controlled by the
  `RECORDER_*` and `FILENAME_*` variables).
- **Autopilot / publisher** — combines schema, schedule, recorder and the
  WeLocal/Nextcloud/FTP connectors to upload recordings, publish the schema
  and clean up repeats automatically (`AUTOPILOT_*` flags, `yarn autopilot`).
- **Streaming brain (Liquidsoap)** — the bundled `liquidsoap/` container is the
  on-air mixer. Via the `LIQ_*` flags in `.env` it can run in three preset
  roles without changing any `.liq` file:
  - `light` — pure relay of `MAIN_STREAM_URL` to icecast (no harbor, no
    repeats).  
    `LIQ_ENABLE_HARBOR=false`, `LIQ_ENABLE_REPEAT_SCHEDULE=false`.
  - `light-repeat` *(default)* — relay + DJ harbor input + scheduled
    repeat playback from the archive.  
    `LIQ_ENABLE_HARBOR=true`, `LIQ_ENABLE_REPEAT_SCHEDULE=true`.
  - `repeat-only` — no live source, plays only repeats with crossfade,
    typically used to feed a lossless mount.  
    `LIQ_ENABLE_HARBOR=false`, `LIQ_LIVE_SOURCE_KIND=silence`,
    `LIQ_ENABLE_REPEAT_CROSSFADE=true`, disable mp3 mounts and enable
    `LIQ_ENABLE_MOUNT_LOSSLESS`.
- **Icecast host** — the `icecast2` service in the compose file serves the
  resulting streams; mounts are configured in `liquidsoap/mounts.liq` and
  toggled individually via `LIQ_ENABLE_MOUNT_*`.

All roles share the same `.env` file at the project root, so switching
behaviour usually means flipping a few flags rather than editing code.

## How to use

This library can only be used on the server-side and requires a [Node.js](https://nodejs.org/en/download/package-manager/) environment.

If you want to see how it works and you like to run own tests, you can clone this repository and install the dependencies:

```
$ git clone git@github.com:FreieRadios/radiobox.git
$ cd radiobox
$ yarn install
```

You can now run

```
$ yarn dev
```

and play around with the functionality.

## BroadcastSchema

You can define a broadcasting schedule schema for your station in an `.xlsx` file. See `schema/example.xlsx` for an example.

It requires an xlsx file with:

- Weekday names in first row
- Broadcast names in first column
- Additional info for each broadcasting can be added to any non-weekday-column

Syntax for each schedule:

- `M:[1-12]` each month
- `M:[1,3,5]` e.g. only in Jan, Mar and May
- `D:[1-5]` each weekday (from column) of month
- `D:[1,3,5]` e.g. each first, third and fifth e.g. monday of month
- `D:[-1]` e.g. each last weekday (from column) of month
- `H:[20,21]` e.g. starting at 20:00 and 21:00 (duration as given in `gridSize`)
- `R:12` number of hours to set a repeat of broadcasting
- `I:"Add Info"` Additional info to print out
- `O:true` Overrides all other broadcastings in timeslot

* Schedule parts must be comma separated,
* Schedule blocks must be semicolon separated.
* Default size of a time slot is 60min.

Example usage:

```ts
import BroadcastSchema from "./src/broadcast-schema";

const schema = new BroadcastSchema({
  schemaFile: "schema/example.xlsx",
});

// Show the schema array:
console.log(schema.getBroadcasts());
```

## BroadcastSchedule

Take your `BroadcastSchema` and pass it to a `BroadcastSchedule` instance. It will return an object consisting of timeslots with one matching broadcasting per slot.

Example usage:

```ts
import BroadcastSchedule from "./src/broadcast-schedule";

const schedule = new BroadcastSchedule({
  // This is where your schema goes:
  schema,

  // Define a period
  dateStart: "2024-07-29T00:00:00",
  dateEnd: "2024-08-01T00:00:00",

  // You might need to start slot calculation
  // 1d earlier to pull repeats:
  repeatPadding: 1,
  locale: "de",
  repeatShort: "(Wdh.)",
});

// Find multiple broadcastings for a slot or
// free slots; autofix if possible
const errors = schedule.checkIntegrity(true);
```

## ScheduleExport

The `schedule` object can be used to create a `json` file designed to be exported to an API. Currently, `welocal-json` is the only supported format.

Example usage:

```ts
import ScheduleExport from "./src/schedule-export";
const exporter = new ScheduleExport({
  schedule,
  mode: "welocal-json",
  outDir: "json",
  filenamePrefix: "program_schema_mystation",
});

// Write to json outdir
exporter.write();
// The given example will only contain one valid broadcasting;
// other slots are filled with 'unknown'.
```

## BroadcastRecorder

A `schedule` can also be used to record from a stream and store well named and sliced files.
This will also respect broadcasts exceeding the default time slot (2 hours or more).

`BroadcastRecorder` will run until dateEnd is reached and store each broadcasting into a separete `.mp3` file.

Note: [ffmpeg](https://ffmpeg.org/download.html) is required to run the recorder on your system.

```ts
const recorder = new BroadcastRecorder({
  schedule,
  dateStart: "2024-07-10T00:00:00",
  dateEnd: "2024-07-13T05:00:00",
  ignoreRepeats: false,
  streamUrl: process.env.RECORDER_STREAM_URL,
  filenamePrefix: "radioz-stream",
});

recorder.start().then((resp) => {
  console.log("Recording has finished!");
});
```

To start a recording session for today and the given settings in `.env`, run: 
```
$ yarn record
```

Use `.on()` to register an event listener:
```ts
recorder.on("finished", async (sourceFile, slot) => {
  // Do something after broadcast recording has finished for this time slot.
  // This is only called once, even if broadcasting took longer than 1h.
});
```

## BroadcastArchive
`BroadcastArchive` is used to batch download audio files from the web.
You need to provide a json file with one record per item

## ApiConnectorWelocal

Use the `schedule` object to synchronize your local `.mp3` folder with `welocal` api.

Example usage:

```ts
import ApiConnectorWelocal from "./src/api-connector-welocal";
const connector = new ApiConnectorWelocal({
  schedule,
  // you will need a welocal API token
  token: "xxxxxx",
  // this is where to find local mp3 files
  uploadFilePath: "mp3/",
  // prefix for mp3 files:
  filePrefix: "mystation-stream",
  fileSuffix: ".mp3",
  logFile: "upload-welocal",
});

connector.uploadNewFiles().then((resp) => {
  console.log("all uploads finished!");
});
```

## Autopilot
You can combine `BroadcastSchema`, `BroadcastSchedule`, `BroadcastRecorder` and `ApiConnectorWelocal` to feed a welocal instance automatically from an audio stream.

To start an autopilot session for the settings given in `.env`, run:
```
$ yarn autopilot
```


# Environment Variables

All configuration lives in a single `.env` file at the project root. It is
mounted into every container (radiobox, liquidsoap, icecast) via
`docker-compose`'s `env_file: .env`, so the same variables drive both the
Node.js code and the Liquidsoap scripts (see `liquidsoap/var.liq`).

To get started, copy the template and edit it:

```
$ cp .env.example .env
$ $EDITOR .env
```

`.env.example` is the authoritative, fully-commented list of every variable
the project understands. It is grouped into the following sections:

- **Station identity** — `STATION_NAME`, `META_STATION_CLAIM`,
  `META_UPDATE_INTERVAL`.
- **Schedule / locale** — `SCHEDULE_LOCALE`, `SCHEDULE_ZONE`,
  `RADIOBOX_BASEDIR`, `BROADCAST_SCHEMA_FILE`, `FILENAME_PREFIX`,
  `FILENAME_SUFFIX`, `MP3_PATH`.
- **Autopilot toggles** — `AUTOPILOT_UPLOAD_NEXTCLOUD`,
  `AUTOPILOT_UPLOAD_WELOCAL`, `AUTOPILOT_PUT_SCHEMA_DAYS`,
  `AUTOPILOT_COPY_REPEAT`, `AUTOPILOT_CLEAN_REPEATS`.
- **Recorder** — `RECORDER_STREAM_URL`, `RECORDER_STREAM_DELAY`,
  `RECORDER_START_TIME`, `RECORDER_DURATION`, `RECORDER_BITRATE`.
- **Icecast** — `ICECAST_PASSWORD`, `ICECAST_ADMIN_PASSWORD`,
  `ICECAST_HOSTNAME`, `ICECAST_HOST`, `ICECAST_PORT`.
- **Liquidsoap identity** — `STATION_DESCRIPTION`, `STATION_GENRE`,
  `STATION_HOST`.
- **Liquidsoap harbor (DJ live input)** — `HARBOR_PORT`, `HARBOR_USER`,
  `HARBOR_PASSWORD`.
- **Liquidsoap sources / mounts** — `MAIN_STREAM_URL`, `RADIO_LEGACY_MOUNT`.
- **Liquidsoap behaviour flags** — `LIQ_SCRIPT_LABEL`, `LIQ_ENABLE_HARBOR`,
  `LIQ_ENABLE_REPEAT_SCHEDULE`, `LIQ_ENABLE_REPEAT_CROSSFADE`,
  `LIQ_LIVE_SOURCE_KIND` (`main_stream` / `harbor` / `silence`),
  `LIQ_ENABLE_MOUNT_LIVE`, `LIQ_ENABLE_MOUNT_LIVE_128K`,
  `LIQ_ENABLE_MOUNT_LEGACY`, `LIQ_ENABLE_MOUNT_LOSSLESS`. See the
  *Roles* chapter at the top for the `light` / `light-repeat` /
  `repeat-only` presets.
- **WeLocal CMMS API** — `WELOCAL_API_TOKEN`, `WELOCAL_API_URL`.
- **Repeat / schedule labels** — `REPEAT_SHORT`, `REPEAT_LONG`,
  `REPEAT_DATE_FORMAT`, `SCHEDULE_INFO_*`.
- **Schedule exporter** — `EXPORTER_FILENAME_PREFIX`, `EXPORTER_MP3_PATH`,
  `EXPORTER_BASE_PATH`, `EXPORTER_REPEAT_FOLDER`.
- **FTP** — `FTP_HOST`, `FTP_USER`, `FTP_PASSWORD`, `FTP_REMOTE_PATH`,
  `FTP_SECURE`.
- **Nextcloud (WebDAV)** — `NEXTCLOUD_WEBDAV_PASSWORD`,
  `NEXTCLOUD_WEBDAV_USER`, `NEXTCLOUD_WEBDAV_URL`,
  `NEXTCLOUD_WEBDAV_DIRECTORY`, `NEXTCLOUD_WEBDAV_SCHEMA_DIRECTORY`,
  `NEXTCLOUD_WEBDAV_SCHEMA_FILE`.

Refer to `.env.example` for inline comments, accepted values and sensible
defaults. No credentials, descriptions or behaviour flags are hard-coded in
the `.liq` files anymore — everything is read from the environment with
fallbacks defined in `liquidsoap/var.liq`.
