import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadMotionPackage,
  type MotionDocument,
  type MotionPackage,
} from "@shellx-motion/core";
import { hasAtomicCOWAuthority } from "@shellx-motion/core/test-support";
import {
  applyTimelineFixedAdjustmentIntent,
  dispatchTimelineFixedAdjustmentAuthoringCommand,
  type TimelineFixedAdjustmentAuthoringServices,
} from "./timeline-adjustment-fixed-authoring.js";
import {
  readTimelineFixedAdjustmentIntent,
  TIMELINE_FIXED_ADJUSTMENT_COMMANDS,
} from "./timeline-adjustment-fixed.js";
import { dispatchTimelineStructuralCommand } from "./timeline-structural-dispatch.js";

const ADJUSTMENT = {
  id: "finish", startMs: 0, durationMs: 1_000,
  effects: {
    vignette: { amount: 0.7, softness: 0.45, color: "#10203080" },
    filmGrain: { amount: 0.25, size: 3, seed: 42 },
  },
} as const;
const atomicCOW = hasAtomicCOWAuthority(tmpdir()) ? it : it.skip;

describe("timeline fixed-adjustment Debug boundary", () => {
  it("parses the exact inspect/set/remove vocabulary without dropping fixed effects", () => {
    expect(readTimelineFixedAdjustmentIntent(TIMELINE_FIXED_ADJUSTMENT_COMMANDS.inspect, { packageRoot: "/pkg", layerId: "finish" }))
      .toEqual({ ok: true, intent: { kind: "inspect", layerId: "finish" } });
    expect(readTimelineFixedAdjustmentIntent(TIMELINE_FIXED_ADJUSTMENT_COMMANDS.set, editArgs({ adjustment: ADJUSTMENT })))
      .toEqual({ ok: true, intent: { kind: "set", adjustment: ADJUSTMENT } });
    expect(readTimelineFixedAdjustmentIntent(TIMELINE_FIXED_ADJUSTMENT_COMMANDS.remove, editArgs({ layerId: "finish" })))
      .toEqual({ ok: true, intent: { kind: "remove", layerId: "finish" } });
  });

  it("refuses hostile or partial records before package loading and leaves the frozen source unchanged", async () => {
    const source = motion();
    const before = structuredClone(source);
    Object.freeze(source.layers[0]!); Object.freeze(source.layers); Object.freeze(source);
    let loads = 0;
    const services: TimelineFixedAdjustmentAuthoringServices = {
      packageLoader: async () => { loads += 1; throw new Error("hostile input must not load package"); },
      isUnsafePackageOutputDirectory: async () => false,
      isEmptyOrAbsentDirectory: async () => true,
    };
    const accessor = editArgs({ adjustment: ADJUSTMENT });
    Object.defineProperty(accessor, "adjustment", { enumerable: true, get: () => ADJUSTMENT });
    const hostile = [
      editArgs({ adjustment: { ...ADJUSTMENT, effectModule: { id: "not-allowed" } } }),
      editArgs({ adjustment: { ...ADJUSTMENT, effects: { vignette: { ...ADJUSTMENT.effects.vignette, pluginData: { targetLayerId: "base" } } } } }),
      accessor,
    ];
    for (const args of hostile) {
      const result = await dispatchTimelineFixedAdjustmentAuthoringCommand(TIMELINE_FIXED_ADJUSTMENT_COMMANDS.set, args, services);
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    }
    expect(loads).toBe(0);
    expect(source).toStrictEqual(before);
  });

  it("rejects a caller receipt root before loading a package or creating output", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-fixed-adjustment-rejected-receipts-root-"));
    let loads = 0;
    try {
      const result = await dispatchTimelineFixedAdjustmentAuthoringCommand(
        TIMELINE_FIXED_ADJUSTMENT_COMMANDS.set,
        editArgs({ outDir, adjustment: ADJUSTMENT, receiptsRoot: "/caller-controlled-receipts" }),
        {
          packageLoader: async () => { loads += 1; throw new Error("caller receipt root must fail before loading"); },
          isUnsafePackageOutputDirectory: async () => false,
          isEmptyOrAbsentDirectory: async () => true,
          receiptsRoot: "/host-configured-receipts",
        },
      );
      expect(result).toEqual({ ok: false, error: { code: "invalid_args", message: "Unknown argument: receiptsRoot." }, warnings: [] });
      expect(loads).toBe(0);
      expect(await readdir(outDir)).toEqual([]);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("uses the public Core family for inspection, set replacement, and removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-fixed-adjustment-inspect-"));
    try {
      const inspected = await dispatchTimelineFixedAdjustmentAuthoringCommand(
        TIMELINE_FIXED_ADJUSTMENT_COMMANDS.inspect,
        { packageRoot: root, layerId: "finish" },
        { authoringInputRoots: [tmpdir()], packageLoader: async () => inMemoryPackage(root, [adjustmentLayer()]) },
      );
      expect(inspected).toMatchObject({ ok: true, result: { inspection: { layerId: "finish", index: 0, adjustmentFingerprint: expect.any(String) } } });
      const routed = await dispatchTimelineStructuralCommand(
        TIMELINE_FIXED_ADJUSTMENT_COMMANDS.inspect,
        { packageRoot: root, layerId: "finish" },
        { authoringInputRoots: [tmpdir()], packageLoader: async () => inMemoryPackage(root, [adjustmentLayer()]) },
      );
      expect(routed).toMatchObject({ ok: true, result: { inspection: { layerId: "finish" } } });

      const created = applyTimelineFixedAdjustmentIntent(motion(), { kind: "set", adjustment: ADJUSTMENT }, {});
      expect(created).toMatchObject({ action: "created", index: 1, changedPaths: ["/layers/finish"] });
      const removed = applyTimelineFixedAdjustmentIntent(created.motion, { kind: "remove", layerId: "finish" }, {});
      expect(removed).toMatchObject({ action: "removed", index: 1, adjustmentFingerprint: null });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  atomicCOW("writes one COW receipt with before/after, effect/order facts, and reopens the exact package", async () => {
    const root = await writePackage();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-fixed-adjustment-out-"));
    const removeDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-fixed-adjustment-remove-"));
    const before = await readFile(join(root, "motion.json"));
    try {
      const services: TimelineFixedAdjustmentAuthoringServices = {
        authoringInputRoots: [tmpdir()], authoringOutputRoots: [tmpdir()],
        packageLoader: loadMotionPackage,
        isUnsafePackageOutputDirectory: async () => false,
        isEmptyOrAbsentDirectory: async (path) => (await readdir(path)).length === 0,
      };
      const set = await dispatchTimelineFixedAdjustmentAuthoringCommand(
        TIMELINE_FIXED_ADJUSTMENT_COMMANDS.set,
        editArgs({ packageRoot: root, outDir, adjustment: ADJUSTMENT, createdBy: "test" }),
        services,
      );
      expect(set).toMatchObject({
        ok: true,
        result: {
          action: "created", index: 1, beforeMotionSha256: expect.any(String), afterMotionSha256: expect.any(String),
          fixedAdjustment: { effectFamilies: ["vignette", "filmGrain"], effectCount: 2, rootAdjustmentOrder: ["finish"] },
        },
      });
      expect(await readFile(join(root, "motion.json"))).toEqual(before);
      const reopened = await loadMotionPackage(outDir);
      expect(reopened.motion.layers.map((layer) => layer.id)).toEqual(["base", "finish"]);
      const receipt = JSON.parse(await readFile(join(outDir, "receipts", "timeline-adjustment-fixed-set.receipt.json"), "utf8"));
      expect(receipt).toMatchObject({ operation: "timeline.adjustment.fixed.set", output: { action: "created", beforeMotionSha256: expect.any(String), afterMotionSha256: expect.any(String), fixedAdjustment: { canonicalEffectOrder: ["vignette", "filmGrain"] } } });

      const remove = await dispatchTimelineFixedAdjustmentAuthoringCommand(
        TIMELINE_FIXED_ADJUSTMENT_COMMANDS.remove,
        editArgs({ packageRoot: outDir, outDir: removeDir, layerId: "finish" }),
        services,
      );
      expect(remove).toMatchObject({ ok: true, result: { action: "removed", fixedAdjustment: { effectCount: 0, rootAdjustmentOrder: [] } } });
      expect((await loadMotionPackage(removeDir)).motion.layers.map((layer) => layer.id)).toEqual(["base"]);
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outDir, { recursive: true, force: true }), rm(removeDir, { recursive: true, force: true })]);
    }
  });
});

function editArgs(values: Record<string, unknown>): Record<string, unknown> { return { packageRoot: "/package", outDir: "/out", ...values }; }
function adjustmentLayer() { return { id: "finish", type: "adjustment", startMs: 0, durationMs: 1_000, effects: ADJUSTMENT.effects }; }
function motion(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "motion_fixed_adjustment", name: "Fixed adjustment", durationMs: 1_000, fps: 30, width: 100, height: 100,
    layers: [{ id: "base", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000 }], assets: [], provenance: { sourceApp: "test", createdBy: "test" },
  } as MotionDocument;
}
function inMemoryPackage(root: string, layers = motion().layers): MotionPackage {
  return {
    root,
    manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_fixed_adjustment", name: "Fixed adjustment", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] } },
    motion: { ...motion(), layers },
  } as MotionPackage;
}
async function writePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-fixed-adjustment-source-"));
  const pkg = inMemoryPackage(root);
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(pkg.manifest, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify(pkg.motion, null, 2)}\n`);
  return root;
}
