import { DateTime } from "luxon";
import BroadcastSchedule from "../src/broadcast-schedule";
import BroadcastSchema from "../src/broadcast-schema";
import "dotenv/config";

test("test scheduler for override while being last of month", () => {
  const schema = new BroadcastSchema({
    schemaFile: process.env.BROADCAST_SCHEMA_FILE,
  });

  // Last Monday of September '24 is the fifth Monday
  const dataStartString = ["2024-09-30", "220000"].join("T");
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

  // 'MyBroadcast 1b' should override 'MyBroadcast 1' if month has 5 Mondays.
  expect(schedule.getGrid()[0].broadcast.name).toBe("MyBroadcast 1b");
});
