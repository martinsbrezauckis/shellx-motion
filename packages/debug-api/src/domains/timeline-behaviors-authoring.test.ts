import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as Core from "@shellx-motion/core";
import { canonicalJson, loadMotionPackage, type MotionDocument, type MotionPackage } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { TIMELINE_BEHAVIOR_COMMAND_METADATA } from "../command-metadata-timeline-behaviors.js";
import { debugCommandDefinition } from "../command-registry.js";
import { withTestAuthoringRoots } from "../authoring-test-context.test-support.js";
import {
  applyTimelineBehaviorIntent,
  behaviorMutationFacts,
  dispatchTimelineBehaviorAuthoringCommand,
  type TimelineBehaviorAuthoringServices,
  type TimelineBehaviorCore,
} from "./timeline-behaviors-authoring.js";
import { readTimelineBehaviorIntent, TIMELINE_BEHAVIOR_COMMANDS } from "./timeline-behaviors.js";
import { dispatchTimelineStructuralCommand } from "./timeline-structural-dispatch.js";

describe("timeline behaviors Debug authoring", () => {
  it("parses the closed inspect/upsert/remove vocabulary and preserves the complete binding", () => {
    expect(readTimelineBehaviorIntent(TIMELINE_BEHAVIOR_COMMANDS.inspect, { packageRoot: "/pkg" }))
      .toEqual({ ok: true, intent: { kind: "inspect", packageRoot: "/pkg" } });
    expect(readTimelineBehaviorIntent(TIMELINE_BEHAVIOR_COMMANDS.upsert, edit({ binding: binding() })))
      .toEqual({ ok: true, intent: { kind: "upsert", edit: { packageRoot: "/pkg", outDir: "/out" }, binding: binding() } });
    expect(readTimelineBehaviorIntent(TIMELINE_BEHAVIOR_COMMANDS.upsert, edit({ binding: pathSpringBinding() })))
      .toEqual({ ok: true, intent: { kind: "upsert", edit: { packageRoot: "/pkg", outDir: "/out" }, binding: pathSpringBinding() } });
    expect(readTimelineBehaviorIntent(TIMELINE_BEHAVIOR_COMMANDS.remove, edit({ targetLayerId: "subject" })))
      .toEqual({ ok: true, intent: { kind: "remove", edit: { packageRoot: "/pkg", outDir: "/out" }, targetLayerId: "subject" } });
    expect(readTimelineBehaviorIntent(TIMELINE_BEHAVIOR_COMMANDS.upsert, edit({ receiptsRoot: "/caller" })))
      .toEqual({ ok: false, problem: "Unknown argument: receiptsRoot." });
    expect(readTimelineBehaviorIntent(TIMELINE_BEHAVIOR_COMMANDS.upsert, edit({ packageDir: "/other" })))
      .toEqual({ ok: false, problem: "outDir and packageDir must match when both are supplied." });
    expect(Object.values(TIMELINE_BEHAVIOR_COMMANDS).map((command) => debugCommandDefinition(command))).toEqual([
      expect.objectContaining({ permission: "read_motion", mutates: false }),
      expect.objectContaining({ permission: "edit_motion", mutates: true }),
      expect.objectContaining({ permission: "edit_motion", mutates: true }),
    ]);
  });

  it("bounds every envelope before descriptors or values can be visited", async () => {
    for (const command of Object.values(TIMELINE_BEHAVIOR_COMMANDS)) {
      let descriptors = 0, valueGets = 0, loads = 0, outputs = 0;
      const hostile = new Proxy({}, {
        ownKeys: () => Array.from({ length: 10_000 }, (_, index) => `unexpected${index}`),
        getOwnPropertyDescriptor: () => { descriptors += 1; return undefined; },
        get: () => { valueGets += 1; return undefined; },
      });
      expect(readTimelineBehaviorIntent(command, hostile)).toMatchObject({ ok: false, problem: expect.stringContaining("allowance") });
      expect({ descriptors, valueGets }).toEqual({ descriptors: 0, valueGets: 0 });
      const result = await dispatchTimelineBehaviorAuthoringCommand(command, hostile, {
        packageLoader: async () => { loads += 1; throw new Error("must not load"); },
        isUnsafePackageOutputDirectory: async () => { outputs += 1; return false; },
        isEmptyOrAbsentDirectory: async () => { outputs += 1; return true; },
      });
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
      expect({ loads, outputs }).toEqual({ loads: 0, outputs: 0 });
    }
  });

  it("refuses hostile reflection, accessors, symbols, non-enumerables, and sparse values before loading", async () => {
    for (const command of Object.values(TIMELINE_BEHAVIOR_COMMANDS)) {
      for (const hostile of hostileEnvelopes(command)) {
        let loads = 0, outputs = 0;
        const parsed = readTimelineBehaviorIntent(command, hostile.value);
        expect(parsed).toMatchObject({ ok: false });
        expect(hostile.mutations()).toBe(0);
        const result = await dispatchTimelineBehaviorAuthoringCommand(command, hostile.value, {
          packageLoader: async () => { loads += 1; throw new Error("must not load"); },
          isUnsafePackageOutputDirectory: async () => { outputs += 1; return false; },
          isEmptyOrAbsentDirectory: async () => { outputs += 1; return true; },
        });
        expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
        expect({ loads, outputs }).toEqual({ loads: 0, outputs: 0 });
        expect(hostile.mutations()).toBe(0);
      }
    }
    let loads = 0;
    const sparse = edit({ binding: Object.assign([], { 1: binding() }) });
    const sparseResult = await dispatchTimelineBehaviorAuthoringCommand(TIMELINE_BEHAVIOR_COMMANDS.upsert, sparse, { packageLoader: async () => { loads += 1; throw new Error("must not load"); } });
    expect(sparseResult).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(loads).toBe(0);
  });

  it("caps a nested behavior binding before traversing a hostile 100k-key Proxy", async () => {
    let ownKeys = 0, descriptors = 0, valueGets = 0, loads = 0, outputs = 0;
    const binding = new Proxy({}, {
      ownKeys: () => { ownKeys += 1; return Array.from({ length: 100_000 }, (_, index) => `field${index}`); },
      getOwnPropertyDescriptor: () => { descriptors += 1; return undefined; },
      get: () => { valueGets += 1; return undefined; },
    });
    const args = edit({ binding });
    expect(readTimelineBehaviorIntent(TIMELINE_BEHAVIOR_COMMANDS.upsert, args)).toEqual({
      ok: false, problem: "binding exceeds the 512-field data limit.",
    });
    expect({ ownKeys, descriptors, valueGets }).toEqual({ ownKeys: 1, descriptors: 0, valueGets: 0 });
    const result = await dispatchTimelineBehaviorAuthoringCommand(TIMELINE_BEHAVIOR_COMMANDS.upsert, args, {
      packageLoader: async () => { loads += 1; throw new Error("must not load"); },
      isUnsafePackageOutputDirectory: async () => { outputs += 1; return false; },
      isEmptyOrAbsentDirectory: async () => { outputs += 1; return true; },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect({ loads, outputs }).toEqual({ loads: 0, outputs: 0 });
  });

  it("uses Core's exact 12-key binding boundary before package load for ordinary and proxy records", async () => {
    const thirteen = { ...binding(), extra0: 0, extra1: 1, extra2: 2, extra3: 3, extra4: 4, extra5: 5, extra6: 6 };
    expect(readTimelineBehaviorIntent(TIMELINE_BEHAVIOR_COMMANDS.upsert, edit({ binding: thirteen })))
      .toMatchObject({ ok: false, problem: expect.stringContaining("12-field record limit") });

    let ownKeys = 0, descriptors = 0, valueGets = 0;
    const target = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field${index}`, index]));
    const hundred = new Proxy(target, {
      ownKeys(inner) { ownKeys += 1; return Reflect.ownKeys(inner); },
      getOwnPropertyDescriptor(inner, key) { descriptors += 1; return Reflect.getOwnPropertyDescriptor(inner, key); },
      get() { valueGets += 1; return undefined; },
    });
    expect(readTimelineBehaviorIntent(TIMELINE_BEHAVIOR_COMMANDS.upsert, edit({ binding: hundred })))
      .toMatchObject({ ok: false, problem: expect.stringContaining("12-field record limit") });
    expect({ ownKeys, descriptors, valueGets }).toEqual({ ownKeys: 1, descriptors: 100, valueGets: 0 });

    let loads = 0, outputs = 0;
    const result = await dispatchTimelineBehaviorAuthoringCommand(TIMELINE_BEHAVIOR_COMMANDS.upsert, edit({ binding: thirteen }), {
      packageLoader: async () => { loads += 1; throw new Error("must not load"); },
      isUnsafePackageOutputDirectory: async () => { outputs += 1; return false; },
      isEmptyOrAbsentDirectory: async () => { outputs += 1; return true; },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect({ loads, outputs }).toEqual({ loads: 0, outputs: 0 });
  });

  it("uses only the public Core operations, strips transport data, and binds exact before/after facts", () => {
    const calls: unknown[] = [];
    const parsed = readTimelineBehaviorIntent(TIMELINE_BEHAVIOR_COMMANDS.upsert, edit({ binding: binding() }));
    if (!parsed || !parsed.ok || parsed.intent.kind !== "upsert") throw new Error("expected upsert intent");
    const mutation = applyTimelineBehaviorIntent(motion(), parsed.intent, { behaviors: recordingCore(calls) });
    expect(calls).toEqual([{ binding: binding() }]);
    expect(behaviorMutationFacts(mutation)).toMatchObject({
      outputMotionSha256: Core.canonicalJsonSha256(mutation.motion),
      behaviors: {
        action: "upserted", targetLayerId: "subject", changedPaths: ["/behaviors/bindings/0"],
        beforeSourceSha256: null, afterSourceSha256: expect.any(String),
        beforeStaticPlan: { fingerprint: expect.any(String), behaviorSourceSha256: null, budget: expect.any(Object) },
        afterStaticPlan: { fingerprint: expect.any(String), behaviorSourceSha256: expect.any(String), budget: expect.any(Object) },
      },
    });
  });

  it("refuses no-op, missing removal, invalid stores, and locks without changing a frozen source", () => {
    const seeded = Core.upsertMotionBehavior(motion(), { binding: binding() }).motion;
    const noOp = deepFreeze(seeded), noOpBefore = canonicalJson(noOp);
    expect(() => applyTimelineBehaviorIntent(noOp, { kind: "upsert", edit: editTransport(), binding: binding() }, {})).toThrow("did not change");
    expect(canonicalJson(noOp)).toBe(noOpBefore);
    const missing = deepFreeze(motion()), missingBefore = canonicalJson(missing);
    expect(() => applyTimelineBehaviorIntent(missing, { kind: "remove", edit: editTransport(), targetLayerId: "subject" }, {})).toThrow("is absent");
    expect(canonicalJson(missing)).toBe(missingBefore);
    const invalid = deepFreeze({ ...motion(), behaviors: { schema: "shellx-motion/behaviors@1", bindings: [{ ...binding(), unknown: true }] } } as unknown as MotionDocument);
    const invalidBefore = canonicalJson(invalid);
    expect(() => applyTimelineBehaviorIntent(invalid, { kind: "remove", edit: editTransport(), targetLayerId: "subject" }, {})).toThrow("unknown field");
    expect(canonicalJson(invalid)).toBe(invalidBefore);
    const locked = deepFreeze({ ...seeded, layers: seeded.layers.map((layer) => layer.id === "subject" ? { ...layer, locked: true } : layer) });
    const lockedBefore = canonicalJson(locked);
    expect(() => applyTimelineBehaviorIntent(locked, { kind: "remove", edit: editTransport(), targetLayerId: "subject" }, {})).toThrow("locked layer");
    expect(canonicalJson(locked)).toBe(lockedBefore);
  });

  it("routes read-only inspection through production structural dispatch without a receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-behaviors-inspect-"));
    try {
      const pkg = packageFor(root);
      const result = await dispatchTimelineStructuralCommand(
        TIMELINE_BEHAVIOR_COMMANDS.inspect,
        { packageRoot: pkg.root },
        withTestAuthoringRoots({ packageLoader: async () => pkg }, { inputRoots: [pkg.root] }),
      );
      expect(result).toMatchObject({ ok: true, result: { inspection: { store: null, staticPlan: { behaviorSourceSha256: null } } } });
      expect(result).not.toHaveProperty("receiptId");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("keeps metadata one-to-one and refuses an actually group-writable output topology", async () => {
    expect(Object.keys(TIMELINE_BEHAVIOR_COMMAND_METADATA).sort()).toEqual(Object.values(TIMELINE_BEHAVIOR_COMMANDS).sort());
    expect(TIMELINE_BEHAVIOR_COMMAND_METADATA[TIMELINE_BEHAVIOR_COMMANDS.inspect]).not.toHaveProperty("expectedReceipts");
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-m2607-behavior-topology-refusal-"));
    try {
      const anchor = await createTrustedWorkspaceAnchor(root);
      const source = join(root, "source");
      const outputRoot = join(root, "output-root");
      const unsafeParent = join(outputRoot, "group-writable");
      const outDir = join(unsafeParent, "output");
      await cp(fixtureRoot, source, { recursive: true });
      await mkdir(outputRoot, { mode: 0o700 });
      await mkdir(unsafeParent, { mode: 0o700 });
      await chmod(unsafeParent, 0o777);
      const before = await readFile(join(source, "motion.json"), "utf8");
      const result = await withTrustedWorkspaceAnchor(anchor, async () => await dispatchTimelineBehaviorAuthoringCommand(TIMELINE_BEHAVIOR_COMMANDS.upsert, {
        packageRoot: source, outDir, binding: { ...binding(), targetLayerId: "midnight-field", durationUs: 7_200_000 },
      }, {
        authoringInputRoots: [source], authoringOutputRoots: [outputRoot], packageLoader: loadMotionPackage,
        isUnsafePackageOutputDirectory: async () => false,
        isEmptyOrAbsentDirectory: async () => true,
      }));
      expect(result).toMatchObject({ ok: false, error: { code: "timeline_behavior_failed", message: expect.stringMatching(/group- or world-writable/i) } });
      expect(existsSync(outDir)).toBe(false);
      expect(await readFile(join(source, "motion.json"), "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function edit(values: Record<string, unknown>): Record<string, unknown> { return { packageRoot: "/pkg", outDir: "/out", ...values }; }
function editTransport() { return { packageRoot: "/pkg", outDir: "/out" }; }
function binding() { return { targetLayerId: "subject", enabled: true, kind: "transform", startUs: 0, durationUs: 1_000, motion: { kind: "gravity", velocityX: 1, velocityY: 0, gravityY: 0 } }; }
function pathSpringBinding() {
  return {
    targetLayerId: "subject", enabled: true, kind: "path-follow", startUs: 0, durationUs: 1_000,
    easing: { type: "spring", stiffness: 100, damping: 20 },
    geometry: { schema: "shellx-motion/shape-geometry@1", kind: "path", viewBox: { x: 0, y: 0, width: 10, height: 10 }, data: "M 0 0 L 10 0 L 10 10 Z" },
  };
}
function motion(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "behavior-debug", name: "Behavior Debug", durationMs: 1_000, fps: 30, width: 100, height: 100, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{ id: "subject", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 10, height: 10 } }],
  } as MotionDocument;
}
function packageFor(root: string): MotionPackage {
  return { root, manifest: { schema: "shellx-motion/package-manifest@1", id: "behavior-debug-package", name: "Behavior Debug", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] } }, motion: motion() };
}
function recordingCore(calls: unknown[]): TimelineBehaviorCore {
  return {
    inspectMotionBehaviors: Core.inspectMotionBehaviors,
    upsertMotionBehavior: (source, input) => { calls.push(input); return Core.upsertMotionBehavior(source, input); },
    removeMotionBehavior: Core.removeMotionBehavior,
  };
}
function hostileEnvelopes(command: typeof TIMELINE_BEHAVIOR_COMMANDS[keyof typeof TIMELINE_BEHAVIOR_COMMANDS]): Array<{ value: unknown; mutations: () => number }> {
  const value = command === TIMELINE_BEHAVIOR_COMMANDS.inspect ? { packageRoot: "/pkg" }
    : command === TIMELINE_BEHAVIOR_COMMANDS.upsert ? edit({ binding: binding() }) : edit({ targetLayerId: "subject" });
  const accessorKey = command === TIMELINE_BEHAVIOR_COMMANDS.upsert ? "binding" : command === TIMELINE_BEHAVIOR_COMMANDS.remove ? "targetLayerId" : "packageRoot";
  let mutations = 0;
  const accessor = { ...value } as Record<string, unknown>;
  delete accessor[accessorKey];
  Object.defineProperty(accessor, accessorKey, { enumerable: true, get() { mutations += 1; Object.defineProperty(accessor, "observed", { value: true, enumerable: true }); return "must not read"; } });
  const nonEnumerable = { ...value }; Object.defineProperty(nonEnumerable, accessorKey, { value: "hidden", enumerable: false });
  const symbol = { ...value, [Symbol("hostile")]: true };
  return [
    { value: new Proxy(value, { ownKeys: () => { throw new Error("ownKeys"); } }), mutations: () => 0 },
    { value: new Proxy(value, { getPrototypeOf: () => { throw new Error("prototype"); } }), mutations: () => 0 },
    { value: new Proxy(value, { getOwnPropertyDescriptor: () => { throw new Error("descriptor"); } }), mutations: () => 0 },
    { value: Object.freeze(accessor), mutations: () => mutations },
    { value: nonEnumerable, mutations: () => 0 },
    { value: symbol, mutations: () => 0 },
  ];
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/packages/gpu-g9-particle-cathedral");
