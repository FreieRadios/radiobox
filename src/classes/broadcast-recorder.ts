import { DateTime } from 'luxon';
import {
  BroadcastRecorderEventListener,
  BroadcastRecorderEvents,
  BroadcastRecorderProps,
  TimeSlot,
} from '../types/types';
import BroadcastSchedule from './broadcast-schedule';
import ffmpeg from 'fluent-ffmpeg';
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

  async writeStreamToFile(
    targetFile: string,
    currentSlot: TimeSlot,
    now: DateTime,
    seconds: number
  ) {
    try {
      await this.executeFFmpegRecording(targetFile, currentSlot, seconds);
    } catch (error) {
      console.error('[recorder] Recording failed:', error);
      throw error;
    }
  }

  // writeStreamToFile(
  //   targetFile: string,
  //   currentSlot: TimeSlot,
  //   now: DateTime,
  //   seconds: number
  // ) {
  //   const delay = this.delay || 0;
  //   const partSuffix = "-part.mp3";
  //
  //   const title = currentSlot.broadcast.getTitle(
  //     currentSlot,
  //     ["name", "startEndTime", "info_0"],
  //     " - "
  //   );
  //   const genre = currentSlot.broadcast.getTitle(currentSlot, ["info_1"]);
  //   const album = currentSlot.broadcast.getTitle(
  //     currentSlot,
  //     ["info_0", "startDate", "startEndTime"],
  //     " "
  //   );
  //   const date = currentSlot.broadcast.getTitle(currentSlot, ["date"]);
  //   const artist = currentSlot.broadcast.getTitle(currentSlot, ["station"]);
  //
  //   const tmpFfmpeg = ffmpeg(this.streamUrl)
  //     .outputOptions(`-ss ${delay}`)
  //     .outputOptions(`-t ${seconds}`)
  //     .outputOptions(`-b:a ${this.bitrate}k`)
  //     .outputOptions("-metadata", "title=" + title)
  //     .outputOptions("-metadata", "album=" + album)
  //     .outputOptions("-metadata", "genre=" + genre)
  //     .outputOptions("-metadata", "date=" + date)
  //     .outputOptions("-metadata", "artist=" + artist)
  //     .outputOptions("-v 256")
  //     .outputOptions("-hide_banner")
  //     .output(targetFile + partSuffix);
  //
  //   tmpFfmpeg
  //     .on("start", async () => {
  //       const _now = DateTime.now().toFormat(timeFormats.machine);
  //       console.log(
  //         `[ffmpeg] ${_now} recording "${
  //           targetFile + partSuffix
  //         }" (${Math.round(seconds / 60)}min left; ${seconds}s)`
  //       );
  //     })
  //     .on("end", async () => {
  //       const _now = DateTime.now().toFormat(timeFormats.machine);
  //       console.log(
  //         `[ffmpeg] ${_now} Finished recording ` + targetFile + partSuffix
  //       );
  //       fs.renameSync(targetFile + partSuffix, targetFile);
  //       await this.onFinished(targetFile, currentSlot, now, seconds);
  //     })
  //     // .on("stderr", (line) => console.log(`FFmpeg STDERR: ${line}`))
  //     // .on("progress", function (progress) {
  //     //   console.log(progress);
  //     //   console.log("Processing: " + progress.percent + "% done");
  //     // })
  //     .on("error", function (err, stdout, stderr) {
  //       console.error(stderr);
  //       console.error("[ffmpeg] Cannot process: " + err.message);
  //       throw new Error("[ffmpeg] Error during recording");
  //     });
  //
  //   tmpFfmpeg.run();
  // }

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

  private async executeFFmpegRecording(
    targetFile: string,
    currentSlot: TimeSlot,
    seconds: number
  ): Promise<void> {
    return new Promise(async (resolve, reject) => {
      const partSuffix = '-part.mp3';
      const delay = this.delay || 0;
      let totalRecordedTime = 0;
      let currentFfmpeg: any = null;
      const maxStreamCheckAttempts = 30; // Will try for 5 minutes (30 * 10 seconds)

      // Function to check if stream is accessible
      const checkStream = async (): Promise<boolean> => {
        return new Promise((resolveCheck) => {
          const probe = ffmpeg(this.streamUrl)
            .inputOptions('-t 1') // Try to read just 1 second
            .on('error', () => resolveCheck(false))
            .on('end', () => resolveCheck(true));

          // Set a timeout for the probe
          const timeout = setTimeout(() => {
            probe.kill('SIGKILL');
            resolveCheck(false);
          }, 5000);

          probe.run();
        });
      };

      // Function to start/resume recording
      const startRecording = async (remainingSeconds: number) => {
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

        currentFfmpeg = ffmpeg(this.streamUrl)
          .outputOptions(`-ss ${delay}`)
          .outputOptions(`-t ${remainingSeconds}`)
          .outputOptions(`-b:a ${this.bitrate}k`)
          .outputOptions('-metadata', 'title=' + title)
          .outputOptions('-metadata', 'album=' + album)
          .outputOptions('-metadata', 'genre=' + genre)
          .outputOptions('-metadata', 'date=' + date)
          .outputOptions('-metadata', 'artist=' + artist)
          .outputOptions('-v 256')
          .outputOptions('-hide_banner')
          .output(targetFile + partSuffix);

        let lastProgressTime = Date.now();
        const streamTimeout = 10000; // 10 seconds without progress indicates stream issue

        currentFfmpeg
          .on('start', () => {
            console.log(
              `[ffmpeg] ${DateTime.now().toFormat(timeFormats.machine)} Resuming recording "${targetFile + partSuffix}" (${Math.round(remainingSeconds / 60)}min left)`
            );
          })
          .on('progress', (progress: any) => {
            lastProgressTime = Date.now();
            // Convert FFmpeg time format to seconds and update total time
            if (progress.timemark) {
              const parts = progress.timemark.split(':');
              const currentTime =
                parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
              totalRecordedTime = Math.max(totalRecordedTime, currentTime);
            }
          })
          .on('error', async (err: Error) => {
            console.error('[ffmpeg] Stream error:', err.message);
            currentFfmpeg.kill('SIGKILL');

            // Check if we still have time to record
            const remainingTime = seconds - totalRecordedTime;
            if (remainingTime > 0) {
              console.log('[ffmpeg] Stream interrupted, attempting to reconnect...');
              await handleStreamInterruption(remainingTime);
            } else {
              finishRecording();
            }
          })
          .on('end', () => {
            finishRecording();
          });

        // Monitor for stream health
        const healthCheck = setInterval(() => {
          if (Date.now() - lastProgressTime > streamTimeout) {
            clearInterval(healthCheck);
            currentFfmpeg.kill('SIGKILL');
            // The error handler will take care of reconnection
          }
        }, 5000);

        currentFfmpeg.run();
      };

      // Handle stream interruption
      const handleStreamInterruption = async (remainingTime: number) => {
        let attempts = 0;

        while (attempts < maxStreamCheckAttempts) {
          console.log(
            `[ffmpeg] Checking stream availability (attempt ${attempts + 1}/${maxStreamCheckAttempts})...`
          );

          if (await checkStream()) {
            console.log('[ffmpeg] Stream is available again, resuming recording');
            await startRecording(remainingTime);
            return;
          }

          attempts++;
          await sleep(10000); // Wait 10 seconds between attempts
        }

        console.error('[ffmpeg] Stream unavailable after maximum attempts, stopping recording');
        finishRecording();
      };

      // Finish recording and cleanup
      const finishRecording = async () => {
        try {
          if (fs.existsSync(targetFile + partSuffix)) {
            fs.renameSync(targetFile + partSuffix, targetFile);
            await this.onFinished(targetFile, currentSlot, DateTime.now(), totalRecordedTime);
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      };

      // Start initial recording
      await startRecording(seconds);
    });
  }
}
