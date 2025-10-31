import { DateTime } from 'luxon';
import 'dotenv/config';
import { timeFormats } from './helper/helper';
import {
  fetchSchemaFromNextcloud,
  getNextcloud,
  getRecorder,
  getSchedule,
  getSchema,
  writeRepeatsPlaylist,
} from './index';
import { getDateStartEnd } from './helper/date-time';
import * as process from 'node:process';
import { copyFile, unlinkFile } from './helper/files';

const run = async () => {
  console.log(`[autopilot] Current dir is ${__dirname}`);
  await fetchSchemaFromNextcloud();

  const now = DateTime.now();
  const schema = getSchema();

  const { dateStart, dateEnd } = getDateStartEnd(
    now.toFormat('yyyy-MM-dd'),
    process.env.RECORDER_START_TIME,
    Number(process.env.RECORDER_DURATION)
  );

  console.log('[Recorder] starts at ' + dateStart.toFormat(timeFormats.human));
  console.log('[Recorder] ends at ' + dateEnd.toFormat(timeFormats.human));

  const schedule = getSchedule(schema, dateStart, dateEnd);
  const recorder = getRecorder(schedule);

  recorder.on('finished', async (sourceFile, slot) => {
    copyFile(sourceFile, process.env.EXPORTER_REPEAT_FOLDER);
    unlinkFile(sourceFile);
  });

  recorder.start().then((resp) => {
    writeRepeatsPlaylist(schema, now, 0, '.flac');
    console.log('[Recorder] has finished!');
  });
};

console.log('[autopilot] ... starting ...');
run().then((resp) => {
  console.log('[autopilot] Startup completed');
});
