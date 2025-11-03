import { DateTime } from "luxon";
import "dotenv/config";
import { timeFormats } from "./helper/helper";
import {
  fetchSchemaFromNextcloud,
  getNextcloud,
  getRecorder,
  getSchedule,
  getSchema,
  getWelocal, writeRepeatsPlaylist,
  putSchemaToFTP,
  updateStreamMeta,
} from './index';
import { getDateStartEnd } from "./helper/date-time";
import * as process from "node:process";
import { cleanupFile, copyFile, unlinkFilesByType } from './helper/files';

const run = async () => {
  console.log(`[autopilot] Current dir is ${__dirname}`);
  await fetchSchemaFromNextcloud();

  const now = DateTime.now();
  const schema = getSchema();

  if ([1,3,5,6].includes(now.weekday)) {
    // Every second day, we want to export the schedule to FTP
    [0, 1, 2, 3].forEach((week) => {
      putSchemaToFTP(schema, now, week);
    });
  }

  const { dateStart, dateEnd } = getDateStartEnd(
    now.toFormat("yyyy-MM-dd"),
    process.env.RECORDER_START_TIME,
    Number(process.env.RECORDER_DURATION)
  );

  updateStreamMeta(schema, Number(process.env.META_UPDATE_INTERVAL), dateEnd);

  console.log("[Recorder] starts at " + dateStart.toFormat(timeFormats.human));
  console.log("[Recorder] ends at " + dateEnd.toFormat(timeFormats.human));

  const schedule = getSchedule(schema, dateStart, dateEnd);
  const recorder = getRecorder(schedule);

  const uploaderWelocal = getWelocal(schedule);
  const uploaderNextcloud = getNextcloud();

  recorder.on('startup', async () => {
    unlinkFilesByType(process.env.EXPORTER_REPEAT_FOLDER, '.mp3')
  });

  recorder.on("finished", async (sourceFile, slot) => {
    const uploadFile = uploaderWelocal.getUploadFileInfo(sourceFile, slot);
    uploaderWelocal.upload(uploadFile).then((resp) => {
      console.log("[welocal] upload finished!");

      uploaderNextcloud
        .upload(uploadFile)
        .then((resp) => {
          console.log("[nextcloud] upload finished!");
          copyFile(sourceFile, process.env.EXPORTER_REPEAT_FOLDER)
          writeRepeatsPlaylist(schema, now, 1)
          cleanupFile(uploadFile);
        })
        .catch((err) => {
          console.error(err);
        });
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
