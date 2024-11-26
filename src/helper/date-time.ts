import { DateTime } from "luxon";
import { DateTimeInput } from "../types";

export const toDateTime = (arg: DateTimeInput, round?: boolean): DateTime => {
  const dateTime = typeof arg === "string" ? DateTime.fromISO(arg) : arg;
  if (round) {
    return dateTime
      .minus({ minutes: dateTime.minute })
      .minus({ seconds: dateTime.second });
  }
  return dateTime;
};

export const midnight = {
  hour: 0,
  minute: 0,
  second: 0,
  millisecond: 0,
};

export const getDateStartEnd = (
  startDay: string,
  startTime: string,
  hours: number
) => {
  const dataStartString = [startDay, "T", startTime].join("");
  const dateStart = DateTime.fromISO(dataStartString);
  const dateEnd = dateStart.plus({
    hours,
  });
  return { dateStart, dateEnd };
};
