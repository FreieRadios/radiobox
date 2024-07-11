import BroadcastSchema from "./src/broadcast-schema";
import BroadcastSchedule from "./src/broadcast-schedule";
import AudioUploadWelocal from "./src/audio-upload-welocal";
import { vd } from "./src/helper/helper";
import BroadcastExport from "./src/broadcast-export";

const schema = new BroadcastSchema({
  schemaFile: "schema/example.xlsx",
});

const schedule = new BroadcastSchedule({
  // dateStart: "2024-07-04",
  // dateEnd: "2024-07-04",
  dateStart: "2024-07-29T00:00:00",
  dateEnd: "2024-08-01T00:00:00",
  repeatPadding: 1,
  schema: schema,
  locale: "de",
  repeatShort: "(Wdh.)",
});

const errors = schedule.checkIntegrity(true);

const exporter = new BroadcastExport({
  schedule,
  mode: "welocal-json",
  outDir: "json",
  filenamePrefix: "program_schema_mystation",
});

exporter.write();

// const uploader = new AudioUploadWelocal({
//   token: "xxx",
//   uploadFilePath: "mp3/",
//   logFile: "upload-welocal",
//   filePrefix: "radioz-stream",
//   fileSuffix: ".mp3",
//   schedule,
// });
//
// uploader.uploadNewFiles().then((resp) => {
//   console.log("all uploads finished!");
// });
