import { DateTime } from 'luxon';
import {
  BroadcastRecorderEventListener,
  BroadcastRecorderEvents,
  BroadcastRecorderProps,
  TimeSlot,
} from '../types/types';
import BroadcastSchedule from './broadcast-schedule';
import { ChildProcess, spawn } from 'child_process';
import { sleep, timeFormats, vd } from '../helper/helper';
import { getFilename, getPath } from '../helper/files';
import { toDateTime } from '../helper/date-time';
import * as fs from 'node:fs';

/*
 * Class to store stream data to files
 */
export default class BroadcastRecorder {
  schedule: BroadcastSchedule;
  streamUrl: string;
  outDir: string;
  filenamePrefix: string;
  // Start recording at (optional)
  dateStart: DateTime;
  // End recording at (optional)
  dateEnd: DateTime;
  filenameSuffix = '.mp3';
  pollingInterval = 1000; //ms
  bitrate = 256; //ms
  // delay each recording by
  delay = 0; // seconds
  events: BroadcastRecorderEvents = {
    startup: [],
    finished: [],
  };

  constructor(props: BroadcastRecorderProps) {
    this.schedule = props.schedule;
    this.outDir = getPath(props.outDir || 'mp3/');
    this.streamUrl = props.streamUrl;
    this.filenamePrefix = props.filenamePrefix;

    if (props.dateStart && props.dateEnd) {
      this.dateStart = toDateTime(props.dateStart);
      this.dateEnd = toDateTime(props.dateEnd);
      this.schedule.sliceGrid(props.dateStart, props.dateEnd);
    } else {
      this.dateStart = this.schedule.dateStart;
      this.dateEnd = this.schedule.dateEnd;
    }

    if (props.ignoreRepeats === true) {
      this.schedule.filter((slot) => slot.matches && !slot.matches[0].isRepeat);
    }

    if (props.delay) {
      this.delay = props.delay;
    }
    if (props.bitrate) {
      this.bitrate = props.bitrate;
    }

    this.schedule.mergeSlots();
  }

  async start() {
    await this.waitUntilStart();
    await this.onStartup(DateTime.now());
    while (DateTime.now() <= this.dateEnd) {
      await this.checkRecording();
    }
  }

  on(type: keyof BroadcastRecorderEvents, listener: BroadcastRecorderEventListener) {
    this.events[type].push(listener);
    return this;
  }

  async checkRecording() {
    const now = DateTime.now();
    const currentSlot = this.schedule.findByDateStart(now);
    if (currentSlot) {
      const remaining = now.until(currentSlot.end);
      // const seconds = 10;
      const seconds = remaining.length('seconds');

      if (seconds > 0) {
        const outputFile = getFilename(
          this.outDir,
          this.filenamePrefix,
          currentSlot,
          this.filenameSuffix
        );

        try {
          this.writeStreamToFile(outputFile, currentSlot, now, Math.round(seconds));
        } catch (e) {
          console.error('[recorder] Error while writing stream to file');
        }
        await sleep(seconds * 1000);
      }
    } else {
      console.log('[recorder] sleeping for ' + this.pollingInterval);
      await sleep(this.pollingInterval);
    }
  }

  writeStreamToFile(targetFile: string, currentSlot: TimeSlot, now: DateTime, seconds: number) {
    const delay = this.delay || 0;

    // Determine if we're recording from a USB device or stream
    const isUsbInput = this.streamUrl.startsWith('hw:') || this.streamUrl.startsWith('plughw:') || this.streamUrl.startsWith('pulse') || this.streamUrl.startsWith('alsa');

    // Set appropriate file extension and suffix based on input type
    const fileExtension = isUsbInput ? '.flac' : '.mp3';
    const partSuffix = isUsbInput ? '-part.flac' : '-part.mp3';

    // Update target file extension if recording from USB
    const finalTargetFile = isUsbInput ? targetFile.replace(/\.(mp3|flac)$/, fileExtension) : targetFile;

    const title = currentSlot.broadcast.getTitle(
      currentSlot,
      ['name', 'startEndTime', 'info_0'],
      ' - '
    );
    const genre = currentSlot.broadcast.getTitle(currentSlot, ['info_1']);
    const album = currentSlot.broadcast.getTitle(
      currentSlot,
      ['info_0', 'startDate', 'startEndTime'],
      ' '
    );
    const date = currentSlot.broadcast.getTitle(currentSlot, ['date']);
    const artist = currentSlot.broadcast.getTitle(currentSlot, ['station']);

    let ffmpegArgs: string[];

    if (isUsbInput) {
      // USB input recording to FLAC (lossless)
      ffmpegArgs = [
        '-f', 'alsa',  // Use ALSA for audio input
        '-i', this.streamUrl,  // USB device (e.g., 'hw:1,0', 'plughw:1,0', 'pulse')
        '-ss', delay.toString(),
        '-t', seconds.toString(),
        '-c:a', 'flac',  // Use FLAC codec for lossless compression
        '-compression_level', '8',  // Maximum FLAC compression
        '-sample_fmt', 's16',  // 16-bit sample format
        '-ar', '44100',  // 44.1kHz sample rate
        '-metadata', `title=${title}`,
        '-metadata', `album=${album}`,
        '-metadata', `genre=${genre}`,
        '-metadata', `date=${date}`,
        '-metadata', `artist=${artist}`,
        '-v', 'error',
        '-hide_banner',
        '-y', // Overwrite temp files
        finalTargetFile + partSuffix
      ];
    } else {
      // Stream URL recording to MP3 (existing functionality)
      ffmpegArgs = [
        '-i', this.streamUrl,
        '-ss', delay.toString(),
        '-t', seconds.toString(),
        '-b:a', `${this.bitrate}k`,
        '-metadata', `title=${title}`,
        '-metadata', `album=${album}`,
        '-metadata', `genre=${genre}`,
        '-metadata', `date=${date}`,
        '-metadata', `artist=${artist}`,
        '-v', 'error',
        '-hide_banner',
        '-y', // Overwrite temp files
        finalTargetFile + partSuffix
      ];
    }

    const ffmpegProcess: ChildProcess = spawn('ffmpeg', ffmpegArgs);

    const retryCallback = () => {
      console.log('[ffmpeg] Retrying recording...');
      this.checkRecording().catch((retryErr) => {
        console.error('[ffmpeg] Retry failed:', retryErr.message);
      });
    };

    // Handle process start
    const _now = DateTime.now().toFormat(timeFormats.machine);
    const inputType = isUsbInput ? 'USB' : 'stream';
    const format = isUsbInput ? 'FLAC' : 'MP3';
    console.log(
      `[ffmpeg] ${_now} recording ${format} from ${inputType} "${
        finalTargetFile + partSuffix
      }" (${Math.round(seconds / 60)}min left; ${seconds}s)`
    );

    // Handle stderr
    ffmpegProcess.stderr?.on('data', (data) => {
      const output = data.toString();
      // Log only errors
      if (output.toLowerCase().includes('error')) {
        console.error(`[ffmpeg] ${output}`);
      }
    });

    // Handle process completion
    ffmpegProcess.on('close', async (code) => {
      const _now = DateTime.now().toFormat(timeFormats.machine);

      if (code === 0) {
        console.log(`[ffmpeg] ${_now} Finished recording ` + finalTargetFile + partSuffix);

        fs.renameSync(finalTargetFile + partSuffix, finalTargetFile);
        await this.onFinished(finalTargetFile, currentSlot, now, seconds);

      } else {
        console.error(`[ffmpeg] Process exited with code ${code}`);
        console.error('[ffmpeg] Error during recording! retry in 3s');

        setTimeout(retryCallback, 3000);
      }
    });

    // Handle process errors
    ffmpegProcess.on('error', (err) => {
      console.error('[ffmpeg] Failed to start process:', err.message);
      console.error('[ffmpeg] Error during recording! retry in 3s');

      setTimeout(retryCallback, 3000);
    });
  }

  async onStartup(startedAt: DateTime) {
    for (const listener of this.events.startup) {
      await listener(null, null, startedAt, null, this);
    }
  }

  async onFinished(
    outputFile: string,
    currentSlot: TimeSlot,
    startedAt: DateTime,
    seconds: number
  ) {
    for (const listener of this.events.finished) {
      await listener(outputFile, currentSlot, startedAt, seconds, this);
    }
  }

  async waitUntilStart() {
    const waitUntilStart = DateTime.now().until(this.dateStart);
    const waitFor = waitUntilStart.length('milliseconds');
    if (waitFor > 0) {
      console.log('[Recorder] Going to wait for ' + Math.round(waitFor / 1000) + 's now....');
      await sleep(waitFor);
    }
  }
}
