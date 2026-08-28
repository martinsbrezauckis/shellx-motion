import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readMotionDocument } from "../../package";
import { loadSchemaSync, validateDocumentSync } from "../../validate";
import { createTransitionRecipe } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-recipes";
import { createCheckpointStoryboard } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-records";
import { admitCheckpointStoryboardC6CRecordProfile } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-scalar-spatial-materializer";
import {
  admitCheckpointStoryboardLifecycleRecordProfile,
  compileCheckpointStoryboardLifecycleProfilePlan,
  readCheckpointStoryboardLifecycleProfileRequest,
} from "../../internal/checkpoint-storyboard/checkpoint-storyboard-lifecycle-profile";
import { CHECKPOINT_STORYBOARD_LIFECYCLE_PROFILE_REQUEST_SCHEMA } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-lifecycle-profile-types";

const HASH = "a".repeat(64);
const MASK = ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] as const;
const creation = (fill: string, width: number, height: number) => ({ schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1" as const, fill, width, height });
const absent = (objectId: string) => ({ objectId, state: "absent" as const, properties: [] });
const present = (objectId: string, x: number, y: number, rotation: number, scale: number, opacity: number) => ({ objectId, state: "present" as const, properties: [
  { property: "transform.x" as const, value: x }, { property: "transform.y" as const, value: y }, { property: "transform.rotation" as const, value: rotation }, { property: "transform.scale" as const, value: scale }, { property: "opacity" as const, value: opacity },
] });

function fixture(options: { readonly capabilityRequirements?: readonly string[]; readonly durationMs?: number; readonly sourceLayerId?: string; readonly sourceAuthority?: string; readonly withoutCreation?: boolean; readonly finalCreate?: boolean; readonly permanentAbsent?: boolean } = {}): any {
  const alpha = present("alpha", 12, 24, 15, 1.25, 0.75), zeta = present("zeta", -10, 40, 0, 1, 1);
  const finalCreate = options.finalCreate === true, permanentAbsent = options.permanentAbsent === true;
  const checkpoints = finalCreate
    ? [
      { id: "start", atUs: 0, objects: [absent("alpha"), absent("zeta")] },
      { id: "finish", atUs: 1_000_000, objects: [present("alpha", 12, 24, 15, 1.25, 0.75), absent("zeta")] },
    ]
    : [
      { id: "start", atUs: 0, objects: [absent("alpha"), absent("zeta")] },
      { id: "zeta-create", atUs: 100_000, objects: [absent("alpha"), permanentAbsent ? absent("zeta") : zeta] },
      { id: "alpha-create", atUs: 300_000, objects: [permanentAbsent ? absent("alpha") : alpha, permanentAbsent ? absent("zeta") : zeta] },
      { id: "zeta-remove", atUs: 700_000, objects: [permanentAbsent ? absent("alpha") : alpha, absent("zeta")] },
      { id: "finish", atUs: 1_000_000, objects: [permanentAbsent ? absent("alpha") : alpha, absent("zeta")] },
    ];
  const edge = (id: string, fromCheckpointId: string, toCheckpointId: string, lifecycle: readonly unknown[]) => ({ id, fromCheckpointId, toCheckpointId, lifecycle, recipeIds: [] });
  const edges = finalCreate
    ? [edge("a-alpha-create", "start", "finish", [{ kind: "create", objectId: "alpha" }, { kind: "preserve", objectId: "zeta" }])]
    : [
      edge("a-zeta-create", "start", "zeta-create", [{ kind: "preserve", objectId: "alpha" }, { kind: permanentAbsent ? "preserve" : "create", objectId: "zeta" }]),
      edge("b-alpha-create", "zeta-create", "alpha-create", [{ kind: permanentAbsent ? "preserve" : "create", objectId: "alpha" }, { kind: "preserve", objectId: "zeta" }]),
      edge("c-zeta-remove", "alpha-create", "zeta-remove", [{ kind: "preserve", objectId: "alpha" }, { kind: permanentAbsent ? "preserve" : "remove", objectId: "zeta" }]),
      edge("d-finish", "zeta-remove", "finish", [{ kind: "preserve", objectId: "alpha" }, { kind: "preserve", objectId: "zeta" }]),
    ];
  const storyboard = createCheckpointStoryboard({
    seed: 1, capabilityRequirements: options.capabilityRequirements ?? ["renderer.native"],
    objectCatalog: [
      { objectId: "alpha", rootShapeKind: "ellipse", propertyMask: MASK, ...(options.withoutCreation ? {} : { creation: creation("#4e8cff", 120, 80) }) },
      { objectId: "zeta", rootShapeKind: "rect", propertyMask: MASK, ...(options.withoutCreation ? {} : { creation: creation("#f3c547", 60, 40) }) },
    ], checkpoints, edges, recipes: [],
  });
  const source: Record<string, unknown> = { id: options.sourceLayerId ?? "title", type: "text", text: "source remains untouched", startMs: 0, durationMs: options.durationMs ?? 1_000 };
  if (options.sourceAuthority) source[options.sourceAuthority] = options.sourceAuthority === "childLayerIds" ? [] : {};
  return {
    schema: CHECKPOINT_STORYBOARD_LIFECYCLE_PROFILE_REQUEST_SCHEMA,
    storyboard,
    base: {
      packageId: "package-1",
      manifest: { schema: "shellx-motion/package-manifest@1", id: "package-1", name: "Private C6B5a fixture", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["native"], hosts: [] } },
      motion: { schema: "shellx-motion/motion@1", id: "motion-1", name: "Private C6B5a fixture", durationMs: options.durationMs ?? 1_000, fps: 30, width: 1280, height: 720, layers: [source], assets: [], provenance: { sourceApp: "test", createdBy: "test" } },
      persistedMotionSha256: HASH,
    },
  };
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function descriptor(storyboard: any): any {
  return clone({ seed: storyboard.seed, capabilityRequirements: storyboard.capabilityRequirements, objectCatalog: storyboard.objectCatalog, checkpoints: storyboard.checkpoints, edges: storyboard.edges, recipes: storyboard.recipes });
}
function reseal(mutator: (value: any) => void): any {
  const value = descriptor(fixture().storyboard);
  mutator(value);
  return createCheckpointStoryboard(value);
}
const GEOMETRY = { schema: "shellx-motion/shape-geometry@1", kind: "line", viewBox: { x: 0, y: 0, width: 10, height: 10 }, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] };

describe("private C6B5a checkpoint lifecycle profile", () => {
  it("admits only the closed base-independent lifecycle record and appends catalog-order frozen layers", () => {
    const input = fixture();
    expect(admitCheckpointStoryboardLifecycleRecordProfile(input.storyboard)).toEqual(input.storyboard);
    expect(admitCheckpointStoryboardC6CRecordProfile(input.storyboard)).toEqual({ storyboard: input.storyboard, profile: "c6b5-lifecycle@1" });
    const plan = compileCheckpointStoryboardLifecycleProfilePlan(input);
    expect(plan).toMatchObject({
      schema: "shellx-motion/private-checkpoint-storyboard-lifecycle-profile-plan@1",
      base: { package: { id: "package-1", motionPath: "motion.json" }, manifest: { id: "package-1" }, canonicalMotion: { id: "motion-1" }, persistedMotion: { id: "motion-1", sha256: HASH } },
      lowererProfile: { supportedCapabilities: ["renderer.browser", "renderer.native"], rootShapeKinds: ["rect", "ellipse"], propertyMask: MASK, lifecycle: "absent-create-present-optional-remove" },
      operations: [
        { objectId: "alpha", targetLayerId: "alpha", create: { edge: { id: "b-alpha-create" }, atMs: 300 }, interval: { startMs: 300, endMs: 1_000, durationMs: 700 } },
        { objectId: "zeta", targetLayerId: "zeta", create: { edge: { id: "a-zeta-create" }, atMs: 100 }, remove: { edge: { id: "c-zeta-remove" }, atMs: 700 }, interval: { startMs: 100, endMs: 700, durationMs: 600 } },
      ],
      layers: [
        { id: "alpha", type: "shape", shape: "ellipse", startMs: 300, durationMs: 700, fill: "#4e8cff", opacity: 0.75, transform: { x: 12, y: 24, rotation: 15, scale: 1.25, width: 120, height: 80, originX: 60, originY: 40 } },
        { id: "zeta", type: "shape", shape: "rect", startMs: 100, durationMs: 600, fill: "#f3c547", opacity: 1, transform: { x: -10, y: 40, rotation: 0, scale: 1, width: 60, height: 40, originX: 30, originY: 20 } },
      ],
      intendedChanges: { paths: ["/layers"], layers: { operation: "append", sourceLayerCount: 1, appendLayerIds: ["alpha", "zeta"] } },
      evidence: { noPackageIO: true, noPackageWrites: true, noCOW: true, noReceipt: true, noPublicSurface: true, noRenderer: true },
    });
    expect(Object.hasOwn(plan.layers[0]!, "visible")).toBe(false);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.layers[0]!.transform)).toBe(true);
  });

  it("builds a schema-valid ordinary Motion document by appending only the derived layers", () => {
    const input = fixture(), plan = compileCheckpointStoryboardLifecycleProfilePlan(input);
    const derived = { ...input.base.motion, layers: [...input.base.motion.layers, ...plan.layers] };
    const validated = validateDocumentSync(loadSchemaSync("motion"), derived);
    expect(validated.ok).toBe(true);
    expect(readMotionDocument(derived)).toMatchObject({ id: "motion-1", layers: [{ id: "title" }, { id: "alpha", type: "shape" }, { id: "zeta", type: "shape" }] });
  });

  it("is deterministic, immutable, and keeps catalog creation out of source Motion facts", () => {
    const input = fixture(), before = JSON.stringify(input);
    const first = compileCheckpointStoryboardLifecycleProfilePlan(input), replay = compileCheckpointStoryboardLifecycleProfilePlan(clone(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(replay).toEqual(first);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.lowererProfile.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first.layers)).not.toContain("private-checkpoint-storyboard-shape-creation");
  });

  it("table-refuses valid C6A records outside the closed lifecycle profile", () => {
    const cases: readonly [string, () => any, string | undefined][] = [
      ["browser positive", () => fixture({ capabilityRequirements: ["renderer.browser"] }).storyboard, undefined],
      ["empty capabilities", () => reseal((value) => { value.capabilityRequirements = []; }), "exactly one renderer.browser or renderer.native"],
      ["GPU capability", () => fixture({ capabilityRequirements: ["renderer.gpu"] }).storyboard, "exactly one renderer.browser or renderer.native"],
      ["multiple capabilities", () => fixture({ capabilityRequirements: ["renderer.browser", "renderer.native"] }).storyboard, "exactly one renderer.browser or renderer.native"],
      ["initial present", () => reseal((value) => {
        for (const checkpoint of value.checkpoints) checkpoint.objects[0] = present("alpha", 12, 24, 15, 1.25, 0.75);
        for (const edge of value.edges) edge.lifecycle[0] = { kind: "preserve", objectId: "alpha" };
      }), "initially absent"],
      ["non-millisecond", () => reseal((value) => { [0, 100_001, 300_001, 700_001, 1_000_001].forEach((atUs, index) => { value.checkpoints[index].atUs = atUs; }); }), "whole-millisecond"],
      ["noncanonical property mask", () => reseal((value) => {
        for (const catalog of value.objectCatalog) catalog.propertyMask = ["opacity"];
        for (const checkpoint of value.checkpoints) for (const state of checkpoint.objects) if (state.state === "present") state.properties = state.properties.filter((entry: any) => entry.property === "opacity");
      }), "exact canonical property mask"],
      ["path root", () => reseal((value) => { value.objectCatalog[0].rootShapeKind = "path"; }), "rect/ellipse"],
      ["nonempty recipe and edge recipeIds", () => reseal((value) => {
        const recipe = createTransitionRecipe({ recipeId: "lifecycle-probe", seed: 2, exactBaseRequirements: [], intent: { kind: "checkpoint-keyframe", easing: "linear", targets: [{ objectId: "alpha", propertyMask: ["opacity"] }] } });
        value.recipes = [recipe]; value.edges[3].recipeIds = [recipe.recipeId];
      }), "no recipes, and empty edge recipeIds"],
    ];
    for (const [label, build, expected] of cases) {
      const candidate = build();
      if (expected) expect(() => admitCheckpointStoryboardLifecycleRecordProfile(candidate), label).toThrow(expected);
      else expect(admitCheckpointStoryboardLifecycleRecordProfile(candidate), label).toEqual(candidate);
    }
    expect(() => admitCheckpointStoryboardLifecycleRecordProfile(fixture({ withoutCreation: true }).storyboard)).toThrow("creation payloads");
    expect(() => admitCheckpointStoryboardLifecycleRecordProfile(fixture({ finalCreate: true }).storyboard)).toThrow("create exactly once before document end");
    expect(() => admitCheckpointStoryboardLifecycleRecordProfile(fixture({ permanentAbsent: true }).storyboard)).toThrow("must not remain permanently absent");
  });

  it("requires exact detached base facts and rejects collisions and competing or structural source authority", () => {
    expect(() => compileCheckpointStoryboardLifecycleProfilePlan(fixture({ durationMs: 999 }))).toThrow("exact detached base motion duration");
    expect(() => compileCheckpointStoryboardLifecycleProfilePlan(fixture({ sourceLayerId: "alpha" }))).toThrow("target/source layer id collision");
    const sourceAuthorities: readonly [string, (source: Record<string, unknown>) => void][] = [
      ["childLayerIds", (source) => { source.type = "group"; source.childLayerIds = ["child"]; }],
      ["trackId", (source) => { source.trackId = "track"; }],
      ["keyframes", (source) => { source.keyframes = {}; }],
      ["transitions", (source) => { source.transitions = {}; }],
      ["tracking", (source) => { source.tracking = {}; }],
      ["stabilization", (source) => { source.stabilization = {}; }],
      ["stabilize", (source) => { source.stabilize = {}; }],
      ["transformAuthority", (source) => { source.transformAuthority = {}; }],
      ["timingAuthority", (source) => { source.timingAuthority = {}; }],
      ["timeRemap", (source) => { source.timeRemap = {}; }],
      ["trimStartMs", (source) => { source.trimStartMs = 0; }],
      ["trimDurationMs", (source) => { source.trimDurationMs = 1; }],
      ["loop", (source) => { source.loop = true; }],
      ["playbackRate", (source) => { source.playbackRate = 1; }],
      ["x-tracking-stabilization", (source) => { source["x-tracking-stabilization"] = {}; }],
      ["depth", (source) => { source.depth = 0; }],
      ["geometry", (source) => { source.type = "shape"; source.geometry = GEOMETRY; }],
      ["geometryKeyframes", (source) => { source.type = "shape"; source.geometry = GEOMETRY; source.geometryKeyframes = { schema: "shellx-motion/shape-geometry-keyframes@1", keyframes: [{ atUs: 0, geometry: GEOMETRY }] }; }],
      ["morph", (source) => { source.morph = {}; }],
    ];
    for (const [field, mutate] of sourceAuthorities) {
      const candidate = fixture(), source = candidate.base.motion.layers[0] as Record<string, unknown>;
      mutate(source);
      expect(() => compileCheckpointStoryboardLifecycleProfilePlan(candidate), field).toThrow();
    }
    const grouped = fixture(); grouped.base.motion.layers[0] = { ...grouped.base.motion.layers[0], type: "group", childLayerIds: ["child"] };
    expect(() => compileCheckpointStoryboardLifecycleProfilePlan(grouped)).toThrow();
    const duplicate = fixture(); duplicate.base.motion.layers.push({ ...duplicate.base.motion.layers[0] });
    expect(() => compileCheckpointStoryboardLifecycleProfilePlan(duplicate)).toThrow();
    const authority = fixture(); authority.base.motion.tracks = [];
    expect(() => compileCheckpointStoryboardLifecycleProfilePlan(authority)).toThrow("existing tracks authority");
    const extra = fixture(); extra.objectLayerBindings = [];
    expect(() => readCheckpointStoryboardLifecycleProfileRequest(extra)).toThrow("unknown field 'objectLayerBindings'");
    const badHash = fixture(); badHash.base.persistedMotionSha256 = "A".repeat(64);
    expect(() => compileCheckpointStoryboardLifecycleProfilePlan(badHash)).toThrow("lowercase sha256");
  });

  it("uses descriptor-first hostile admission with one private installed handoff and source-only compatibility facades", () => {
    let reads = 0;
    const hostile: Record<string, unknown> = { schema: CHECKPOINT_STORYBOARD_LIFECYCLE_PROFILE_REQUEST_SCHEMA, base: {} };
    Object.defineProperty(hostile, "storyboard", { enumerable: true, get() { reads += 1; return fixture().storyboard; } });
    expect(() => readCheckpointStoryboardLifecycleProfileRequest(hostile)).toThrow("enumerable data field");
    expect(reads).toBe(0);
    const compiler = readFileSync(new URL("../../internal/checkpoint-storyboard/checkpoint-storyboard-lifecycle-profile.ts", import.meta.url), "utf8");
    expect(compiler).not.toMatch(/node:(?:fs|path)|\b(?:readFile|writeFile|mkdir|rename)\b/i);
    const compatibility = readFileSync(new URL("./checkpoint-storyboard-lifecycle-profile.ts", import.meta.url), "utf8");
    expect(compatibility.trim()).toBe("/** Compatibility facade for source-only callers; this is not a package entry. */\nexport * from \"../../internal/checkpoint-storyboard/checkpoint-storyboard-lifecycle-profile.js\";");
    const compatibilityTypes = readFileSync(new URL("./checkpoint-storyboard-lifecycle-profile-types.ts", import.meta.url), "utf8");
    expect(compatibilityTypes.trim()).toBe("/** Compatibility facade for source-only callers; this is not a package entry. */\nexport * from \"../../internal/checkpoint-storyboard/checkpoint-storyboard-lifecycle-profile-types.js\";");
    const handoff = readFileSync(new URL("../../internal/checkpoint-storyboard/checkpoint-storyboard-lifecycle-materializer.ts", import.meta.url), "utf8");
    expect(handoff).not.toMatch(/node:(?:fs|path)|\b(?:readFile|writeFile|mkdir|rename)\b/i);
    const coreIndex = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    expect(coreIndex).not.toContain("checkpoint-storyboard-lifecycle");
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } };
    expect(manifest.exports["./internal/checkpoint-storyboard-lifecycle-profile"]).toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-lifecycle-materializer.ts");
    expect(manifest.publishConfig.exports["./internal/checkpoint-storyboard-lifecycle-profile"]).toEqual({
      types: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-lifecycle-materializer.d.ts",
      default: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-lifecycle-materializer.js",
    });
  });
});
