import "dotenv/config";

import BroadcastSchema from "./src/broadcast-schema";
import BroadcastSchedule from "./src/broadcast-schedule";
import ScheduleExport from "./src/schedule-export";
import BroadcastRecorder from "./src/broadcast-recorder";
import ApiConnectorNextcloud from "./src/api-connector-nextcloud";
import ApiConnectorWelocal from "./src/api-connector-welocal";
import { DateTimeInput } from "./src/types";

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
  });
};

export const fetchSchemaFromNextcloud = async () => {
  return getNextcloud()
    .downloadFileFromNextcloud(
      process.env.NEXTCLOUD_WEBDAV_SCHEMA_DIRECTORY,
      process.env.NEXTCLOUD_WEBDAV_SCHEMA_FILE,
      process.env.BROADCAST_SCHEMA_FILE
    )
    .then((resp) => {
      console.log(
        "[nextcloud] Fetched schema file " + process.env.BROADCAST_SCHEMA_FILE
      );
    })
    .catch((e) => {
      console.error(e);
    });
};
