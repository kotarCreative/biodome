import { describe, expect, it } from "vitest";
import { createPlan } from "../../../core/plan.js";
import { VolumeBuilder } from "../../../core/plan-builder/volumes.js";

function makeBuilder() {
  const plan = createPlan("test");
  const packages: string[] = [];
  const processes: unknown[] = [];
  return {
    plan,
    packages,
    processes,
    builder: new VolumeBuilder(
      plan,
      (name) => packages.push(name),
      (spec) => processes.push(spec),
    ),
  };
}

describe("VolumeBuilder", () => {
  it("records local volumes without derived mount dependencies", () => {
    const { builder, packages, plan, processes } = makeBuilder();

    builder.add({
      name: "data",
      type: "local",
      source: "./data",
      target: "/workspace/data",
      allowedPaths: ["**/*.txt"],
    });

    expect(plan.runtime.volumes).toEqual([
      {
        name: "data",
        type: "local",
        source: "./data",
        target: "/workspace/data",
        readOnly: false,
        allowedPaths: ["**/*.txt"],
        credentials: undefined,
        options: undefined,
      },
    ]);
    expect(packages).toEqual([]);
    expect(processes).toEqual([]);
  });

  it("derives a read-only S3 rclone mount with credential references", () => {
    const { builder, packages, plan, processes } = makeBuilder();

    builder.add({
      name: "assets",
      type: "s3",
      bucket: "example-assets",
      prefix: "public/",
      target: "/workspace/assets",
      readOnly: true,
      directMount: true,
      credentials: {
        accessKeyId: { env: "AWS_ACCESS_KEY_ID" },
        secretAccessKey: { env: "AWS_SECRET_ACCESS_KEY" },
      },
    });

    expect(packages).toEqual(["rclone", "fuse3"]);
    expect(processes).toEqual([
      {
        name: "rclone-mount-assets",
        command: [
          "rclone",
          "mount",
          "s3:example-assets/public/",
          "/workspace/assets",
          "--vfs-cache-mode",
          "writes",
          "--read-only",
        ],
        environment: {
          RCLONE_S3_ACCESS_KEY_ID: "${AWS_ACCESS_KEY_ID}",
          RCLONE_S3_SECRET_ACCESS_KEY: "${AWS_SECRET_ACCESS_KEY}",
        },
        mergeEnv: false,
        identity: "mount",
      },
    ]);
    expect(plan.runtime.volumes[0].readOnly).toBe(true);
  });

  it("never passes --allow-other to rclone mounts", () => {
    const { builder, processes } = makeBuilder();

    builder.add({
      name: "assets",
      type: "s3",
      bucket: "example-assets",
      target: "/workspace/assets",
      directMount: true,
    });

    for (const process of processes as Array<{ command: string[] }>) {
      expect(process.command).not.toContain("--allow-other");
    }
  });

  it("rejects direct cloud mounts without explicit opt-in", () => {
    const { builder } = makeBuilder();

    expect(() =>
      builder.add({
        name: "assets",
        type: "s3",
        bucket: "example-assets",
        target: "/workspace/assets",
      }),
    ).toThrow(/directMount: true|unsafe mode/);
  });

  it("emits a deterministic residual-risk warning when direct mounts are enabled", () => {
    const { builder } = makeBuilder();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      builder.add({
        name: "assets",
        type: "s3",
        bucket: "example-assets",
        target: "/workspace/assets",
        directMount: true,
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toEqual([
      '[biodome] Direct FUSE mount "assets" requires SYS_ADMIN inside the dev container; ' +
        "this grants broad kernel access and is an explicitly unsafe opt-in.",
    ]);
  });

  it("derives provider-specific rclone settings", () => {
    const { builder, processes } = makeBuilder();

    builder.addAzure({
      name: "backups",
      account: "storage-account",
      container: "backups",
      path: "daily/",
      target: "/workspace/backups",
      directMount: true,
      credentials: { accountKey: { env: "AZURE_KEY" } },
    });
    builder.addWebdav({
      name: "documents",
      url: "https://cloud.example.test/dav",
      vendor: "nextcloud",
      target: "/workspace/documents",
      directMount: true,
      credentials: { password: { env: "WEBDAV_PASSWORD" } },
    });

    expect(processes).toContainEqual({
      name: "rclone-mount-backups",
      command: [
        "rclone",
        "mount",
        "azure:backups/daily/",
        "/workspace/backups",
        "--vfs-cache-mode",
        "writes",
      ],
      environment: {
        RCLONE_AZURE_ACCOUNT: "storage-account",
        RCLONE_AZURE_KEY: "${AZURE_KEY}",
      },
      mergeEnv: false,
      identity: "mount",
    });
    expect(processes).toContainEqual({
      name: "rclone-mount-documents",
      command: ["rclone", "mount", "webdav:", "/workspace/documents", "--vfs-cache-mode", "writes"],
      environment: {
        RCLONE_WEBDAV_URL: "https://cloud.example.test/dav",
        RCLONE_WEBDAV_VENDOR: "nextcloud",
        RCLONE_WEBDAV_PASS: "${WEBDAV_PASSWORD}",
      },
      mergeEnv: false,
      identity: "mount",
    });
  });

  it("keeps proxy volumes out of mount dependencies", () => {
    const { builder, packages, plan, processes } = makeBuilder();

    builder.addS3({
      name: "proxy-assets",
      bucket: "example-assets",
      target: "/workspace/assets",
      proxy: true,
      credentials: { secretAccessKey: { env: "AWS_SECRET_ACCESS_KEY" } },
    });

    expect(plan.runtime.volumes[0]).toMatchObject({ proxy: true });
    expect(packages).toEqual([]);
    expect(processes).toEqual([]);
  });

  it("contributes only proxy credential references to the MCP environment", () => {
    const { builder } = makeBuilder();
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      builder.addS3({
        name: "proxy-assets",
        bucket: "example-assets",
        target: "/workspace/assets",
        proxy: true,
        credentials: {
          accessKeyId: { env: "AWS_ACCESS_KEY_ID" },
        },
      });
      builder.addS3({
        name: "mounted-assets",
        bucket: "example-assets",
        target: "/workspace/mounted-assets",
        directMount: true,
        credentials: { secretAccessKey: { env: "MOUNT_SECRET" } },
      });
    } finally {
      console.warn = originalWarn;
    }

    const environment = builder.mcpCredentialEnvironment();
    expect(environment).toEqual({ AWS_ACCESS_KEY_ID: "${AWS_ACCESS_KEY_ID}" });
    environment.AWS_ACCESS_KEY_ID = "changed";
    expect(builder.mcpCredentialEnvironment()).toEqual({
      AWS_ACCESS_KEY_ID: "${AWS_ACCESS_KEY_ID}",
    });
  });

  it("rejects invalid and duplicate volume definitions", () => {
    const { builder } = makeBuilder();
    builder.addLocal({ name: "data", source: "./data", target: "/workspace/data" });

    expect(() =>
      builder.addLocal({ name: "data", source: "./other", target: "/workspace/other" }),
    ).toThrow(/Duplicate volume name/);
    expect(() =>
      builder.add({ name: "", type: "local", source: "./data", target: "/workspace/data" }),
    ).toThrow();
  });

  it("normalizes wrapper credentials by omitting undefined values", () => {
    const { builder, plan } = makeBuilder();

    builder.addGdrive({
      name: "drive",
      path: "/team",
      target: "/workspace/drive",
      directMount: true,
      credentials: { clientId: undefined, token: { env: "GDRIVE_TOKEN" } },
    });

    expect(plan.runtime.volumes[0].credentials).toEqual({ token: { env: "GDRIVE_TOKEN" } });
  });
});
