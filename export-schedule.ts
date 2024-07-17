import "dotenv/config";
import BroadcastSchema from "./src/broadcast-schema";
import BroadcastSchedule from "./src/broadcast-schedule";
import ApiConnectorWelocal from "./src/api-connector-welocal";
import { vd } from "./src/helper/helper";
import ScheduleExport from "./src/schedule-export";
import BroadcastRecorder from "./src/broadcast-recorder";

const schedule = new BroadcastSchedule({
  schema: new BroadcastSchema({
    schemaFile: "schema/radio-z.xlsx",
  }),
  dateStart: "2024-07-10T00:00:00",
  dateEnd: "2024-08-01T00:00:00",
  repeatPadding: 1,
  locale: "de",
  repeatShort: " (Wdh.)",
  repeatLong: "Wiederholung vom Vortag",
}).mergeSlots();

schedule.checkIntegrity(true);

const exporter = new ScheduleExport({
  schedule: schedule,
  mode: "welocal-json",
  outDir: "json",
  filenamePrefix: "program_schema_radio-z",
});

exporter.write();
