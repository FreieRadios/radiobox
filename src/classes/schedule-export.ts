import {
  getFilename,
  getPath,
  writeFile,
  writeJsonFile,
} from "../helper/files";
import { DateTime } from "luxon";
import {
  Broadcast,
  Schedule,
  ScheduleExportProps,
  TimeGridJsonWelocal,
  TimeGridPlaylist,
  TimeSlot,
} from "../types/types";
import BroadcastSchedule from "./broadcast-schedule";
import { vd } from "../helper/helper";
import { Client } from "basic-ftp";
import "dotenv/config";
import * as process from "node:process";

/*
 * Class to export a schedule schema to json
 */
export default class ScheduleExport {
  schedule: BroadcastSchedule;
  outDir: string;
  filenamePrefix: string;
  mp3Path: string;
  mp3Prefix: string;
  repeatPath: string;
  mode: ScheduleExportProps["mode"];

  constructor(props: ScheduleExportProps) {
    this.schedule = props.schedule;
    this.mode = props.mode;
    this.outDir = getPath(props.outDir);
    this.filenamePrefix = props.filenamePrefix;
    this.mp3Path = props.mp3Path;
    this.mp3Prefix = props.mp3Prefix;
    this.repeatPath = props.repeatPath;
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

  getFilenameStart() {
    return [this.filenamePrefix, this.schedule.dateStart.toISODate()].join("_");
  }

  convert() {
    switch (this.mode) {
      case "m3u":
        return this.getGrid()
          .filter((slot) => slot.matches.length > 0)
          .map((slot) => {
            const ret = {
              filename: getFilename(this.mp3Path, this.mp3Prefix, slot, ".mp3"),
              repeatFrom: null,
            };
            if (slot.repeatFrom) {
              ret.repeatFrom = getFilename(
                this.repeatPath,
                this.mp3Prefix,
                slot.repeatFrom,
                ".mp3"
              );
            }
            return ret;
          }) as TimeGridPlaylist;
      case "welocal-json":
        return this.getGrid()
          .filter((slot) => slot.matches.length > 0)
          .map((slot) => {
            const broadcast = slot.broadcast;
            const schedule = slot.matches[0];
            const localeStartDate = slot.start.setLocale("de");
            const localeEndDate = slot.end.setLocale("de");
            return {
              day: localeStartDate.toFormat("dd.MM.yyyy"),
              block: this.getTitleInfo(broadcast, schedule, slot),
              start: localeStartDate.toLocaleString(DateTime.TIME_24_SIMPLE),
              end: localeEndDate.toLocaleString(DateTime.TIME_24_SIMPLE),
              short: this.getShortInfo(broadcast, schedule, slot),
              long: this.getLongInfo(broadcast, schedule),
            };
          }) as TimeGridJsonWelocal;
      default:
        return;
    }
  }

  getTitleInfo(broadcast: Broadcast, schedule: Schedule, slot: TimeSlot) {
    if (!broadcast) {
      return "Unknown broadcast";
    }
    const info = [];

    info.push(broadcast.name);
    if (slot.duration > 1) {
      info.push(" (" + slot.duration + "h)");
    }

    if (schedule.isRepeat) {
      info.push(this.schedule.repeatShort);
    }

    return info.join("");
  }

  getShortInfo(broadcast: Broadcast, schedule: Schedule, slot: TimeSlot) {
    if (!broadcast) {
      return "Unknown broadcast";
    }
    const info = [];

    if (schedule.isRepeat) {
      info.push(this.schedule.repeatInfoToString(schedule, slot));
    } else {
      info.push(this.schedule.scheduleInfoToString(schedule, slot));
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

  write(cb?) {
    const data = this.convert();
    const writeData = cb ? cb(data) : data;
    switch (this.mode) {
      case "welocal-json":
        writeJsonFile(this.outDir, this.getFilename(), writeData);
        console.log("[export] Written file " + this.getFilename());
        break;
      case "m3u":
        writeFile(this.outDir, this.getFilenameStart(), writeData, "m3u");
        console.log("[export] Written file " + this.getFilenameStart());
        break;
      default:
        break;
    }

    return this;
  }

  async toFTP(verbose?) {
    const client = new Client();
    client.ftp.verbose = verbose || false;
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

  toTxt() {
    this.write((data: TimeGridPlaylist) =>
      data
        .filter((slot) => slot.repeatFrom)
        .map((slot) => slot.repeatFrom)
        .join(`\n`)
    );
  }
}
