import { DateTime } from "luxon";
import BroadcastSchedule from "../src/broadcast-schedule";
import BroadcastSchema from "../src/broadcast-schema";
import "dotenv/config";
import { vd } from "../src/helper/helper";

test("test scheduler for last of month", async () => {
  const schema = new BroadcastSchema({
    schemaFile: process.env.BROADCAST_SCHEMA_FILE,
  });

  // Last Monday of August '24 is the fourth Monday
  const dataStartString = ["2024-08-26", "220000"].join("T");
  const dateStart = DateTime.fromISO(dataStartString);
  const dateEnd = dateStart.plus({
    hours: 1,
  });

  const schedule = new BroadcastSchedule({
    dateStart: dateStart,
    dateEnd: dateEnd,
    schema: schema,
    locale: process.env.SCHEDULE_LOCALE,
    repeatShort: process.env.REPEAT_SHORT,
    repeatLong: process.env.REPEAT_LONG,
  });

  // 'MyBroadcast 1' if month has 4 mondays.
  expect(schedule.getGrid()[0].broadcast.name).toBe("MyBroadcast 1");
});
