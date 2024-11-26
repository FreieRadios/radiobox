import {
  BroadcastArchiveMapping,
  BroadcastArchiveProps,
  BroadcastArchiveRecord,
} from "../types/types";
import * as fs from "node:fs";
import { vd } from "../helper/helper";
import { DateTime } from "luxon";
import axios from "axios";
import { fileExistsSync } from "../helper/files";

/*
 * Import audio files from URL and combine with information
 */
export default class BroadcastArchive {
  inputFile: string;
  outDir: string;
  skip: string[];
  parserMapping: BroadcastArchiveMapping;
  single = [
    "title",
    "description",
    "date",
    "time",
    "broadcast",
    "category",
    "forename",
    "surname",
  ];
  multiple = ["body", "url"];
  importRecords: BroadcastArchiveRecord[] = [];
  fallbackStrip: string;

  constructor(props: BroadcastArchiveProps) {
    this.inputFile = props.inputFile;
    this.outDir = props.outDir;
    this.parserMapping = props.parserMapping;
    this.skip = props.skip;
    this.importRecords = [];
    this.fallbackStrip = props.fallbackStrip;
  }

  parseInputFile() {
    const json = fs.readFileSync(this.inputFile);
    const data = JSON.parse(json.toString());
    const importData: Record<string, BroadcastArchiveRecord> = {};

    data.forEach((item: any) => {
      const targetId = item[this.parserMapping.primaryId];
      const tmpData = importData[targetId] || ({} as BroadcastArchiveRecord);
      tmpData.id = targetId;

      this.single.forEach((key) => {
        if (item[this.parserMapping[key]]) {
          tmpData[key] = this.clearContents(item[this.parserMapping[key]]);
        }
      });

      this.multiple.forEach((key) => {
        tmpData[key] = tmpData[key] || [];
        const value = item[this.parserMapping[key]];
        if (value && !this.skip.includes(value)) {
          tmpData[key].push(this.clearContents(value));
        }
      });
      importData[targetId] = tmpData;
    });

    this.importRecords = Object.values(importData);

    return this;
  }

  async downloadFiles(from: DateTime, to: DateTime) {
    for (const record of Object.values(this.importRecords)) {
      const dateTime = DateTime.fromISO(record.date);
      if (dateTime >= from && dateTime <= to) {
        for (const url of record.url) {
          const info = url.split("/");
          const targetFile =
            this.outDir + "/" + record.id + "-" + info[info.length - 1];

          console.log(`[Archive] try to download ${url}`);
          await this.storeUrlToFile(url, targetFile).catch(async (error) => {
            console.error(`[Archive] error downloading ${url}`);
          });

          if (url.includes(this.fallbackStrip)) {
            const fallback = url.replace(this.fallbackStrip, "");
            await this.storeUrlToFile(fallback, targetFile).catch(
              async (error) => {
                console.error(`[Archive] error downloading fallback ${url}`);
              }
            );
          }
        }
      }
    }
  }

  async storeUrlToFile(url: string, outFile: string) {
    if (fileExistsSync(outFile)) {
      return;
    }

    await axios({
      url: url,
      method: "GET",
      responseType: "stream",
    })
      .then((response) => {
        response.data.pipe(fs.createWriteStream(outFile)).on("finish", () => {
          console.log(`[Archive] finished ${url}`);
        });
      })
      .catch((err) => {
        console.log(`[Archive] failed ${url}`);
      });
  }

  clearContents(cell: string): string {
    return cell.replaceAll("\n", "").replaceAll("\r", "").replaceAll("\t", "");
  }
}
