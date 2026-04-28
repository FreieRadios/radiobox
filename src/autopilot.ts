import { DateTime } from 'luxon';
import 'dotenv/config';
import { timeFormats } from './helper/helper';
import {
  fetchSchemaFromNextcloud,
  getNextcloud,
  getRecorder,
  getSchedule,
  getSchema,
  getWelocal,
  putSchemaToFTP,
  updateStreamMeta,
} from './index';
import { getDateStartEnd } from './helper/date-time';
import process from 'node:process';
import { cleanupFile, copyRepeat, unlinkFile, unlinkFilesByType } from './helper/files';

const ts = (): string => DateTime.now().toISO() ?? new Date().toISOString();

const log = (scope: string, message: string, ...rest: any[]): void => {
  console.log(`[${ts()}] [${scope}] ${message}`, ...rest);
};

const logError = (scope: string, message: string, ...rest: any[]): void => {
  console.error(`[${ts()}] [${scope}] ERROR: ${message}`, ...rest);
};

const parseBool = (v: string | undefined, def = false): boolean => {
  if (v === undefined) return def;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
};

const parseDays = (v: string | undefined): number[] => {
  if (!v) return [];
  return v
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));
};

let shuttingDown = false;

function gracefulShutdown(reason: string, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('autopilot', `shutting down (reason=${reason}, exitCode=${code})`);
  process.exit(code);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  logError('autopilot', 'uncaughtException', err);
  gracefulShutdown("uncaughtException", 1);
});

const run = async () => {
  log('autopilot', `current working dir: ${__dirname}`);
  log('autopilot', `node=${process.version} pid=${process.pid} platform=${process.platform}`);
  await fetchSchemaFromNextcloud();

  const now = DateTime.now();
  const schema = getSchema();
  const filenameSuffix = process.env.FILENAME_SUFFIX;

  const uploadNextcloud = parseBool(process.env.AUTOPILOT_UPLOAD_NEXTCLOUD, true);
  const uploadWelocal = parseBool(process.env.AUTOPILOT_UPLOAD_WELOCAL, true);
  const putSchemaDays = parseDays(process.env.AUTOPILOT_PUT_SCHEMA_DAYS);
  const doCopyRepeat = parseBool(process.env.AUTOPILOT_COPY_REPEAT, true);
  const doCleanRepeats = parseBool(process.env.AUTOPILOT_CLEAN_REPEATS, true);

  if (putSchemaDays.includes(now.weekday)) {
    // Export the schedule to FTP on configured weekdays
    [0, 1, 2, 3].forEach((week) => {
      putSchemaToFTP(schema, now, week);
    });
  }

  const { dateStart, dateEnd } = getDateStartEnd(
    now.toFormat('yyyy-MM-dd'),
    process.env.RECORDER_START_TIME,
    Number(process.env.RECORDER_DURATION)
  );

  updateStreamMeta(schema, Number(process.env.META_UPDATE_INTERVAL), dateEnd);

  log('recorder', `scheduled to start at ${dateStart.toFormat(timeFormats.human)} (${dateStart.toISO()})`);
  log('recorder', `scheduled to end at   ${dateEnd.toFormat(timeFormats.human)} (${dateEnd.toISO()})`);
  log('autopilot', `config: uploadWelocal=${uploadWelocal} uploadNextcloud=${uploadNextcloud} putSchemaDays=[${putSchemaDays.join(',')}] copyRepeat=${doCopyRepeat} cleanRepeats=${doCleanRepeats}`);

  const schedule = getSchedule(schema, dateStart, dateEnd);
  const recorder = getRecorder(schedule);

  const uploaderWelocal = uploadWelocal ? getWelocal(schedule) : null;
  const uploaderNextcloud = uploadNextcloud ? getNextcloud() : null;

  recorder.on('startup', async () => {
    log('recorder', 'startup event received');
    if (doCleanRepeats) {
      log('autopilot', `cleaning repeat folder: ${process.env.EXPORTER_REPEAT_FOLDER} (suffix=${filenameSuffix})`);
      unlinkFilesByType(process.env.EXPORTER_REPEAT_FOLDER, filenameSuffix);
    }
  });

  recorder.on('finished', async (sourceFile, slot) => {
    const finalize = (uploadFile?: { sourceFile?: string } | any) => {
      if (doCopyRepeat) {
        copyRepeat(sourceFile, slot, filenameSuffix);
      }
      if (uploadFile) {
        cleanupFile(uploadFile);
      } else {
        unlinkFile(sourceFile);
      }
    };

    if (uploaderWelocal && uploaderNextcloud) {
      const uploadFile = uploaderWelocal.getUploadFileInfo(sourceFile, slot);
      log('welocal', `upload starting for ${uploadFile?.sourceFile ?? sourceFile}`);
      uploaderWelocal
        .upload(uploadFile)
        .then(() => {
          log('welocal', `upload finished for ${uploadFile?.sourceFile ?? sourceFile}`);
          log('nextcloud', `upload starting for ${uploadFile?.sourceFile ?? sourceFile}`);
          uploaderNextcloud
            .upload(uploadFile)
            .then(() => {
              log('nextcloud', `upload finished for ${uploadFile?.sourceFile ?? sourceFile}`);
              finalize(uploadFile);
            })
            .catch((err) => logError('nextcloud', 'upload failed', err));
        })
        .catch((err) => logError('welocal', 'upload failed', err));
    } else if (uploaderWelocal) {
      const uploadFile = uploaderWelocal.getUploadFileInfo(sourceFile, slot);
      log('welocal', `upload starting for ${uploadFile?.sourceFile ?? sourceFile}`);
      uploaderWelocal
        .upload(uploadFile)
        .then(() => {
          log('welocal', `upload finished for ${uploadFile?.sourceFile ?? sourceFile}`);
          finalize(uploadFile);
        })
        .catch((err) => logError('welocal', 'upload failed', err));
    } else if (uploaderNextcloud) {
      // Nextcloud uploader needs upload file info; reuse welocal helper shape via a minimal call
      const uploadFile = getWelocal(schedule).getUploadFileInfo(sourceFile, slot);
      log('nextcloud', `upload starting for ${uploadFile?.sourceFile ?? sourceFile}`);
      uploaderNextcloud
        .upload(uploadFile)
        .then(() => {
          log('nextcloud', `upload finished for ${uploadFile?.sourceFile ?? sourceFile}`);
          finalize(uploadFile);
        })
        .catch((err) => logError('nextcloud', 'upload failed', err));
    } else {
      finalize();
    }
  });

  log('recorder', 'starting recording cycle');
  recorder.start().then(() => {
    log('recorder', 'recording cycle has finished');
    gracefulShutdown('cycle-complete', 0);
  });
};

log('autopilot', '... starting ...');
run()
  .then(() => {
    log('autopilot', 'startup completed');
  })
  .catch((err) => {
    logError('autopilot', 'startup failed', err);
    gracefulShutdown('startup-failed', 1);
  });
