import { writeJsonFile } from "./helper/files";
import { DateTime } from "luxon";
import { BroadcastExportProps, TimeGridJson } from "./types";
import BroadcastSchedule from "./broadcast-schedule";

/*
 * Class to export a schedule schema to json
 */
export default class BroadcastExport {
  schedule: BroadcastSchedule;
  outDir: string;
  filenamePrefix: string;
  mode: BroadcastExportProps["mode"];

  constructor(props: BroadcastExportProps) {
    this.schedule = props.schedule;
    this.mode = props.mode;
    this.outDir = props.outDir;
    this.filenamePrefix = props.filenamePrefix;
  }

  getGrid() {
    const grid = this.schedule.getGrid();
    return this.schedule.mergeTimeSlots(grid);
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
            const broadcast = slot.matches[0];
            const localeStartDate = slot.start.setLocale("de");
            const localeEndDate = slot.end.setLocale("de");
            return {
              day: localeStartDate.toLocaleString(DateTime.DATE_SHORT),
              block: broadcast.name,
              start: localeStartDate.toLocaleString(DateTime.TIME_24_SIMPLE),
              end: localeEndDate.toLocaleString(DateTime.TIME_24_SIMPLE),
              short: broadcast.toString(),
              long:
                slot.broadcast?.info.join(" | ") || this.schedule.repeatLong,
            };
          }) as TimeGridJson;
      default:
        return;
    }
  }

  write() {
    writeJsonFile(this.outDir, this.getFilename(), this.convert());
  }
}
