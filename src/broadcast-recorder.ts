import { DateTime } from "luxon";
import { BroadcastRecorderProps } from "./types";
import BroadcastSchedule from "./broadcast-schedule";
import ffmpeg from "fluent-ffmpeg";
import { sleep } from "./helper/helper";

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

  constructor(props: BroadcastRecorderProps) {
    this.schedule = props.schedule;
    this.outDir = props.outDir;
    this.streamUrl = props.streamUrl;
    this.filenamePrefix = props.filenamePrefix;
    this.dateStart = DateTime.fromISO(props.dateStart);
    this.dateEnd = DateTime.fromISO(props.dateEnd);

    if (this.dateStart && this.dateEnd) {
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

    const pollingInterval = 1000;
    const startTime = this.dateStart.toUnixInteger();
    const endTime = this.dateEnd.toUnixInteger();

    for (let i = startTime; i <= endTime; i += pollingInterval) {
      await this.checkRecording();
      await sleep(pollingInterval);
    }
  }

  async checkRecording() {
    const now = DateTime.now();
    const currentBroadcast = this.schedule.findByDateStart(now);
    if (currentBroadcast) {
      const remaining = now.until(currentBroadcast.end);
      const seconds = remaining.length("seconds");
      if (seconds > 0) {
        const outputFile = "mp3/" + currentBroadcast.broadcast.name + ".mp3";
        console.log(
          "Recording " +
            outputFile +
            " " +
            Math.round(seconds / 60) +
            "min left"
        );
        this.writeStreamToFile(outputFile, seconds);
        await sleep(seconds * 1000);
      }
    }
  }

  writeStreamToFile(targetFile: string, seconds: number) {
    // const stream = fs.createWriteStream(targetFile);
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
      console.log("Still " + Math.round(waitFor / 1000) + "s to wait....");
      await sleep(waitFor);
    }
  }
}
