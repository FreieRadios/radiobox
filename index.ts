import "dotenv/config";
import BroadcastSchema from "./src/broadcast-schema";
import BroadcastSchedule from "./src/broadcast-schedule";
import AudioUploadWelocal from "./src/audio-upload-welocal";
import { vd } from "./src/helper/helper";
import ScheduleExport from "./src/schedule-export";
import BroadcastRecorder from "./src/broadcast-recorder";

const schema = new BroadcastSchema({
  schemaFile: "schema/radio-z.xlsx",
});

const schedule = new BroadcastSchedule({
  // dateStart: "2024-07-04",
  // dateEnd: "2024-07-04",
  dateStart: "2024-07-10T00:00:00",
  dateEnd: "2024-08-01T00:00:00",
  repeatPadding: 1,
  schema: schema,
  locale: "de",
  repeatShort: "(Wdh.)",
});

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

// const errors = schedule.checkIntegrity(true);
//
// const exporter = new ScheduleExport({
//   schedule,
//   mode: "welocal-json",
//   outDir: "json",
//   filenamePrefix: "program_schema_mystation",
// });
//
// exporter.write();
//
// const uploader = new AudioUploadWelocal({
//   token: process.env.WELOCAL_API_TOKEN,
//   baseUrl: process.env.WELOCAL_API_URL,
//   uploadFilePath: "mp3/",
//   logFile: "upload-welocal",
//   filePrefix: "radioz-stream",
//   fileSuffix: ".mp3",
//   schedule,
// });

// uploader.uploadNewFiles().then((resp) => {
//   console.log("all uploads finished!");
// });
