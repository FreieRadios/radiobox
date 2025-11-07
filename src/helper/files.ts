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
  const finalPath = `${outDir}/${filename}.${ext}`;
  const tempPath = `${finalPath}.tmp`;

  fs.writeFile(tempPath, data, (err) => {
    if (err) {
      return console.log(err);
    }

    // Atomically rename the temp file to the final file
    fs.rename(tempPath, finalPath, (renameErr) => {
      if (renameErr) {
        console.log(renameErr);
        // Clean up temp file on error
        fs.unlink(tempPath, () => {});
        return;
      }
      console.log(`${finalPath} has been saved!`);
    });
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
  unlinkFile(uploadFile.sourceFile)
};

export const unlinkFile = (sourceFile: string) => {
  fs.unlink(sourceFile, (err) => {
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

export const moveFile = (sourceFile: string, destinationFile: string) => {
  try {
    // Get the destination directory
    const destinationDir = path.dirname(destinationFile);

    // Ensure destination directory exists
    if (!fs.existsSync(destinationDir)) {
      fs.mkdirSync(destinationDir, { recursive: true });
      console.log(`[autopilot] Created directory: ${destinationDir}`);
    }

    // Move the file (rename is atomic and works across directories on the same filesystem)
    fs.renameSync(sourceFile, destinationFile);
    console.log(`[autopilot] Moved ${sourceFile} to ${destinationFile}`);
  } catch (error) {
    console.error(`[autopilot] Error moving file from ${sourceFile} to ${destinationFile}:`, error);
    throw error;
  }
}

export const unlinkFilesByType = (directory: string, type: string) => {
  try {
    const dirPath = getPath(directory);

    if (!fs.existsSync(dirPath)) {
      console.log(`[autopilot] Directory does not exist: ${dirPath}`);
      return;
    }

    const files = fs.readdirSync(dirPath);
    const flacFiles = files.filter(file => path.extname(file).toLowerCase() === type);

    if (flacFiles.length === 0) {
      console.log(`[autopilot] No files found in ${dirPath}`);
      return;
    }

    flacFiles.forEach(file => {
      const filePath = path.join(dirPath, file);
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error(`[autopilot] Error deleting ${filePath}:`, err);
        } else {
          console.log(`[autopilot] Deleted file: ${filePath}`);
        }
      });
    });

    console.log(`[autopilot] Initiated deletion of ${flacFiles.length} files`);
  } catch (error) {
    console.error(`[autopilot] Error reading directory ${directory}:`, error);
  }
};
