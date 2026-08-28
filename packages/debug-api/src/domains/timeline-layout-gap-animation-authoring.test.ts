import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasAtomicCOWAuthority } from "@shellx-motion/core/test-support";
import { dispatchDebugCommand } from "../index.js";
import { TIMELINE_LAYOUT_COMMANDS } from "./timeline-layout.js";
import { TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS } from "./timeline-layout-gap-animation.js";

const atomicCOW = hasAtomicCOWAuthority(tmpdir()) ? it : it.skip;

describe("timeline layout gap animation COW authority", () => {
  atomicCOW("continues authority across each COW revision, blocks dangling layout removal, then restores ordinary removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-gap-authoring-"));
    const source = await writePackage(join(root, "source"));
    const applied = await empty(root, "applied");
    const first = await empty(root, "first");
    const second = await empty(root, "second");
    const tornDown = await empty(root, "teardown");
    const removed = await empty(root, "removed");
    const blocked = await empty(root, "blocked");
    const unrelated = await Promise.all([
      empty(root, "unrelated-layout"),
      empty(root, "unrelated-layer"),
      empty(root, "unrelated-delete"),
      empty(root, "unrelated-reorder"),
      empty(root, "unrelated-keyframe"),
      empty(root, "unrelated-spatial"),
    ]);
    const receiptsRoot = join(root, "host-receipts");
    await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
    const context = { tier: "edit_motion" as const, authoringInputRoots: [root], authoringOutputRoots: [root], receiptsRoot };
    try {
      const staticApplied = await dispatchDebugCommand(TIMELINE_LAYOUT_COMMANDS.apply, layoutApplyArgs(source, applied), context);
      if (!staticApplied.ok) throw new Error(staticApplied.error.message);
      const removal = (staticApplied.result as { removal: { applicationId: string; applicationFingerprint: string } }).removal;
      const application = (staticApplied.result as { application: { id: string; fingerprint: string; sourceChildLayerIds: string[] } }).application;
      const track = { id: "gap-track", applicationId: application.id, applicationFingerprint: application.fingerprint, childLayerIds: application.sourceChildLayerIds, keyframes: [{ atUs: 0, value: 2, easing: "linear" }, { atUs: 500_000, value: 20, easing: "linear" }] };

      const attached = await dispatchDebugCommand(TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.trackUpsert, { packageRoot: applied, outDir: first, track }, context);
      if (!attached.ok) throw new Error(attached.error.message);
      expect(attached).toMatchObject({ warnings: [expect.stringContaining("C2-L1 is a Core and Debug authoring checkpoint only")], result: { layoutGapAnimation: { action: "track_inserted", application: { applicationId: application.id, applicationFingerprint: application.fingerprint }, teardown: "successor-authority-persisted" } } });
      expect(staticEvidence(await motionAt(first))).toEqual(staticEvidence(await motionAt(applied)));

      const activeRefusals: Array<{ command: string; args: Record<string, unknown>; code: string }> = [
        { command: TIMELINE_LAYOUT_COMMANDS.apply, args: layoutApplyArgs(first, unrelated[0]!), code: "timeline_layout_failed" },
        { command: "motion.timeline.layer.trim", args: { packageRoot: first, outDir: unrelated[1], layerId: "a", durationMs: 90 }, code: "timeline_layer_trim_failed" },
        { command: "motion.timeline.layer.delete", args: { packageRoot: first, outDir: unrelated[2], layerId: "a" }, code: "timeline_layer_delete_failed" },
        { command: "motion.timeline.layer.reorder", args: { packageRoot: first, outDir: unrelated[3], layerId: "a", index: 1 }, code: "timeline_layer_reorder_failed" },
        { command: "motion.timeline.keyframe.upsert", args: { packageRoot: first, outDir: unrelated[4], layerId: "a", target: "transform.x", atMs: 10, value: 3, easing: "linear" }, code: "timeline_keyframe_upsert_failed" },
        { command: "motion.timeline.spatial.position.upsert", args: { packageRoot: first, outDir: unrelated[5], layerId: "a", atMs: 10, x: 3, y: 4, easing: "linear" }, code: "timeline_spatial_position_upsert_failed" },
      ];
      for (const refusal of activeRefusals) {
        expect(await dispatchDebugCommand(refusal.command as Parameters<typeof dispatchDebugCommand>[0], refusal.args, context)).toEqual({
          ok: false,
          error: { code: refusal.code, message: "remove layout gap track first" },
          warnings: [],
        });
      }
      await Promise.all(unrelated.map(async (path) => await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" })));

      const continued = await dispatchDebugCommand(TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.keyframeUpsert, { packageRoot: first, outDir: second, trackId: track.id, keyframe: { atUs: 250_000, value: 12, easing: "ease-in" } }, context);
      if (!continued.ok) throw new Error(continued.error.message);
      expect(continued).toMatchObject({ ok: true, result: { layoutGapAnimation: { action: "keyframe_inserted", teardown: "successor-authority-persisted" } } });
      expect(staticEvidence(await motionAt(second))).toEqual(staticEvidence(await motionAt(applied)));

      const dangling = await dispatchDebugCommand(TIMELINE_LAYOUT_COMMANDS.remove, { packageRoot: second, outDir: blocked, removal }, context);
      expect(dangling).toEqual({ ok: false, error: { code: "timeline_layout_failed", message: "remove layout gap track first" }, warnings: [] });
      await expect(stat(blocked)).rejects.toMatchObject({ code: "ENOENT" });

      const detached = await dispatchDebugCommand(TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.trackRemove, { packageRoot: second, outDir: tornDown, trackId: track.id }, context);
      if (!detached.ok) throw new Error(detached.error.message);
      expect(detached).toMatchObject({ ok: true, warnings: [], result: { render: null, receipt: { status: "passed" }, layoutGapAnimation: { action: "track_removed", teardown: "restores-static-layout-remove-authority", store: { afterSha256: null } } } });
      const restored = await motionAt(tornDown);
      expect(restored.layoutGapAnimation).toBeUndefined();
      expect(staticEvidence(restored)).toEqual(staticEvidence(await motionAt(applied)));

      const staticRemoved = await dispatchDebugCommand(TIMELINE_LAYOUT_COMMANDS.remove, { packageRoot: tornDown, outDir: removed, removal }, context);
      expect(staticRemoved).toMatchObject({ ok: true, result: { operation: "remove", removal } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  atomicCOW("rolls back a C2 output if successor-authority persistence cannot write a host record", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-gap-rollback-"));
    const source = await writePackage(join(root, "source"));
    const applied = await empty(root, "applied");
    const failed = await empty(root, "failed");
    const receiptsRoot = join(root, "host-receipts");
    await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
    const context = { tier: "edit_motion" as const, authoringInputRoots: [root], authoringOutputRoots: [root], receiptsRoot };
    const authorityDirectory = join(receiptsRoot, ".shellx-motion-layout-authority");
    try {
      const staticApplied = await dispatchDebugCommand(TIMELINE_LAYOUT_COMMANDS.apply, layoutApplyArgs(source, applied), context);
      if (!staticApplied.ok) throw new Error(staticApplied.error.message);
      const application = (staticApplied.result as { application: { id: string; fingerprint: string; sourceChildLayerIds: string[] } }).application;
      const beforeAuthority = await readdir(authorityDirectory);
      await chmod(authorityDirectory, 0o500);
      const result = await dispatchDebugCommand(TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.trackUpsert, { packageRoot: applied, outDir: failed, track: { id: "gap-track", applicationId: application.id, applicationFingerprint: application.fingerprint, childLayerIds: application.sourceChildLayerIds, keyframes: [{ atUs: 0, value: 2 }] } }, context);
      expect(result).toMatchObject({ ok: false, error: { code: "timeline_layout_gap_animation_failed" } });
      await expect(stat(failed)).rejects.toMatchObject({ code: "ENOENT" });
      await chmod(authorityDirectory, 0o700);
      expect(await readdir(authorityDirectory)).toEqual(beforeAuthority);
    } finally {
      await chmod(authorityDirectory, 0o700).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  atomicCOW("rolls back a C2 output and leaves no pair member when the authority link fails after its receipt link", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-gap-pair-rollback-"));
    const source = await writePackage(join(root, "source"));
    const applied = await empty(root, "applied");
    const failed = await empty(root, "failed");
    const receiptsRoot = join(root, "host-receipts");
    await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
    const context = {
      tier: "edit_motion" as const,
      authoringInputRoots: [root],
      authoringOutputRoots: [root],
      receiptsRoot,
      layoutGapAuthorityPairHooks: {
        beforeCommitStep(step: "receipt" | "authority" | "journal") {
          if (step === "authority") throw new Error("inject continuation authority second-link failure");
        },
      },
    };
    const authorityDirectory = join(receiptsRoot, ".shellx-motion-layout-authority");
    try {
      const staticApplied = await dispatchDebugCommand(TIMELINE_LAYOUT_COMMANDS.apply, layoutApplyArgs(source, applied), context);
      if (!staticApplied.ok) throw new Error(staticApplied.error.message);
      const application = (staticApplied.result as { application: { id: string; fingerprint: string; sourceChildLayerIds: string[] } }).application;
      const beforeAuthority = await readdir(authorityDirectory);
      const result = await dispatchDebugCommand(TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.trackUpsert, {
        packageRoot: applied,
        outDir: failed,
        track: { id: "gap-track", applicationId: application.id, applicationFingerprint: application.fingerprint, childLayerIds: application.sourceChildLayerIds, keyframes: [{ atUs: 0, value: 2 }] },
      }, context);
      expect(result).toMatchObject({ ok: false, error: { code: "timeline_layout_gap_animation_failed", message: "inject continuation authority second-link failure" } });
      await expect(stat(failed)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(authorityDirectory)).toEqual(beforeAuthority);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function empty(root: string, name: string) { const path = join(root, name); await rm(path, { recursive: true, force: true }); return path; }
function layoutApplyArgs(packageRoot: string, outDir: string) { return { packageRoot, outDir, groupId: "pack", layout: { schema: "shellx-motion/layout@1", kind: "row", width: 100, height: 100, padding: { top: 10, right: 10, bottom: 10, left: 10 }, gap: 2, align: { x: "start", y: "center" }, distribution: "start", overflow: "clip" }, repeaters: [] }; }
async function writePackage(root: string): Promise<string> { await mkdir(root, { recursive: true, mode: 0o700 }); await writeFile(join(root, "manifest.json"), `${JSON.stringify({ schema: "shellx-motion/package-manifest@1", id: "pkg_layout_gap", name: "Layout gap", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["native"], hosts: ["motion"] } })}\n`); await writeFile(join(root, "motion.json"), `${JSON.stringify({ schema: "shellx-motion/motion@1", id: "motion_layout_gap", name: "Layout gap", durationMs: 1_000, fps: 30, width: 100, height: 100, layers: [{ id: "pack", type: "group", startMs: 0, durationMs: 900, childLayerIds: ["a", "b"] }, child("a"), child("b")], assets: [], provenance: { sourceApp: "test", createdBy: "test" } }, null, 2)}\n`); return root; }
async function motionAt(root: string) { return JSON.parse(await readFile(join(root, "motion.json"), "utf8")) as { layoutApplications?: unknown; layoutGapAnimation?: unknown; layers: Array<{ id: string; transform?: unknown; startMs: number; durationMs: number }> }; }
function staticEvidence(motion: Awaited<ReturnType<typeof motionAt>>) { const application = (motion.layoutApplications as Array<{ id: string; fingerprint: string; patches: unknown }> | undefined)?.[0]; return { application, children: motion.layers.filter((layer) => layer.id === "a" || layer.id === "b").map((layer) => ({ id: layer.id, transform: layer.transform, startMs: layer.startMs, durationMs: layer.durationMs })) }; }
function child(id: string) { return { id, type: "shape", shape: "rect", startMs: 0, durationMs: 100, transform: { x: 0, y: 0, width: 30, height: 20, scale: 1, rotation: 0, opacity: 1 } }; }
