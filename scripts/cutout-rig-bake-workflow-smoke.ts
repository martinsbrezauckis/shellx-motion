import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "../packages/core/src/output-path-trusted-workspace";
import { dispatchDebugCommand } from "../packages/debug-api/src/index";
import { renderingSamplesProofRoot } from "./rendering-samples-proof-root";

// The checked public PNG fixture is copied into a deliberately minimal static source package before the bake.
const root = renderingSamplesProofRoot(".scratch/rendering-samples/cutout-rig-bake-workflow");
const sourceFixture = resolve("fixtures/packages/gpu-material-admitted/assets/poster.png");
const sourcePackageRoot = join(root, "source-package");
const bakedPackageRoot = join(root, "baked-package");
const hostReceiptsRoot = join(root, "host-receipts");

await rm(root, { recursive: true, force: true });
await mkdir(join(sourcePackageRoot, "assets"), { recursive: true });
await copyFile(sourceFixture, join(sourcePackageRoot, "assets", "poster.png"));
await writeJson(join(sourcePackageRoot, "manifest.json"), {
  schema: "shellx-motion/package-manifest@1",
  id: "pkg_cutout_rig_workflow_smoke",
  name: "Cutout rig workflow smoke",
  motion: "motion.json",
  assets: ["assets/poster.png"],
  sourceApp: "shellx-motion-smoke",
  compatibility: { lanes: ["native", "browser"], hosts: ["shellx-motion"] },
});
await writeJson(join(sourcePackageRoot, "motion.json"), {
  schema: "shellx-motion/motion@1",
  id: "motion_cutout_rig_workflow_smoke",
  name: "Cutout rig workflow smoke",
  durationMs: 100,
  fps: 10,
  width: 1920,
  height: 1080,
  assets: [],
  layers: [{
    id: "source",
    type: "image",
    assetRef: "assets/poster.png",
    trackId: "main",
    startMs: 0,
    durationMs: 100,
    transform: { x: 2, y: 3, width: 1920, height: 1080, scale: 1, rotation: 0, originX: 1, originY: 0.5 },
  }],
  tracks: [{ id: "main", type: "overlay", layerIds: ["source"] }],
  provenance: { sourceApp: "shellx-motion-smoke", createdBy: "cutout-rig-bake-workflow-smoke" },
});
const workspaceAuthority = await createTrustedWorkspaceAnchor(root);

const baked = await withTrustedWorkspaceAnchor(workspaceAuthority, async () => await dispatchDebugCommand("motion.timeline.cutout.rig.bake", {
  packageRoot: sourcePackageRoot,
  outDir: bakedPackageRoot,
  sourceLayerId: "source",
  receiptsRoot: hostReceiptsRoot,
  createdBy: "cutout-rig-bake-workflow-smoke",
  rig: {
    schema: "shellx-motion/cutout-rig@1",
    sampleEveryFrames: 1,
    nodes: [{
      layerId: "poster-detail",
      stackIndex: 0,
      crop: { x: 0, y: 0, width: 64, height: 64 },
      origin: { x: 0, y: 0 },
      poses: [{ atMs: 0, x: 4, y: 5, scale: 1, rotation: 0 }],
    }],
  },
}, {
  tier: "edit_motion",
  scratchRoot: root,
  receiptsRoot: hostReceiptsRoot,
  authoringInputRoots: [root],
  authoringOutputRoots: [root],
}));
assert(baked.ok, `cutout rig bake failed: ${JSON.stringify(baked)}`);

const result = record(baked.result);
assert.deepEqual(result?.outputLayerIds, ["poster-detail"]);
assert.equal(record(result?.cadence)?.bakedSampleCount, 1);
const receiptPath = String(result?.receiptPath ?? "");
const hostReceiptPath = String(result?.hostReceiptPath ?? "");
assert(receiptPath && hostReceiptPath, "cutout rig bake must persist package and host receipts");
await stat(receiptPath);
await stat(hostReceiptPath);
assert.equal(record(JSON.parse(await readFile(receiptPath, "utf8")))?.operation, "timeline.cutout.rig.bake");
assert.equal(record(JSON.parse(await readFile(hostReceiptPath, "utf8")))?.operation, "timeline.cutout.rig.bake");

process.stdout.write(`${JSON.stringify({
  ok: true,
  command: "cutout-rig-bake-workflow:smoke",
  sourceFixture,
  sourcePackageRoot,
  bakedPackageRoot,
  receiptId: baked.receiptId,
  receiptPath,
  hostReceiptPath,
}, null, 2)}\n`);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
