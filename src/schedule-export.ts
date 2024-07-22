import { writeJsonFile } from "./helper/files";
import { DateTime } from "luxon";
import {
  Broadcast,
  Schedule,
  ScheduleExportProps,
  TimeGridJson,
} from "./types";
import BroadcastSchedule from "./broadcast-schedule";
import { vd } from "./helper/helper";
import { Client } from "basic-ftp";
import "dotenv/config";
import * as process from "node:process";

/*
 * Class to export a schedule schema to json
 */
export default class ScheduleExport {
  schedule: BroadcastSchedule;
  outDir: string;
  blockName: string;
  filenamePrefix: string;
  mode: ScheduleExportProps["mode"];

  constructor(props: ScheduleExportProps) {
    this.schedule = props.schedule;
    this.mode = props.mode;
    this.outDir = props.outDir;
    this.blockName = props.blockName;
    this.filenamePrefix = props.filenamePrefix;
  }

  getGrid() {
    return this.schedule.getGrid();
  }

  getFilename() {
    return [
      this.filenamePrefix,
      this.schedule.dateStart.toISODate(),
      this.schedule.dateEnd.toISODate(),
    ].join("_");
  }

  convert() {
    switch (this.mode) {
      case "welocal-json":
        return this.getGrid()
          .filter((slot) => slot.matches.length > 0)
          .map((slot) => {
            const broadcast = slot.broadcast;
            const schedule = slot.matches[0];
            const localeStartDate = slot.start.setLocale("de");
            const localeEndDate = slot.end.setLocale("de");
            return {
              day: localeStartDate.toLocaleString(DateTime.DATE_SHORT),
              block: this.blockName || broadcast.name,
              start: localeStartDate.toLocaleString(DateTime.TIME_24_SIMPLE),
              end: localeEndDate.toLocaleString(DateTime.TIME_24_SIMPLE),
              short: this.getShortInfo(broadcast, schedule),
              long: this.getLongInfo(broadcast, schedule),
            };
          }) as TimeGridJson;
      default:
        return;
    }
  }

  getShortInfo(broadcast: Broadcast, schedule: Schedule) {
    if (!broadcast) {
      return "Unknown broadcast";
    }
    const info = [broadcast.name];
    if (schedule.isRepeat) {
      info.push(this.schedule.repeatShort);
    }
    return info.join("");
  }

  getLongInfo(broadcast: Broadcast, schedule: Schedule) {
    if (!broadcast) {
      return "Unknown broadcast info";
    }
    const info = [...broadcast.info];
    if (schedule.isRepeat) {
      info.push(this.schedule.repeatLong);
    }
    return info.join(" | ");
  }

  write() {
    writeJsonFile(this.outDir, this.getFilename(), this.convert());
    return this;
  }

  async toFTP() {
    const client = new Client();
    client.ftp.verbose = true;
    const sourceFile = `${this.outDir}/${this.getFilename()}.json`;
    const targetFile = `${
      process.env.FTP_REMOTE_PATH
    }/${this.getFilename()}.json`;
    try {
      await client.access({
        host: process.env.FTP_HOST,
        user: process.env.FTP_USER,
        password: process.env.FTP_PASSWORD,
        secure: process.env.FTP_SECURE === "true",
      });
      // console.log(await client.list());
      await client.uploadFrom(sourceFile, targetFile);
    } catch (err) {
      console.log(err);
    }
    client.close();
  }
}
