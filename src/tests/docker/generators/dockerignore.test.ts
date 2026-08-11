import { describe, expect, it } from "vitest";
import { generateDockerignore } from "../../../docker/generators/dockerignore.js";

describe("generateDockerignore", () => {
  it("keeps target-scoped generated files in the Docker build context", () => {
    const dockerignore = generateDockerignore();

    expect(dockerignore).toContain("!.biodome-build/targets");
    expect(dockerignore).toContain("!.biodome-build/targets/**");
    expect(dockerignore).toContain(".biodome-build/targets/*/manifest.json");
    expect(dockerignore).toContain(".biodome-build/targets/*/state.json");
    expect(dockerignore).toContain(".biodome-build/targets/*/artifacts/");
    expect(dockerignore).toContain(".biodome-build/targets/*/logs/");
  });

  it("excludes .biodome but keeps supervisord.conf", () => {
    const dockerignore = generateDockerignore();
    expect(dockerignore).toContain(".biodome-build/*");
    expect(dockerignore).toContain("!.biodome-build/supervisord.conf");
    expect(dockerignore).not.toContain(".biodome-build\n");
  });
});
