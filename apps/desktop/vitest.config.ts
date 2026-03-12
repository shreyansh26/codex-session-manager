import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/test/**/*.test.ts", "src/test/**/*.test.tsx"],
    coverage: {
      enabled: false
    }
  }
});
