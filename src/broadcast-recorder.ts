import { DateTime } from "luxon";
import {
  BroadcastRecorderEventListener,
  BroadcastRecorderEvents,
  BroadcastRecorderProps,
  TimeSlot,
} from "./types";
import BroadcastSchedule from "./broadcast-schedule";
import ffmpeg from "fluent-ffmpeg";
import { sleep, timeFormats } from "./helper/helper";
import { getFilename } from "./helper/files";
import { toDateTime } from "./helper/date-time";
import * as fs from "node:fs";

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
  filenameSuffix = ".mp3";
  pollingInterval = 1000; //ms
  // delay each recording by
  delay = 0; // seconds
  events: BroadcastRecorderEvents = {
    finished: [],
  };

  constructor(props: BroadcastRecorderProps) {
    this.schedule = props.schedule;
    this.outDir = props.outDir || "mp3/";
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

    this.schedule.mergeSlots();
  }

  async start() {
    await this.waitUntilStart();
    while (DateTime.now() <= this.dateEnd) {
      await this.checkRecording();
    }
  }

  on(
    type: keyof BroadcastRecorderEvents,
    listener: BroadcastRecorderEventListener
  ) {
    this.events[type].push(listener);
    return this;
  }

  async checkRecording() {
    const now = DateTime.now();
    const currentSlot = this.schedule.findByDateStart(now);
    if (currentSlot) {
      const remaining = now.until(currentSlot.end);
      const seconds = remaining.length("seconds");

      if (seconds > 0) {
        const outputFile = getFilename(
          this.outDir,
          this.filenamePrefix,
          currentSlot,
          this.filenameSuffix
        );
        try {
          this.writeStreamToFile(
            outputFile,
            currentSlot,
            now,
            Math.round(seconds)
          );
        } catch (e) {
          throw "Could not write stream to file";
        }

        await sleep(seconds * 1000);
      }
    } else {
      await sleep(this.pollingInterval);
    }
  }

  writeStreamToFile(
    targetFile: string,
    currentSlot: TimeSlot,
    now: DateTime,
    seconds: number
  ) {
    const delay = this.delay || 0;
    const partSuffix = "-part.mp3";
    const tmpFfmpeg = ffmpeg(this.streamUrl)
      .outputOptions(`-ss ${delay}`)
      .outputOptions(`-t ${seconds}`)
      .outputOptions("-v 256")
      .outputOptions("-hide_banner")
      .output(targetFile + partSuffix);

    tmpFfmpeg
      .on("start", async () => {
        const _now = DateTime.now().toFormat(timeFormats.machine);
        console.log(
          `[ffmpeg] ${_now} recording "${
            targetFile + partSuffix
          }" (${Math.round(seconds / 60)}min left; ${seconds}s)`
        );
      })
      .on("end", async () => {
        const _now = DateTime.now().toFormat(timeFormats.machine);
        console.log(
          `[ffmpeg] ${_now} Finished recording ` + targetFile + partSuffix
        );
        fs.renameSync(targetFile + partSuffix, targetFile);
        await this.onFinished(targetFile, currentSlot, now, seconds);
      })
      .on("error", function (err, stdout, stderr) {
        throw "[ffmpeg] Cannot process: " + err.message;
      });

    tmpFfmpeg.run();
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
    const waitFor = waitUntilStart.length("milliseconds");
    if (waitFor > 0) {
      console.log(
        "[Recorder] Going to wait for " +
          Math.round(waitFor / 1000) +
          "s now...."
      );
      await sleep(waitFor);
    }
  }
}
