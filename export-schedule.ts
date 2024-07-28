import "dotenv/config";
import BroadcastSchema from "./src/broadcast-schema";
import BroadcastSchedule from "./src/broadcast-schedule";
import ScheduleExport from "./src/schedule-export";
import { vd } from "./src/helper/helper";

const schedule = new BroadcastSchedule({
  schema: new BroadcastSchema({
    schemaFile: "schema/radio-z.xlsx",
  }),
  dateStart: "2024-08-12T00:00:00",
  dateEnd: "2024-08-19T00:00:00",
  repeatPadding: 1,
  locale: "de",
  repeatShort: " " + process.env.REPEAT_SHORT,
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

schedule.checkIntegrity(true);
schedule.setMergeInfo();

const exporter = new ScheduleExport({
  schedule: schedule,
  mode: "welocal-json",
  outDir: "json",
  filenamePrefix: "program_schema_radio-z",
});

exporter.write();
