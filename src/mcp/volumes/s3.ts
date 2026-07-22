import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import {
  VolumeAdapter,
  FileInfo,
  VolumeConfig,
  resolveCredentials,
  VolumeAccessError,
} from "./adapter.js";

export function createS3Adapter(config: VolumeConfig): VolumeAdapter {
  const credentials = resolveCredentials(config.credentials);
  const client = new S3Client({
    region: credentials.region || "us-east-1",
    endpoint: credentials.endpoint,
    credentials:
      credentials.accessKeyId && credentials.secretAccessKey
        ? {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            sessionToken: credentials.sessionToken,
          }
        : undefined,
    forcePathStyle: !!credentials.endpoint,
  });

  const prefix = config.prefix || "";

  function fullPath(path: string): string {
    return prefix + path.replace(/^\/+/, "");
  }

  function stripPrefix(key: string): string {
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  }

  return {
    async list(path: string): Promise<FileInfo[]> {
      const full = fullPath(path);
      const delimiter = "/";
      const files: FileInfo[] = [];
      let continuationToken: string | undefined;

      do {
        const command = new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: full,
          Delimiter: delimiter,
          ContinuationToken: continuationToken,
        });
        const response = await client.send(command);

        if (response.CommonPrefixes) {
          for (const cp of response.CommonPrefixes) {
            if (!cp.Prefix) continue;
            const stripped = stripPrefix(cp.Prefix);
            files.push({
              name: stripped.split("/").pop() || stripped,
              path: stripped,
              isDirectory: true,
            });
          }
        }

        if (response.Contents) {
          for (const obj of response.Contents) {
            if (!obj.Key) continue;
            const stripped = stripPrefix(obj.Key);
            if (stripped === path.replace(/^\/+/, "")) continue;
            files.push({
              name: stripped.split("/").pop() || stripped,
              path: stripped,
              size: obj.Size,
              lastModified: obj.LastModified,
              isDirectory: false,
            });
          }
        }

        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);

      return files;
    },

    async read(path: string): Promise<Buffer> {
      const command = new GetObjectCommand({
        Bucket: config.bucket,
        Key: fullPath(path),
      });
      const response = await client.send(command);
      const bytes = await response.Body?.transformToByteArray();
      if (!bytes) throw new VolumeAccessError(`Empty body for ${path}`);
      return Buffer.from(bytes);
    },

    async write(path: string, content: Buffer): Promise<void> {
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: fullPath(path),
        Body: content,
      });
      await client.send(command);
    },

    async stat(path: string): Promise<FileInfo> {
      const command = new HeadObjectCommand({
        Bucket: config.bucket,
        Key: fullPath(path),
      });
      const response = await client.send(command);
      return {
        name: path.split("/").pop() || path,
        path,
        size: response.ContentLength,
        lastModified: response.LastModified,
        isDirectory: false,
      };
    },
  };
}
