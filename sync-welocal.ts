import BroadcastSchema from "./src/broadcast-schema";
import BroadcastSchedule from "./src/broadcast-schedule";
import BroadcastRecorder from "./src/broadcast-recorder";
import { DateTime } from "luxon";
import "dotenv/config";
import { timeFormats, vd } from "./src/helper/helper";
import AudioUploadWelocal from "./src/audio-upload-welocal";

const schema = new BroadcastSchema({
  schemaFile: process.env.BROADCAST_SCHEMA_FILE,
});

const dateStart = DateTime.now().minus({ hours: 1 });
const dateEnd = DateTime.now();

const schedule = new BroadcastSchedule({
  dateStart: dateStart,
  dateEnd: dateEnd,
  schema: schema,
  locale: process.env.SCHEDULE_LOCALE,
  repeatShort: process.env.REPEAT_SHORT,
});

const uploader = new AudioUploadWelocal({
  schedule,
  token: process.env.WELOCAL_API_TOKEN,
  baseUrl: process.env.WELOCAL_API_URL,
  uploadFilePath: "mp3/",
  logFile: "upload-welocal",
  filePrefix: process.env.FILENAME_PREFIX,
  fileSuffix: ".mp3",
});

// vd(schedule.toArray());
// vd(uploader.getFileList());

console.log("[welocal] start api sync");
uploader.uploadNewFiles().then((resp) => {
  console.log("[welocal] uploads finished!");
});
