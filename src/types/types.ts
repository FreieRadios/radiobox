import { DateTime } from "luxon";
import BroadcastSchema from "../classes/broadcast-schema";
import BroadcastSchedule from "../classes/broadcast-schedule";
import BroadcastRecorder from "../classes/broadcast-recorder";

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
  delay?: number;
  bitrate?: number;
};

export type BroadcastRecorderEventListener = (
  outputFile: string,
  currentSlot: TimeSlot,
  startedAt: DateTime,
  seconds: number,
  parent: BroadcastRecorder
) => Promise<void>;
export type BroadcastRecorderEvents = {
  finished: BroadcastRecorderEventListener[];
};

export type BroadcastSchemaProps = {
  schemaFile: string;
  stationName?: string;
  weekdayColNames?: string[];
};

export type BroadcastArchiveProps = {
  inputFile: string;
  outDir: string;
  fallbackStrip: string;
  parserMapping: BroadcastArchiveMapping;
  skip: string[];
};

export type BroadcastArchiveRecord = {
  id: string | number;
  title: string;
  description: string;
  date: string;
  time: string;
  broadcast: string;
  category: string;
  url: string[];
  body: string[];
};

export type BroadcastArchiveMapping = {
  primaryId: string;
  url: string;
  title: string;
  description: string;
  body: string;
  date: string;
  time: string;
  broadcast: string;
  category: string;
  forename: string;
  surname: string;
};

export type BroadcastScheduleProps = {
  schema: BroadcastSchema;
  dateStart: DateTimeInput;
  dateEnd: DateTimeInput;
  locale?: string;
  repeatShort?: string;
  repeatLong?: string;
  repeatPadding?: number;
  strings?: {
    each: string;
    last: string;
    and: string;
    monthly: string;
    always: string;
    from: string;
    oclock: string;
  };
};

export type ScheduleExportProps = {
  schedule: BroadcastSchedule;
  mode: "welocal-json" | "txt";
  outDir?: string;
  filenamePrefix?: string;
  mp3Prefix?: string;
  mp3Path?: string;
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

export type AudioUploadNextcloudProps = {
  baseUrl: string;
  targetDirectory: string;
  username: string;
  password: string;
};

export type UploadConfig = {
  headers: Record<string, string>;
};

export type UploadFile = {
  sourceFile: string;
  targetName: string;
  postTitle: string;
  postStatus: "draft" | "publish";
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
  getTitle: (slot?: TimeSlot, schema?: string[], glue?: string) => string;
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
};

export type TimeSlot = {
  start: DateTime;
  end: DateTime;
  broadcast?: Broadcast;
  matches: Schedule[];
  wasMerged?: boolean;
  // number of slots (1h default) after merging
  duration: number;
  // slot count in duration (e.g. 1 of 2h means 'first hour of two hours')
  nOfmax: number;
  repeatFrom?: TimeSlot;
};

export type TimeGrid = TimeSlot[];

export type TimeGridError = {
  timeSlot: TimeSlot;
  reason: string;
};

export type TimeGridPlaylist = {
  filename: string;
  repeatFrom?: string;
}[];

export type TimeGridJsonWelocal = {
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
