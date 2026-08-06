#!/usr/bin/env node
/**
 * Run the implementation-side public-export content gate when its private manifest is present.
 *
 * The generated public repository intentionally excludes the exporter, its manifest, and the
 * private marker table. `pnpm test` still needs to be self-contained there, so this small public
 * wrapper makes the boundary explicit: implementation checkouts run the strict gate; an already
 * generated public tree reports that publication scanning is not applicable instead of importing a
 * file that does not ship.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = resolve(repoRoot, "scripts", "public-export-manifest.json");

if (!existsSync(manifestPath)) {
  console.log(JSON.stringify({
    ok: true,
    gate: "publication-content",
    status: "not_applicable",
    reason: "This is an already-generated public tree; implementation-side export policy is not included."
  }, null, 2));
  process.exit(0);
}

await import("./docs-boundary-gate.mjs");
await import("./export-content-gate.mjs");
