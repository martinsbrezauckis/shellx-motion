/**
 * No per-test timeout may sit BELOW its package's configured global.
 *
 * Role: the packages run vitest with `--testTimeout=45000` for one reason — a slower machine must not
 * be a failing one. A per-case ceiling below that silently defeats the policy for that case, and it
 * is invisible until someone runs the suite on slower hardware.
 *
 * It cost two Windows verification rounds during cross-host verification: `agent-runtime` capped two process-spawning
 * tests at 5000 ms and 2000 ms, and `connectors` capped a browser-render test at 15000 ms. All three
 * failed on wall-clock rather than on behaviour, and each looked like a product defect until the
 * assertion turned out to be a timeout. 105 such ceilings existed across 22 files.
 *
 * Raising a ceiling can never make a test wrong: it only changes how long vitest waits before giving
 * up. A test that asserts something times out does so against its OWN deadline (an adapter's
 * `timeoutMs`, an abort signal), not against vitest's.
 *
 * Usage: node scripts/test-timeout-floor-gate.mjs
 * Exit 0 when every per-test ceiling is at or above its package global; exit 1 listing each that is
 * not, with the file, line and value.
 */
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PACKAGES = join(REPO, "packages");

/** The `--testTimeout=<ms>` a package's test script sets, or null when it sets none. */
async function packageGlobalTimeout(packageDir) {
  const manifestPath = join(packageDir, "package.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const script = manifest.scripts?.test;
  if (typeof script !== "string") return null;
  const match = /--testTimeout[= ](\d+)/.exec(script);
  return match ? Number(match[1]) : null;
}

const violations = [];
let checkedFiles = 0;

for (const entry of await readdir(PACKAGES, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packageDir = join(PACKAGES, entry.name);
  const globalTimeout = await packageGlobalTimeout(packageDir);
  if (globalTimeout === null) continue;

  const srcDir = join(packageDir, "src");
  if (!existsSync(srcDir)) continue;
  for (const file of await readdir(srcDir, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith(".test.ts")) continue;
    const relativePath = `packages/${entry.name}/src/${file.name}`;
    const lines = (await readFile(join(srcDir, file.name), "utf8")).split("\n");
    checkedFiles += 1;
    lines.forEach((line, index) => {
      // The trailing-argument form vitest uses: `}, 30_000);` closing an it()/test().
      const match = /^\s*\}, ([0-9_]+)\);\s*$/.exec(line);
      if (!match) return;
      const value = Number(match[1].replace(/_/g, ""));
      if (value < globalTimeout) {
        violations.push({ path: relativePath, line: index + 1, value, globalTimeout });
      }
    });
  }
}

if (violations.length === 0) {
  console.log(JSON.stringify({ ok: true, gate: "test-timeout-floor", checkedFiles }, null, 2));
  process.exit(0);
}

console.error(`${violations.length} per-test timeout(s) below their package global:`);
for (const violation of violations) {
  console.error(`  ${violation.path}:${violation.line}  ${violation.value} < ${violation.globalTimeout}`);
}
console.error(
  "\nThe package global exists so a slower machine is not a failing one. Raise these to the global, or\n" +
  "raise the global. Asserting that something times out is done against that thing's own deadline, not\n" +
  "against vitest's."
);
process.exit(1);
