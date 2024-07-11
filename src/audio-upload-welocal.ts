import * as fs from "node:fs";
import axios from "axios";
import {
  AudioUploadProps,
  TimeSlot,
  UploadConfig,
  UploadFile,
  UploadLogEntry,
  UploadSlot,
} from "./types";
import BroadcastSchedule from "./broadcast-schedule";
import { fileExistsSync, writeJsonFile } from "./helper/files";
import { DateTime } from "luxon";
import crypto from "crypto";
import { vd } from "./helper/helper";

export default class AudioUploadWelocal {
  token: string;
  baseUrl = "https://radio-z.prod.welocal.cloud/cmms-api/v3.0";
  prepareUploadRoute = "/media/upload/prepare/";
  finalizeUploadRoute = "/media/upload/finalize/";
  setMediaStatusRoute = "/media/status/set/:public_media_id/";
  setPostStatusRoute = "/post/status/set/:post_id/";
  encodeRoute = "/media/encode/:kind/:post_id/";

  uploadFilePath: string;
  config: UploadConfig;
  schedule: BroadcastSchedule;
  logs: UploadLogEntry[];
  logPath = "logs";
  logFile: string;
  filePrefix: string;
  fileSuffix: string;

  constructor(props: AudioUploadProps) {
    this.schedule = props.schedule;
    this.uploadFilePath = props.uploadFilePath;
    this.filePrefix = props.filePrefix;
    this.fileSuffix = props.fileSuffix || ".mp3";
    this.config = {
      headers: {
        "X-CMMS-API-AUTH-KEY": props.token,
      },
    };

    this.logFile = props.logFile;
    this.logs = [];
    this.linkLogfile();
  }

  linkLogfile() {
    const logFilePath = this.logPath + "/" + this.logFile + ".json";
    if (fileExistsSync(logFilePath)) {
      try {
        this.logs = JSON.parse(fs.readFileSync(logFilePath).toString());
      } catch {
        fs.copyFileSync(
          logFilePath,
          logFilePath + ".corrupted-" + crypto.randomUUID()
        );
        console.error("Can\t read logfile.");
      }
    } else {
      writeJsonFile(this.logPath, this.logFile, []);
    }
  }

  updateLogs() {
    writeJsonFile(this.logPath, this.logFile, this.logs);
  }

  getTargetStartDateTimeString(slot: TimeSlot) {
    return (
      this.uploadFilePath +
      ([
        this.filePrefix,
        slot.start.toISODate({ format: "basic" }),
        slot.start.setLocale("de").toFormat("HHmmss"),
      ].join("-") +
        this.fileSuffix)
    );
  }

  async uploadNewFiles() {
    const files = this.getFileList();
    for (const file of files) {
      const uploadSlot = await this.prepareUpload(
        file.targetName,
        file.postTitle,
        file.uploadCategories
      );
      console.log("Upload started: " + file.sourceFile);
      await this.upload(file.sourceFile, uploadSlot)
        .then((response) => {
          console.log("Upload finished: " + file.sourceFile);
          this.logs.push({
            sourceFile: file.sourceFile,
            targetFile: file.targetName,
            postTitle: file.postTitle,
            broadcastName: file.broadcast.name,
            uploadDateTime: response.headers?.date,
            broadcastDateTime: file.slot.start.toString(),
            mediaId: uploadSlot.mediaId,
          });
          this.updateLogs();
        })
        .catch((e) => {
          console.error(e);
        });
    }
  }

  getFileList() {
    const grid = this.schedule.getGrid();
    const uploadFiles = <UploadFile[]>[];
    for (const slot of grid) {
      const sourceFile = this.getTargetStartDateTimeString(slot);
      const doUpload = this.checkUpload(sourceFile);
      if (doUpload) {
        uploadFiles.push({
          sourceFile: sourceFile,
          targetName: this.getTargetName(slot),
          postTitle: this.getPostTitle(slot),
          uploadCategories: [
            ...slot.broadcast.info[1].split(" "),
            slot.broadcast.name,
          ],
          broadcast: slot.broadcast,
          slot: slot,
        });
      }
    }
    return uploadFiles;
  }

  getPostTitle(slot: TimeSlot) {
    return [
      slot.broadcast.name,
      slot.start.toLocaleString(DateTime.DATE_SHORT),
      slot.start.toLocaleString(DateTime.TIME_24_SIMPLE),
      slot.broadcast.info[0],
    ].join(" 🢒 ");
  }

  getTargetName(slot: TimeSlot) {
    return (
      (
        slot.broadcast.name +
        " am " +
        slot.start.toLocaleString(DateTime.DATE_SHORT) +
        " " +
        slot.start.toLocaleString(DateTime.TIME_24_SIMPLE)
      )
        .replaceAll("ä", "ae")
        .replaceAll("Ö", "Oe")
        .replaceAll("ö", "oe")
        .replaceAll("ü", "ue")
        .replaceAll("ß", "ss")
        .replaceAll("'", "-")
        .replaceAll(".", "-")
        .replaceAll(":", "-")
        .replaceAll("/", "-")
        .replaceAll(" ", "_")
        .replaceAll(",", "-")
        .replaceAll("+", "-")
        .replaceAll("!", "_")
        .replaceAll("&", "-") + ".mp3"
    );
  }

  checkUpload(sourceFile: string) {
    if (!fileExistsSync(sourceFile)) {
      return false;
    }
    if (this.logs.find((log) => log.sourceFile === sourceFile)) {
      console.log("Already uploaded: " + sourceFile);
      return false;
    }
    return true;
  }

  upload = async (sourceFile: string, uploadSlot: UploadSlot) => {
    await this.uploadFileToUrl(sourceFile, uploadSlot.uploadUrl).catch(
      (err) => {
        throw err.message;
      }
    );
    const finished = await this.finalizeUpload(uploadSlot.mediaId).catch(
      (err) => {
        throw err.message;
      }
    );
    return finished;
  };

  prepareUpload = async (
    targetFile: string,
    postTitle: string,
    uploadCategories: string[]
  ): Promise<UploadSlot> => {
    const postData = {
      file_name: targetFile,
      post_title: postTitle,
      post_status: "publish",
      metadata: {
        categories: uploadCategories,
      },
    };

    const response = await axios
      .post(this.baseUrl + this.prepareUploadRoute, postData, this.config)
      .catch((e) => {
        throw e;
      });

    if (!response.data.upload_url) {
      throw "Could not retrieve upload_url";
    }

    return {
      uploadUrl: response.data.upload_url,
      mediaId: response.data.media_id,
    };
  };

  uploadFileToUrl = async (sourceFile: string, uploadUrl: string) => {
    const file = fs.readFileSync(sourceFile, {});
    return axios({
      method: "put",
      url: uploadUrl, //API url
      data: file, // Buffer
      headers: {
        "Content-Type": "audio/mpeg",
        ...this.config.headers,
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
  };

  finalizeUpload = async (mediaId) => {
    console.log("Finalize " + mediaId);
    return axios.post(
      this.baseUrl + this.finalizeUploadRoute,
      {
        media_id: mediaId,
      },
      this.config
    );
  };

  updateMediaStatus = async (public_media_id: number) => {
    return axios.post(
      this.baseUrl +
        this.setMediaStatusRoute.replace(
          ":public_media_id",
          String(public_media_id)
        ),
      {
        status: "publish",
      },
      this.config
    );
  };

  updatePostStatus = async (post_id: number) => {
    return axios.post(
      this.baseUrl +
        this.setPostStatusRoute.replace(":post_id", String(post_id)),
      {
        status: "publish",
      },
      this.config
    );
  };

  encodePost = async (kind: string, post_id: number) => {
    return axios.get(
      this.baseUrl +
        this.encodeRoute
          .replace(":kind", kind)
          .replace(":post_id", String(post_id)),
      this.config
    );
  };
}
