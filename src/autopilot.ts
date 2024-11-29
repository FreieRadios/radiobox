import { DateTime } from "luxon";
import "dotenv/config";
import { timeFormats, vd } from "./helper/helper";
import {
  fetchSchemaFromNextcloud,
  getExporter,
  getNextcloud,
  getRecorder,
  getSchedule,
  getSchema,
  getWelocal,
} from "./index";
import { getDateStartEnd, midnight } from "./helper/date-time";
import { Settings } from "luxon";
import { TimeGridPlaylist } from "./types/types";

const run = async () => {
  console.log(`[autopilot] Current dir is ${__dirname}`);
  await fetchSchemaFromNextcloud();

  const now = DateTime.now();
  const schema = getSchema();

  if (now.weekday === 1) {
    // Each Monday, we would like to export the schedule to FTP
    const schedule = getSchedule(
      schema,
      now.plus({ days: 21 }).set(midnight),
      now.plus({ days: 28 }).set(midnight)
    );
    getExporter(schedule, "welocal-json")
      .write()
      .toFTP()
      .then((response) => {
        console.log("[Export] exported to FTP");
      });
  }

  // Create a txt file with repeat mp3 files for today
  // console.log("[autopilot] Create mp3 repeats .txt file ...");
  // getExporter(
  //   getSchedule(
  //     schema,
  //     now.plus({ days: 0 }).set(midnight),
  //     now.plus({ days: 1 }).set(midnight)
  //   ).mergeSlots(),
  //   "txt"
  // ).toTxt();

  const { dateStart, dateEnd } = getDateStartEnd(
    now.toFormat("yyyy-MM-dd"),
    process.env.RECORDER_START_TIME,
    Number(process.env.RECORDER_DURATION)
  );
  console.log("[Recorder] starts at " + dateStart.toFormat(timeFormats.human));
  console.log("[Recorder] ends at " + dateEnd.toFormat(timeFormats.human));

  const schedule = getSchedule(schema, dateStart, dateEnd);
  const recorder = getRecorder(schedule);

  const uploaderWelocal = getWelocal(schedule);
  const uploaderNextcloud = getNextcloud();

  recorder.on("finished", async (sourceFile, slot) => {
    const uploadFile = uploaderWelocal.getUploadFileInfo(sourceFile, slot);
    uploaderWelocal.upload(uploadFile).then((resp) => {
      console.log("[welocal] upload finished!");
    });
    uploaderNextcloud
      .upload(uploadFile)
      .then((resp) => {
        console.log("[nextcloud] upload finished!");
      })
      .catch((err) => {
        console.error(err);
      });
  });

  recorder.start().then((resp) => {
    console.log("[Recorder] has finished!");
  });
};

console.log("[autopilot] ... starting ...");
run().then((resp) => {
  console.log("[autopilot] Startup completed");
});
