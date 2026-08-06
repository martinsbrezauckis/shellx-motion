/**
 * no-nul-bytes.mjs — repository source-hygiene gate.
 *
 * Asserts that no text source file in a SHIPPED tree contains a NUL (0x00) byte. A
 * NUL byte makes file(1) classify the source as binary `data` and makes ripgrep
 * treat it as a binary file, which silently breaks auditability, and can break
 * formatters, minifiers, scanners, source maps, and packaging tools. This gate
 * exists because packages/debug-server/workbench/markdown.js once used literal NUL
 * bytes as inline-parser placeholder delimiters; those were replaced with a
 * printable ASCII-escaped sentinel, and this check prevents any regression.
 *
 * SCOPE WAS packages/ ONLY, AND THAT HOLE WAS REAL . A digest separator
 * written as a raw NUL landed in scripts/build-public-export.mjs and this gate
 * passed, because it never looked there. git immediately classified the file as
 * binary — `git show` reported `Bin 5192 -> 8514 bytes` instead of a diff, and grep
 * silently matched nothing in it — so the release-critical export builder became
 * unreviewable in exactly the week it mattered most. It is now scanned across every
 * root the public export manifest ships, because a gate that inspects less than it
 * claims to govern reports health it never measured.
 *
 * Scope: only recognised TEXT source extensions are inspected, so genuinely binary
 * fixtures (PNG/MP4/etc.) that legitimately contain NUL bytes are never flagged.
 *
 * Wiring: run standalone via `pnpm run source-hygiene:check`, and as the first step
 * of the root `pnpm test` suite so CI fails fast on any reintroduced NUL byte.
 * Cheap and deterministic (no network, no build) — safe in any pipeline.
 *
 * Exit code: 0 when clean, 1 when any offender is found (paths printed to stderr).
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, extname, relative } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Roots to scan: every tree the public export manifest ships. Kept as a list rather than "the whole
 * repository" so working directories (artifacts/, .scratch/) and genuinely binary evidence are not
 * dragged in, and so adding a shipped tree is a deliberate one-line decision.
 */
const SCAN_ROOTS = ["packages", "scripts", "schemas", "skill", "docs", "templates", "fixtures"];

/** Text source extensions that must never contain a NUL byte. */
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".md", ".css", ".html", ".svg", ".txt", ".yml", ".yaml"
]);

/** Directories that hold build output, deps, or scratch — never source. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".turbo", ".git", ".scratch"]);

/** Recursively collect candidate text source files under `dir`. */
function collectTextFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...collectTextFiles(join(dir, entry.name)));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

const files = SCAN_ROOTS.flatMap((name) => collectTextFiles(join(root, name)));
const offenders = [];
for (const file of files) {
  // Read as raw bytes; a NUL anywhere in a text source is the failure condition.
  if (readFileSync(file).includes(0x00)) offenders.push(relative(root, file));
}

if (offenders.length > 0) {
  console.error(`NUL bytes found in ${offenders.length} text source file(s):`);
  for (const offender of offenders) console.error(`  ${offender}`);
  console.error("Text source must not contain NUL bytes (breaks file(1)/rg/formatters). See scripts/no-nul-bytes.mjs.");
  process.exitCode = 1;
} else {
  console.log(`PASS no-nul-bytes: ${files.length} text source files across ${SCAN_ROOTS.length} shipped root(s) contain no NUL bytes.`);
}
