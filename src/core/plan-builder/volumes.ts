import { Schema } from "effect";
import { type Plan, type SecretValue, type Volume, VolumeSpecSchema } from "../plan.js";
import type {
  AzureVolumeSpec,
  DropboxVolumeSpec,
  GcsVolumeSpec,
  GdriveVolumeSpec,
  LocalVolumeSpec,
  ProcessSpec,
  S3VolumeSpec,
  SftpVolumeSpec,
  SmbVolumeSpec,
  VolumeSpec,
  WebdavVolumeSpec,
} from "../feature.js";
import { ValidationError } from "../errors.js";

export class VolumeBuilder {
  constructor(
    private readonly plan: Plan,
    private readonly addAptPackage: (name: string) => void,
    private readonly addProcess: (spec: ProcessSpec) => void,
  ) {}

  add(spec: VolumeSpec): void {
    const validated = Schema.decodeSync(VolumeSpecSchema)(spec);

    if (this.plan.runtime.volumes.some((volume) => volume.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate volume name: ${validated.name}` });
    }

    const readOnly = validated.readOnly || validated.options?.readOnly === "true";
    const volume: Volume = {
      ...validated,
      readOnly,
      credentials: validated.credentials ? { ...validated.credentials } : undefined,
      options: validated.options ? { ...validated.options } : undefined,
      allowedPaths: validated.allowedPaths ? [...validated.allowedPaths] : undefined,
    };
    this.plan.runtime.volumes.push(volume);

    if (validated.proxy || validated.type === "local") return;

    this.addAptPackage("rclone");
    this.addAptPackage("fuse3");

    const command = [
      "rclone",
      "mount",
      this.rcloneRemote(volume),
      validated.target,
      "--allow-other",
      "--vfs-cache-mode",
      "writes",
    ];
    if (readOnly) command.push("--read-only");
    this.addProcess({
      name: `rclone-mount-${validated.name}`,
      command,
      environment: this.buildRcloneEnv(volume),
    });
  }

  addLocal(spec: LocalVolumeSpec): void {
    this.add({
      name: spec.name,
      type: "local",
      source: spec.source,
      target: spec.target,
      readOnly: spec.readOnly,
      allowedPaths: spec.allowedPaths,
    });
  }

  addS3(spec: S3VolumeSpec): void {
    this.add({
      name: spec.name,
      type: "s3",
      bucket: spec.bucket,
      prefix: spec.prefix,
      target: spec.target,
      credentials: this.normalizeCredentials(spec.credentials),
      proxy: spec.proxy,
      readOnly: spec.readOnly,
      allowedPaths: spec.allowedPaths,
    });
  }

  addGcs(spec: GcsVolumeSpec): void {
    this.add({
      name: spec.name,
      type: "gcs",
      bucket: spec.bucket,
      prefix: spec.prefix,
      target: spec.target,
      credentials: this.normalizeCredentials(spec.credentials),
      proxy: spec.proxy,
      readOnly: spec.readOnly,
      allowedPaths: spec.allowedPaths,
    });
  }

  addAzure(spec: AzureVolumeSpec): void {
    this.add({
      name: spec.name,
      type: "azure",
      account: spec.account,
      container: spec.container,
      path: spec.path,
      target: spec.target,
      credentials: this.normalizeCredentials(spec.credentials),
      proxy: spec.proxy,
      readOnly: spec.readOnly,
      allowedPaths: spec.allowedPaths,
    });
  }

  addSftp(spec: SftpVolumeSpec): void {
    this.add({
      name: spec.name,
      type: "sftp",
      host: spec.host,
      port: spec.port,
      path: spec.path,
      target: spec.target,
      credentials: this.normalizeCredentials(spec.credentials),
      proxy: spec.proxy,
      readOnly: spec.readOnly,
      allowedPaths: spec.allowedPaths,
    });
  }

  addSmb(spec: SmbVolumeSpec): void {
    this.add({
      name: spec.name,
      type: "smb",
      host: spec.host,
      share: spec.share,
      target: spec.target,
      credentials: this.normalizeCredentials(spec.credentials),
      proxy: spec.proxy,
      readOnly: spec.readOnly,
      allowedPaths: spec.allowedPaths,
    });
  }

  addWebdav(spec: WebdavVolumeSpec): void {
    this.add({
      name: spec.name,
      type: "webdav",
      url: spec.url,
      path: spec.path,
      target: spec.target,
      vendor: spec.vendor,
      credentials: spec.credentials ? this.normalizeCredentials(spec.credentials) : undefined,
      proxy: spec.proxy,
      readOnly: spec.readOnly,
      allowedPaths: spec.allowedPaths,
    });
  }

  addDropbox(spec: DropboxVolumeSpec): void {
    this.add({
      name: spec.name,
      type: "dropbox",
      path: spec.path,
      target: spec.target,
      credentials: this.normalizeCredentials(spec.credentials),
      proxy: spec.proxy,
      readOnly: spec.readOnly,
      allowedPaths: spec.allowedPaths,
    });
  }

  addGdrive(spec: GdriveVolumeSpec): void {
    this.add({
      name: spec.name,
      type: "gdrive",
      path: spec.path,
      target: spec.target,
      credentials: this.normalizeCredentials(spec.credentials),
      proxy: spec.proxy,
      readOnly: spec.readOnly,
      allowedPaths: spec.allowedPaths,
    });
  }

  private rcloneRemote(volume: Volume): string {
    switch (volume.type) {
      case "s3":
        return `s3:${volume.bucket}/${volume.prefix || ""}`;
      case "gcs":
        return `gcs:${volume.bucket}/${volume.prefix || ""}`;
      case "azure":
        return `azure:${volume.container}/${volume.path || ""}`;
      case "sftp":
        return `sftp:${volume.path}`;
      case "smb":
        return `smb:${volume.host}/${volume.share}`;
      case "webdav":
        return `webdav:${volume.path || ""}`;
      case "dropbox":
        return `dropbox:${volume.path}`;
      case "gdrive":
        return `drive:${volume.path}`;
      default:
        throw new ValidationError({
          message: `Unsupported volume type for rclone: ${volume.type}`,
        });
    }
  }

  private buildRcloneEnv(volume: Volume): Record<string, string> {
    const env: Record<string, string> = {};
    if (!volume.credentials) return env;

    const mappings: Record<string, Record<string, string>> = {
      s3: {
        accessKeyId: "RCLONE_S3_ACCESS_KEY_ID",
        secretAccessKey: "RCLONE_S3_SECRET_ACCESS_KEY",
        region: "RCLONE_S3_REGION",
        sessionToken: "RCLONE_S3_SESSION_TOKEN",
        endpoint: "RCLONE_S3_ENDPOINT",
      },
      gcs: {
        clientId: "RCLONE_GCS_CLIENT_ID",
        clientSecret: "RCLONE_GCS_CLIENT_SECRET",
        token: "RCLONE_GCS_TOKEN",
        serviceAccountFile: "RCLONE_GCS_SERVICE_ACCOUNT_FILE",
        projectNumber: "RCLONE_GCS_PROJECT_NUMBER",
      },
      azure: { accountKey: "RCLONE_AZURE_KEY", sasUrl: "RCLONE_AZURE_SAS_URL" },
      sftp: {
        user: "RCLONE_SFTP_USER",
        password: "RCLONE_SFTP_PASS",
        keyFile: "RCLONE_SFTP_KEY_FILE",
      },
      smb: { user: "RCLONE_SMB_USER", password: "RCLONE_SMB_PASS", domain: "RCLONE_SMB_DOMAIN" },
      webdav: {
        user: "RCLONE_WEBDAV_USER",
        password: "RCLONE_WEBDAV_PASS",
        bearerToken: "RCLONE_WEBDAV_BEARER_TOKEN",
      },
      dropbox: { token: "RCLONE_DROPBOX_TOKEN" },
      gdrive: {
        clientId: "RCLONE_DRIVE_CLIENT_ID",
        clientSecret: "RCLONE_DRIVE_CLIENT_SECRET",
        token: "RCLONE_DRIVE_TOKEN",
      },
    };

    if (volume.type === "sftp" && volume.host) {
      env.RCLONE_SFTP_HOST = volume.host;
      if (volume.port) env.RCLONE_SFTP_PORT = String(volume.port);
    }
    if (volume.type === "smb" && volume.host) env.RCLONE_SMB_HOST = volume.host;
    if (volume.type === "azure" && volume.account) env.RCLONE_AZURE_ACCOUNT = volume.account;
    if (volume.type === "webdav" && volume.url) {
      env.RCLONE_WEBDAV_URL = volume.url;
      if (volume.vendor) env.RCLONE_WEBDAV_VENDOR = volume.vendor;
    }

    const map = mappings[volume.type];
    for (const [key, value] of Object.entries(volume.credentials)) {
      const rcloneKey = map[key];
      if (rcloneKey) env[rcloneKey] = typeof value === "string" ? value : `\${${value.env}}`;
    }
    return env;
  }

  private normalizeCredentials(
    credentials: Record<string, SecretValue | undefined>,
  ): Record<string, SecretValue> {
    const result: Record<string, SecretValue> = {};
    for (const [key, value] of Object.entries(credentials)) {
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
}
