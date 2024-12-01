import "dotenv/config";

import BroadcastSchema from "./classes/broadcast-schema";
import BroadcastSchedule from "./classes/broadcast-schedule";
import ScheduleExport from "./classes/schedule-export";
import BroadcastRecorder from "./classes/broadcast-recorder";
import ApiConnectorNextcloud from "./classes/api-connector-nextcloud";
import ApiConnectorWelocal from "./classes/api-connector-welocal";
import { DateTimeInput } from "./types/types";
import { getPath } from "./helper/files";
import { DateTime } from "luxon";
import { Client } from "node-osc";
import slugify from "slugify";

export const getNextcloud = () => {
  return new ApiConnectorNextcloud({
    baseUrl: process.env.NEXTCLOUD_WEBDAV_URL,
    username: process.env.NEXTCLOUD_WEBDAV_USER,
    password: process.env.NEXTCLOUD_WEBDAV_PASSWORD,
    targetDirectory: process.env.NEXTCLOUD_WEBDAV_DIRECTORY,
  });
};

export const getWelocal = (schedule) => {
  return new ApiConnectorWelocal({
    token: process.env.WELOCAL_API_TOKEN,
    baseUrl: process.env.WELOCAL_API_URL,
    uploadFilePath: process.env.MP3_PATH,
    logFile: "upload-welocal",
    filePrefix: process.env.FILENAME_PREFIX,
    fileSuffix: ".mp3",
    schedule,
  });
};

export const getSchema = () => {
  return new BroadcastSchema({
    schemaFile: process.env.BROADCAST_SCHEMA_FILE,
    stationName: process.env.STATION_NAME,
  });
};

export const getSchedule = (
  schema: BroadcastSchema,
  dateStart: DateTimeInput,
  dateEnd: DateTimeInput
) => {
  const schedule = new BroadcastSchedule({
    dateStart,
    dateEnd,
    schema,
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
  });
  dumpScheduleErrors(schedule);
  return schedule;
};

export const dumpScheduleErrors = (schedule: BroadcastSchedule) => {
  const errors = schedule.checkIntegrity(true);
  if (errors.length) {
    console.error("[schedule] BroadcastSchedule has errors: ");
    console.error(errors.map((error) => error.reason));
  }
};

export const getRecorder = (schedule: BroadcastSchedule) => {
  return new BroadcastRecorder({
    schedule,
    outDir: process.env.MP3_PATH,
    streamUrl: process.env.RECORDER_STREAM_URL,
    delay: Number(process.env.RECORDER_STREAM_DELAY),
    filenamePrefix: process.env.FILENAME_PREFIX,
  });
};

export const getExporter = (schedule: BroadcastSchedule, mode) => {
  return new ScheduleExport({
    schedule,
    mode,
    outDir: "json",
    filenamePrefix: process.env.EXPORTER_FILENAME_PREFIX,
    mp3Prefix: process.env.FILENAME_PREFIX,
    mp3Path: process.env.EXPORTER_MP3_PATH,
  });
};

export const fetchSchemaFromNextcloud = async () => {
  console.log(
    "[nextcloud] Fetching schema.... " +
      process.env.NEXTCLOUD_WEBDAV_SCHEMA_FILE +
      " from " +
      process.env.NEXTCLOUD_WEBDAV_SCHEMA_DIRECTORY
  );
  return getNextcloud()
    .downloadFileFromNextcloud(
      process.env.NEXTCLOUD_WEBDAV_SCHEMA_DIRECTORY,
      process.env.NEXTCLOUD_WEBDAV_SCHEMA_FILE,
      getPath(process.env.BROADCAST_SCHEMA_FILE)
    )
    .then((resp) => {
      console.log(
        "[nextcloud] Fetched schema file " + process.env.BROADCAST_SCHEMA_FILE
      );
    })
    .catch((e) => {
      console.error(e);
      console.error("[nextcloud] Error fetching schema!");
    });
};

/*
 * Updates stream meta text by interval
 * Use current broadcast name and caption and sends an ocs request
 * to liquidsoap
 *
 * There's a problem with VLC UTF-8 decoding, need to slugify the string.
 */
export const updateStreamMeta = (schema: BroadcastSchema, interval: number) => {
  const client = new Client("liquidsoap", 44444);

  let count = -1;
  const claim = process.env.META_STATION_CLAIM;
  const staticText = [...claim.split(" | "), "dyn:Title"];
  const max = staticText.length;

  setInterval(() => {
    const now = DateTime.now();
    const nowPlaying = getSchedule(schema, now, now.plus({ hours: 1 }));
    const nowGrid = nowPlaying.getGrid();

    if (nowGrid.length) {
      count++;

      const nowBroadcast = nowGrid[0].broadcast;
      const nowTitle = nowBroadcast.name;
      const nowCaption = nowBroadcast.info[0];

      staticText[max - 1] = nowTitle.replaceAll("-", " ");
      staticText[max] = nowCaption.replaceAll("-", " ");

      const useString = staticText[count];

      if (count === max) {
        count = -1;
      }

      client.send(
        {
          address: "/metadata",
          args: [
            { type: "string", value: "title" },
            {
              type: "string",
              value: useString,
            },
          ],
        },
        (err) => {
          if (err) console.error(err);
        }
      );
    }
  }, interval);
};
