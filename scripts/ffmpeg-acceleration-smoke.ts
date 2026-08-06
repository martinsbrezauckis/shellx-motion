import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, hostname, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema, validateDocument } from "../packages/core/src/index";
import { probeFfmpegHardwareEncoderUsability } from "../packages/renderer-ffmpeg/src/index";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const startedAt = new Date().toISOString();
const priorTimeout = process.env.SHELLX_MOTION_FFMPEG_TIMEOUT_MS;
if (!priorTimeout) process.env.SHELLX_MOTION_FFMPEG_TIMEOUT_MS = "15000";

let probe: Awaited<ReturnType<typeof probeFfmpegHardwareEncoderUsability>>;
try {
  probe = await probeFfmpegHardwareEncoderUsability({
    vaapiDevice: process.env.SHELLX_MOTION_VAAPI_DEVICE?.trim() || undefined
  });
} finally {
  if (priorTimeout === undefined) delete process.env.SHELLX_MOTION_FFMPEG_TIMEOUT_MS;
  else process.env.SHELLX_MOTION_FFMPEG_TIMEOUT_MS = priorTimeout;
}

assert(probe.ok, `FFmpeg hardware acceleration probe failed: ${JSON.stringify(probe)}`);
const host = {
  id: process.env.SHELLX_MOTION_HOST_ID?.trim() || hostname(),
  platform: platform(),
  arch: arch(),
  release: release()
};
const warnings = probe.probes
  .filter((entry) => entry.compiled && !entry.usable)
  .map((entry) => `Compiled encoder ${entry.encoder} could not initialize.`);
const receipt = {
  schema: "shellx-motion/receipt@1",
  id: `ffmpeg-acceleration-${host.platform}-${host.arch}`,
  operation: "ffmpeg.acceleration.probe",
  status: warnings.length > 0 ? "warning" : "passed",
  packageId: "host",
  inputHashes: {},
  createdAt: startedAt,
  lane: "ffmpeg",
  output: {
    finishedAt: new Date().toISOString(),
    host,
    selection: probe.selection,
    hardwareAvailable: probe.usableEncoders.length > 0,
    // The probe now spans all codec families (h264/hevc/av1); the first usable encoder in probe
    // order is the one selection would prefer for its family.
    selectedEncoder: probe.usableEncoders[0] ?? null,
    usableEncoders: probe.usableEncoders,
    probes: probe.probes
  },
  warnings
};
assert.deepEqual(await validateDocument(await loadSchema("receipt"), receipt), { ok: true });
const receiptPath = join(repoRoot, ".scratch", "ffmpeg-acceleration", `${host.platform}-${host.arch}.receipt.json`);
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ok: true, receiptPath, receipt }, null, 2)}\n`);
