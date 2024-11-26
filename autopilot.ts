import { DateTime } from "luxon";
import "dotenv/config";
import { timeFormats, vd } from "./src/helper/helper";
import {
  dumpScheduleErrors,
  fetchSchemaFromNextcloud,
  getExporter,
  getNextcloud,
  getRecorder,
  getSchedule,
  getSchema,
  getWelocal,
} from "./index";
import { getDateStartEnd, midnight } from "./src/helper/date-time";

const run = async () => {
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

  const { dateStart, dateEnd } = getDateStartEnd(
    now.toFormat("yyyy-MM-dd"),
    // process.env.RECORDER_START_TIME,
    "120000",
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
    // uploaderWelocal.upload(uploadFile).then((resp) => {
    //   console.log("[welocal] upload finished!");
    // });
    // uploaderNextcloud.upload(uploadFile).then((resp) => {
    //   console.log("[nextcloud] upload finished!");
    // });
  });

  recorder.start().then((resp) => {
    console.log("[Recorder] has finished!");
  });
};

console.log("[autopilot] ... starting ...");
run().then((resp) => {
  console.log("[autopilot] Startup completed");
});
