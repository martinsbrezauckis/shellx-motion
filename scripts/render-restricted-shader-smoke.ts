import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repoRoot, "fixtures", "packages", "restricted-shader");
const outRoot = join(repoRoot, ".scratch", "restricted-shader-smoke");
const outputPath = join(outRoot, "restricted-shader.mp4");

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

assert(render.ok, `Restricted shader render failed: ${JSON.stringify(render, null, 2)}`);
assert.equal(readField(render, "lane"), "ffmpeg");
assert.equal(readField(render, "frameLane"), "browser");
assert.equal(readField(render, "preset"), "mp4-h264");
assert.equal(readField(readField(render, "frames"), "count"), 29);
await stat(outputPath);
const bytes = await readFile(outputPath);
assert.equal(bytes.subarray(4, 8).toString("ascii"), "ftyp");

const frameReceipt = readField(render, "frameReceipt");
const shaders = readField(readField(frameReceipt, "output"), "shaders");
assert.equal(readField(shaders, "policy"), "restricted-package-glsl");
assert.deepEqual(readField(shaders, "layers"), [{
  layerId: "signal-bloom",
  assetRef: "assets/signal-bloom.glsl",
  sha256: "5efe80902fd4c596ebe935829df38925647606a3b567e15b8436698cc3a044f7",
  bytes: 257,
  seed: 8675309,
  uniformCount: 1
}]);

const quality = await runCli([
  "quality-check",
  outputPath,
  "--at-ms",
  "700",
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

assert(quality.ok, `Restricted shader quality gate failed: ${JSON.stringify(quality, null, 2)}`);
console.log(JSON.stringify({
  ok: true,
  command: "render-restricted-shader:smoke",
  packageRoot,
  outputPath,
  bytes: bytes.byteLength,
  frames: readField(readField(render, "frames"), "count"),
  shaderEvidence: shaders,
  quality: {
    framePath: readField(quality, "framePath"),
    visualDiff: readField(quality, "visualDiff")
  }
}, null, 2));

function readField(value: unknown, key: string): unknown {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `Expected object while reading ${key}.`);
  return Reflect.get(value, key);
}
