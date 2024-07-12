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
