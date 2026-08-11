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
          "--allow-other",
          "--vfs-cache-mode",
          "writes",
          "--read-only",
        ],
        environment: {
          RCLONE_S3_ACCESS_KEY_ID: "${AWS_ACCESS_KEY_ID}",
          RCLONE_S3_SECRET_ACCESS_KEY: "${AWS_SECRET_ACCESS_KEY}",
        },
      },
    ]);
    expect(plan.runtime.volumes[0].readOnly).toBe(true);
  });

  it("derives provider-specific rclone settings", () => {
    const { builder, processes } = makeBuilder();

    builder.addAzure({
      name: "backups",
      account: "storage-account",
      container: "backups",
      path: "daily/",
      target: "/workspace/backups",
      credentials: { accountKey: { env: "AZURE_KEY" } },
    });
    builder.addWebdav({
      name: "documents",
      url: "https://cloud.example.test/dav",
      vendor: "nextcloud",
      target: "/workspace/documents",
      credentials: { password: { env: "WEBDAV_PASSWORD" } },
    });

    expect(processes).toContainEqual({
      name: "rclone-mount-backups",
      command: [
        "rclone",
        "mount",
        "azure:backups/daily/",
        "/workspace/backups",
        "--allow-other",
        "--vfs-cache-mode",
        "writes",
      ],
      environment: {
        RCLONE_AZURE_ACCOUNT: "storage-account",
        RCLONE_AZURE_KEY: "${AZURE_KEY}",
      },
    });
    expect(processes).toContainEqual({
      name: "rclone-mount-documents",
      command: [
        "rclone",
        "mount",
        "webdav:",
        "/workspace/documents",
        "--allow-other",
        "--vfs-cache-mode",
        "writes",
      ],
      environment: {
        RCLONE_WEBDAV_URL: "https://cloud.example.test/dav",
        RCLONE_WEBDAV_VENDOR: "nextcloud",
        RCLONE_WEBDAV_PASS: "${WEBDAV_PASSWORD}",
      },
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
      credentials: { clientId: undefined, token: { env: "GDRIVE_TOKEN" } },
    });

    expect(plan.runtime.volumes[0].credentials).toEqual({ token: { env: "GDRIVE_TOKEN" } });
  });
});
