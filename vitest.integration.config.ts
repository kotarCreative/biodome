import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // CLI fixtures and npm pack rebuild the same dist/ tree. Running files in
    // parallel lets one fixture import another fixture's half-written build.
    fileParallelism: false,
    include: [
      "src/tests/integration/**/*.{test,spec}.ts",
      "src/tests/package/**/*.{test,spec}.ts",
    ],
  },
});
