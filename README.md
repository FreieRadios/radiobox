# RADIOBOX

### A box of tools for free radio stations

This library provides a set of simple typescript classes to help community radio stations.

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
Also see `.env.example` for example values.

```dotenv
# Locale schema to use for schedule slots 
SCHEDULE_LOCALE="en"
# location of schema xlsx file
BROADCAST_SCHEMA_FILE="schema/example.xlsx"
# prefix for output mp3 files
FILENAME_PREFIX="example-stream"
# stream url for recording
RECORDER_STREAM_URL="http://example.net:8000/live"
# at what time to start recording each day
RECORDER_START_TIME="140000"
# how long to record the stream
RECORDER_DURATION=12
# Abbreviation for repeats
REPEAT_SHORT="(Wdh.)"

# Required to sync mp3 with welocal API
WELOCAL_API_TOKEN=xxx
WELOCAL_API_URL="xxx"
```
