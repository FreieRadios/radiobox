import "dotenv/config";

import BroadcastSchema from "./src/broadcast-schema";
import BroadcastSchedule from "./src/broadcast-schedule";
import { DateTime } from "luxon";
import ScheduleExport from "./src/schedule-export";
import { TimeGridPlaylist } from "./src/types";

const schema = new BroadcastSchema({
  schemaFile: process.env.BROADCAST_SCHEMA_FILE,
});

const now = DateTime.now();

// Play around with repeat filename export
const exporter = new ScheduleExport({
  schedule: new BroadcastSchedule({
    dateStart: now.plus({ days: 0 }).set({
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    }),
    dateEnd: now.plus({ days: 1 }).set({
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    }),
    schema: schema,
    repeatPadding: 1,
  }).mergeSlots(),
  mode: "txt",
  outDir: "json",
  filenamePrefix: process.env.EXPORTER_FILENAME_PREFIX,
  mp3Path: process.env.MP3_PATH,
});

exporter.write((data: TimeGridPlaylist) =>
  data
    .filter((slot) => slot.repeatFrom)
    .map((slot) => slot.repeatFrom)
    .join(`\n`)
);
