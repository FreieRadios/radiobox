import { DateTime } from 'luxon';
import { timeFormats, vd } from '../helper/helper';
import {
  fetchSchemaFromNextcloud,
  getNextcloud,
  getRecorder,
  getSchedule,
  getSchema,
  getWelocal,
  putSchemaToFTP,
  updateStreamMeta,
} from '../index';
import { getDateStartEnd } from '../helper/date-time';
import process from 'node:process';
import { copyRepeat, unlinkFile, unlinkFilesByType } from '../helper/files';
import { TimeSlot } from '../types/types';

export interface WelocalLike {
  getUploadFileInfo(sourceFile: string, slot: TimeSlot): any;
  upload(file: any): Promise<any>;
}

export interface NextcloudLike {
  getUploadFileInfo(sourceFile: string): any;
  upload(file: any): Promise<any>;
}

export interface FinishedHandlerDeps {
  uploaderWelocal: WelocalLike | null;
  uploaderNextcloud: NextcloudLike | null;
  doCopyRepeat: boolean;
  filenameSuffix: string;
  // Injectable side-effects (so tests can stub fs operations).
  copyRepeat?: typeof copyRepeat;
  unlinkFile?: typeof unlinkFile;
  log?: (scope: string, message: string, ...rest: any[]) => void;
  logError?: (scope: string, message: string, ...rest: any[]) => void;
}

interface AutopilotConfig {
  schemaFilename: string;
  uploadNextcloud: boolean;
  uploadWelocal: boolean;
  putSchemaDays: number[];
  doCopyRepeat: boolean;
  doCleanRepeats: boolean;
  doUpdateStreamMeta: boolean;
  disableRecording: boolean;
  doSyncSchemaFile: boolean;
  filenameSuffix: string;
}

export class Autopilot {
  private shuttingDown = false;
  private globalPendingJobs: Promise<void>[] = [];

  constructor() {}

  private ts(): string {
    return DateTime.now().toISO() ?? new Date().toISOString();
  }

  public log(scope: string, message: string, ...rest: any[]): void {
    console.log(`[${this.ts()}] [${scope}] ${message}`, ...rest);
  }

  public logError(scope: string, message: string, ...rest: any[]): void {
    console.error(`[${this.ts()}] [${scope}] ERROR: ${message}`, ...rest);
  }

  private parseBool(v: string | undefined, def = false): boolean {
    if (v === undefined) return def;
    return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
  }
  private parseString(v: string | undefined, def = ''): string {
    if (v === undefined) return def;
    return String(v);
  }

  private parseDays(v: string | undefined): number[] {
    if (!v) return [];
    return v
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));
  }

  public createFinishedHandler(deps: FinishedHandlerDeps) {
    const _copyRepeat = deps.copyRepeat ?? copyRepeat;
    const _unlinkFile = deps.unlinkFile ?? unlinkFile;
    const _log = deps.log ?? this.log.bind(this);
    const _logError = deps.logError ?? this.logError.bind(this);

    const pendingJobs: Promise<void>[] = [];

    const handler = (sourceFile: string, slot: TimeSlot) => {
      const job = (async () => {
        try {
          if (deps.uploaderWelocal) {
            const uploadFile = deps.uploaderWelocal.getUploadFileInfo(sourceFile, slot);
            _log('welocal', `upload starting for ${sourceFile}`);
            await deps.uploaderWelocal.upload(uploadFile);
            _log('welocal', `upload finished for ${sourceFile}`);
          }
          if (deps.uploaderNextcloud) {
            const uploadFile = deps.uploaderNextcloud.getUploadFileInfo(sourceFile);
            _log('nextcloud', `upload starting for ${sourceFile}`);
            await deps.uploaderNextcloud.upload(uploadFile);
            _log('nextcloud', `upload finished for ${sourceFile}`);
          }
          if (deps.doCopyRepeat) {
            _copyRepeat(sourceFile, slot, deps.filenameSuffix);
          }
          _unlinkFile(sourceFile);
        } catch (err) {
          _logError('autopilot', 'upload/finalize failed', err);
        }
      })();
      pendingJobs.push(job);
      job.finally(() => {
        const idx = pendingJobs.indexOf(job);
        if (idx >= 0) pendingJobs.splice(idx, 1);
      });
      return job;
    };

    const waitForPending = async () => {
      if (pendingJobs.length > 0) {
        await Promise.allSettled(pendingJobs);
      }
    };

    return { handler, pendingJobs, waitForPending };
  }

  public async gracefulShutdown(reason: string, code = 0) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.globalPendingJobs.length > 0) {
      this.log(
        'autopilot',
        `waiting for ${this.globalPendingJobs.length} pending job(s) to finish before shutdown`
      );
      await Promise.allSettled(this.globalPendingJobs);
    }
    this.log('autopilot', `shutting down (reason=${reason}, exitCode=${code})`);
    process.exit(code);
  }

  public async run() {
    this.log('autopilot', `current working dir: ${process.cwd()}`);
    this.log(
      'autopilot',
      `node=${process.version} pid=${process.pid} platform=${process.platform}`
    );

    const config = this.loadConfig();
    const now = DateTime.now();

    const schema = await this.syncSchema(config);
    this.exportSchemaToFTP(schema, now, config.putSchemaDays);

    const { dateStart, dateEnd } = getDateStartEnd(
      now.toFormat('yyyy-MM-dd'),
      process.env.RECORDER_START_TIME,
      Number(process.env.RECORDER_DURATION)
    );

    if (config.doUpdateStreamMeta) {
      updateStreamMeta(schema, Number(process.env.META_UPDATE_INTERVAL), dateEnd);
    }

    this.log(
      'recorder',
      `scheduled from ${dateStart.toFormat(timeFormats.human)} to ${dateEnd.toFormat(timeFormats.human)}`
    );
    this.log(
      'autopilot',
      `config: schemaFilename=${config.schemaFilename} uploadWelocal=${config.uploadWelocal} uploadNextcloud=${config.uploadNextcloud} putSchemaDays=[${config.putSchemaDays.join(',')}] copyRepeat=${config.doCopyRepeat} cleanRepeats=${config.doCleanRepeats} disableRecording=${config.disableRecording}`
    );

    if (config.disableRecording) {
      await this.handleRecordingDisabled(config, dateEnd);
      return;
    }

    const recorder = this.setupRecorder(schema, dateStart, dateEnd, config);

    this.log('recorder', 'starting recording cycle');
    recorder.start().then(() => {
      this.log('recorder', 'recording cycle has finished');
      this.gracefulShutdown('cycle-complete', 0);
    });
  }

  private loadConfig(): AutopilotConfig {
    return {
      uploadNextcloud: this.parseBool(process.env.AUTOPILOT_UPLOAD_NEXTCLOUD, true),
      uploadWelocal: this.parseBool(process.env.AUTOPILOT_UPLOAD_WELOCAL, true),
      putSchemaDays: this.parseDays(process.env.AUTOPILOT_PUT_SCHEMA_DAYS),
      doCopyRepeat: this.parseBool(process.env.AUTOPILOT_COPY_REPEAT, true),
      doCleanRepeats: this.parseBool(process.env.AUTOPILOT_CLEAN_REPEATS, true),
      doUpdateStreamMeta: this.parseBool(process.env.AUTOPILOT_UPDATE_STREAM_META, true),
      disableRecording: this.parseBool(process.env.AUTOPILOT_DISABLE_RECORDING, false),
      doSyncSchemaFile: this.parseBool(process.env.AUTOPILOT_SYNC_SCHEMA_FILE, true),
      schemaFilename: this.parseString(process.env.AUTOPILOT_SCHEMA_FILENAME, 'schema.json'),
      filenameSuffix: process.env.FILENAME_SUFFIX || '',
    };
  }

  private async syncSchema(config: AutopilotConfig) {
    if (config.doSyncSchemaFile) {
      await fetchSchemaFromNextcloud();
    }
    return getSchema();
  }

  private exportSchemaToFTP(schema: any, now: DateTime, putSchemaDays: number[]) {
    if (putSchemaDays.includes(now.weekday)) {
      putSchemaDays.forEach((week) => {
        putSchemaToFTP(schema, now, week);
      });
    }
  }

  private async handleRecordingDisabled(config: AutopilotConfig, dateEnd: DateTime) {
    this.log('autopilot', 'recording is disabled by AUTOPILOT_DISABLE_RECORDING');
    if (config.doUpdateStreamMeta) {
      this.log(
        'autopilot',
        'keeping autopilot running for stream meta updates until scheduled end'
      );
      const waitTime = dateEnd.diff(DateTime.now()).as('milliseconds');
      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }
    this.log('autopilot', 'autopilot cycle finished (no recording)');
    await this.gracefulShutdown('cycle-complete-no-recording', 0);
  }

  private setupRecorder(
    schema: any,
    dateStart: DateTime,
    dateEnd: DateTime,
    config: AutopilotConfig
  ) {
    const schedule = getSchedule(schema, dateStart, dateEnd);
    const recorder = getRecorder(schedule);

    const uploaderWelocal = config.uploadWelocal ? getWelocal(schedule) : null;
    const uploaderNextcloud = config.uploadNextcloud ? getNextcloud() : null;

    recorder.on('startup', async () => {
      this.log('recorder', 'startup event received');
      if (config.doCleanRepeats) {
        this.log(
          'autopilot',
          `cleaning repeat folder: ${process.env.EXPORTER_REPEAT_FOLDER} (suffix=${config.filenameSuffix})`
        );
        unlinkFilesByType(process.env.EXPORTER_REPEAT_FOLDER || '', config.filenameSuffix);
      }
    });

    const { handler, pendingJobs } = this.createFinishedHandler({
      uploaderWelocal,
      uploaderNextcloud,
      doCopyRepeat: config.doCopyRepeat,
      filenameSuffix: config.filenameSuffix,
    });

    recorder.on('finished', async (sourceFile, slot) => {
      const job = handler(sourceFile, slot);
      this.globalPendingJobs.push(job);
      job.finally(() => {
        const idx = this.globalPendingJobs.indexOf(job);
        if (idx >= 0) this.globalPendingJobs.splice(idx, 1);
      });
      // pendingJobs is kept for reference/debugging only.
      void pendingJobs;
    });

    return recorder;
  }
}
