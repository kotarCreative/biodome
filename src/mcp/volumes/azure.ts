import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import {
  VolumeAdapter,
  FileInfo,
  VolumeConfig,
  resolveCredentials,
  VolumeAccessError,
  decodeCursor,
  encodeCursor,
  readBounded,
  rejectOversized,
} from "./adapter.js";

export function createAzureAdapter(config: VolumeConfig): VolumeAdapter {
  const credentials = resolveCredentials(config.credentials);
  const account = config.account;
  if (!account) {
    throw new VolumeAccessError(`Azure volume ${config.name} requires an account`);
  }
  let client: BlobServiceClient;

  if (credentials.accountKey) {
    const sharedKeyCredential = new StorageSharedKeyCredential(account, credentials.accountKey);
    client = new BlobServiceClient(`https://${account}.blob.core.windows.net`, sharedKeyCredential);
  } else if (credentials.sasUrl) {
    client = new BlobServiceClient(credentials.sasUrl);
  } else {
    throw new VolumeAccessError(`Azure volume ${config.name} requires accountKey or sasUrl`);
  }

  if (!config.container) {
    throw new VolumeAccessError(`Azure volume ${config.name} requires a container`);
  }
  const containerClient = client.getContainerClient(config.container);
  const prefix = config.path || "";

  function fullPath(path: string): string {
    return prefix + path.replace(/^\/+/, "");
  }

  function stripPrefix(key: string): string {
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  }

  return {
    async list(path, options) {
      const full = fullPath(path);
      const scope = { kind: "azure", volumeName: config.name, path };
      const result: FileInfo[] = [];
      const pages = containerClient.listBlobsByHierarchy("/", { prefix: full }).byPage({
        continuationToken: decodeCursor(options.cursor, scope),
        maxPageSize: options.limit,
      });
      const page = await pages.next();
      if (page.done || !page.value) return { files: result };
      for (const item of page.value.segment.blobItems ?? []) {
        const stripped = stripPrefix(item.name);
        if (stripped === path.replace(/^\/+/, "")) continue;
        result.push({
          name: stripped.split("/").pop() || stripped,
          path: stripped,
          size: item.properties.contentLength,
          lastModified: item.properties.lastModified,
          isDirectory: false,
        });
      }
      for (const item of page.value.segment.blobPrefixes ?? []) {
        const stripped = stripPrefix(item.name);
        result.push({
          name: stripped.split("/").pop() || stripped,
          path: stripped,
          isDirectory: true,
        });
      }
      return {
        files: result,
        nextCursor: page.value.continuationToken
          ? encodeCursor(page.value.continuationToken, scope)
          : undefined,
      };
    },

    async read(path, options) {
      const blobClient = containerClient.getBlobClient(fullPath(path));
      const properties = await blobClient.getProperties();
      rejectOversized(properties.contentLength, options.maxBytes, path);
      const download = await blobClient.download();
      rejectOversized(download.contentLength, options.maxBytes, path);
      return readBounded(download.readableStreamBody, options.maxBytes, path);
    },

    async write(path: string, content: Buffer): Promise<void> {
      const blockClient = containerClient.getBlockBlobClient(fullPath(path));
      await blockClient.uploadData(content);
    },

    async stat(path: string): Promise<FileInfo> {
      const blobClient = containerClient.getBlobClient(fullPath(path));
      const props = await blobClient.getProperties();
      return {
        name: path.split("/").pop() || path,
        path,
        size: props.contentLength,
        lastModified: props.lastModified,
        isDirectory: false,
      };
    },
  };
}
