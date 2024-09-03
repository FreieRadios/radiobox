import { isLastOfMonth, nthOfMonth, timeFormats, vd } from "./helper/helper";
import { DateTime } from "luxon";
import {
  Broadcast,
  BroadcastScheduleProps,
  DateTimeInput,
  Schedule,
  TimeGrid,
  TimeGridError,
  TimeSlot,
} from "./types";
import BroadcastSchema from "./broadcast-schema";
import { toDateTime } from "./helper/date-time";
import * as process from "node:process";

/*
 * Class to build a schedule schema
 */
export default class BroadcastSchedule {
  // First day of Calendar export
  dateStart: DateTime;
  // Last day of Calendar export
  dateEnd: DateTime;
  // Location of the .xlsx schema file
  schema: BroadcastSchema;
  // Weekday names are required in first row of xlsx schema file
  weekdayColNames: string[] = [];
  // Required to calculate repeats on first day of grid;
  // The prepended day will be sliced before return
  repeatPadding: number;
  // Maximum number of timeslots for the result grid
  maxGridLength: number;
  // Number of minutes to define the default lenght of a time slot
  // in Minutes
  gridSize: number;
  repeatShort: string;
  repeatLong: string;
  outDir: string;
  locale: string;
  strings: BroadcastScheduleProps["strings"];
  _grid: TimeGrid;

  constructor(props: BroadcastScheduleProps) {
    this.schema = props.schema;
    this.weekdayColNames = this.schema.weekdayColNames;

    this.repeatPadding =
      props.repeatPadding !== undefined ? props.repeatPadding : 1;
    this.dateStart = toDateTime(props.dateStart, true);
    this.dateEnd = toDateTime(props.dateEnd, true);
    this.gridSize = 60;
    this.maxGridLength = 10000;

    this.locale = props.locale || "de";
    this.repeatShort = props.repeatShort || "(rep.)";
    this.repeatLong = props.repeatLong || "Repeat";
    this.strings = props.strings || {
      each: "Each",
      last: "last",
      and: "and",
      monthly: "of month",
      always: "always",
      from: "from",
      oclock: "O'clock",
    };

    this._grid = [];
    this.setGrid();
  }

  /*
   * Initial function to create an empty time grid and match
   * fitting broadcasts by schema definition.
   */
  setGrid = () => {
    const broadcasts = this.schema.getBroadcasts();

    const emptyGrid = this.getTimeGrid();
    const timeGrid = this.matchBroadcasts(broadcasts, emptyGrid);

    this.addRepeats(timeGrid);
    this.trimGrid(timeGrid);
  };

  getGrid() {
    return this._grid;
  }

  getTimeGrid(): TimeGrid {
    const grid = <TimeGrid>[];
    let current = this.dateStart.minus({
      days: this.repeatPadding,
    });
    const dateEnd = this.dateEnd.plus({ days: this.repeatPadding });

    for (let i = 0; i <= this.maxGridLength; i++) {
      const end = current.plus({ minutes: this.gridSize });
      grid.push({
        start: current,
        end: end,
        duration: 1,
        nOfmax: 1,
        matches: [],
      });
      current = end;
      if (current >= dateEnd) {
        return grid;
      }
    }

    return grid;
  }

  matchBroadcasts = (broadcasts: Broadcast[], timeGrid: TimeGrid) => {
    timeGrid.forEach((timeSlot) => {
      broadcasts.forEach((broadcast) => {
        const match = this.findScheduledBroadcast(
          broadcast.schedules,
          timeSlot.start
        );
        if (match) {
          if (this.pushMatches(timeSlot, match, false)) {
            timeSlot.broadcast = broadcast;
          }
        }
      });
    });
    return timeGrid;
  };

  pushMatches(slot: TimeSlot, schedule: Schedule, isRepeat: boolean) {
    if (schedule.overrides) {
      slot.matches = [];
    } else if (slot.matches.find((match) => match.overrides)) {
      return;
    }
    slot.matches.push(this.scheduleFactory(schedule, isRepeat));
    return true;
  }

  scheduleFactory(schedule: Schedule, isRepeat: boolean): Schedule {
    return {
      ...schedule,
      isRepeat,
    };
  }

  findScheduledBroadcast(schedules: Schedule[], timeSlot: DateTime) {
    return schedules.find(
      (schedule) =>
        schedule.monthsOfYear.includes(timeSlot.month) &&
        schedule.weekday === timeSlot.weekday &&
        schedule.hoursOfDay.includes(timeSlot.hour) &&
        this.checkNthOfMonth(timeSlot, schedule.nthWeekdaysOfMonth)
    );
  }

  checkNthOfMonth(timeSlot: DateTime, nthWeekdays: number[]) {
    const matches = [];
    if (nthWeekdays.includes(-1)) {
      matches.push(isLastOfMonth(timeSlot));
    }
    if (nthWeekdays.filter((nth) => nth > 0).length > 0) {
      matches.push(nthWeekdays.includes(nthOfMonth(timeSlot)));
    }
    return !matches.includes(false);
  }

  addRepeats = (timeGrid: TimeGrid) => {
    timeGrid.forEach((timeSlot) => {
      timeSlot.matches
        .filter((schedule) => schedule.isRepeat === false)
        .forEach((schedule) => {
          const repeatTarget = timeSlot.start
            .plus({
              hours: schedule.repeatOffset,
            })
            .toUnixInteger();
          const targetSlot = timeGrid.find(
            (existingSlot) =>
              existingSlot.start.toUnixInteger() === repeatTarget
          );
          if (repeatTarget && targetSlot) {
            if (this.pushMatches(targetSlot, schedule, true)) {
              targetSlot.broadcast = timeSlot.broadcast;
            }
          }
        });
    });
    return timeGrid;
  };

  /*
   * This is required to remove repeat padding.
   */
  trimGrid(timeGrid: TimeGrid) {
    const lastSlotInPadding = this.dateStart;
    this._grid = timeGrid.filter((slot) => {
      return slot.start >= lastSlotInPadding && slot.end <= this.dateEnd;
    });
  }

  sliceGrid(dateStart: DateTimeInput, dateEnd: DateTimeInput) {
    const dateTimeStart = toDateTime(dateStart);
    const dateTimeEnd = toDateTime(dateEnd);
    this._grid = this._grid.filter((slot) => {
      return slot.start >= dateTimeStart && slot.end <= dateTimeEnd;
    });
  }

  /*
   * Merges two or more adjacent time slots if they contain the same
   * broadcasting; useful if broadcastings exceed time grid.
   */
  mergeSlots() {
    this._grid = this.mergeTimeSlots(this._grid);
    return this;
  }

  mergeTimeSlots(grid: TimeGrid) {
    this.setMergeInfo(true);
    return grid.filter((slot) => {
      return !slot.wasMerged;
    });
  }

  setMergeInfo(updateEnd?: boolean) {
    this._grid.forEach((slot, s) => {
      for (let sMin = s + 1; sMin < this._grid.length; sMin++) {
        if (!this._grid[sMin] || !this._grid[sMin].broadcast) {
          return;
        }
        if (this._grid[sMin].broadcast !== slot.broadcast) {
          return;
        } else {
          if (updateEnd) {
            slot.end = this._grid[sMin].end;
          }
          // TODO: calculate properly; find all repeats from here
          slot.duration++;
          slot.nOfmax = slot.duration;
          this._grid[sMin].wasMerged = true;
        }
      }
    });
    return this;
  }

  filter(callback: (slot: TimeSlot) => boolean) {
    this._grid = this._grid.filter((slot) => {
      return callback(slot);
    });
    return this;
  }

  findByDateStart(dateStart: DateTime) {
    return this._grid.find((slot) => {
      return slot.start <= dateStart && slot.end > dateStart;
    });
  }

  toArray() {
    return this._grid.map((slot) => {
      return {
        start: slot.start.toFormat(timeFormats.human),
        end: slot.end.toFormat(timeFormats.human),
        isRepeat: slot.matches[0].isRepeat,
        duration: slot.duration,
        name: slot.matches.map((map) => map.toString()).join(", "),
      };
    });
  }

  repeatInfoToString = (schedule: Schedule, slot: TimeSlot) => {
    const info = [
      this.repeatLong,
      " (",
      slot.start
        .minus({ hours: schedule.repeatOffset })
        .toFormat(process.env.REPEAT_DATE_FORMAT),
      ")",
    ];
    return info.join("");
  };

  scheduleInfoToString = (schedule: Schedule, slot: TimeSlot) => {
    const info = [];
    const weekdays = [];
    if (schedule.nthWeekdaysOfMonth.length < 5) {
      weekdays.push(this.strings.each + " ");
      schedule.nthWeekdaysOfMonth.forEach((weekday, i) => {
        if (weekday === -1) {
          weekdays.push(this.strings.last);
        } else {
          weekdays.push(String(weekday) + ".");
        }
        if (schedule.nthWeekdaysOfMonth[i + 1]) {
          if (schedule.nthWeekdaysOfMonth[i + 2]) {
            weekdays.push(", ");
          } else {
            weekdays.push(" " + this.strings.and + " ");
          }
        }
      });
      weekdays.push(" " + slot.start.weekdayLong + " " + this.strings.monthly);
    } else {
      weekdays.push(this.strings.always + " ");
      weekdays.push(slot.start.weekdayLong.toLowerCase() + "s");
    }
    info.push(weekdays.join(""));
    info.push(" " + this.strings.from + " ");
    info.push(
      slot.start.toLocaleString(DateTime.TIME_24_SIMPLE) +
        " " +
        this.strings.oclock
    );
    return info.join("");
  };

  checkIntegrity = (autofix?: boolean) => {
    const errors = <TimeGridError[]>[];
    const getTimeString = (slot: TimeSlot) => {
      return slot.start.setLocale("de").toLocaleString(DateTime.DATETIME_HUGE);
    };
    const grid = this.getGrid() as TimeGrid;
    grid.forEach((slot, s) => {
      if (slot.matches.length === 0) {
        errors.push({
          timeSlot: slot,
          reason: "No broadcasting matches " + getTimeString(slot),
        });
        if (autofix) {
          this.pushMatches(
            slot,
            {
              name: "TBA",
              info: "Unknown",
            } as any,
            false
          );
        }
      } else if (slot.matches.length > 1) {
        errors.push({
          timeSlot: slot,
          reason: "Multiple matches " + getTimeString(slot),
        });
        if (autofix) {
          slot.matches = [slot.matches[0]];
        }
      }
    });
    return errors;
  };
}
