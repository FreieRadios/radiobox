
import { DateTime } from 'luxon';
import {
  BroadcastRecorderEventListener,
  BroadcastRecorderEvents,
  BroadcastRecorderProps,
  TimeSlot,
} from '../types/types';
import BroadcastSchedule from './broadcast-schedule';
import { spawn, ChildProcess } from 'child_process';
import { sleep, timeFormats } from '../helper/helper';
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
    const partSuffix = '-part.mp3';
    const tempSuffix = '-temp.mp3';

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

    const ffmpegArgs = [
      '-i', this.streamUrl,
      '-ss', delay.toString(),
      '-t', seconds.toString(),
      '-b:a', `${this.bitrate}k`,
      '-metadata', `title=${title}`,
      '-metadata', `album=${album}`,
      '-metadata', `genre=${genre}`,
      '-metadata', `date=${date}`,
      '-metadata', `artist=${artist}`,
      '-v', 'error', // Changed to 'error' for less verbose output
      '-hide_banner',
      '-y', // Overwrite temp files
      targetFile + partSuffix
    ];

    const ffmpegProcess: ChildProcess = spawn('ffmpeg', ffmpegArgs);

    const retryCallback = () => {
      console.log('[ffmpeg] Retrying recording...');
      this.checkRecording().catch((retryErr) => {
        console.error('[ffmpeg] Retry failed:', retryErr.message);
      });
    };

    // Handle process start
    const _now = DateTime.now().toFormat(timeFormats.machine);
    console.log(
      `[ffmpeg] ${_now} recording "${
        targetFile + partSuffix
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
        console.log(`[ffmpeg] ${_now} Finished recording ` + targetFile + partSuffix);
        fs.renameSync(targetFile + partSuffix, targetFile);

        await this.onFinished(targetFile, currentSlot, now, seconds);

        // Check if the part file exists
        // if (fs.existsSync(targetFile + partSuffix)) {
        //   // Check if target file already exists
        //   if (fs.existsSync(targetFile)) {
        //     // Concatenate existing file with new recording
        //     await this.concatenateAudioFiles(targetFile, targetFile + partSuffix, targetFile + tempSuffix);
        //
        //     // Replace original with concatenated file
        //     fs.renameSync(targetFile + tempSuffix, targetFile);
        //
        //     // Clean up part file
        //     fs.unlinkSync(targetFile + partSuffix);
        //   } else {
        //     // No existing file, just rename part to final
        //     fs.renameSync(targetFile + partSuffix, targetFile);
        //   }
        //
        //   // ToDo: Check if the 'close' event was emitted at a regular recording ending or if there is still time left to record, but something else has happened.
        //   // If the recording was terminated too early, it should auto-resume without calling the onFinished (because it has not yet finished).
        //
        //   await this.onFinished(targetFile, currentSlot, now, seconds);
        // } else {
        //   console.error('[ffmpeg] Part file not found after recording completion');
        // }
      } else {
        console.error(`[ffmpeg] Process exited with code ${code}`);
        console.error('[ffmpeg] Error during recording! retry in 3s');

        // throw Error('[ffmpeg] Terminated')

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

  // private checkIfRecordingCompletedNaturally(
  //   startedAt: DateTime,
  //   expectedDurationSeconds: number,
  //   currentSlot: TimeSlot
  // ): boolean {
  //   const actualDuration = DateTime.now().diff(startedAt, 'seconds').seconds;
  //   const tolerance = 5; // Allow 5 seconds tolerance for natural completion
  //
  //   // Check if we recorded for the expected duration (within tolerance)
  //   const completedNaturally = Math.abs(actualDuration - expectedDurationSeconds) <= tolerance;
  //
  //   // Also check if the time slot has actually ended
  //   const slotEnded = DateTime.now() >= currentSlot.end.minus({ seconds: tolerance });
  //
  //   console.log(
  //     `[recorder] Duration check - Expected: ${expectedDurationSeconds}s, Actual: ${Math.round(actualDuration)}s, ` +
  //     `Slot ended: ${slotEnded}, Completed naturally: ${completedNaturally}`
  //   );
  //
  //   return completedNaturally || slotEnded;
  // }

  // private async resumeRecording(
  //   targetFile: string,
  //   currentSlot: TimeSlot,
  //   originalStartTime: DateTime
  // ): Promise<void> {
  //   console.log('[recorder] Recording terminated early, attempting to resume...');
  //
  //   // Calculate remaining time for this slot
  //   const now = DateTime.now();
  //   const remaining = now.until(currentSlot.end);
  //   const remainingSeconds = remaining.length('seconds');
  //
  //   if (remainingSeconds > 5) { // Only resume if there's more than 5 seconds left
  //     console.log(`[recorder] Resuming recording for ${Math.round(remainingSeconds)}s remaining`);
  //
  //     // Start a new recording that will be concatenated
  //     this.writeStreamToFile(targetFile, currentSlot, originalStartTime, Math.round(remainingSeconds));
  //   } else {
  //     console.log('[recorder] Too little time remaining, not resuming recording');
  //     // Consider this as completed and trigger onFinished
  //     const totalExpectedDuration = originalStartTime.until(currentSlot.end).length('seconds');
  //     await this.onFinished(targetFile, currentSlot, originalStartTime, totalExpectedDuration);
  //   }
  // }

  private async concatenateAudioFiles(existingFile: string, newFile: string, outputFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const concatArgs = [
        '-i', existingFile,
        '-i', newFile,
        '-filter_complex', '[0:0][1:0]concat=n=2:v=0:a=1[out]',
        '-map', '[out]',
        '-b:a', `${this.bitrate}k`,
        '-v', 'error',
        '-hide_banner',
        '-y',
        outputFile
      ];

      const concatProcess = spawn('ffmpeg', concatArgs);

      concatProcess.on('close', (code) => {
        if (code === 0) {
          console.log('[ffmpeg] Successfully concatenated audio files');
          resolve();
        } else {
          console.error(`[ffmpeg] Concatenation failed with code ${code}`);
          reject(new Error(`Concatenation failed with code ${code}`));
        }
      });

      concatProcess.on('error', (err) => {
        console.error('[ffmpeg] Concatenation process error:', err.message);
        reject(err);
      });
    });
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
