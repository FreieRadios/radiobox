import { DateTime } from "luxon";
import BroadcastSchema from "./broadcast-schema";
import BroadcastSchedule from "./broadcast-schedule";

export type DateTimeInput = string | DateTime;

export type BroadcastRecorderProps = {
  schedule: BroadcastSchedule;
  // skip to record all scheduled
  dateStart?: DateTimeInput;
  // skip to record all scheduled
  dateEnd?: DateTimeInput;
  streamUrl: string;
  outDir?: string;
  filenamePrefix?: string;
  ignoreRepeats?: boolean;
};

export type BroadcastSchemaProps = {
  schemaFile: string;
  weekdayColNames?: string[];
};

export type BroadcastScheduleProps = {
  schema: BroadcastSchema;
  dateStart: DateTimeInput;
  dateEnd: DateTimeInput;
  locale?: string;
  repeatShort?: string;
  repeatLong?: string;
  repeatPadding?: number;
};

export type ScheduleExportProps = {
  schedule: BroadcastSchedule;
  mode: "welocal-json";
  outDir?: string;
  filenamePrefix?: string;
};

export type AudioUploadProps = {
  baseUrl: string;
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
  postTitle: string;
  uploadCategories: string[];
  broadcast: Broadcast;
  slot: TimeSlot;
};

export type UploadLogEntry = {
  sourceFile: string;
  targetFile: string;
  postTitle: string;
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
  // number of slots (1h default) after merging
  duration: number;
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

export type FilenamePattern = {
  mode: "DateTime" | "string" | "number";
  param: string | number;
};