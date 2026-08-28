import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "../../canonical-json";
import { createCheckpointStoryboard } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-records";
import { createTransitionRecipe } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-recipes";
import {
  admitCheckpointStoryboardRetainedTraceRecordProfile,
  compileCheckpointStoryboardRetainedTraceProfilePlan,
  readCheckpointStoryboardRetainedTraceProfileRequest,
} from "./checkpoint-storyboard-retained-trace-profile";
import {
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS,
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_REQUEST_SCHEMA,
} from "./checkpoint-storyboard-retained-trace-profile-types";

const HASH = "a".repeat(64);

function descriptor(options: {
  readonly durationUs?: number;
  readonly sampleIntervalUs?: number;
  readonly driver?: unknown;
  readonly retention?: unknown;
  readonly output?: unknown;
  readonly drawers?: unknown[];
  readonly caps?: unknown;
} = {}): any {
  const durationUs = options.durationUs ?? 4_000;
  const sampleIntervalUs = options.sampleIntervalUs ?? 1_000;
  const sampleCount = Math.floor(durationUs / sampleIntervalUs) + 1 + (durationUs % sampleIntervalUs === 0 ? 0 : 1);
  const drawer = {
    id: "line",
    driver: options.driver ?? {
      kind: "parametric-graph",
      graph: {
        nodes: [
          { id: "time", kind: "time-us" },
          { id: "scale", kind: "constant", value: 0.001 },
          { id: "x", kind: "multiply", left: "time", right: "scale" },
          { id: "zero", kind: "constant", value: 0 },
        ],
        output: { x: "x", y: "zero", z: "zero" },
      },
    },
    retention: options.retention ?? { kind: "full-clip", maxSamples: sampleCount },
    output: options.output ?? {
      mode: "line",
      width: { source: "constant", from: 2, to: 2 },
      colour: { source: "constant", from: 0.5, to: 0.5 },
      opacity: { source: "constant", from: 0.75, to: 0.75 },
      speedLimit: 100,
    },
  };
  return {
    schema: "shellx-motion/private-parametric-trace@1",
    clip: { durationUs, sampleIntervalUs },
    drawers: options.drawers ?? [drawer],
    caps: options.caps ?? { perDrawer: { ...CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS }, aggregate: { ...CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS } },
  };
}

function request(options: {
  readonly durationMs?: number;
  readonly capabilityRequirements?: readonly string[];
  readonly opacity?: number;
  readonly baseOpacity?: number;
  readonly trace?: unknown;
  readonly binding?: { readonly objectId: string; readonly layerId: string };
} = {}): any {
  const durationMs = options.durationMs ?? 4;
  const opacity = options.opacity ?? 0.75;
  const trace = options.trace ?? descriptor({ durationUs: durationMs * 1_000 });
  const recipe = createTransitionRecipe({ recipeId: "retained-line", seed: 2, exactBaseRequirements: [], intent: { kind: "parametric-trace", outputObjectId: "trace-anchor", trace } });
  const storyboard = createCheckpointStoryboard({
    seed: 1,
    capabilityRequirements: options.capabilityRequirements ?? ["renderer.gpu"],
    objectCatalog: [{ objectId: "trace-anchor", rootShapeKind: "rect", propertyMask: ["opacity"] }],
    checkpoints: [
      { id: "start", atUs: 0, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: opacity }] }] },
      { id: "finish", atUs: durationMs * 1_000, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: opacity }] }] },
    ],
    edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "trace-anchor" }], recipeIds: ["retained-line"] }],
    recipes: [recipe],
  });
  return {
    schema: CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_REQUEST_SCHEMA,
    storyboard,
    base: {
      packageId: "package-1",
      manifest: {
        schema: "shellx-motion/package-manifest@1",
        id: "package-1",
        name: "Private C6B7a retained trace fixture",
        motion: "motion.json",
        assets: [],
        sourceApp: "test",
        compatibility: { lanes: ["gpu"], hosts: [] },
      },
      motion: {
        schema: "shellx-motion/motion@1",
        id: "motion-1",
        name: "Private C6B7a retained trace fixture",
        durationMs,
        fps: 30,
        width: 1280,
        height: 720,
        assets: [],
        provenance: { sourceApp: "test", createdBy: "test" },
        layers: [{ id: "trace-anchor", type: "shape", shape: "rect", fill: "#4e8cff", startMs: 0, durationMs, opacity: options.baseOpacity ?? opacity, transform: { x: 0, y: 0, width: 100, height: 100 } }],
      },
      persistedMotionSha256: HASH,
    },
    objectLayerBindings: [options.binding ?? { objectId: "trace-anchor", layerId: "trace-anchor" }],
  };
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

describe("private C6B7a checkpoint retained-trace profile compiler", () => {
  it("binds one sealed C6 record to one frozen C4C retained line plan without a package write", () => {
    const input = request();
    const plan = compileCheckpointStoryboardRetainedTraceProfilePlan(input);

    expect(admitCheckpointStoryboardRetainedTraceRecordProfile(input.storyboard)).toEqual(input.storyboard);
    expect(plan).toMatchObject({
      schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-profile-plan@1",
      storyboard: { id: input.storyboard.id, sha256: input.storyboard.sha256, revision: 1 },
      base: {
        package: { id: "package-1", motionPath: "motion.json" },
        manifest: { id: "package-1" },
        canonicalMotion: { id: "motion-1" },
        persistedMotion: { id: "motion-1", sha256: HASH },
      },
      lowererProfile: {
        requiredCapability: "renderer.gpu",
        rootShapeKind: "rect",
        checkpointPropertyMask: ["opacity"],
        lifecycle: "preserve",
        drawerCount: 1,
        driverKind: "parametric-graph",
        retention: "full-clip",
        outputMode: "line",
        signals: "constant",
        caps: CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS,
      },
      objectLayerBinding: { objectId: "trace-anchor", layerId: "trace-anchor", layerIndex: 0, rootShapeKind: "rect", staticOpacity: 0.75 },
      projection: {
        outputObjectId: "trace-anchor",
        trace: {
          schema: "shellx-motion/private-parametric-trace-plan@1",
          schedule: [0, 1_000, 2_000, 3_000, 4_000],
          drawers: [{ id: "line", driver: { kind: "parametric-graph" }, retention: { kind: "full-clip", maxSamples: 5 }, output: { mode: "line" } }],
        },
      },
      budget: { objects: 1, checkpoints: 2, edges: 1, recipes: 1, scheduleSamples: 5, vertices: 5 },
      evidence: { noPackageIO: true, noPackageWrites: true, noCOW: true, noReceipt: true, noPublicSurface: true, noRenderer: true, noGpuExecutionWrapper: true },
    });
    expect(plan).not.toHaveProperty("intendedChanges");
    expect(plan.projection).not.toHaveProperty("path");
    expect(plan.projection.trace.evidence).toMatchObject({ noRenderer: true, noPixelClaim: true });
  });

  it("is deterministic, detached, deep-frozen, and binds every C4C identity and budget", () => {
    const input = request();
    const before = JSON.stringify(input);
    const first = compileCheckpointStoryboardRetainedTraceProfilePlan(input);
    const replay = compileCheckpointStoryboardRetainedTraceProfilePlan(clone(input));
    const revised = compileCheckpointStoryboardRetainedTraceProfilePlan(request({ trace: descriptor({ output: { mode: "line", width: { source: "constant", from: 3, to: 3 }, colour: { source: "constant", from: 0.5, to: 0.5 }, opacity: { source: "constant", from: 0.75, to: 0.75 }, speedLimit: 100 } }) }));
    expect(JSON.stringify(input)).toBe(before);
    expect(replay).toEqual(first);
    expect(revised.fingerprint).not.toBe(first.fingerprint);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.lowererProfile.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.projection.trace.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.projection.trace.sourceSha256).toBe(canonicalJsonSha256(descriptor()));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.projection.trace.schedule)).toBe(true);
    expect(Object.isFrozen(first.projection.trace.drawers[0]!.windows)).toBe(true);
    expect(first.budget.compileWorkUnits).toBeLessThanOrEqual(CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS.maxWorkUnits);
    expect(first.budget.peakBytes).toBeLessThanOrEqual(CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS.maxBytes);
  });

  it("refuses a widened storyboard, base, driver, retention, output, schedule, or cap before materialization", () => {
    expect(() => compileCheckpointStoryboardRetainedTraceProfilePlan(request({ capabilityRequirements: ["renderer.native"] }))).toThrow("renderer.gpu");
    expect(() => compileCheckpointStoryboardRetainedTraceProfilePlan(request({ binding: { objectId: "trace-anchor", layerId: "other" } }))).toThrow("same-ID");
    expect(() => compileCheckpointStoryboardRetainedTraceProfilePlan(request({ baseOpacity: 0.5 }))).toThrow("static base opacity");
    expect(() => compileCheckpointStoryboardRetainedTraceProfilePlan(request({ trace: descriptor({ driver: { kind: "path-follow", startUs: 0, durationUs: 4_000, geometry: { schema: "shellx-motion/shape-geometry@1", kind: "path", viewBox: { x: 0, y: 0, width: 1, height: 1 }, data: "M 0 0 L 1 1" } } }) }))).toThrow("parametric-graph");
    expect(() => compileCheckpointStoryboardRetainedTraceProfilePlan(request({ trace: descriptor({ retention: { kind: "last-samples", samples: 2 } }) }))).toThrow("full-clip");
    expect(() => compileCheckpointStoryboardRetainedTraceProfilePlan(request({ trace: descriptor({ output: { mode: "ribbon", width: { source: "constant", from: 2, to: 2 }, colour: { source: "constant", from: 0.5, to: 0.5 }, opacity: { source: "constant", from: 0.75, to: 0.75 }, speedLimit: 100 } }) }))).toThrow("constant line");
    expect(() => compileCheckpointStoryboardRetainedTraceProfilePlan(request({ trace: descriptor({ output: { mode: "line", width: { source: "age", from: 2, to: 4 }, colour: { source: "constant", from: 0.5, to: 0.5 }, opacity: { source: "constant", from: 0.75, to: 0.75 }, speedLimit: 100 } }) }))).toThrow("constant line");
    expect(() => compileCheckpointStoryboardRetainedTraceProfilePlan(request({ durationMs: 64, trace: descriptor({ durationUs: 64_000, sampleIntervalUs: 1_000 }) }))).toThrow("2..64");
    expect(() => compileCheckpointStoryboardRetainedTraceProfilePlan(request({ trace: descriptor({ caps: { perDrawer: { ...CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS, maxBytes: 1 }, aggregate: { ...CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS, maxBytes: 1 } } }) }))).toThrow("fixed per-drawer");

    expect(() => admitCheckpointStoryboardRetainedTraceRecordProfile(request({ trace: descriptor({ driver: { kind: "path-follow", startUs: 0, durationUs: 4_000, geometry: { schema: "shellx-motion/shape-geometry@1", kind: "path", viewBox: { x: 0, y: 0, width: 1, height: 1 }, data: "M 0 0 L 1 1" } } }) }).storyboard)).toThrow("parametric-graph");
    expect(() => admitCheckpointStoryboardRetainedTraceRecordProfile(request({ trace: descriptor({ retention: { kind: "last-samples", samples: 2 } }) }).storyboard)).toThrow("full-clip");
    expect(() => admitCheckpointStoryboardRetainedTraceRecordProfile(request({ trace: descriptor({ output: { mode: "line", width: { source: "age", from: 2, to: 4 }, colour: { source: "constant", from: 0.5, to: 0.5 }, opacity: { source: "constant", from: 0.75, to: 0.75 }, speedLimit: 100 } }) }).storyboard)).toThrow("constant line");
    expect(() => admitCheckpointStoryboardRetainedTraceRecordProfile(request({ trace: descriptor({ caps: { perDrawer: { ...CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS, maxBytes: 1 }, aggregate: { ...CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS, maxBytes: 1 } } }) }).storyboard)).toThrow("fixed per-drawer");

    const base = clone(request());
    base.base.motion.assets = [{ id: "asset-1", path: "asset.png", type: "image" }];
    expect(() => compileCheckpointStoryboardRetainedTraceProfilePlan(base)).toThrow("asset-free");
    base.base.motion.assets = [];
    base.base.motion.layers[0].keyframes = { opacity: [] };
    expect(() => compileCheckpointStoryboardRetainedTraceProfilePlan(base)).toThrow("authority");
  });

  it("preserves hostile snapshot rules and has no package write, public-root, or GPU-wrapper route", () => {
    const hostile: Record<string, unknown> = { schema: CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_REQUEST_SCHEMA, base: {}, objectLayerBindings: [] };
    let getterCalls = 0;
    Object.defineProperty(hostile, "storyboard", { enumerable: true, get() { getterCalls += 1; return request().storyboard; } });
    expect(() => readCheckpointStoryboardRetainedTraceProfileRequest(hostile)).toThrow("enumerable data field");
    expect(getterCalls).toBe(0);

    const source = readFileSync(new URL("./checkpoint-storyboard-retained-trace-profile.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:(?:fs|path)|\b(?:readFile|writeFile|mkdir|rename)\b/i);
    expect(source).not.toMatch(/compileGpuParametricTracePreview(?:Static|Frame)Plan|readGpuParametricTracePreviewUpload|renderGpuParametricTracePreview/);
    const index = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } };
    expect(index).not.toContain("checkpoint-storyboard-retained-trace");
    expect(manifest.exports).toHaveProperty("./internal/checkpoint-storyboard-retained-trace-profile", "./src/internal/checkpoint-storyboard/checkpoint-storyboard-retained-trace-profile.ts");
    expect(manifest.publishConfig.exports).toHaveProperty("./internal/checkpoint-storyboard-retained-trace-profile");
  });
});
