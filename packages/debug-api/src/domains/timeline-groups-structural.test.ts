import { describe, expect, it } from "vitest";
import { loadMotionPackage } from "@shellx-motion/core";
import { hasAtomicCOWAuthority } from "@shellx-motion/core/test-support";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MotionDebugCommand } from "../command-registry.js";
import { dispatchDebugCommand } from "../index.js";

const atomicCOW = hasAtomicCOWAuthority(tmpdir()) ? it : it.skip;

describe("timeline group Debug mutations", () => {
  atomicCOW("persists every structural group operation through COW, receipt evidence, and reopen", async () => {
    const roots: string[] = [];
    let current = await writeGroupPackage();
    roots.push(current);
    try {
      current = await applyGroupEdit(current, "motion.timeline.group.create", {
        group: { id: "manual", type: "group", startMs: 0, durationMs: 100, childLayerIds: ["a", "b"] }, layerIndex: 0
      }); roots.push(current);
      current = await applyGroupEdit(current, "motion.timeline.group.child.add", { groupId: "manual", childLayerId: "c" }); roots.push(current);
      current = await applyGroupEdit(current, "motion.timeline.group.child.remove", { groupId: "manual", childLayerId: "c" }); roots.push(current);
      current = await applyGroupEdit(current, "motion.timeline.group.child.move", { sourceGroupId: null, destinationGroupId: "manual", childLayerId: "c", index: 0 }); roots.push(current);
      current = await applyGroupEdit(current, "motion.timeline.group.child.reorder", { groupId: "manual", childLayerId: "c", index: 2 }); roots.push(current);
      current = await applyGroupEdit(current, "motion.timeline.group.wrap", { group: { id: "nested" }, childLayerIds: ["a", "b"] }); roots.push(current);
      current = await applyGroupEdit(current, "motion.timeline.group.unwrap", { groupId: "nested" }); roots.push(current);
      current = await applyGroupEdit(current, "motion.timeline.group.duplicate", { groupId: "manual", offsetMs: 200 }); roots.push(current);
      current = await applyGroupEdit(current, "motion.timeline.group.root.reorder", { groupId: "manual_copy", index: 0 }); roots.push(current);
      current = await applyGroupEdit(current, "motion.timeline.group.delete", { groupId: "manual_copy", disposition: "cascade" }); roots.push(current);
      current = await applyGroupEdit(current, "motion.timeline.group.trim", { groupId: "manual", startMs: 10 }); roots.push(current);
      current = await applyGroupEdit(current, "motion.timeline.group.split", { groupId: "manual", atMs: 50 }); roots.push(current);

      const reopened = await loadMotionPackage(current);
      expect(reopened.motion.layers.find((layer) => layer.id === "manual")?.childLayerIds).toEqual(["a", "b", "c"]);
      expect(reopened.motion.layers.find((layer) => layer.id === "manual")).toMatchObject({ startMs: 10, durationMs: 40 });
      expect(reopened.motion.layers.find((layer) => layer.id === "manual_split_50")).toMatchObject({ startMs: 50, durationMs: 60 });
      expect(reopened.motion.layers.some((layer) => layer.id === "manual_copy")).toBe(false);
      expect(JSON.parse(await readFile(join(roots[0], "motion.json"), "utf8")).layers.map((layer: { id: string }) => layer.id)).toEqual(["a", "b", "c"]);
    } finally {
      await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true })));
    }
  });

  atomicCOW("rejects hostile group requests before a package copy, receipt, or source mutation", async () => {
    const source = await writeGroupPackage();
    const wrapOut = await mkdtemp(join(tmpdir(), "shellx-motion-debug-group-hostile-wrap-"));
    const splitSource = await writeGroupPackage(true);
    const splitOut = await mkdtemp(join(tmpdir(), "shellx-motion-debug-group-hostile-split-"));
    const trimOut = await mkdtemp(join(tmpdir(), "shellx-motion-debug-group-hostile-trim-"));
    try {
      const before = await readFile(join(source, "motion.json"), "utf8");
      const wrap = await dispatchDebugCommand(
        "motion.timeline.group.wrap",
        { packageRoot: source, outDir: wrapOut, group: { id: "bad" }, childLayerIds: ["a", "c"], force: true },
        { tier: "edit_motion", authoringInputRoots: [source], authoringOutputRoots: [wrapOut] }
      );
      expect(wrap).toMatchObject({ ok: false, error: { code: "invalid_args", message: "Unknown argument: force." } });
      expect(await readdir(wrapOut)).toEqual([]);
      expect(await readFile(join(source, "motion.json"), "utf8")).toBe(before);

      const split = await dispatchDebugCommand(
        "motion.timeline.layer.split",
        { packageRoot: splitSource, outDir: splitOut, layerId: "pack", atMs: 50 },
        { tier: "edit_motion", authoringInputRoots: [splitSource], authoringOutputRoots: [splitOut] }
      );
      expect(split).toMatchObject({ ok: false, error: { code: "timeline_layer_split_failed", message: expect.stringContaining("use splitMotionGroupAtMs") } });
      expect(await readdir(splitOut)).toEqual([]);
      const trim = await dispatchDebugCommand(
        "motion.timeline.layer.trim",
        { packageRoot: splitSource, outDir: trimOut, layerId: "a", durationMs: 50 },
        { tier: "edit_motion", authoringInputRoots: [splitSource], authoringOutputRoots: [trimOut] }
      );
      expect(trim).toMatchObject({ ok: false, error: { code: "timeline_layer_trim_failed", message: expect.stringContaining("group-owned layer a") } });
      expect(await readdir(trimOut)).toEqual([]);
    } finally {
      await Promise.all([source, wrapOut, splitSource, splitOut, trimOut].map(async (root) => await rm(root, { recursive: true, force: true })));
    }
  });
});

async function applyGroupEdit(source: string, command: MotionDebugCommand, args: Record<string, unknown>): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-group-edit-"));
  const receiptsRoot = join(outDir, "host-receipts");
  const result = await dispatchDebugCommand(
    command,
    { packageRoot: source, outDir, receiptsRoot, ...args },
    { tier: "edit_motion", authoringInputRoots: [source], authoringOutputRoots: [outDir] },
  );
  if (!result.ok) throw new Error(`${command}: ${result.error.message}`);
  expect(result.ok).toBe(true);
  const stem = command.slice("motion.timeline.group.".length).replaceAll(".", "-");
  const receiptPath = join(outDir, "receipts", `timeline-group-${stem}.receipt.json`);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  expect(receipt).toMatchObject({ id: result.receiptId, operation: command.slice("motion.".length), status: "passed", lane: "debug-api" });
  expect(JSON.parse(await readFile(join(receiptsRoot, `${result.receiptId}.receipt.json`), "utf8"))).toEqual(receipt);
  expect(await loadMotionPackage(outDir)).toMatchObject({ root: outDir });
  return outDir;
}

async function writeGroupPackage(withGroup = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-group-package-"));
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1", id: "pkg_debug_groups", name: "Debug Groups", motion: "motion.json", assets: [], sourceApp: "shellx-motion", compatibility: { lanes: ["native"], hosts: ["motion"] }
  }, null, 2)}\n`);
  const layers = withGroup
    ? [{ id: "pack", type: "group", startMs: 0, durationMs: 100, childLayerIds: ["a"] }, leaf("a"), leaf("b"), leaf("c")]
    : [leaf("a"), leaf("b"), leaf("c")];
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1", id: "motion_debug_groups", name: "Debug Groups", durationMs: 500, fps: 30, width: 64, height: 36,
    layers, assets: [], provenance: { sourceApp: "shellx-motion", createdBy: "test" }
  }, null, 2)}\n`);
  return root;
}

function leaf(id: string) {
  return { id, type: "shape", shape: "rect", startMs: 0, durationMs: 100 };
}
