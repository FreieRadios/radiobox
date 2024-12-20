import * as fs from "node:fs";
import axios from "axios";
import {
  AudioUploadProps,
  TimeSlot,
  UploadConfig,
  UploadFile,
  UploadLogEntry,
  UploadSlot,
} from "../types/types";
import BroadcastSchedule from "./broadcast-schedule";
import {
  fileExistsSync,
  getFilename,
  getPath,
  writeJsonFile,
} from "../helper/files";
import { DateTime } from "luxon";
import crypto from "crypto";
import { vd } from "../helper/helper";

export default class ApiConnectorWelocal {
  token: string;
  baseUrl: string;
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
    this.baseUrl = props.baseUrl;
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
    this.logPath = getPath(this.logPath);
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
        console.error("Can't read logfile.");
      }
    } else {
      writeJsonFile(this.logPath, this.logFile, []);
    }
  }

  updateLogs() {
    writeJsonFile(this.logPath, this.logFile, this.logs);
  }

  getTargetStartDateTimeString(slot: TimeSlot) {
    return getFilename(
      this.uploadFilePath,
      this.filePrefix,
      slot,
      this.fileSuffix
    );
  }

  async uploadNewFiles() {
    const files = this.getFileList();
    for (const file of files) {
      await this.upload(file);
    }
  }

  getFileList() {
    const grid = this.schedule.getGrid();
    const uploadFiles = <UploadFile[]>[];
    for (const slot of grid) {
      const sourceFile = this.getTargetStartDateTimeString(slot);
      const doUpload = this.checkUpload(sourceFile);
      if (doUpload) {
        uploadFiles.push(this.getUploadFileInfo(sourceFile, slot));
      }
    }
    return uploadFiles;
  }

  getUploadFileInfo(sourceFile: string, slot: TimeSlot): UploadFile {
    return {
      sourceFile: sourceFile,
      targetName: this.getTargetName(sourceFile),
      postTitle: this.getPostTitle(slot),
      postStatus: this.getPostStatus(slot),
      uploadCategories: [
        ...slot.broadcast.info[1].split(" "),
        slot.broadcast.name,
      ],
      broadcast: slot.broadcast,
      slot: slot,
    };
  }

  async upload(file: UploadFile) {
    const doUpload = this.checkUpload(file.sourceFile);
    if (!doUpload) {
      return;
    }

    const uploadSlot = await this.prepareUpload(
      file.targetName,
      file.postTitle,
      file.postStatus,
      file.uploadCategories
    );
    console.log("[welocal] Upload started: " + file.sourceFile);
    await this.doUpload(file.sourceFile, uploadSlot)
      .then((response) => {
        console.log("[welocal] Upload finished: " + file.sourceFile);
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

  getPostTitle(slot: TimeSlot) {
    const title = slot.broadcast.getTitle(slot);
    return title.replaceAll("&", "+");
  }

  getPostStatus(slot: TimeSlot) {
    if (slot.broadcast.info[2]?.length) {
      return "draft";
    }
    return "publish";
  }

  getTargetName(sourceFile: string) {
    return sourceFile.replaceAll(this.uploadFilePath, "");
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

  doUpload = async (sourceFile: string, uploadSlot: UploadSlot) => {
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
    postStatus: string,
    uploadCategories: string[]
  ): Promise<UploadSlot> => {
    const postData = {
      file_name: targetFile,
      post_title: postTitle,
      post_status: postStatus,
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
    console.log("[welocal] Finalize media id" + mediaId);
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
