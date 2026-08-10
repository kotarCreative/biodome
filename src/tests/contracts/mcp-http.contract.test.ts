import { createMcpApplication, type McpApplicationDependencies } from "../../mcp/application.js";
import { decodeMcpPlan } from "../../mcp/plan.js";
import type { VolumeAdapter } from "../../mcp/volumes/adapter.js";
import { mcpHttpContract } from "./lib/mcp-http.js";

const adapter: VolumeAdapter = {
  list: async () => ({ files: [] }),
  read: async () => Buffer.alloc(0),
  write: async () => {},
  stat: async (path) => ({ name: path, path, isDirectory: false }),
};

const dependencies: McpApplicationDependencies = {
  volumeAdapters: { create: async () => adapter },
  providers: {
    listCatalog: async () => [],
    describe: async () => {
      throw new Error("not used");
    },
    call: async () => ({}),
    getErrors: () => [],
    close: async () => {},
  },
  processRunner: {
    exec: async () => ({ stdout: "", stderr: "" }),
    execFile: async () => ({ stdout: "", stderr: "" }),
  },
  probeService: async () => true,
  events: { write: async () => {} },
  uuid: () => "contract-session",
  now: () => new Date(0),
};

mcpHttpContract("built-in", () =>
  createMcpApplication(
    decodeMcpPlan({
      project: "contract",
      languages: [],
      services: [],
      processes: [],
      endpoints: [],
      providers: [],
      environment: {},
      envVars: [],
      repos: [],
      volumes: [],
      mcp: {
        token: "contract-token",
        allowExec: false,
        allowProcessControl: false,
        maxReadBytes: 1024,
        maxWriteBytes: 1024,
        maxListEntries: 10,
      },
    }),
    dependencies,
  ),
);
