import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repoRoot, "fixtures", "packages", "rich-depth-promo");
const outRoot = join(repoRoot, ".scratch", "rich-depth-promo-smoke");
const outputPath = join(outRoot, "rich-depth-promo.mp4");

await rm(outRoot, { recursive: true, force: true });
const render = await runCli([
  "render",
  packageRoot,
  "--lane",
  "ffmpeg",
  "--out",
  outputPath,
  "--min-unique-frames",
  "8"
], { scratchRoot: join(outRoot, "frames") });

assert(render.ok, `Rich depth promo render failed: ${JSON.stringify(render, null, 2)}`);
assert.equal(readField(render, "lane"), "ffmpeg");
assert.equal(readField(render, "frameLane"), "browser");
assert.equal(readField(render, "preset"), "mp4-h264");
assert.equal(readField(readField(render, "frames"), "count"), 39);
const warnings = readField(render, "warnings");
assert(Array.isArray(warnings));
assert(!warnings.some((warning) => String(warning).includes("product review clips")));
await stat(outputPath);
const bytes = await readFile(outputPath);
assert.equal(bytes.subarray(4, 8).toString("ascii"), "ftyp");

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
  "1000",
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
], { scratchRoot: join(outRoot, "quality") });

assert(quality.ok, `Rich depth promo quality gate failed: ${JSON.stringify(quality, null, 2)}`);
const receipt = readField(render, "receipt");
const frameReceipt = readField(render, "frameReceipt");
const frameOutput = readField(frameReceipt, "output");
const temporalSampling = readField(frameOutput, "temporalSampling");
assert.equal(readField(temporalSampling, "totalSamples"), 6);

console.log(JSON.stringify({
  ok: true,
  command: "render-rich-depth-promo:smoke",
  packageRoot,
  outputPath,
  bytes: bytes.byteLength,
  frames: readField(readField(render, "frames"), "count"),
  receiptId: readField(receipt, "id"),
  temporalSamples: readField(temporalSampling, "totalSamples"),
  quality: {
    framePath: readField(quality, "framePath"),
    visualDiff: readField(quality, "visualDiff")
  }
}, null, 2));

function readField(value: unknown, key: string): unknown {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `Expected object while reading ${key}.`);
  return Reflect.get(value, key);
}
