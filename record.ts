import BroadcastSchema from "./src/broadcast-schema";
import BroadcastSchedule from "./src/broadcast-schedule";
import BroadcastRecorder from "./src/broadcast-recorder";
import { DateTime } from "luxon";
import "dotenv/config";
import { timeFormats } from "./src/helper/helper";

const schema = new BroadcastSchema({
  schemaFile: process.env.BROADCAST_SCHEMA_FILE,
});

const dataStartString = [
  DateTime.now().toFormat("yyyy-MM-dd"),
  "T",
  process.env.RECORDER_START_TIME,
].join("");
const dateStart = DateTime.fromISO(dataStartString);
const dateEnd = dateStart.plus({
  hours: Number(process.env.RECORDER_DURATION),
});

const schedule = new BroadcastSchedule({
  dateStart: dateStart,
  dateEnd: dateEnd,
  schema: schema,
  locale: process.env.SCHEDULE_LOCALE,
  repeatShort: process.env.REPEAT_SHORT,
});

const recorder = new BroadcastRecorder({
  schedule,
  streamUrl: process.env.RECORDER_STREAM_URL,
  filenamePrefix: process.env.FILENAME_PREFIX,
});

console.log("[Recorder] starts at " + dateStart.toFormat(timeFormats.human));
console.log("[Recorder] ends at " + dateEnd.toFormat(timeFormats.human));

recorder.start().then((resp) => {
  console.log("[Recorder] has finished!");
});
