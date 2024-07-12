import { DateTime } from "luxon";
import { BroadcastRecorderProps } from "./types";
import BroadcastSchedule from "./broadcast-schedule";
import ffmpeg from "fluent-ffmpeg";
import { sleep, vd } from "./helper/helper";
import { getFilename } from "./helper/files";
import { toDateTime } from "./helper/date-time";

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

    this.schedule.mergeSlots();
  }

  async start() {
    await this.waitUntilStart();

    const startTime = this.dateStart.toUnixInteger();
    const endTime = this.dateEnd.toUnixInteger();

    for (let i = startTime; i <= endTime; i += this.pollingInterval) {
      await this.checkRecording();
    }
  }

  async checkRecording() {
    const now = DateTime.now();
    const currentBroadcast = this.schedule.findByDateStart(now);
    if (currentBroadcast) {
      const remaining = now.until(currentBroadcast.end);
      const seconds = remaining.length("seconds");
      if (seconds > 0) {
        const outputFile = getFilename(
          this.outDir,
          this.filenamePrefix,
          currentBroadcast,
          this.filenameSuffix
        );
        this.writeStreamToFile(outputFile, seconds);
        this.logMessage(outputFile, seconds);
        await sleep(seconds * 1000);
      }
    } else {
      await sleep(this.pollingInterval);
    }
  }

  logMessage(outputFile: string, seconds: number) {
    console.log(
      `[ffmpeg] recording "${outputFile}" (${Math.round(seconds / 60)}min left)`
    );
  }

  writeStreamToFile(targetFile: string, seconds: number) {
    ffmpeg(this.streamUrl)
      .outputOptions("-ss 00:00:00")
      .outputOptions(`-t ${seconds}`)
      .outputOptions("-vol 256")
      .outputOptions("-hide_banner")
      .output(targetFile)
      .on("end", function () {
        console.log("Finished recording " + targetFile);
      })
      .on("error", function (err, stdout, stderr) {
        console.log("Cannot process: " + err.message);
      })
      .run();
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
