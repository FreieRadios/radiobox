import { DateTime } from "luxon";
import {
  BroadcastRecorderEventListener,
  BroadcastRecorderEvents,
  BroadcastRecorderProps,
  TimeSlot,
} from "../types/types";
import BroadcastSchedule from "./broadcast-schedule";
import ffmpeg from "fluent-ffmpeg";
import { sleep, timeFormats } from "../helper/helper";
import { getFilename, getPath } from "../helper/files";
import { toDateTime } from "../helper/date-time";
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
    this.outDir = getPath(props.outDir || "mp3/");
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
      // const seconds = 10;
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
          console.error("[recorder] Error while writing stream to file");
        }
        await sleep(seconds * 1000);
      }
    } else {
      console.log("[recorder] sleeping for " + this.pollingInterval);
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

    const title = currentSlot.broadcast.getTitle(
      currentSlot,
      ["name", "startEndTime", "info_0"],
      " - "
    );
    const genre = currentSlot.broadcast.getTitle(currentSlot, ["info_1"]);
    const album = currentSlot.broadcast.getTitle(
      currentSlot,
      ["info_0", "startDate", "startEndTime"],
      " "
    );
    const date = currentSlot.broadcast.getTitle(currentSlot, ["date"]);
    const artist = currentSlot.broadcast.getTitle(currentSlot, ["station"]);

    const tmpFfmpeg = ffmpeg(this.streamUrl)
      .outputOptions(`-ss ${delay}`)
      .outputOptions(`-t ${seconds}`)
      .outputOptions(`-b:a 256k`)
      .outputOptions("-metadata", "title=" + title)
      .outputOptions("-metadata", "album=" + album)
      .outputOptions("-metadata", "genre=" + genre)
      .outputOptions("-metadata", "date=" + date)
      .outputOptions("-metadata", "artist=" + artist)
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
      // .on("stderr", (line) => console.log(`FFmpeg STDERR: ${line}`))
      // .on("progress", function (progress) {
      //   console.log(progress);
      //   console.log("Processing: " + progress.percent + "% done");
      // })
      .on("error", function (err, stdout, stderr) {
        console.error(stderr);
        console.error("[ffmpeg] Cannot process: " + err.message);
        throw new Error("[ffmpeg] Error during recording");
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
