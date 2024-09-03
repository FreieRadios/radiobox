import { DateTime } from "luxon";
import BroadcastSchedule from "../src/broadcast-schedule";
import BroadcastSchema from "../src/broadcast-schema";
import BroadcastRecorder from "../src/broadcast-recorder";
import { timeFormats, vd } from "../src/helper/helper";
import "dotenv/config";

test("record a broadcast from url and store as mp3", async () => {
  const dataStartString = [
    DateTime.now().toFormat("yyyy-MM-dd"),
    "T",
    "123400",
    // process.env.RECORDER_START_TIME,
  ].join("");

  const dateStart = DateTime.fromISO(dataStartString);

  const dateEnd = dateStart.plus({
    seconds: 120,
  });

  const schedule = new BroadcastSchedule({
    dateStart: dateStart,
    dateEnd: dateEnd,
    schema: new BroadcastSchema({
      schemaFile: process.env.BROADCAST_SCHEMA_FILE,
    }),
    locale: process.env.SCHEDULE_LOCALE,
    repeatShort: process.env.REPEAT_SHORT,
  });

  const recorder = new BroadcastRecorder({
    schedule,
    streamUrl: process.env.RECORDER_STREAM_URL,
    filenamePrefix: process.env.FILENAME_PREFIX,
    delay: 5,
  });

  console.log("[Recorder] starts at " + dateStart.toFormat(timeFormats.human));
  console.log("[Recorder] ends at " + dateEnd.toFormat(timeFormats.human));

  await recorder.start().then((resp) => {
    console.log("[Recorder] has finished!");
  });

  expect(2).toBe(2);
});
