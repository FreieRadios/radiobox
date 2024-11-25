import * as fs from "node:fs";
import axios from "axios";
import { AudioUploadNextcloudProps, UploadConfig, UploadFile } from "./types";
import path from "node:path";

export default class ApiConnectorNextcloud {
  baseUrl: string;
  config: UploadConfig;
  username: string;
  targetDirectory: string;
  password: string;

  nextcloudUrlPart: string = "remote.php/dav/files";

  constructor(props: AudioUploadNextcloudProps) {
    this.baseUrl = props.baseUrl;
    this.config = {
      headers: {},
    };
    this.username = props.username;
    this.password = props.password;
    this.targetDirectory = props.targetDirectory;
  }

  async upload(file: UploadFile) {
    console.log("[nextcloud] Upload started: " + file.sourceFile);

    await this.uploadToNextcloud(file.sourceFile)
      .then((response) => {
        console.log("[nextcloud] Upload finished: " + file.sourceFile);
      })
      .catch((e) => {
        console.error(e);
      });
  }

  async uploadToNextcloud(filePath: string) {
    const fileStream = fs.createReadStream(filePath);
    const fileName = path.basename(filePath);
    const uploadUrl = [
      this.baseUrl,
      this.nextcloudUrlPart,
      this.username,
      this.targetDirectory,
      fileName,
    ].join("/");

    return await axios.put(uploadUrl, fileStream, {
      headers: {
        "Content-Type": "application/octet-stream",
      },
      auth: {
        username: this.username,
        password: this.password,
      },
    });
  }
}
