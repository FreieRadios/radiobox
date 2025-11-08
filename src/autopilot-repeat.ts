import { DateTime } from 'luxon';
import 'dotenv/config';
import { timeFormats } from './helper/helper';
import { fetchSchemaFromNextcloud, getRecorder, getSchedule, getSchema } from './index';
import { getDateStartEnd } from './helper/date-time';
import * as process from 'node:process';
import { copyFile, copyRepeat, getFilename, unlinkFile, unlinkFilesByType } from './helper/files';

const run = async () => {
  console.log(`[autopilot] Current dir is ${__dirname}`);
  await fetchSchemaFromNextcloud();

  const now = DateTime.now();
  const schema = getSchema();

  const filenameSuffix = process.env.FILENAME_SUFFIX

  const { dateStart, dateEnd } = getDateStartEnd(
    now.toFormat('yyyy-MM-dd'),
    process.env.RECORDER_START_TIME,
    Number(process.env.RECORDER_DURATION)
  );

  console.log('[Recorder] starts at ' + dateStart.toFormat(timeFormats.human));
  console.log('[Recorder] ends at ' + dateEnd.toFormat(timeFormats.human));

  const schedule = getSchedule(schema, dateStart, dateEnd);
  const recorder = getRecorder(schedule);

  recorder.on('startup', async () => {
    unlinkFilesByType(process.env.EXPORTER_REPEAT_FOLDER, filenameSuffix);
  });

  recorder.on('finished', async (sourceFile, slot) => {
    copyRepeat(sourceFile, slot, filenameSuffix)
    unlinkFile(sourceFile);
  });

  recorder.start().then((resp) => {
    console.log('[Recorder] has finished!');
  });
};

console.log('[autopilot] ... starting ...');
run().then((resp) => {
  console.log('[autopilot] Startup completed');
});
