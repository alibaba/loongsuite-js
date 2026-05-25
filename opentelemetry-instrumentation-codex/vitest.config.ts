import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "**/*.d.ts"],
      reporter: ["text", "html"],
      thresholds: {
        lines: 50,
        branches: 35,
        functions: 50,
        statements: 50,
      },
    },
  },
});
