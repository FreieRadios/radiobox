import { DateTime } from "luxon";
import "dotenv/config";
import { timeFormats } from "./helper/helper";
import {
  fetchSchemaFromNextcloud,
  getNextcloud,
  getRecorder,
  getSchedule,
  getSchema,
  getWelocal, listRepeats,
  putSchemaToFTP,
  updateStreamMeta,
} from './index';
import { getDateStartEnd } from "./helper/date-time";
import * as process from "node:process";
import { cleanupFile } from "./helper/files";

const run = async () => {
  console.log(`[autopilot] Current dir is ${__dirname}`);
  await fetchSchemaFromNextcloud();

  const now = DateTime.now();
  const schema = getSchema();

  listRepeats(schema, now)
};

console.log("[autopilot] ... starting ...");
run().then((resp) => {
  console.log("[autopilot] Startup completed");
});
