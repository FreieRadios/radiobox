import BroadcastSchema from "./src/broadcast-schema";
import BroadcastSchedule from "./src/broadcast-schedule";
import BroadcastRecorder from "./src/broadcast-recorder";
import { DateTime } from "luxon";
import "dotenv/config";
import { timeFormats } from "./src/helper/helper";
import ApiConnectorWelocal from "./src/api-connector-welocal";
import ScheduleExport from "./src/schedule-export";

const schema = new BroadcastSchema({
  schemaFile: process.env.BROADCAST_SCHEMA_FILE,
});

const now = DateTime.now();

if (now.weekday === 1) {
  // Each Monday, we would like to export the schedule to FTP
  const exporter = new ScheduleExport({
    schedule: new BroadcastSchedule({
      dateStart: now.plus({ days: 21 }).set({
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
      }),
      dateEnd: now.plus({ days: 28 }).set({
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
      }),
      schema: schema,
      repeatPadding: 1,
      locale: process.env.SCHEDULE_LOCALE,
      repeatShort: process.env.REPEAT_SHORT,
      repeatLong: process.env.REPEAT_LONG,
      strings: {
        each: process.env.SCHEDULE_INFO_EACH,
        last: process.env.SCHEDULE_INFO_LAST,
        and: process.env.SCHEDULE_INFO_AND,
        monthly: process.env.SCHEDULE_INFO_MONTHLY,
        always: process.env.SCHEDULE_INFO_ALWAYS,
        from: process.env.SCHEDULE_INFO_FROM,
        oclock: process.env.SCHEDULE_INFO_HOUR,
      },
    }),
    mode: "welocal-json",
    outDir: "json",
    filenamePrefix: process.env.EXPORTER_FILENAME_PREFIX,
  });
  exporter
    .write()
    .toFTP()
    .then((response) => {
      console.log("[Export] exported to FTP");
    });
}

const dataStartString = [
  now.toFormat("yyyy-MM-dd"),
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
  repeatLong: process.env.REPEAT_LONG,
});

const recorder = new BroadcastRecorder({
  schedule,
  outDir: process.env.MP3_PATH,
  streamUrl: process.env.RECORDER_STREAM_URL,
  filenamePrefix: process.env.FILENAME_PREFIX,
});

console.log("[Recorder] starts at " + dateStart.toFormat(timeFormats.human));
console.log("[Recorder] ends at " + dateEnd.toFormat(timeFormats.human));

const uploader = new ApiConnectorWelocal({
  token: process.env.WELOCAL_API_TOKEN,
  baseUrl: process.env.WELOCAL_API_URL,
  uploadFilePath: process.env.MP3_PATH,
  logFile: "upload-welocal",
  filePrefix: process.env.FILENAME_PREFIX,
  fileSuffix: ".mp3",
  schedule,
});

recorder.on("finished", async (sourceFile, slot) => {
  const uploadFile = uploader.getUploadFileInfo(sourceFile, slot);
  uploader.upload(uploadFile).then((resp) => {
    console.log("[welocal] upload finished!");
  });
});

recorder.start().then((resp) => {
  console.log("[Recorder] has finished!");
});
