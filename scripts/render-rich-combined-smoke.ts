import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = join(repoRoot, ".scratch", "rich-combined-smoke");
await rm(outRoot, { recursive: true, force: true });

const proofs = [];
for (const fixture of [
  { id: "holographic-lab-promo", evidence: "shaders" },
  { id: "dimensional-device-promo", evidence: "scenes3d" }
] as const) {
  const packageRoot = join(repoRoot, "fixtures", "packages", fixture.id);
  const fixtureRoot = join(outRoot, fixture.id);
  const outputPath = join(fixtureRoot, `${fixture.id}.mp4`);
  const render = await runCli([
    "render",
    packageRoot,
    "--lane",
    "ffmpeg",
    "--out",
    outputPath,
    "--min-unique-frames",
    "10"
  ], { scratchRoot: join(fixtureRoot, "frames") });

  assert(render.ok, `${fixture.id} render failed: ${JSON.stringify(render, null, 2)}`);
  assert.equal(readField(render, "lane"), "ffmpeg");
  assert.equal(readField(render, "frameLane"), "browser");
  assert.equal(readField(readField(render, "frames"), "count"), 39);
  await stat(outputPath);
  const bytes = await readFile(outputPath);
  assert.equal(bytes.subarray(4, 8).toString("ascii"), "ftyp");
  const frameReceipt = readField(render, "frameReceipt");
  const evidence = readField(readField(frameReceipt, "output"), fixture.evidence);
  assert(Array.isArray(readField(evidence, "layers")));

  const quality = await runCli([
    "quality-check",
    outputPath,
    "--at-ms",
    "800",
    "--expect-width",
    "320",
    "--expect-height",
    "180",
    "--min-edge-pixels",
    "700",
    "--min-non-transparent-pixels",
    "50000",
    "--preview-package",
    packageRoot,
    "--preview-lane",
    "browser",
    "--max-changed-pixels",
    "57600",
    "--max-mean-diff",
    "12",
    "--min-psnr-db",
    "22"
  ], { scratchRoot: join(fixtureRoot, "quality") });
  assert(quality.ok, `${fixture.id} quality gate failed: ${JSON.stringify(quality, null, 2)}`);
  proofs.push({
    fixture: fixture.id,
    outputPath,
    bytes: bytes.byteLength,
    frames: readField(readField(render, "frames"), "count"),
    evidence,
    framePath: readField(quality, "framePath"),
    visualDiff: readField(quality, "visualDiff")
  });
}

console.log(JSON.stringify({ ok: true, command: "render-rich-combined:smoke", proofs }, null, 2));

function readField(value: unknown, key: string): unknown {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `Expected object while reading ${key}.`);
  return Reflect.get(value, key);
}
