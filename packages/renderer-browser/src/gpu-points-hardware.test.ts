import { loadMotionPackage } from "@shellx-motion/core";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderGpuPointsQualificationEvidence } from "./gpu-points-qualification-evidence.test-support";

const fixtureRoot = fileURLToPath(new URL("../../../fixtures/packages/gpu-points-preview", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const GPU_POINTS_OPERATION_TIMEOUT_MS = 30_000;
// Windows raw-DACL admission can take more than a minute for the package and again for output
// publication on a cold checkout before the bounded 30-second GPU operation starts. The runner
// budget covers both admissions + operation; it does not weaken the render deadline.
const GPU_POINTS_FIXTURE_TIMEOUT_MS = 240_000;

describe("GPU points hardware fixture", () => {
  it("keeps its runner budget above the bounded render operation", () => {
    expect(GPU_POINTS_FIXTURE_TIMEOUT_MS).toBeGreaterThan(GPU_POINTS_OPERATION_TIMEOUT_MS);
  });

  it.skipIf(process.env.MOTION_GPU_HARDWARE_FIXTURE !== "1")("renders the package fixture with time, alpha, PNG and governed receipt proof", async () => {
    const pkg = await loadMotionPackage(fixtureRoot);
    const outputRoot = process.env.MOTION_GPU_QUALIFICATION_OUTPUT_ROOT;
    if (!outputRoot) throw new Error("MOTION_GPU_QUALIFICATION_OUTPUT_ROOT must name an existing empty private directory outside the source checkout.");
    const result = await renderGpuPointsQualificationEvidence(pkg, {
      sourceDir: sourceRoot,
      outputRoot,
      atMs: 500,
      timeoutMs: GPU_POINTS_OPERATION_TIMEOUT_MS
    });
    expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.generatedAt).toBe(result.preview.receipt.createdAt);
    expect(result.preview.frame).toMatchObject({ width: 96, height: 64, atMs: 500, gpu: { backend: "webgpu-browser", adapterFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), adapter: { cdpVendorId: expect.any(Number), cdpDeviceId: expect.any(Number), vendor: expect.any(String), device: expect.any(String) }, limits: { maxTextureDimension2D: expect.any(Number), maxBufferSize: expect.any(Number), maxStorageBufferBindingSize: expect.any(Number) } }, resources: { lane: "gpu", operation: "gpu.preview", state: "passed" } });
    expect(result.preview.receipt).toMatchObject({ operation: "preview.gpu.frame", lane: "gpu", status: "passed", inputHashes: { "gpu-frame-plan": expect.stringMatching(/^[a-f0-9]{64}$/) }, output: { gpu: { backend: "webgpu-browser", adapterFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), adapter: { cdpVendorId: expect.any(Number), cdpDeviceId: expect.any(Number) } }, framePlanFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(result.evidence).toMatchObject({
      schema: "shellx-motion/gpu-points-qualification-evidence@2",
      host: { platform: "win32" },
      source: { before: { gitDirty: false }, after: { gitDirty: false } },
      session: { schema: "shellx-motion/windows-gpu-session@1", id: expect.stringMatching(/^[a-f0-9-]{36}$/), sourceBundle: { path: "source.bundle", mediaType: "application/vnd.git.bundle", bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/), gitCommit: expect.stringMatching(/^[a-f0-9]{40}$/), gitTree: expect.stringMatching(/^[a-f0-9]{40}$/), version: expect.any(String) } },
      browser: { identity: { name: expect.any(String), version: expect.any(String), userAgent: expect.any(String), executableSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }, args: ["--enable-gpu", "--force-high-performance-gpu", "--use-webgpu-power-preference=default-high-performance"], ignoredDefaultArgs: ["--enable-unsafe-swiftshader"], sandbox: { enabled: true, status: "enabled" } },
      gpu: result.preview.frame.gpu,
      pointsPreview: { artifact: { path: "points-preview.png", mediaType: "image/png", sha256: result.preview.frame.sha256 }, png: { width: 96, height: 64 } },
      motionPreviewReceipt: { path: "motion-preview.receipt.json", mediaType: "application/json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }
    });
    const persistedEvidence = JSON.parse(await readFile(result.evidencePath, "utf8"));
    expect(persistedEvidence).toEqual(result.evidence);
  }, GPU_POINTS_FIXTURE_TIMEOUT_MS);
});
