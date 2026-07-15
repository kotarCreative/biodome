import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/tests/**/*.{test,spec}.ts"],
    exclude: ["src/tests/integration/**"],
  },
});
