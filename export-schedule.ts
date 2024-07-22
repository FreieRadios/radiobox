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
  dateEnd: "2024-08-18T00:00:00",
  repeatPadding: 1,
  locale: "de",
  repeatShort: " (Wdh.)",
  repeatLong: "Wiederholung vom Vortag",
});

schedule.checkIntegrity(true);
// schedule.mergeSlots();

const exporter = new ScheduleExport({
  schedule: schedule,
  blockName: "Sendung",
  mode: "welocal-json",
  outDir: "json",
  filenamePrefix: "program_schema_radio-z",
});

exporter.write();
