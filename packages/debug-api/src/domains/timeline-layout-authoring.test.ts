import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMotionDocument, type MotionPackage } from "@shellx-motion/core";
import { hasAtomicCOWAuthority } from "@shellx-motion/core/test-support";
import { dispatchDebugCommand } from "../index.js";
import { dispatchTimelineLayoutAuthoringCommand } from "./timeline-layout-authoring.js";
import { isTimelineLayoutCommand, readTimelineLayoutIntent, TIMELINE_LAYOUT_COMMANDS } from "./timeline-layout.js";
import { dispatchTimelineStructuralCommand } from "./timeline-structural-dispatch.js";

const atomicCOW = hasAtomicCOWAuthority(tmpdir()) ? it : it.skip;

describe("timeline layout Debug commands", () => {
  it("keeps the four commands exact, private, and hostile-input safe before package loading", async () => {
    expect(readTimelineLayoutIntent(TIMELINE_LAYOUT_COMMANDS.inspect, readArgs())).toMatchObject({ ok: true, intent: { kind: "inspect", groupId: "pack", layout, repeaters: [] } });
    expect(readTimelineLayoutIntent(TIMELINE_LAYOUT_COMMANDS.compile, readArgs())).toMatchObject({ ok: true, intent: { kind: "compile" } });
    expect(readTimelineLayoutIntent(TIMELINE_LAYOUT_COMMANDS.apply, editArgs())).toMatchObject({ ok: true, intent: { kind: "apply" } });
    expect(readTimelineLayoutIntent(TIMELINE_LAYOUT_COMMANDS.remove, removeArgs({ removal: removalState() }))).toMatchObject({ ok: true, intent: { kind: "remove", removal: removalState() } });
    expect(isTimelineLayoutCommand("motion.timeline.layout.preview")).toBe(false);

    let loads = 0;
    const result = await dispatchTimelineLayoutAuthoringCommand(
      TIMELINE_LAYOUT_COMMANDS.inspect,
      { ...readArgs(), motion: {}, createdAt: "2026-08-16T00:00:00.000Z" },
      unavailableServices(() => { loads += 1; }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args", message: "Unknown argument: motion." } });
    expect(loads).toBe(0);
    expect(readTimelineLayoutIntent(TIMELINE_LAYOUT_COMMANDS.apply, { ...editArgs(), createdAt: "2026-08-16T00:00:00.000Z" }))
      .toEqual({ ok: false, problem: "Unknown argument: createdAt." });
    expect(readTimelineLayoutIntent(TIMELINE_LAYOUT_COMMANDS.inspect, readArgs({ layout: { ...layout, width: Number.NaN } })))
      .toEqual({ ok: false, problem: "Arguments.layout.width must be finite." });
    const nested = await dispatchTimelineLayoutAuthoringCommand(
      TIMELINE_LAYOUT_COMMANDS.inspect,
      readArgs({ layout: { ...layout, accidental: true } }),
      unavailableServices(() => { loads += 1; }),
    );
    expect(nested).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("/layout/accidental: field.unknown:") } });
    expect(loads).toBe(0);
    const accessor = readArgs();
    Object.defineProperty(accessor, "repeaters", { enumerable: true, get: () => [] });
    expect(readTimelineLayoutIntent(TIMELINE_LAYOUT_COMMANDS.inspect, accessor))
      .toEqual({ ok: false, problem: "Arguments.repeaters must be a data property." });
    expect(readTimelineLayoutIntent(TIMELINE_LAYOUT_COMMANDS.remove, removeArgs({ removal: { ...removalState(), patches: [] } })))
      .toEqual({ ok: false, problem: "removal has unknown field patches." });
    const rootOverride = await dispatchTimelineLayoutAuthoringCommand(
      TIMELINE_LAYOUT_COMMANDS.apply,
      editArgs({ receiptsRoot: "/caller-controlled-receipts" }),
      {
        authoringInputRoots: ["/"], authoringOutputRoots: ["/"], receiptsRoot: "/host-configured-receipts",
        packageLoader: async () => { loads += 1; throw new Error("receiptsRoot override must refuse before loading"); },
        isUnsafePackageOutputDirectory: async () => false, isEmptyOrAbsentDirectory: async () => true,
        writeReceipt: async () => "unused",
      },
    );
    expect(rootOverride).toEqual({ ok: false, error: { code: "invalid_args", message: "Unknown argument: receiptsRoot." }, warnings: [] });
    expect(loads).toBe(0);
  });

  it("routes read-only inspect and compile through structural production dispatch without a receipt", async () => {
    const source = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layout-read-"));
    try {
      const services = { authoringInputRoots: [source], packageLoader: async () => inMemoryPackage(source) };
      const inspected = await dispatchTimelineStructuralCommand(TIMELINE_LAYOUT_COMMANDS.inspect, { packageRoot: source, groupId: "pack", layout, repeaters: [] }, services);
      const compiled = await dispatchTimelineStructuralCommand(TIMELINE_LAYOUT_COMMANDS.compile, { packageRoot: source, groupId: "pack", layout, repeaters: [] }, services);
      if (!inspected || !compiled) throw new Error("expected layout structural dispatch result");
      if (!inspected.ok) throw new Error(inspected.error.message);
      if (!compiled.ok) throw new Error(compiled.error.message);
      expect(inspected).toMatchObject({ ok: true, result: { compilation: { source: { groupId: "pack", childLayerIds: ["a", "b"] }, layoutFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
      expect(compiled).toMatchObject({ ok: true, result: { compilation: { budget: { limits: { maxCompiledInstances: 512 } }, overflow: { physicalClipping: "refused" }, repeaters: [] } } });
      expect("receiptId" in inspected).toBe(false);
      expect("receipt" in (inspected.ok ? inspected.result as object : {})).toBe(false);
      expect(await readdir(source)).not.toContain("receipts");
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  it("de-aliases shared JSON repeater values before the Core cyclic-data boundary", async () => {
    const source = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layout-shared-data-"));
    try {
      const sharedDelta = { x: 0, y: 0, scale: 0, rotation: 0 };
      const services = { authoringInputRoots: [source], packageLoader: async () => inMemoryPackage(source) };
      const compiled = await dispatchTimelineStructuralCommand(
        TIMELINE_LAYOUT_COMMANDS.compile,
        {
          packageRoot: source,
          groupId: "pack",
          layout,
          repeaters: [
            { ...repeater("a", 2), transformDelta: sharedDelta },
            { ...repeater("b", 2), transformDelta: sharedDelta },
          ],
        },
        services,
      );

      expect(compiled).toMatchObject({ ok: true, result: { compilation: { repeaters: [{ sourceId: "a" }, { sourceId: "b" }] } } });
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  it("keeps omitted package fields JSON-clean before strict Core layout transport", async () => {
    const source = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layout-json-clean-"));
    try {
      const pkg = inMemoryPackage(source);
      const parsed = readMotionDocument(JSON.parse(JSON.stringify(pkg.motion)));
      expect(Object.hasOwn(parsed, "background")).toBe(false);

      const compiled = await dispatchTimelineStructuralCommand(
        TIMELINE_LAYOUT_COMMANDS.compile,
        readArgs({ packageRoot: source }),
        { authoringInputRoots: [source], packageLoader: async () => ({ ...pkg, motion: parsed }) },
      );
      expect(compiled).toMatchObject({ ok: true, result: { compilation: { source: { groupId: "pack", childLayerIds: ["a", "b"] } } } });
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  atomicCOW("writes only the outer COW receipt and preserves explicit layout removal evidence", async () => {
    const source = await writePackage();
    const applyOut = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layout-apply-"));
    const removeOut = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layout-remove-"));
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layout-host-receipts-"));
    try {
      const context = { tier: "edit_motion" as const, authoringInputRoots: [source, applyOut], authoringOutputRoots: [applyOut, removeOut], receiptsRoot };
      const applied = await dispatchDebugCommand(TIMELINE_LAYOUT_COMMANDS.apply, editArgs({ packageRoot: source, outDir: applyOut }), context);
      expect(applied).toMatchObject({ ok: true, result: { layoutFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), removal: { schema: "shellx-motion/debug-layout-removal@1", applicationId: expect.stringMatching(/^layout-[a-f0-9]{24}$/), applicationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }, application: { disposition: "applied", id: expect.stringMatching(/^layout-[a-f0-9]{24}$/), fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), groupId: "pack", sourceChildLayerIds: ["a", "b"], materializedChildLayerIds: ["a", "b"], generatedLayerIds: [], trackOrders: [] }, budget: { usage: expect.any(Object) }, overflow: { physicalClipping: "refused" }, repeaters: [], outputMotionSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
      if (!applied.ok) throw new Error(applied.error.message);
      const removal = (applied.result as { removal?: unknown }).removal;
      const applyReceipt = JSON.parse(await readFile(join(applyOut, "receipts", "timeline-layout-apply.receipt.json"), "utf8"));
      expect(applyReceipt).toMatchObject({ operation: "timeline.layout.apply", status: "passed", lane: "debug-api", output: { removal, application: (applied.result as { application: unknown }).application, layoutFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), budget: expect.any(Object), overflow: { physicalClipping: "refused" }, repeaters: [], outputMotionSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }, warnings: [] });
      expect(applyReceipt.artifacts).toEqual([
        { role: "motion_package", path: applyOut, status: "available", mediaType: "application/vnd.shellx-motion.package+directory", primary: true },
        { role: "timeline_receipt", path: join(applyOut, "receipts", "timeline-layout-apply.receipt.json"), status: "available", mediaType: "application/json" },
      ]);
      expect(await readdir(join(applyOut, "receipts"))).toEqual(["timeline-layout-apply.receipt.json"]);

      const removed = await dispatchDebugCommand(TIMELINE_LAYOUT_COMMANDS.remove, removeArgs({ packageRoot: applyOut, outDir: removeOut, removal }), context);
      expect(removed).toMatchObject({ ok: true, result: { operation: "remove", revertedAppliedFingerprint: applyReceipt.output.layoutFingerprint, removal, application: { disposition: "removed", id: (removal as { applicationId: string }).applicationId, fingerprint: (removal as { applicationFingerprint: string }).applicationFingerprint, groupId: "pack", sourceChildLayerIds: ["a", "b"], materializedChildLayerIds: ["a", "b"], generatedLayerIds: [], trackOrders: [] }, outputMotionSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
      const removeReceipt = JSON.parse(await readFile(join(removeOut, "receipts", "timeline-layout-remove.receipt.json"), "utf8"));
      expect(removeReceipt).toMatchObject({ operation: "timeline.layout.remove", status: "passed", output: { removal, application: (removed.ok ? removed.result as { application: unknown } : {} ).application, revertedAppliedFingerprint: applyReceipt.output.layoutFingerprint }, warnings: [] });
    } finally {
      await Promise.all([source, applyOut, removeOut, receiptsRoot].map(async (path) => await rm(path, { recursive: true, force: true })));
    }
  });

  atomicCOW("carries the Core overflow refusal into the outer apply receipt", async () => {
    const source = await writePackage({ secondWidth: 100 });
    const applyOut = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layout-overflow-"));
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layout-overflow-host-"));
    try {
      const context = { tier: "edit_motion" as const, authoringInputRoots: [source], authoringOutputRoots: [applyOut], receiptsRoot };
      const applied = await dispatchDebugCommand(TIMELINE_LAYOUT_COMMANDS.apply, editArgs({ packageRoot: source, outDir: applyOut }), context);
      expect(applied).toMatchObject({ ok: true, warnings: [expect.stringContaining("physical clipping is refused")], result: { overflow: { policy: "clip", outsideSlotCount: 1, clippedSlotCount: 1, physicalClipping: "refused" } } });
      const receipt = JSON.parse(await readFile(join(applyOut, "receipts", "timeline-layout-apply.receipt.json"), "utf8"));
      expect(receipt).toMatchObject({ status: "warning", warnings: [expect.stringContaining("physical clipping is refused")], output: { overflow: { policy: "clip", outsideSlotCount: 1, clippedSlotCount: 1, physicalClipping: "refused" } } });
    } finally {
      await Promise.all([source, applyOut, receiptsRoot].map(async (path) => await rm(path, { recursive: true, force: true })));
    }
  });

  atomicCOW("persists materialized repeaters and removes them only through the stable application marker", async () => {
    const source = await writePackage();
    const applyOut = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layout-repeat-apply-"));
    const removeOut = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layout-repeat-remove-"));
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layout-repeat-host-"));
    try {
      const context = { tier: "edit_motion" as const, authoringInputRoots: [source, applyOut], authoringOutputRoots: [applyOut, removeOut], receiptsRoot };
      const applied = await dispatchDebugCommand(TIMELINE_LAYOUT_COMMANDS.apply, editArgs({ packageRoot: source, outDir: applyOut, repeaters: [repeater("a", 2)] }), context);
      if (!applied.ok) throw new Error(applied.error.message);
      const removal = (applied.result as { removal?: unknown }).removal;
      expect(applied).toMatchObject({ ok: true, result: { removal: { applicationId: expect.stringMatching(/^layout-[a-f0-9]{24}$/), applicationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }, application: { disposition: "applied", groupId: "pack", sourceChildLayerIds: ["a", "b"], materializedChildLayerIds: ["a", "a__layout_repeat_1", "b"], generatedLayerIds: ["a__layout_repeat_1"], trackOrders: [] }, changedLayerIds: expect.arrayContaining(["pack", "a", "b", "a__layout_repeat_1"]) } });
      const appliedMotion = JSON.parse(await readFile(join(applyOut, "motion.json"), "utf8"));
      expect(appliedMotion.layers.find((layer: { id: string }) => layer.id === "pack")?.childLayerIds).toEqual(["a", "a__layout_repeat_1", "b"]);
      expect(appliedMotion.layoutApplications).toHaveLength(1);

      const removed = await dispatchDebugCommand(TIMELINE_LAYOUT_COMMANDS.remove, removeArgs({ packageRoot: applyOut, outDir: removeOut, removal }), context);
      if (!removed.ok) throw new Error(removed.error.message);
      expect(removed).toMatchObject({ ok: true, result: { removal, application: { disposition: "removed", groupId: "pack", sourceChildLayerIds: ["a", "b"], materializedChildLayerIds: ["a", "a__layout_repeat_1", "b"], generatedLayerIds: ["a__layout_repeat_1"], trackOrders: [] }, revertedAppliedFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } });
      const removedMotion = JSON.parse(await readFile(join(removeOut, "motion.json"), "utf8"));
      expect(removedMotion.layers.find((layer: { id: string }) => layer.id === "pack")?.childLayerIds).toEqual(["a", "b"]);
      expect(removedMotion.layers.some((layer: { id: string }) => layer.id === "a__layout_repeat_1")).toBe(false);
      expect(removedMotion.layoutApplications).toBeUndefined();
    } finally {
      await Promise.all([source, applyOut, removeOut, receiptsRoot].map(async (path) => await rm(path, { recursive: true, force: true })));
    }
  });
});

const layout = {
  schema: "shellx-motion/layout@1", kind: "row", width: 100, height: 100,
  padding: { top: 10, right: 10, bottom: 10, left: 10 }, gap: 2,
  align: { x: "start", y: "center" }, distribution: "start", overflow: "clip",
} as const;

function readArgs(values: Record<string, unknown> = {}): Record<string, unknown> { return { packageRoot: "/package", groupId: "pack", layout, repeaters: [], ...values }; }
function editArgs(values: Record<string, unknown> = {}): Record<string, unknown> { return { packageRoot: "/package", outDir: "/out", groupId: "pack", layout, repeaters: [], ...values }; }
function removeArgs(values: Record<string, unknown> = {}): Record<string, unknown> { return { packageRoot: "/package", outDir: "/out", ...values }; }
function removalState() {
  return {
    schema: "shellx-motion/debug-layout-removal@1", applicationId: `layout-${"a".repeat(24)}`, applicationFingerprint: "a".repeat(64),
  };
}
function repeater(sourceId: string, count: number) { return { schema: "shellx-motion/repeater@1", sourceId, count, transformDelta: { x: 0, y: 0, scale: 0, rotation: 0 }, opacityDelta: 0, indexTimeStaggerMs: 0 }; }
function unavailableServices(onLoad: () => void) { return { packageLoader: async () => { onLoad(); throw new Error("invalid arguments must not load a package"); } }; }

async function writePackage(options: { secondWidth?: number } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layout-source-"));
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1", id: "pkg_debug_layout", name: "Debug layout", motion: "motion.json", assets: [], sourceApp: "shellx-motion", compatibility: { lanes: ["native"], hosts: ["motion"] },
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1", id: "motion_debug_layout", name: "Debug layout", durationMs: 500, fps: 30, width: 100, height: 100,
    layers: [{ id: "pack", type: "group", startMs: 0, durationMs: 300, childLayerIds: ["a", "b"] }, child("a", 0), child("b", 0, options.secondWidth)], assets: [], provenance: { sourceApp: "test", createdBy: "test" },
  }, null, 2)}\n`);
  return root;
}
function inMemoryPackage(root: string): MotionPackage {
  return {
    root,
    manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_debug_layout", name: "Debug layout", motion: "motion.json", assets: [], sourceApp: "shellx-motion", compatibility: { lanes: ["native"], hosts: ["motion"] } },
    motion: { schema: "shellx-motion/motion@1", id: "motion_debug_layout", name: "Debug layout", durationMs: 500, fps: 30, width: 100, height: 100, layers: [{ id: "pack", type: "group", startMs: 0, durationMs: 300, childLayerIds: ["a", "b"] }, child("a", 0), child("b", 0)], assets: [], provenance: { sourceApp: "test", createdBy: "test" } },
  } as MotionPackage;
}
function child(id: string, x: number, width = 30) { return { id, type: "shape", shape: "rect", startMs: 0, durationMs: 100, transform: { x, y: 0, width, height: 20, scale: 1, rotation: 0, opacity: 1 } }; }
