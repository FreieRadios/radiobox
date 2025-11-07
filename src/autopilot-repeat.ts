import { DateTime } from 'luxon';
import 'dotenv/config';
import { timeFormats } from './helper/helper';
import {
  fetchSchemaFromNextcloud,
  getRecorder,
  getSchedule,
  getSchema,
  writeRepeatsPlaylist,
} from './index';
import { getDateStartEnd } from './helper/date-time';
import * as process from 'node:process';
import { getFilename, moveFile, unlinkFilesByType } from './helper/files';

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

  console.log('[Recorder] Write repeat playlist for now!');
  writeRepeatsPlaylist(schema, DateTime.now(), 1, '.flac');

  recorder.on('startup', async () => {
    //unlinkFilesByType(process.env.EXPORTER_REPEAT_FOLDER, '.flac');
  });

  recorder.on('startRecording', async (sourceFile, slot) => {});

  recorder.on('finished', async (sourceFile, slot) => {
    const destinationFilename = getFilename(
      process.env.EXPORTER_REPEAT_FOLDER,
      'repeat',
      slot.matches[0].repeatAt,
      '.flac'
    );
    moveFile(sourceFile, destinationFilename);
  });

  recorder.start().then((resp) => {
    console.log('[Recorder] has finished!');
  });
};

console.log('[autopilot] ... starting ...');
run().then((resp) => {
  console.log('[autopilot] Startup completed');
});
