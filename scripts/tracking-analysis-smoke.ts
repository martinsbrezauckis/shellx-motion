import assert from "node:assert/strict";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { analyzeTrackingMedia } from "../packages/analysis-tracking/src/index";
import { dispatchDebugCommand } from "../packages/debug-api/src/index";
import { createGovernedFfmpegRunner, resolveFfmpegExecutable } from "../packages/renderer-ffmpeg/src/index";
import { createLocalMotionSdk } from "../packages/sdk/src/local";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "../packages/core/src/output-path-trusted-workspace";
import { renderingSamplesProofRoot } from "./rendering-samples-proof-root";

const root = renderingSamplesProofRoot(".scratch/tracking-analysis-smoke");
const sourcePath = resolve(root, "moving-marker.mkv");
const sourceFramesPath = resolve(root, "moving-marker.gray");
const receiptPath = resolve(root, "tracking-analysis.receipt.json");
const sourcePackageRoot = resolve(root, "source-package");
const trackedPackageRoot = resolve(root, "tracked-package");
const stabilizedPackageRoot = resolve(root, "stabilized-package");
const detachedPackageRoot = resolve(root, "detached-package");
const sdkTrackedPackageRoot = resolve(root, "sdk-tracked-package");
const sdkStabilizedPackageRoot = resolve(root, "sdk-stabilized-package");
const sdkDetachedPackageRoot = resolve(root, "sdk-detached-package");
const authoringContext = { authoringInputRoots: [root], authoringOutputRoots: [root] };
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const workspaceAuthority = await createTrustedWorkspaceAnchor(root);
await writeFile(sourceFramesPath, Buffer.concat([
  syntheticLumaFrame(64, 48, 11, 11),
  syntheticLumaFrame(64, 48, 14, 13),
  syntheticLumaFrame(64, 48, 17, 15),
]));

const generate = await createGovernedFfmpegRunner({
  scratchRoot: root,
  lane: "analysis",
  operation: "analysis.fixture.generate",
})({
  executable: resolveFfmpegExecutable(),
  args: [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "rawvideo",
    "-pixel_format", "gray",
    "-video_size", "64x48",
    "-framerate", "10",
    "-i", sourceFramesPath,
    "-c:v", "ffv1",
    "-pix_fmt", "gray",
    "-y", sourcePath,
  ],
  shell: false,
});
assert.equal(generate.exitCode, 0, `fixture generation failed: ${generate.stderr}`);
await rm(sourceFramesPath, { force: true });

const result = await analyzeTrackingMedia({
  id: "smoke_point_translation",
  assetId: "moving_marker",
  sourcePath,
  inputRoot: root,
  mode: "point",
  model: "translation",
  reference: {
    atMs: 0,
    bounds: { x: 6, y: 6, width: 12, height: 12 },
    points: [{ x: 11, y: 11 }],
  },
  settings: {
    startMs: 0,
    endMs: 200,
    stepMs: 100,
    direction: "forward",
    searchRadiusPx: 10,
    pyramidLevels: 2,
    maxIterations: 20,
    confidenceFloor: 0.55,
    deterministicSeed: 20260714,
  },
  scratchRoot: root,
  packageId: "pkg_tracking_smoke",
  createdAt: "2026-07-14T00:00:00.000Z",
});
assert(result.ok, `tracking analysis failed: ${JSON.stringify(result)}`);
assert.equal(result.analysis.status, "succeeded");
assert.deepEqual(result.analysis.samples.map((sample) => sample.state), ["tracked", "tracked", "tracked"]);
const translations = result.analysis.samples.map((sample) => [sample.matrix?.[2], sample.matrix?.[5]]);
assert.deepEqual(translations, [[0, 0], [3, 2], [6, 4]]);
assert.equal(result.resources.length, 2);
assert(result.resources.every((evidence) => evidence.lane === "analysis" && evidence.state === "passed"));
assert(result.resources.every((evidence) => evidence.processContainment !== undefined));

await mkdir(resolve(sourcePackageRoot, "assets"), { recursive: true });
await copyFile(sourcePath, resolve(sourcePackageRoot, "assets/moving-marker.mkv"));
await writeJson(resolve(sourcePackageRoot, "manifest.json"), {
  schema: "shellx-motion/package-manifest@1",
  id: "pkg_tracking_workflow_smoke",
  name: "Tracking workflow smoke",
  motion: "motion.json",
  assets: ["assets/moving-marker.mkv"],
  sourceApp: "shellx-motion-smoke",
  compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["shellx-motion", "shellx-canvas", "shellx-cut"] },
});
await writeJson(resolve(sourcePackageRoot, "motion.json"), {
  schema: "shellx-motion/motion@1",
  id: "motion_tracking_workflow_smoke",
  name: "Tracking workflow smoke",
  durationMs: 300,
  fps: 10,
  width: 64,
  height: 48,
  layers: [{
    id: "footage",
    type: "video",
    assetId: "moving_marker",
    startMs: 0,
    durationMs: 300,
    transform: { x: 5, y: 7, width: 64, height: 48, scale: 1, rotation: 0 },
    keyframes: { "transform.x": [{ atMs: 0, value: 5 }] },
  }],
  assets: [{
    schema: "shellx-motion/asset@1",
    id: "moving_marker",
    kind: "video",
    source: { path: "assets/moving-marker.mkv", mimeType: "video/x-matroska" },
    hash: { sha256: result.source.sha256 },
  }],
  provenance: { sourceApp: "shellx-motion-smoke", createdBy: "tracking-smoke" },
});

const workflowRequest = await inWorkspace(async () => await dispatchDebugCommand("motion.analysis.tracking.request", {
  packageRoot: sourcePackageRoot,
  outDir: trackedPackageRoot,
  analysisId: "workflow_point_translation",
  assetId: "moving_marker",
  mode: "point",
  model: "translation",
  reference: { atMs: 0, bounds: { x: 6, y: 6, width: 12, height: 12 }, points: [{ x: 11, y: 11 }] },
  settings: {
    startMs: 0, endMs: 200, stepMs: 100, direction: "forward", searchRadiusPx: 10,
    pyramidLevels: 2, maxIterations: 20, confidenceFloor: 0.55, deterministicSeed: 20260714,
  },
  createdAt: "2026-07-14T00:00:00.000Z",
}, { tier: "write_local", scratchRoot: resolve(root, "workflow-scratch"), ...authoringContext }));
assert(workflowRequest.ok, `tracking debug request failed: ${JSON.stringify(workflowRequest)}`);
const workflowInspect = await inWorkspace(async () => await dispatchDebugCommand("motion.analysis.tracking.inspect", {
  packageRoot: trackedPackageRoot,
  analysisId: "workflow_point_translation",
}, { tier: "read_motion", ...authoringContext }));
assert(workflowInspect.ok && record(workflowInspect.result)?.current === true, `tracking debug inspect failed: ${JSON.stringify(workflowInspect)}`);
const workflowApply = await inWorkspace(async () => await dispatchDebugCommand("motion.analysis.tracking.apply", {
  packageRoot: trackedPackageRoot,
  outDir: stabilizedPackageRoot,
  analysisId: "workflow_point_translation",
  layerId: "footage",
}, { tier: "edit_motion", ...authoringContext }));
assert(workflowApply.ok, `tracking debug apply failed: ${JSON.stringify(workflowApply)}`);
const workflowVerify = await inWorkspace(async () => await dispatchDebugCommand("motion.analysis.tracking.verify", {
  packageRoot: stabilizedPackageRoot,
  layerId: "footage",
  analysisId: "workflow_point_translation",
}, { tier: "read_motion", ...authoringContext }));
assert(workflowVerify.ok && record(record(workflowVerify.result)?.verification)?.current === true, `tracking debug verify failed: ${JSON.stringify(workflowVerify)}`);
const workflowDetach = await inWorkspace(async () => await dispatchDebugCommand("motion.analysis.tracking.detach", {
  packageRoot: stabilizedPackageRoot,
  outDir: detachedPackageRoot,
  layerId: "footage",
}, { tier: "edit_motion", ...authoringContext }));
assert(workflowDetach.ok && record(workflowDetach.result)?.restoredPreviousKeyframes === true, `tracking debug detach failed: ${JSON.stringify(workflowDetach)}`);

const sdk = createLocalMotionSdk(authoringContext);
const sdkRequest = await inWorkspace(async () => await sdk.trackingRequest({
  packageRoot: sourcePackageRoot,
  outDir: sdkTrackedPackageRoot,
  analysisId: "sdk_point_translation",
  assetId: "moving_marker",
  mode: "point",
  model: "translation",
  reference: { atMs: 0, bounds: { x: 6, y: 6, width: 12, height: 12 }, points: [{ x: 11, y: 11 }] },
  settings: {
    startMs: 0, endMs: 200, stepMs: 100, direction: "forward", searchRadiusPx: 10,
    pyramidLevels: 2, maxIterations: 20, confidenceFloor: 0.55, deterministicSeed: 20260714,
  },
  createdAt: "2026-07-14T00:00:00.000Z",
}));
assert(sdkRequest.ok, `tracking SDK request failed: ${JSON.stringify(sdkRequest)}`);
assert.equal(sdkRequest.output.lifecycle.lastGood?.samples.total, 3);
assert.equal(sdkRequest.output.lifecycle.lastGood?.segments.length, 1);
assert(!JSON.stringify(sdkRequest.output).includes("implementationSha256"), "tracking SDK output must omit full solver/sample matrices");
const sdkInspect = await inWorkspace(async () => await sdk.trackingInspect({ packageRoot: sdkTrackedPackageRoot, analysisId: "sdk_point_translation" }));
assert(sdkInspect.ok && sdkInspect.output.current, `tracking SDK inspect failed: ${JSON.stringify(sdkInspect)}`);
const sdkApply = await inWorkspace(async () => await sdk.trackingApply({
  packageRoot: sdkTrackedPackageRoot,
  outDir: sdkStabilizedPackageRoot,
  analysisId: "sdk_point_translation",
  layerId: "footage",
}));
assert(sdkApply.ok && sdkApply.output.segment.index === 0, `tracking SDK apply failed: ${JSON.stringify(sdkApply)}`);
const sdkVerify = await inWorkspace(async () => await sdk.trackingVerify({
  packageRoot: sdkStabilizedPackageRoot,
  layerId: "footage",
  analysisId: "sdk_point_translation",
}));
assert(sdkVerify.ok && sdkVerify.output.verification.current, `tracking SDK verify failed: ${JSON.stringify(sdkVerify)}`);
const sdkDetach = await inWorkspace(async () => await sdk.trackingDetach({
  packageRoot: sdkStabilizedPackageRoot,
  outDir: sdkDetachedPackageRoot,
  layerId: "footage",
}));
assert(sdkDetach.ok && sdkDetach.output.restoredPreviousKeyframes, `tracking SDK detach failed: ${JSON.stringify(sdkDetach)}`);

const smokeReceipt = {
  schema: "shellx-motion/tracking-smoke@1",
  status: "passed",
  source: result.source,
  translations,
  generationResources: generate.resources,
  analysisResources: result.resources,
  trackingReceipt: result.receipt,
  workflow: {
    requestReceiptId: workflowRequest.receiptId,
    inspectCurrent: record(workflowInspect.result)?.current,
    applyReceiptId: workflowApply.receiptId,
    verifyCurrent: record(record(workflowVerify.result)?.verification)?.current,
    detachReceiptId: workflowDetach.receiptId,
    restoredPreviousKeyframes: record(workflowDetach.result)?.restoredPreviousKeyframes,
    sourcePackageRoot,
    trackedPackageRoot,
    stabilizedPackageRoot,
    detachedPackageRoot,
  },
  sdkWorkflow: {
    requestId: sdkRequest.requestId,
    requestReceiptId: sdkRequest.ok ? sdkRequest.output.receipt.id : null,
    inspectCurrent: sdkInspect.ok ? sdkInspect.output.current : false,
    appliedSegment: sdkApply.ok ? sdkApply.output.segment : null,
    verifyCurrent: sdkVerify.ok ? sdkVerify.output.verification.current : false,
    restoredPreviousKeyframes: sdkDetach.ok ? sdkDetach.output.restoredPreviousKeyframes : false,
    trackedPackageRoot: sdkTrackedPackageRoot,
    stabilizedPackageRoot: sdkStabilizedPackageRoot,
    detachedPackageRoot: sdkDetachedPackageRoot,
  },
};
await writeFile(receiptPath, `${JSON.stringify(smokeReceipt, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ok: true, command: "tracking:smoke", receiptPath, ...smokeReceipt }, null, 2)}\n`);

function syntheticLumaFrame(width: number, height: number, x: number, y: number): Buffer {
  const frame = Buffer.alloc(width * height);
  frame[y * width + x] = 255;
  frame[y * width + x - 1] = 80;
  frame[y * width + x + 1] = 140;
  frame[(y - 1) * width + x] = 210;
  frame[(y + 1) * width + x] = 100;
  return frame;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function inWorkspace<T>(operation: () => Promise<T>): Promise<T> {
  return await withTrustedWorkspaceAnchor(workspaceAuthority, operation);
}
