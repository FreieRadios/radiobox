import { dataFromXlsx } from "./helper/files";
import { Broadcast, BroadcastSchemaProps, Schedule, TimeSlot } from "./types";
import { DateTime } from "luxon";
import { vd } from "./helper/helper";

/*
 * Class to read a schema xlsx-file
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
  // name of the station for info & titles
  stationName: string;
  // Weekday names are required in first row of xlsx schema file
  weekdayColNames: string[] = [];
  // mapped internally
  weekdayColIds: number[] = [];

  constructor(props: BroadcastSchemaProps) {
    this.schemaFile = props.schemaFile;
    this.stationName = props.stationName;
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
          const broadcast = this.broadcastFactory(cols);
          broadcasts.push(broadcast);
        }
      });

    return broadcasts;
  }

  broadcastFactory(cols: string[]): Broadcast {
    const broadcast = {
      name: cols[0],
      info: cols.filter(
        (cell, colId) => colId > 0 && !this.weekdayColIds.includes(colId)
      ),
      schedules: this.getSchedules(cols, cols[0]),
      getTitle: (slot?: TimeSlot, schema?: string[], glue?: string) => {
        glue = glue || " - ";
        return this.getTitle(broadcast, slot, schema)
          .filter((part) => part?.length > 0)
          .join(glue);
      },
    };
    return broadcast;
  }

  getTitle = (broadcast: Broadcast, slot?: TimeSlot, schema?: string[]) => {
    const parts = [];
    schema = schema || ["name", "startEndTime", "info_0"];
    schema.forEach((schemaKey) => {
      let part = "";
      switch (schemaKey) {
        case "name":
          part = broadcast.name;
          break;
        case "startTime":
          part = slot?.start.toLocaleString(DateTime.TIME_24_SIMPLE);
          break;
        case "startEndTime":
          part =
            slot?.start.toLocaleString(DateTime.TIME_24_SIMPLE) +
            "-" +
            slot?.end.toLocaleString(DateTime.TIME_24_SIMPLE);
          break;
        case "endTime":
          part = slot?.end.toLocaleString(DateTime.TIME_24_SIMPLE);
          break;
        case "startDate":
          part = slot?.start.toLocaleString(DateTime.DATE_SHORT);
          break;
        case "endDate":
          part = slot?.end.toLocaleString(DateTime.DATE_SHORT);
          break;
        case "date":
          part = slot?.start.toFormat("yyyy-MM-dd");
          break;
        case "info_0":
          part = broadcast.info[0];
          break;
        case "info_1":
          part = broadcast.info[1];
          break;
        case "info_2":
          part = broadcast.info[2];
          break;
        case "station":
          part = this.stationName;
          break;
        default:
          part = schemaKey;
          break;
      }
      parts.push(part);
    });

    return parts;
  };

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
        try {
          const schedule = this.parseCellJson(cols[c], weekday + 1, name);
          schedules.push(...schedule);
        } catch (e) {
          console.error(`Could not parse schedule at "${name}": ${cols[c]}`);
        }
      }
    });
    return schedules;
  }

  parseCellJson(cell: string, weekday: number, name: string): Schedule[] {
    const blocks = cell
      .split(";")
      .map((block: string) => this.replaceRangeArrays(block))
      .map((block: string) => this.parseJsonBlock(block))
      .map((block: Schedule) => {
        block.name = name;
        block.weekday = weekday;
        return block;
      });
    return blocks;
  }

  replaceRangeArrays = (block: string) => {
    return block
      .replace("[1-12]", "[1,2,3,4,5,6,7,8,9,10,11,12]")
      .replace("[1-5]", "[1,2,3,4,5]")
      .replace("M:", '"monthsOfYear": ')
      .replace("D:", '"nthWeekdaysOfMonth": ')
      .replace("H:", '"hoursOfDay": ')
      .replace("R:", '"repeatOffset": ')
      .replace("I:", '"info": ')
      .replace("O:", '"overrides": ');
  };

  parseJsonBlock = (block: string) => {
    let json = {};
    try {
      json = JSON.parse("{" + block + "}");
    } catch (e) {
      throw "JSON parse error";
    }
    return json as Schedule;
  };
}
