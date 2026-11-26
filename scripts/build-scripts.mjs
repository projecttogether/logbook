// Bundles the worker, the operational scripts, and the operator command
// (`cli`) into dist/ with esbuild. The Docker image runs them with plain
// `node`, next to the Next.js standalone server.
import { build } from "esbuild";

await build({
  entryPoints: {
    worker: "src/workers/main.ts",
    "worker-healthcheck": "src/workers/healthcheck.ts",
    migrate: "src/scripts/migrate.ts",
    "directory-sync": "src/scripts/directory-sync.ts",
    "import-entries": "src/scripts/import-entries.ts",
    cli: "src/cli/entry.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node26",
  format: "esm",
  sourcemap: true,
  tsconfig: "tsconfig.json",
  // Optional native binding of pg; never installed.
  external: ["pg-native"],
  // Bundled CommonJS dependencies call require().
  banner: {
    js: "import { createRequire as __logbookCreateRequire } from 'node:module'; const require = __logbookCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});
