import BroadcastSchema from "./src/broadcast-schema";
import BroadcastSchedule from "./src/broadcast-schedule";
import BroadcastRecorder from "./src/broadcast-recorder";
import { DateTime } from "luxon";
import "dotenv/config";
import { sleep, timeFormats, vd } from "./src/helper/helper";
import ApiConnectorWelocal from "./src/api-connector-welocal";

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
