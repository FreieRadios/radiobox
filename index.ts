import BroadcastSchema from "./src/broadcast-schema";
import BroadcastSchedule from "./src/broadcast-schedule";
import AudioUploadWelocal from "./src/audio-upload-welocal";

const schema = new BroadcastSchema({
  schemaFile: "schema/radio-z.xlsx",
});

const schedule = new BroadcastSchedule({
  // dateStart: "2024-07-04",
  // dateEnd: "2024-07-04",
  dateStart: "2024-07-10T16:00:00",
  dateEnd: "2024-07-10T17:00:00",
  repeatPadding: 0,
  schema: schema,
  locale: "de",
  repeatShort: "(Wdh.)",
  repeatLong: "Wiederholung vom Vortag",
});
// const errors = schedule.checkIntegrity(true);
//
// const exporter = new BroadcastExport({
//   schedule,
//   mode: "welocal-json",
//   outDir: "json",
//   filenamePrefix: "program_radio-z",
// });
//
// exporter.write();

const uploader = new AudioUploadWelocal({
  token: "xxx",
  uploadFilePath: "mp3/",
  logFile: "upload-welocal",
  filePrefix: "radioz-stream",
  fileSuffix: ".mp3",
  schedule,
});

uploader.uploadNewFiles().then((resp) => {
  console.log("all uploads finished!");
});
