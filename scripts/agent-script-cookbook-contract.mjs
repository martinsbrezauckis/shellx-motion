#!/usr/bin/env node
/**
 * Keeps the agent-authored-script cookbook honest and mechanically usable.
 *
 * The document is a public, agent-facing capability reference. Its small JavaScript samples must
 * remain parseable on their own, and the taxonomy must not quietly drop a requested effect family
 * or turn planned engine primitives into an implied shipped API. This is intentionally a source
 * check, not an execution harness: rendered package proof belongs to each concrete package's
 * preview/final receipt.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const COOKBOOK = resolve(ROOT, "docs/public/agent-authored-scripts.md");
const SKILL_REFERENCE = resolve(ROOT, "skill/shellx-motion/references/agent-authored-scripts.md");
const cookbook = readFileSync(COOKBOOK, "utf8");
const skillReference = readFileSync(SKILL_REFERENCE, "utf8");
const failures = [];

const REQUIRED = [
  "Multiple sparks drawing lines",
  "Detailed light-drone animation / swarm rebuild",
  "Fireworks",
  "Sand / magnetic graphite",
  "Laser, engraving, and path reveal",
  "Pulsating countdown",
  "Endless tunnel in / out",
  "Factorial-type workflows",
  "Odds-board / reel-like effects",
  "Code rain",
  "Infinity paths and horizon fields",
  "Black hole / singularity / wormhole",
  "Galaxies, spiral arms, starfields, and twinkle",
  "Tree and leaf-vein skeleton growth",
  "Flowers opening and nature growth",
  "Sun and day/night cycles",
  "Lissajous, rose curves, spirals, hypotrochoids, and epicycles",
  "Superformula and calculated-result forms",
  "Strange attractors and complex-plane mappings",
  "Harmonic and interference waves",
  "Fractal / recursive forms and calculated growth",
  "Gravity and orbit",
  "Attraction / repulsion / magnetic charge",
  "Springs, constraints, and collision",
  "Turbulence, curl-like flow, advection",
  "Vortices, shockwaves, wave interference, field ripples",
  "Tractor beam",
  "Shield impact",
  "Energy arc",
  "Orbital debris",
  "Plasma core",
  "Teleport / disassembly",
  "Magnetic sand",
  "Drone formation"
];

for (const marker of REQUIRED) {
  if (!cookbook.includes(marker)) failures.push(`cookbook is missing required technique marker: ${marker}`);
}

for (const marker of [
  "Works today: data Motion",
  "Works today: package-local canvas script",
  "Works today but bake at author time",
  "Planned engine work (not yet an API)",
  "Script **import** remains blocked",
  "approved-agent-entry provenance",
  "`motion.package.script.author`",
  "local filesystem location or package claims alone are not trust evidence",
  "4,201 shape layers",
  "48 MB",
  "bounded `points` layer",
  "`sin` / `cos`",
  "GPU instancing"
]) {
  if (!cookbook.includes(marker)) failures.push(`cookbook is missing route/security boundary: ${marker}`);
}

for (const marker of [
  "browser-only single-subpath stroked `pathReveal`",
  "static bounded `effects.trail` on points/particles",
  "`pathReveal.start` / `pathReveal.end`",
  "refuses this browser-only feature",
  "Multi-subpath reveal, geometry generation/morph, arbitrary-layer or",
  "planned engine work."
]) {
  if (!cookbook.includes(marker)) failures.push(`cookbook is missing current path/trail boundary: ${marker}`);
}
if (cookbook.includes("first-class path reveal/growing strokes")) {
  failures.push("cookbook still describes the integrated single-subpath pathReveal primitive as planned.");
}
for (const stale of ["until v0.2 adds provenance resolution", "does not make script imports safe, attest script provenance"]) {
  if (cookbook.includes(stale)) failures.push(`cookbook contains stale provenance/host wording: ${stale}`);
}

if (!skillReference.includes("Script import is blocked")) {
  failures.push("skill reference no longer carries the script-import refusal.");
}
if (!skillReference.includes("Planned engine work (not yet an API)")) {
  failures.push("skill reference no longer distinguishes planned engine features.");
}
if (!skillReference.includes("single-subpath stroked `pathReveal`") || !skillReference.includes("Native refuses `pathReveal`")) {
  failures.push("skill reference no longer carries the current browser-only pathReveal boundary.");
}
if (!skillReference.includes("approved-agent-entry provenance") || !skillReference.includes("`motion.package.script.author`")) {
  failures.push("skill reference no longer carries the current approved-agent-entry provenance boundary.");
}

const snippets = [...cookbook.matchAll(/```js cookbook-testable\n([\s\S]*?)```/g)].map((match) => match[1]);
if (snippets.length < 5) failures.push(`cookbook has ${snippets.length} testable snippets; expected at least 5.`);

const temporaryRoot = mkdtempSync(join(tmpdir(), "shellx-motion-cookbook-"));
try {
  for (const [index, snippet] of snippets.entries()) {
    const path = join(temporaryRoot, `snippet-${index + 1}.mjs`);
    writeFileSync(path, snippet, "utf8");
    try {
      execFileSync(process.execPath, ["--check", path], { stdio: "pipe" });
    } catch (error) {
      const stderr = error && typeof error === "object" && "stderr" in error
        ? String(error.stderr)
        : String(error);
      failures.push(`cookbook snippet ${index + 1} does not parse: ${stderr.trim()}`);
    }
  }
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}

if (failures.length > 0) {
  console.error(`agent-script-cookbook-contract failed (${failures.length}):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`agent-script-cookbook-contract: OK — ${snippets.length} parseable snippets and ${REQUIRED.length} technique markers.`);
}
