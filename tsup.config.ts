import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  dts: false,
  splitting: true,
  clean: true,
  target: "es2022",
  format: ["esm"],

  // Perhaps enable later?
  // "minify": true,
  // "sourcemap": true,
});
