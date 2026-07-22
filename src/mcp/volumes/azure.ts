import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import {
  VolumeAdapter,
  FileInfo,
  VolumeConfig,
  resolveCredentials,
  VolumeAccessError,
} from "./adapter.js";

export function createAzureAdapter(config: VolumeConfig): VolumeAdapter {
  const credentials = resolveCredentials(config.credentials);
  const account = config.account!;
  let client: BlobServiceClient;

  if (credentials.accountKey) {
    const sharedKeyCredential = new StorageSharedKeyCredential(account, credentials.accountKey);
    client = new BlobServiceClient(`https://${account}.blob.core.windows.net`, sharedKeyCredential);
  } else if (credentials.sasUrl) {
    client = new BlobServiceClient(credentials.sasUrl);
  } else {
    throw new VolumeAccessError(`Azure volume ${config.name} requires accountKey or sasUrl`);
  }

  const containerClient = client.getContainerClient(config.container!);
  const prefix = config.path || "";

  function fullPath(path: string): string {
    return prefix + path.replace(/^\/+/, "");
  }

  function stripPrefix(key: string): string {
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  }

  return {
    async list(path: string): Promise<FileInfo[]> {
      const full = fullPath(path);
      const result: FileInfo[] = [];

      for await (const item of containerClient.listBlobsByHierarchy("/", { prefix: full })) {
        if (item.kind === "prefix") {
          const stripped = stripPrefix(item.name);
          result.push({
            name: stripped.split("/").pop() || stripped,
            path: stripped,
            isDirectory: true,
          });
        } else {
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
      }

      return result;
    },

    async read(path: string): Promise<Buffer> {
      const blobClient = containerClient.getBlobClient(fullPath(path));
      const download = await blobClient.download();
      const chunks: Buffer[] = [];
      if (download.readableStreamBody) {
        for await (const chunk of download.readableStreamBody as AsyncIterable<Buffer>) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      }
      return Buffer.concat(chunks);
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
