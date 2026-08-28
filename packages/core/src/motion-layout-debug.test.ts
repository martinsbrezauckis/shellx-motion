import { describe, expect, it } from "vitest";
import { runMotionLayoutDebug } from "./motion-layout-debug";
import { createMotionLayoutApplication, motionLayoutApplicationFingerprint } from "./motion-layout-application";
import { mintMotionLayoutRemovalAuthorization } from "./motion-layout-removal-authority";
import { buildLayoutApplicationDefinitions } from "./motion-public-schema-layout-applications";
import type { MotionLayoutDebugApplied, MotionLayoutDebugIntent, MotionLayoutDebugOperation, MotionLayoutDebugResult } from "./motion-layout-debug";
import type { MotionDocument, MotionLayer, MotionTrack } from "./types";
import { loadSchema, validateDocument } from "./validate";

describe("closed Debug layout intent adapter", () => {
  it("strictly parses inspect/compile intent and receipts bounded slot-only facts without mutation", () => {
    const motion = document([group("pack", ["a"]), child("a")]);
    const before = structuredClone(motion);
    const inspected = ok(runMotionLayoutDebug(intent("inspect", motion)));
    expect(inspected).toMatchObject({ operation: "inspect", compilation: { source: { groupId: "pack", childLayerIds: ["a"] }, overflow: { basis: "unscaled-unrotated-layout-slot", physicalClipping: "refused" } }, receipt: { operation: "debug.layout.inspect", inputHashes: { layout: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
    expect(motion).toEqual(before);

    const repeated = intent("compile", motion);
    repeated.repeaters = [repeater("a", 2)];
    const compiled = ok(runMotionLayoutDebug(repeated));
    expect(compiled).toMatchObject({ operation: "compile", compilation: { instances: [expect.objectContaining({ instanceIndex: 0 }), expect.objectContaining({ instanceIndex: 1 })], repeaters: [{ sourceId: "a", count: 2, instanceCount: 2 }] } });

    const outside = document([group("pack", ["a"]), child("a", 0, 100, 500)]);
    const outsideResult = ok(runMotionLayoutDebug(intent("compile", outside)));
    expect(outsideResult).toMatchObject({ compilation: { overflow: { outsideSlotCount: 1, clippedSlotCount: 1, physicalClipping: "refused" } }, receipt: { status: "warning", warnings: [expect.stringContaining("physical clipping is refused")] } });

    expect(codes({ ...intent("inspect", motion), physicalClip: true })).toContain("field.unknown");
    expect(codes({ ...intent("inspect", motion), createdAt: "not-an-instant" })).toContain("intent.created_at");
  });

  it("refuses accessor, symbol, and sparse-array values before the Core parser can execute them", () => {
    const motion = document([group("pack", ["a"]), child("a")]);
    const rootAccessor = intent("compile", motion) as unknown as Record<string, unknown>;
    let rootReads = 0;
    Object.defineProperty(rootAccessor, "operation", { enumerable: true, get: () => { rootReads += 1; return "compile"; } });
    expect(codes(rootAccessor)).toContain("intent.data_only");
    expect(rootReads).toBe(0);
    expect(motion.layers.map((layer) => layer.id)).toEqual(["pack", "a"]);

    const nestedAccessor = intent("compile", motion);
    const nestedTransform = nestedAccessor.motion.layers.find((layer) => layer.id === "a")?.transform as Record<string, unknown>;
    let nestedReads = 0;
    Object.defineProperty(nestedTransform, "x", { enumerable: true, get: () => { nestedReads += 1; return 0; } });
    expect(codes(nestedAccessor)).toContain("intent.data_only");
    expect(nestedReads).toBe(0);
    expect(Object.getOwnPropertyDescriptor(nestedTransform, "x")?.get).toBeTypeOf("function");

    const sparse = intent("compile", motion) as unknown as Record<string, unknown>;
    sparse.repeaters = new Array(1);
    expect(codes(sparse)).toContain("intent.data_only");
    const symbolic = intent("compile", motion) as unknown as Record<string, unknown>;
    (symbolic as Record<PropertyKey, unknown>)[Symbol("hidden")] = "no";
    expect(codes(symbolic)).toContain("intent.data_only");
  });

  it("measures application-record caps in UTF-8 bytes, not JavaScript code units", () => {
    const layout = intent("apply", document([group("pack", ["a"]), child("a")])).layout;
    expect(() => createMotionLayoutApplication({
      groupId: "pack", layoutFingerprint: "a".repeat(64), childLayerIds: ["a"], materializedChildLayerIds: ["a"], layout, repeaters: [],
      patches: [{ layerId: "a", before: { transform: { x: 0, y: 0, width: 30, height: 20, scale: 1, rotation: 0, opacity: 1, "x-note": "€".repeat(50_000) }, timing: { startMs: 0, durationMs: 100 } }, after: { transform: { x: 1, y: 0, width: 30, height: 20, scale: 1, rotation: 0, opacity: 1, "x-note": "€".repeat(50_000) }, timing: { startMs: 0, durationMs: 100 } } }],
      trackPatches: [], generatedLayers: []
    })).toThrow(/byte cap/);

    const motion = document([group("pack", ["a"]), {
      ...child("a"),
      transform: { ...child("a").transform, "x-note": "€".repeat(50_000) }
    }]);
    const before = structuredClone(motion);
    expect(codes(intent("apply", motion))).toContain("apply.application_record");
    expect(motion).toEqual(before);
  });

  it("keeps persisted layout-application schema bounds identical to the layout validator", () => {
    const definitions = buildLayoutApplicationDefinitions() as Record<string, {
      oneOf?: Array<{ properties?: Record<string, Record<string, unknown>> }>;
      properties?: Record<string, Record<string, unknown>>;
    }>;
    const variants = definitions.layoutApplicationLayout.oneOf ?? [];
    const radial = variants.find((variant) => variant.properties?.kind?.const === "radial")?.properties;
    const grid = variants.find((variant) => variant.properties?.kind?.const === "grid")?.properties;
    expect(radial?.padding).toEqual({ $ref: "#/$defs/layoutApplicationPadding" });
    expect((definitions.layoutApplicationPadding.properties?.top as { minimum?: number }).minimum).toBe(0);
    expect((radial?.radius as { minimum?: number }).minimum).toBe(0);
    expect((radial?.startAngleDeg as { minimum?: number; maximum?: number })).toMatchObject({ minimum: -360_000, maximum: 360_000 });
    expect((radial?.sweepAngleDeg as { minimum?: number; maximum?: number })).toMatchObject({ minimum: -360_000, maximum: 360_000 });
    expect((grid?.columns as { maximum?: number }).maximum).toBe(64);
  });

  it("applies only compiled ordinary transform/timing intent by atomic copy-on-write and removes through a document-resident application", async () => {
    const motion = document([
      group("pack", ["first", "second"], 100, 400),
      child("first", 10, 100, 3),
      { ...child("second", 120, 80, 5), transform: { ...child("second", 120, 80, 5).transform, "x-plugin": { authoringMode: "preserve" } }, fill: "#ff00ff", keyframes: { "style.fill": [{ atMs: 0, value: "#ff00ff" }] } },
      child("outside", 0, 100, 0),
    ]);
    const applied = ok(runMotionLayoutDebug(intent("apply", motion)));
    if (applied.operation !== "apply") throw new Error("expected apply result");
    expect(applied.motion).not.toBe(motion);
    expect(applied.motion.layers).not.toBe(motion.layers);
    expect(applied.motion.layers.find((layer) => layer.id === "outside")).toBe(motion.layers.find((layer) => layer.id === "outside"));
    expect(applied.motion.layers.find((layer) => layer.id === "second")).toMatchObject({ fill: "#ff00ff", keyframes: { "style.fill": [{ atMs: 0, value: "#ff00ff" }] }, transform: { x: 47, y: 40, width: 30, height: 20, "x-plugin": { authoringMode: "preserve" } }, startMs: 120, durationMs: 80 });
    expect(applied.receipt).toMatchObject({ operation: "debug.layout.apply", output: { layoutFingerprint: applied.compilation.layoutFingerprint, outputMotionSha256: expect.stringMatching(/^[a-f0-9]{64}$/), budget: applied.compilation.budget, overflow: { physicalClipping: "refused" }, repeaters: [] } });
    expect(applied.applied.removal).toMatchObject({ applicationId: expect.stringMatching(/^layout-[a-f0-9]{24}$/), applicationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(applied.motion.layoutApplications?.[0]?.patches.map((patch) => patch.layerId)).toEqual(["first", "second"]);
    expect(await validateDocument(await loadSchema("motion"), applied.motion)).toEqual({ ok: true });
    expect(motion.layers.find((layer) => layer.id === "first")?.transform?.x).toBe(3);

    const directRemove = runMotionLayoutDebug(removeIntent(applied.motion, applied.applied));
    expect(directRemove.status === "refused" ? directRemove.issues.map((entry) => entry.code) : []).toContain("remove.receipt_authorization");
    const removed = ok(runAuthorizedRemoval(applied.motion, applied.applied));
    if (removed.operation !== "remove") throw new Error("expected remove result");
    expect(removed.motion).toEqual(motion);
    expect(removed.receipt).toMatchObject({ operation: "debug.layout.remove", output: { revertedAppliedFingerprint: applied.compilation.layoutFingerprint } });
  });

  it("materializes repeaters exactly and refuses no-op, unsupported, and stale application state", async () => {
    const repeatMotion = document([group("pack", ["a"]), child("a"), child("outside")]);
    repeatMotion.tracks = [{ id: "stack", type: "overlay", layerIds: ["a", "outside"] }];
    const repeatOriginal = structuredClone(repeatMotion);
    const repeated = intent("apply", repeatMotion);
    repeated.repeaters = [repeater("a", 2)];
    const repeatedApplied = ok(runMotionLayoutDebug(repeated));
    if (repeatedApplied.operation !== "apply") throw new Error("expected materialized apply");
    expect(repeatedApplied.motion.layers.find((layer) => layer.id === "pack")?.childLayerIds).toEqual(["a", "a__layout_repeat_1"]);
    expect(repeatedApplied.motion.layers.map((layer) => layer.id)).toEqual(["pack", "a", "a__layout_repeat_1", "outside"]);
    expect(repeatedApplied.motion.tracks?.[0].layerIds).toEqual(["a", "a__layout_repeat_1", "outside"]);
    expect(repeatedApplied.motion.layoutApplications?.[0]).toMatchObject({ materializedChildLayerIds: ["a", "a__layout_repeat_1"], generatedLayers: [{ id: "a__layout_repeat_1", sourceLayerId: "a", instanceIndex: 1, layerSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
    expect(repeatMotion).toEqual(repeatOriginal);
    const reopened = structuredClone(repeatedApplied.motion);
    expect(await validateDocument(await loadSchema("motion"), reopened)).toEqual({ ok: true });
    const repeatedRemoved = ok(runAuthorizedRemoval(reopened, repeatedApplied.applied));
    if (repeatedRemoved.operation !== "remove") throw new Error("expected materialized remove");
    expect(repeatedRemoved.motion).toEqual(repeatOriginal);
    const changedClone = structuredClone(repeatedApplied.motion);
    changedClone.layers.find((layer) => layer.id === "a__layout_repeat_1")!.name = "changed";
    expect(codes(removeIntent(changedClone, repeatedApplied.applied), removalOptions(repeatedApplied.applied))).toContain("remove.stale_materialization");
    for (const consumer of [
      { ...child("matte-consumer"), matte: { type: "alpha", sourceLayerId: "a__layout_repeat_1" } },
      { ...child("duck-consumer"), type: "audio", ducking: { triggerLayerIds: ["a__layout_repeat_1"] } },
      { ...child("scene-consumer"), type: "environment", environment: { sceneSourceLayerId: "a__layout_repeat_1" } } as MotionLayer,
      { ...child("mask-consumer"), type: "environment", environment: { effectMaskLayerId: "a__layout_repeat_1" } } as MotionLayer
    ]) {
      const externallyReferenced = structuredClone(repeatedApplied.motion);
      externallyReferenced.layers.push(consumer);
      const original = structuredClone(externallyReferenced);
      expect(codes(removeIntent(externallyReferenced, repeatedApplied.applied), removalOptions(repeatedApplied.applied))).toContain("remove.stale_materialization");
      expect(externallyReferenced).toEqual(original);
    }
    const cloneOnlyMotion = document([group("pack", ["a"]), child("a")]);
    const cloneOnly = intent("apply", cloneOnlyMotion);
    cloneOnly.layout = { schema: "shellx-motion/layout@1", kind: "stack", width: 30, height: 20, padding: { top: 0, right: 0, bottom: 0, left: 0 }, gap: 0, align: { x: "start", y: "start" }, distribution: "start", overflow: "allow" };
    cloneOnly.repeaters = [repeater("a", 2)];
    const cloneOnlyApplied = ok(runMotionLayoutDebug(cloneOnly));
    if (cloneOnlyApplied.operation !== "apply") throw new Error("expected clone-only materialization");
    expect(cloneOnlyApplied.motion.layoutApplications?.[0]).toMatchObject({ patches: [], generatedLayers: [expect.objectContaining({ id: "a__layout_repeat_1" })] });
    const cloneOnlyRemoved = ok(runAuthorizedRemoval(cloneOnlyApplied.motion, cloneOnlyApplied.applied));
    if (cloneOnlyRemoved.operation !== "remove") throw new Error("expected clone-only removal");
    expect(cloneOnlyRemoved.motion).toEqual(cloneOnlyMotion);

    const collision = document([group("pack", ["a"]), child("a"), child("a__layout_repeat_1")]);
    const collisionOriginal = structuredClone(collision);
    const collisionIntent = intent("apply", collision); collisionIntent.repeaters = [repeater("a", 2)];
    expect(codes(collisionIntent)).toContain("apply.materialization");
    expect(collision).toEqual(collisionOriginal);
    const typedSource = document([group("pack", ["a"]), { ...child("a"), matte: { type: "alpha", sourceLayerId: "outside" } }, child("outside")]);
    const typedOriginal = structuredClone(typedSource);
    const typedIntent = intent("apply", typedSource); typedIntent.repeaters = [repeater("a", 2)];
    expect(codes(typedIntent)).toContain("apply.materialization");
    expect(typedSource).toEqual(typedOriginal);
    const groupTiming = intent("compile", repeatMotion);
    groupTiming.repeaters = [{ ...repeater("a", 2), indexTimeStaggerMs: 201 }];
    expect(codes(groupTiming)).toContain("group.local_timing");

    const noOp = document([group("pack", ["a"]), child("a")]);
    const noOpIntent = intent("apply", noOp);
    noOpIntent.layout = { schema: "shellx-motion/layout@1", kind: "stack", width: 30, height: 20, padding: { top: 0, right: 0, bottom: 0, left: 0 }, gap: 0, align: { x: "start", y: "start" }, distribution: "start", overflow: "allow" };
    expect(codes(noOpIntent)).toContain("apply.no_op");

    const origin = document([group("pack", ["a"]), { ...child("a"), transform: { ...child("a").transform, originX: 0.5 } }]);
    expect(codes(intent("inspect", origin))).toContain("child.box_origin");
    const animatedOrigin = document([group("pack", ["a"]), { ...child("a"), keyframes: { "transform.originY": [{ atMs: 0, value: 0.5 }] } }]);
    expect(codes(intent("inspect", animatedOrigin))).toContain("child.animated_box");
    const nested = document([group("outer", ["inner"]), group("inner", ["a"]), child("a")]);
    expect(codes(intent("inspect", nested, "outer"))).toContain("child.nested_group");

    const applied = ok(runMotionLayoutDebug(intent("apply", repeatMotion)));
    if (applied.operation !== "apply") throw new Error("expected apply result");
    const staleOutput = structuredClone(applied.motion);
    const layer = staleOutput.layers.find((entry) => entry.id === "a");
    if (!layer?.transform) throw new Error("expected transform");
    layer.transform.x = 999;
    expect(codes(removeIntent(staleOutput, applied.applied), removalOptions(applied.applied))).toContain("remove.stale_output");
    const staleOwnership = structuredClone(applied.motion);
    const pack = staleOwnership.layers.find((entry) => entry.id === "pack");
    if (!pack) throw new Error("expected group");
    pack.childLayerIds = ["outside"];
    expect(codes(removeIntent(staleOwnership, applied.applied), removalOptions(applied.applied))).toContain("remove.stale_ownership");

    const missingApplication = removeIntent(applied.motion, applied.applied);
    const originalAppliedMotion = structuredClone(applied.motion);
    missingApplication.removal.applicationId = "missing";
    expect(codes(missingApplication)).toContain("remove.application_missing");
    expect(applied.motion).toEqual(originalAppliedMotion);

    const wrongFingerprint = removeIntent(applied.motion, applied.applied);
    wrongFingerprint.removal.applicationFingerprint = "0".repeat(64);
    expect(codes(wrongFingerprint)).toContain("remove.application_fingerprint");
    expect(applied.motion).toEqual(originalAppliedMotion);

    const malformed = removeIntent(applied.motion, applied.applied);
    malformed.removal = { ...malformed.removal, execute: "no" } as typeof malformed.removal;
    expect(codes(malformed)).toContain("field.unknown");
  });

  it("requires a matching host authorization and refuses forged alternate layout markers without mutation", () => {
    const original = document([group("pack", ["a"]), child("a")]);
    const applied = ok(runMotionLayoutDebug(intent("apply", original)));
    if (applied.operation !== "apply") throw new Error("expected apply result");
    const removal = removeIntent(applied.motion, applied.applied);
    expect(codes(removal)).toContain("remove.receipt_authorization");

    const wrong = mintMotionLayoutRemovalAuthorization({
      packageId: TEST_PACKAGE_ID,
      applicationId: applied.applied.removal.applicationId,
      applicationFingerprint: "0".repeat(64),
      receiptId: "layout-test-receipt",
    });
    expect(codes(removal, { packageId: TEST_PACKAGE_ID, removalAuthorization: wrong })).toContain("remove.receipt_authorization");

    const released = removalOptions(applied.applied);
    released.removalAuthorization.release();
    expect(codes(removal, released)).toContain("remove.receipt_authorization");

    const forged = structuredClone(applied.motion);
    const record = forged.layoutApplications?.[0];
    if (!record) throw new Error("expected persisted application record");
    record.layout = { ...record.layout, gap: record.layout.gap + 1 };
    record.fingerprint = motionLayoutApplicationFingerprint(record);
    const forgedRemoval = removeIntent(forged, { schema: "shellx-motion/debug-layout-applied@1", removal: {
      ...applied.applied.removal,
      applicationFingerprint: record.fingerprint,
    } });
    const before = structuredClone(forged);
    expect(codes(forgedRemoval, removalOptions(applied.applied))).toContain("remove.receipt_authorization");
    expect(forged).toEqual(before);
  });
});

const TEST_PACKAGE_ID = "pkg_layout_test";

function intent<T extends Exclude<MotionLayoutDebugOperation, "remove">>(operation: T, motion: MotionDocument, groupId = "pack"): Extract<MotionLayoutDebugIntent, { operation: T }> {
  return {
    schema: "shellx-motion/debug-layout-intent@1" as const, operation, motion, groupId, createdAt: "2026-08-16T00:00:00.000Z",
    layout: { schema: "shellx-motion/layout@1" as const, kind: "row" as const, width: 100, height: 100, padding: { top: 10, right: 10, bottom: 10, left: 10 }, gap: 2, align: { x: "start" as const, y: "center" as const }, distribution: "start" as const, overflow: "clip" as const }, repeaters: [],
  } as Extract<MotionLayoutDebugIntent, { operation: T }>;
}
function removeIntent(motion: MotionDocument, applied: MotionLayoutDebugApplied) {
  return { schema: "shellx-motion/debug-layout-intent@1" as const, operation: "remove" as const, motion, createdAt: "2026-08-16T00:00:00.000Z", removal: structuredClone(applied.removal) };
}
function removalOptions(applied: MotionLayoutDebugApplied, packageId = TEST_PACKAGE_ID) {
  return {
    packageId,
    removalAuthorization: mintMotionLayoutRemovalAuthorization({
      packageId,
      applicationId: applied.removal.applicationId,
      applicationFingerprint: applied.removal.applicationFingerprint,
      receiptId: "layout-test-receipt",
    }),
  };
}
function runAuthorizedRemoval(motion: MotionDocument, applied: MotionLayoutDebugApplied) {
  return runMotionLayoutDebug(removeIntent(motion, applied), removalOptions(applied));
}
function repeater(sourceId: string, count: number) { return { schema: "shellx-motion/repeater@1" as const, sourceId, count, transformDelta: { x: 0, y: 0, scale: 0, rotation: 0 }, opacityDelta: 0, indexTimeStaggerMs: 0 }; }
function document(layers: MotionLayer[]): MotionDocument { return { schema: "shellx-motion/motion@1", id: "motion", name: "Motion", durationMs: 1_000, fps: 30, width: 100, height: 100, layers, assets: [], provenance: { sourceApp: "test", createdBy: "test" } }; }
function group(id: string, childLayerIds: string[], startMs = 0, durationMs = 300): MotionLayer { return { id, type: "group", startMs, durationMs, childLayerIds }; }
function child(id: string, startMs = 0, durationMs = 100, x = 0): MotionLayer { return { id, type: "shape", shape: "rect", startMs, durationMs, transform: { x, y: 0, width: 30, height: 20, scale: 1, rotation: 0, opacity: 1 } }; }
function ok(result: MotionLayoutDebugResult) { if (result.status !== "ok") throw new Error(result.issues.map((entry) => `${entry.code}: ${entry.message}`).join("\n")); return result; }
function codes(value: unknown, options?: Parameters<typeof runMotionLayoutDebug>[1]): string[] { const result = runMotionLayoutDebug(value, options); if (result.status === "ok") throw new Error("expected refusal"); return result.issues.map((entry) => entry.code); }
