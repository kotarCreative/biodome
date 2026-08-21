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
  decodeCursor,
  encodeCursor,
  readBounded,
  rejectOversized,
  VolumeAccessError,
} from "./adapter.js";

// Endpoints must be plain HTTP(S) and must never point at link-local ranges
// where cloud metadata services live.
function validatedEndpoint(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new VolumeAccessError(`S3 endpoint must use http or https: ${redactEndpoint(endpoint)}`);
  }
  if (isDeniedHost(parsed.hostname)) {
    throw new VolumeAccessError(
      `S3 endpoint host is not allowed: ${redactEndpoint(parsed.hostname)}`,
    );
  }
  return endpoint;
}

function isDeniedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "metadata.google.internal" || host.endsWith(".internal")) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    return (
      (ipv4[1] === "169" && ipv4[2] === "254") || // link-local, incl. cloud metadata
      (ipv4[1] === "0" && ipv4[2] === "0") // this-network
    );
  }
  return host === "::1" || host.startsWith("fe80:");
}

function redactEndpoint(value: string): string {
  return value.replace(/(\/\/)[^@\s]+@/g, "$1***REDACTED***@");
}

export function createS3Adapter(config: VolumeConfig): VolumeAdapter {
  const credentials = resolveCredentials(config.credentials);
  const client = new S3Client({
    region: credentials.region || "us-east-1",
    endpoint: validatedEndpoint(credentials.endpoint),
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
    async list(path, options) {
      const full = fullPath(path);
      const scope = { kind: "s3", volumeName: config.name, path };
      const files: FileInfo[] = [];
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: full,
          Delimiter: "/",
          MaxKeys: options.limit,
          ContinuationToken: decodeCursor(options.cursor, scope),
        }),
      );

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

      return {
        files,
        nextCursor:
          response.IsTruncated && response.NextContinuationToken
            ? encodeCursor(response.NextContinuationToken, scope)
            : undefined,
      };
    },

    async read(path, options) {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: fullPath(path) }),
      );
      rejectOversized(head.ContentLength, options.maxBytes, path);
      const response = await client.send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: fullPath(path),
        }),
      );
      rejectOversized(response.ContentLength, options.maxBytes, path);
      return readBounded(
        response.Body as AsyncIterable<unknown> | undefined,
        options.maxBytes,
        path,
      );
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
