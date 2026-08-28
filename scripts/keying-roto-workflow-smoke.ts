import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "../packages/core/src/output-path-trusted-workspace";
import { dispatchDebugCommand } from "../packages/debug-api/src/index";
import { renderingSamplesProofRoot } from "./rendering-samples-proof-root";

// The source image is a checked public fixture. Every package and receipt this workflow creates stays in .scratch.
const root = renderingSamplesProofRoot(".scratch/rendering-samples/keying-roto-workflow");
const sourceFixture = resolve("fixtures/packages/gpu-material-admitted/assets/poster.png");
const sourcePackageRoot = join(root, "source-package");
const keyedPackageRoot = join(root, "keyed-package");
const rotoPackageRoot = join(root, "roto-package");
const detachedPackageRoot = join(root, "detached-package");
const hostReceiptsRoot = join(root, "host-receipts");
const context = {
  scratchRoot: root,
  receiptsRoot: hostReceiptsRoot,
  authoringInputRoots: [root],
  authoringOutputRoots: [root],
};

await rm(root, { recursive: true, force: true });
await mkdir(join(sourcePackageRoot, "assets"), { recursive: true });
await copyFile(sourceFixture, join(sourcePackageRoot, "assets", "poster.png"));
await writeJson(join(sourcePackageRoot, "manifest.json"), {
  schema: "shellx-motion/package-manifest@1",
  id: "pkg_keying_roto_workflow_smoke",
  name: "Keying and roto workflow smoke",
  motion: "motion.json",
  assets: ["assets/poster.png"],
  sourceApp: "shellx-motion-smoke",
  compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["shellx-motion"] },
});
await writeJson(join(sourcePackageRoot, "motion.json"), {
  schema: "shellx-motion/motion@1",
  id: "motion_keying_roto_workflow_smoke",
  name: "Keying and roto workflow smoke",
  durationMs: 100,
  fps: 10,
  width: 1920,
  height: 1080,
  assets: [],
  layers: [{
    id: "subject",
    type: "image",
    assetRef: "assets/poster.png",
    trackId: "main",
    startMs: 0,
    durationMs: 100,
    transform: { x: 0, y: 0, width: 1920, height: 1080, scale: 1, rotation: 0 },
  }],
  tracks: [{ id: "main", type: "overlay", layerIds: ["subject"] }],
  provenance: { sourceApp: "shellx-motion-smoke", createdBy: "keying-roto-workflow-smoke" },
});
const workspaceAuthority = await createTrustedWorkspaceAnchor(root);

const keyed = await withTrustedWorkspaceAnchor(workspaceAuthority, async () => await dispatchDebugCommand("motion.keying.apply", {
  packageRoot: sourcePackageRoot,
  outDir: keyedPackageRoot,
  layerId: "subject",
  receiptsRoot: hostReceiptsRoot,
  keying: { schema: "shellx-motion/chroma-key@1", keyColor: "#00ff00", similarity: 0.2, spillSuppression: 0.8 },
}, { tier: "edit_motion", ...context }));
assert(keyed.ok, `keying apply failed: ${JSON.stringify(keyed)}`);

const inspected = await withTrustedWorkspaceAnchor(workspaceAuthority, async () => await dispatchDebugCommand("motion.keying.inspect", {
  packageRoot: keyedPackageRoot,
  layerId: "subject",
}, { tier: "read_motion", ...context }));
assert(inspected.ok && record(inspected.result)?.state && record(record(inspected.result)?.state)?.keying, `keying inspect failed: ${JSON.stringify(inspected)}`);

const roto = await withTrustedWorkspaceAnchor(workspaceAuthority, async () => await dispatchDebugCommand("motion.roto.upsert", {
  packageRoot: keyedPackageRoot,
  outDir: rotoPackageRoot,
  layerId: "subject",
  receiptsRoot: hostReceiptsRoot,
  mask: {
    type: "roto",
    schema: "shellx-motion/roto-mask@1",
    closed: true,
    frames: [{ atMs: 0, vertices: [{ id: "a", x: 0.1, y: 0.1 }, { id: "b", x: 0.9, y: 0.1 }, { id: "c", x: 0.5, y: 0.9 }] }],
    tracking: {
      schema: "shellx-motion/roto-tracking-attachment@1",
      analysisId: "subject-track",
      sourceSha256: "a".repeat(64),
      segmentIndex: 0,
      model: "similarity",
    },
  },
}, { tier: "edit_motion", ...context }));
assert(roto.ok, `roto upsert failed: ${JSON.stringify(roto)}`);

const detached = await withTrustedWorkspaceAnchor(workspaceAuthority, async () => await dispatchDebugCommand("motion.roto.tracking.detach", {
  packageRoot: rotoPackageRoot,
  outDir: detachedPackageRoot,
  layerId: "subject",
  receiptsRoot: hostReceiptsRoot,
}, { tier: "edit_motion", ...context }));
assert(detached.ok && record(record(detached.result)?.state)?.trackingAttached === false, `roto tracking detach failed: ${JSON.stringify(detached)}`);

const receipts = [
  [keyed, "keying.apply"],
  [roto, "roto.upsert"],
  [detached, "roto.tracking.detach"],
] as const;
for (const [result, operation] of receipts) {
  const receiptPath = String(record(result.result)?.receiptPath ?? "");
  const hostReceiptPath = String(record(result.result)?.hostReceiptPath ?? "");
  assert(receiptPath && hostReceiptPath, `${operation} must persist package and host receipts`);
  await stat(receiptPath);
  await stat(hostReceiptPath);
  assert.equal(record(JSON.parse(await readFile(receiptPath, "utf8")))?.operation, operation);
  assert.equal(record(JSON.parse(await readFile(hostReceiptPath, "utf8")))?.operation, operation);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  command: "keying-roto-workflow:smoke",
  sourceFixture,
  sourcePackageRoot,
  keyedPackageRoot,
  rotoPackageRoot,
  detachedPackageRoot,
  receiptIds: receipts.map(([result]) => result.receiptId),
}, null, 2)}\n`);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
