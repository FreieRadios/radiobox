import * as fs from "fs";
import nodeXlsx from "node-xlsx";
import { TimeSlot, UploadFile } from "../types/types";
import slugify from "slugify";
import { timeFormats } from "./helper";
import * as process from "node:process";
import path from 'path';

export const getPath = (file) => {
  if (process.env.RADIOBOX_BASEDIR) {
    return process.env.RADIOBOX_BASEDIR + "/" + file;
  }
  return file;
};

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

export const writeJsonFile = (
  outDir: string,
  filename: string,
  data: object
) => {
  writeFile(outDir, filename, JSON.stringify(data, null, 2), "json");
};

export const writeFile = (
  outDir: string,
  filename: string,
  data: string,
  ext: string
) => {
  fs.writeFile(`${outDir}/${filename}.${ext}`, data, (err) => {
    if (err) {
      return console.log(err);
    }
    console.log(`${outDir}/${filename}.${ext} has been saved!`);
  });
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

export const cleanupFile = (uploadFile: UploadFile) => {
  fs.unlink(uploadFile.sourceFile, (err) => {
    if (err) {
      console.error(err);
    } else {
      console.log("[autopilot] upload file was deleted.");
    }
  });
};

export const copyFile = (sourceFile: string, destinationPath: string) => {
  const sourceFileName = path.basename(sourceFile);
  const targetFilePath = path.join(getPath(destinationPath), sourceFileName);

  try {
    // Ensure repeat directory exists
    if (!fs.existsSync(destinationPath)) {
      fs.mkdirSync(destinationPath, { recursive: true });
      console.log(`[autopilot] Created repeat directory: ${destinationPath}`);
    }

    // Copy file to repeat directory
    fs.copyFileSync(sourceFile, targetFilePath);
    console.log(`[autopilot] Copied ${sourceFile} to ${targetFilePath}`);
  } catch (error) {
    console.error(`[autopilot] Error copying file to repeat directory:`, error);
  }
}
