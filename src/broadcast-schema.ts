import { dataFromXlsx } from "./helper/files";
import { parseJsonBlock, replaceRangeArrays } from "./helper/helper";
import { Broadcast, BroadcastSchemaProps, Schedule } from "./types";

/*
 * Class read a schema xlsx-file
 *
 * It requires an xlsx file with
 *  - Weekday names in first row
 *  - Broadcast names in first column
 *  - Additional info for each broadcast can be added to any non-weekday-column
 *
 * Syntax for each schedule:
 * "M:[1-12]" each month
 * "M:[1,3,5]" e.g. only in Jan, Mar and May
 * "D:[1-5]" each nth weekday (from column) of month
 * "D:[1,3,5]" e.g. each first, third and fifth weekday of month
 * "D:[-1]" e.g. each last weekday (from column) of month
 * "H:[20,21]" e.g. starting at 20:00 and 21:00 (duration as given in this.gridSize)
 * "R:12" number of hours to set a repeat of broadcast
 * "I:"Add Info"" Additional info to print out
 * "O:true" Overrides all other broadcasts in timeslot
 *
 * Schedule parts must be comma separated,
 * Schedule blocks must be semicolon separated.
 */
export default class BroadcastSchema {
  // path & filename of xlsx-schema file
  schemaFile: string;
  // Weekday names are required in first row of xlsx schema file
  weekdayColNames: string[] = [];
  // mapped internally
  weekdayColIds: number[] = [];

  constructor(props: BroadcastSchemaProps) {
    this.schemaFile = props.schemaFile;
    this.weekdayColNames =
      props.weekdayColNames !== undefined
        ? props.weekdayColNames
        : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

    this.getBroadcasts();
  }

  getBroadcasts = (): Broadcast[] => {
    const schema = dataFromXlsx(this.schemaFile);
    return this.parseWorksheet(schema);
  };

  parseWorksheet(worksheet: string[][]): Broadcast[] {
    const broadcasts: Broadcast[] = [];
    this.setWeekdayColIds(worksheet[0]);

    worksheet
      .filter((row, r) => r > 0)
      .forEach((cols) => {
        if (cols.length > 1) {
          broadcasts.push({
            name: cols[0],
            info: cols.filter(
              (cell, colId) => colId > 0 && !this.weekdayColIds.includes(colId)
            ),
            schedules: this.getSchedules(cols, cols[0]),
          });
        }
      });

    return broadcasts;
  }

  setWeekdayColIds(header: string[]) {
    const colIds = [];
    this.weekdayColNames.forEach((weekdayName) => {
      if (!header.indexOf(weekdayName)) {
        throw "Can't find required weekday in xlsx row 1: " + weekdayName;
      }
      colIds.push(header.indexOf(weekdayName));
    });
    this.weekdayColIds = colIds;
  }

  getSchedules(cols: string[], name: string): Schedule[] {
    const schedules = <Schedule[]>[];
    this.weekdayColIds.forEach((c, weekday) => {
      if (cols[c] && cols[c].trim().length) {
        schedules.push(...this.parseCellJson(cols[c], weekday + 1, name));
      }
    });
    return schedules;
  }

  parseCellJson(cell: string, weekday: number, name: string): Schedule[] {
    const blocks = cell
      .split(";")
      .map((block: string) => replaceRangeArrays(block))
      .map((block: string) => parseJsonBlock(block))
      .map((block: Schedule) => {
        block.name = name;
        block.weekday = weekday;
        return block;
      });
    return blocks;
  }
}
