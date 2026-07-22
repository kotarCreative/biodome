import { VolumeAdapter, VolumeConfig, VolumeAccessError } from "./adapter.js";
import { createS3Adapter } from "./s3.js";
import { createGcsAdapter } from "./gcs.js";
import { createAzureAdapter } from "./azure.js";

export * from "./adapter.js";

export function createVolumeAdapter(config: VolumeConfig): VolumeAdapter {
  switch (config.type) {
    case "s3":
      return createS3Adapter(config);
    case "gcs":
      return createGcsAdapter(config);
    case "azure":
      return createAzureAdapter(config);
    default:
      throw new VolumeAccessError(`Proxy volume type not yet implemented: ${config.type}`);
  }
}
