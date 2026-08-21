import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "src/tests/integration/**/*.{test,spec}.ts",
      "src/tests/package/**/*.{test,spec}.ts",
    ],
  },
});
