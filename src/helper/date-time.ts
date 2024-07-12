import { DateTime } from "luxon";
import { DateTimeInput } from "../types";

export const toDateTime = (arg: DateTimeInput): DateTime => {
  return typeof arg === "string" ? DateTime.fromISO(arg) : arg;
};
