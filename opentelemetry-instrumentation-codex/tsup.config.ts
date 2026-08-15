import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
  target: "node18",
  shims: true,
  noExternal: ["@loongsuite/opentelemetry-util-genai"],
});
