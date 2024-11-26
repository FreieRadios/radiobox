import "dotenv/config";

import BroadcastSchema from "./classes/broadcast-schema";
import BroadcastSchedule from "./classes/broadcast-schedule";
import ScheduleExport from "./classes/schedule-export";
import { TimeGridPlaylist } from "./types/types";
import { DateTime } from "luxon";
import { getExporter, getSchedule, getSchema } from "./index";
import { midnight } from "./helper/date-time";

const schema = getSchema();

const now = DateTime.now();

// Play around with repeat filename export
const exporter = getExporter(
  getSchedule(
    schema,
    now.plus({ days: 0 }).set(midnight),
    now.plus({ days: 1 }).set(midnight)
  ).mergeSlots(),
  "txt"
);

exporter.write((data: TimeGridPlaylist) =>
  data
    .filter((slot) => slot.repeatFrom)
    .map((slot) => slot.repeatFrom)
    .join(`\n`)
);
