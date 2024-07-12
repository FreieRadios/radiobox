import * as fs from "fs";
import nodeXlsx from "node-xlsx";
import { FilenamePattern, TimeSlot } from "../types";
import { DateTime } from "luxon";
import slugify from "slugify";
import { timeFormats } from "./helper";

export const dataFromXlsx = (
  file: string,
  worksheetId?: number
): string[][] => {
  if (!fileExistsSync(file)) {
    console.error(`Could not locate ${file}`);
    return [];
  }
  const fileContents = fs.readFileSync(file);
  const workSheetsFromBuffer = nodeXlsx.parse(fileContents);
  worksheetId = worksheetId || 0;
  const data = workSheetsFromBuffer[worksheetId]?.data as string[][];
  return data;
};

export function fileExistsSync(path: string): boolean {
  // If the file doesn't exist, avoid throwing an exception over the native barrier for every miss
  if (!fs.existsSync(path)) {
    return false;
  }
  try {
    const stats = fs.statSync(path);
    return stats.isFile();
  } catch (err) {
    // If error, assume file did not exist
    return false;
  }
}

export const writeJsonFile = (outDir, filename, data) => {
  fs.writeFile(
    `${outDir}/${filename}.json`,
    JSON.stringify(data, null, 2),
    (err) => {
      if (err) {
        return console.log(err);
      }
      console.log(`${outDir}/${filename}.json was saved!`);
    }
  );
};

export const getFilename = (
  uploadFilePath: string,
  filePrefix: string,
  slot: TimeSlot,
  fileSuffix: string
) => {
  return (
    uploadFilePath +
    ([
      filePrefix,
      slot.start.toFormat(timeFormats.machine),
      slugify(slot.broadcast.name.slice(0, 50)),
    ].join("-") +
      fileSuffix)
  );
};
