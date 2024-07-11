import { DateTime } from "luxon";
import BroadcastSchema from "./broadcast-schema";
import BroadcastSchedule from "./broadcast-schedule";

export type BroadcastSchemaProps = {
  schemaFile: string;
  weekdayColNames?: string[];
};

export type BroadcastScheduleProps = {
  schema: BroadcastSchema;
  dateStart: string;
  dateEnd: string;
  locale?: string;
  repeatShort?: string;
  repeatLong?: string;
  repeatPadding?: number;
};

export type BroadcastExportProps = {
  schedule: BroadcastSchedule;
  mode: "welocal-json";
  outDir?: string;
  filenamePrefix?: string;
};

export type AudioUploadProps = {
  token: string;
  uploadFilePath: string;
  filePrefix: string;
  fileSuffix?: string;
  schedule: BroadcastSchedule;
  logFile: string;
};

export type UploadConfig = {
  headers: Record<string, string>;
};

export type UploadFile = {
  sourceFile: string;
  targetName: string;
  uploadCategories: string[];
  broadcast: Broadcast;
  slot: TimeSlot;
};

export type UploadLogEntry = {
  sourceFile: string;
  targetFile: string;
  broadcastName: string;
  uploadDateTime: string;
  broadcastDateTime: string;
  mediaId: string;
};

export type UploadSlot = {
  uploadUrl: string;
  mediaId: string;
};

export type Broadcast = {
  name: string;
  info: string[];
  schedules: Schedule[];
};

export type Schedule = {
  name: string;
  info?: string;
  overrides?: boolean;
  weekday: number;
  monthsOfYear: number[];
  nthWeekdaysOfMonth: number[];
  hoursOfDay: number[];
  repeatOffset: number;
  isRepeat: boolean;
  toString: () => string;
};

export type TimeSlot = {
  start: DateTime;
  end: DateTime;
  broadcast?: Broadcast;
  matches: Schedule[];
  wasMerged?: boolean;
};

export type TimeGrid = TimeSlot[];

export type TimeGridError = {
  timeSlot: TimeSlot;
  reason: string;
};

export type TimeGridJson = {
  day: string;
  block: string;
  start: string;
  end: string;
  short: string;
  long: string;
}[];
