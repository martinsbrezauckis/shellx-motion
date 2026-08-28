import { describe, expect, it } from "vitest";
import { RENDERER_CAPABILITY_CARDS } from "../../capability-cards";
import {
  compileCheckpointStoryboardPlan, createCheckpointStoryboard, createTransitionRecipe,
  readCheckpointStoryboard, readTransitionRecipe, snapshotCheckpointStoryboardData,
} from "./checkpoint-storyboard";

const MASK = ["transform.x", "transform.y", "opacity"] as const;
const CAPABILITY = RENDERER_CAPABILITY_CARDS[0]!.id;
const CATALOG = [{ objectId: "orb", rootShapeKind: "ellipse", propertyMask: MASK }] as const;
const GEOMETRY_CATALOG = [{ objectId: "contour", rootShapeKind: "geometry", propertyMask: [] }] as const;

function object(state = "present", x = 0, y = 0, opacity = 1) {
  return state === "absent"
    ? { objectId: "orb", state: "absent", properties: [] }
    : { objectId: "orb", state: "present", properties: [
      { property: "transform.x", value: x }, { property: "transform.y", value: y }, { property: "opacity", value: opacity },
    ] };
}
function checkpoint(id: string, atUs: number, state = "present", x = 0, y = 0, opacity = 1) {
  return { id, atUs, objects: [object(state, x, y, opacity)] };
}
function keyframe(recipeId = "move", parent?: unknown) {
  return createTransitionRecipe({
    recipeId, seed: 7, exactBaseRequirements: [], ...(parent ? { parent } : {}),
    intent: { kind: "checkpoint-keyframe", easing: "ease-in-out", targets: [{ objectId: "orb", propertyMask: ["transform.x", "transform.y"] }] },
  });
}
function edge(id = "start-finish", fromCheckpointId = "start", toCheckpointId = "finish", lifecycle = [{ kind: "preserve", objectId: "orb" }], recipeIds = ["move"]) {
  return { id, fromCheckpointId, toCheckpointId, lifecycle, recipeIds };
}
function storyboard(overrides: Record<string, unknown> = {}) {
  const recipe = keyframe();
  return {
    seed: 42, capabilityRequirements: [CAPABILITY], objectCatalog: CATALOG, recipes: [recipe],
    checkpoints: [checkpoint("start", 0), checkpoint("finish", 1_000_000, "present", 100, 50)],
    edges: [edge()],
    ...overrides,
  };
}
function geometry(y = 0) {
  return {
    schema: "shellx-motion/shape-geometry@1", kind: "line", viewBox: { x: 0, y: 0, width: 100, height: 100 },
    points: [{ x: 0, y }, { x: 100, y }],
  };
}
function geometryObject(y = 0) {
  return { objectId: "contour", state: "present", properties: [], geometry: geometry(y) };
}
function geometryCheckpoint(id: string, atUs: number, y = 0) {
  return { id, atUs, objects: [geometryObject(y)] };
}
function geometryMorph(recipeId = "morph") {
  return createTransitionRecipe({
    recipeId, seed: 11, exactBaseRequirements: [],
    intent: { kind: "checkpoint-geometry-morph", targets: [{ objectId: "contour", easing: "linear" }] },
  });
}
function geometryStoryboard(overrides: Record<string, unknown> = {}) {
  const recipe = geometryMorph();
  return {
    seed: 43, capabilityRequirements: [CAPABILITY], objectCatalog: GEOMETRY_CATALOG, recipes: [recipe],
    checkpoints: [geometryCheckpoint("start", 0), geometryCheckpoint("finish", 1_000_001, 20)],
    edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "contour" }], recipeIds: ["morph"] }],
    ...overrides,
  };
}

describe("private C6A checkpoint storyboard plan", () => {
  it("seals deterministic immutable private records with revision lineage and no renderer authority", () => {
    const first = createCheckpointStoryboard(storyboard()), replay = createCheckpointStoryboard(storyboard());
    expect(replay).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.objectCatalog[0]!.propertyMask)).toBe(true);
    expect(readCheckpointStoryboard(JSON.parse(JSON.stringify(first)))).toEqual(first);
    expect(compileCheckpointStoryboardPlan(first)).toMatchObject({
      schema: "shellx-motion/private-checkpoint-storyboard-plan@1",
      edges: [{ id: "start-finish", workUnits: 4 }],
      budget: { checkpointCount: 2, objectStateCount: 2, edgeCount: 1, recipeCount: 1 },
      evidence: { noRenderer: true, noArbitraryTimeEvaluation: true, unresolvedExactBaseRequirements: true },
    });
    expect(compileCheckpointStoryboardPlan(replay)).toEqual(compileCheckpointStoryboardPlan(first));
    const revision = createCheckpointStoryboard({ ...storyboard(), parent: first });
    expect(revision).toMatchObject({ revision: 2, parentRevision: { id: first.id, sha256: first.sha256 } });
    expect(() => readCheckpointStoryboard({ ...first, revision: 5 })).toThrow("requires parentRevision");
    expect(() => readCheckpointStoryboard({ ...first, parentRevision: { id: first.id, sha256: first.sha256 } })).toThrow("revision 1 must not");
    expect(() => readCheckpointStoryboard({ ...revision, revision: 3 })).toThrow("stale");
    expect(() => readCheckpointStoryboard({ ...revision, parentRevision: { ...revision.parentRevision!, sha256: "b".repeat(64) } })).toThrow("must match the supplied sha256 prefix");
    expect(() => readCheckpointStoryboard({ ...first, seed: 99 })).toThrow("stale");
  });

  it("keeps legacy catalog identities byte-for-byte stable while admitting only sealed shape creation facts", () => {
    const legacy = createCheckpointStoryboard(storyboard({ capabilityRequirements: ["renderer.browser"] }));
    expect(legacy).toMatchObject({ id: "checkpoint_storyboard_b4f4569103f9fadb7226d845b4c012ba", sha256: "b4f4569103f9fadb7226d845b4c012ba63e313d156fd53695813bfd4a4b0f840" });
    expect(JSON.stringify(legacy.objectCatalog[0])).toBe('{"objectId":"orb","rootShapeKind":"ellipse","propertyMask":["transform.x","transform.y","opacity"]}');
    expect(Object.hasOwn(legacy.objectCatalog[0]!, "creation")).toBe(false);
    expect(Object.hasOwn(legacy.checkpoints[0]!.objects[0]!, "geometry")).toBe(false);
    const created = createCheckpointStoryboard(storyboard({
      objectCatalog: [{ ...CATALOG[0], creation: { schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1", fill: "#4e8cff", width: 120, height: 80 } }],
    }));
    expect(created.objectCatalog[0]!.creation).toEqual({ schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1", fill: "#4e8cff", width: 120, height: 80 });
    expect(Object.isFrozen(created.objectCatalog[0]!.creation)).toBe(true);
    for (const creation of [
      { schema: "wrong", fill: "#4e8cff", width: 120, height: 80 },
      { schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1", fill: "#4E8CFF", width: 120, height: 80 },
      { schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1", fill: "#4e8cff", width: 0, height: 80 },
      { schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1", fill: "#4e8cff", width: 120, height: Number.NaN },
      { schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1", fill: "#4e8cff", width: 120, height: 80, visible: true },
      { schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1", fill: "#4e8cff", width: 120, height: 80, transform: { x: 0 } },
    ]) expect(() => createCheckpointStoryboard(storyboard({ objectCatalog: [{ ...CATALOG[0], creation }] }))).toThrow();
  });

  it("admits hostile data descriptor-first, including storage and array pre-caps without getter execution", () => {
    let ownKeys = 0, gets = 0;
    const hostile = new Proxy({}, { ownKeys: () => { ownKeys += 1; return Array.from({ length: 10_000 }, (_, index) => `bad${index}`); }, get: () => { gets += 1; return undefined; } });
    expect(() => snapshotCheckpointStoryboardData(hostile)).toThrow("24-field record limit");
    expect({ ownKeys, gets }).toEqual({ ownKeys: 1, gets: 0 });

    let hugeKeyGets = 0;
    const hugeKey: Record<string, unknown> = {};
    Object.defineProperty(hugeKey, "x".repeat(256 * 1024), { enumerable: true, get() { hugeKeyGets += 1; return 1; } });
    expect(() => snapshotCheckpointStoryboardData(hugeKey)).toThrow("storage limit");
    expect(hugeKeyGets).toBe(0);
    let arrayOwnKeys = 0;
    const largeArray = new Proxy(Array(65), { ownKeys(target) { arrayOwnKeys += 1; return Reflect.ownKeys(target); } });
    expect(() => snapshotCheckpointStoryboardData(largeArray)).toThrow("arrays must be dense");
    expect(arrayOwnKeys).toBe(0);

    const accessor: Record<string, unknown> = { recipeId: "getter", seed: 1, exactBaseRequirements: [] };
    Object.defineProperty(accessor, "intent", { enumerable: true, get() { gets += 1; return { kind: "checkpoint-keyframe" }; } });
    expect(() => createTransitionRecipe(accessor)).toThrow("enumerable data field");
    expect(gets).toBe(0);
  });

  it("requires fixed complete catalog state, exact consecutive edges, lifecycle, and explicit morph refusal", () => {
    expect(() => createCheckpointStoryboard(storyboard({ checkpoints: [checkpoint("start", 0.5), checkpoint("finish", 2_000)] }))).toThrow("safe integer microsecond");
    expect(() => createCheckpointStoryboard(storyboard({ checkpoints: [checkpoint("start", 0), checkpoint("finish", 3_600_000_001)] }))).toThrow("3600000000");
    expect(() => createCheckpointStoryboard(storyboard({
      checkpoints: [{ id: "start", atUs: 0, objects: [{ objectId: "orb", state: "present", properties: [{ property: "transform.x", value: 0 }, { property: "transform.y", value: 0 }] }] }, checkpoint("finish", 2_000)],
    }))).toThrow("fixed catalog propertyMask");
    expect(() => createCheckpointStoryboard(storyboard({ edges: [edge("start-finish", "start", "finish", [{ kind: "create", objectId: "orb" }])] }))).toThrow("explicitly and exactly map");
    expect(() => createCheckpointStoryboard(storyboard({ edges: [edge("start-finish", "start", "finish", [{ kind: "morph", objectId: "orb" }])] }))).toThrow("explicitly refuses morph");

    const states = [checkpoint("start", 0), checkpoint("middle", 1_000), checkpoint("finish", 2_000)];
    expect(() => createCheckpointStoryboard(storyboard({ checkpoints: states, recipes: [], edges: [
      edge("a-skip", "start", "finish", [{ kind: "preserve", objectId: "orb" }], []),
      edge("b-finish", "middle", "finish", [{ kind: "preserve", objectId: "orb" }], []),
    ] }))).toThrow("uniquely bind consecutive");
    expect(() => createCheckpointStoryboard(storyboard({ recipes: [], edges: [
      edge("first", "start", "finish", [{ kind: "preserve", objectId: "orb" }], []),
      edge("parallel", "start", "finish", [{ kind: "preserve", objectId: "orb" }], []),
    ] }))).toThrow("exactly checkpoints.length - 1");
  });

  it("requires exactly one recipe owner for each changed preserved property and forbids recreate", () => {
    expect(() => createCheckpointStoryboard(storyboard({ recipes: [], edges: [edge("start-finish", "start", "finish", [{ kind: "preserve", objectId: "orb" }], [])] }))).toThrow("without exactly one owning recipe");
    const states = [checkpoint("start", 0), checkpoint("removed", 1_000, "absent"), checkpoint("recreated", 2_000)];
    expect(() => createCheckpointStoryboard(storyboard({ checkpoints: states, recipes: [], edges: [
      edge("a-remove", "start", "removed", [{ kind: "remove", objectId: "orb" }], []),
      edge("b-create", "removed", "recreated", [{ kind: "create", objectId: "orb" }], []),
    ] }))).toThrow("forbids recreate after removal");
  });

  it("admits bounded detached geometry states only through an owning fixed-topology linear morph", () => {
    const admitted = createCheckpointStoryboard(geometryStoryboard());
    expect(admitted.objectCatalog[0]).toEqual({ objectId: "contour", rootShapeKind: "geometry", propertyMask: [] });
    expect(admitted.checkpoints[0]!.objects[0]).toMatchObject({ state: "present", properties: [], geometry: { kind: "line" } });
    expect(admitted.recipes[0]!.intent).toEqual({ kind: "checkpoint-geometry-morph", targets: [{ objectId: "contour", easing: "linear" }] });
    const firstGeometryState = admitted.checkpoints[0]!.objects[0]!;
    if (!("geometry" in firstGeometryState)) throw new Error("Expected admitted geometry state.");
    expect(Object.isFrozen(firstGeometryState.geometry)).toBe(true);
    expect(readCheckpointStoryboard(JSON.parse(JSON.stringify(admitted)))).toEqual(admitted);
    expect(compileCheckpointStoryboardPlan(admitted).edges).toEqual([expect.objectContaining({ id: "start-finish", workUnits: 1_024 })]);

    const maximumTargets = Array.from({ length: 16 }, (_value, index) => ({ objectId: `contour-${String(index).padStart(2, "0")}`, easing: "linear" as const }));
    const maximumRecipe = createTransitionRecipe({ recipeId: "maximum-morph", seed: 1, exactBaseRequirements: [], intent: { kind: "checkpoint-geometry-morph", targets: maximumTargets } });
    expect(maximumRecipe.budget.workUnits).toBe(16_384);

    expect(() => createTransitionRecipe({ recipeId: "nonlinear", seed: 1, exactBaseRequirements: [], intent: { kind: "checkpoint-geometry-morph", targets: [{ objectId: "contour", easing: "ease-in" }] } })).toThrow("must be linear");
    expect(() => createTransitionRecipe({ recipeId: "extra", seed: 1, exactBaseRequirements: [], intent: { kind: "checkpoint-geometry-morph", targets: [{ objectId: "contour", easing: "linear", propertyMask: [] }] } })).toThrow("unknown field 'propertyMask'");
    expect(() => createCheckpointStoryboard(geometryStoryboard({ objectCatalog: [{ objectId: "contour", rootShapeKind: "geometry", propertyMask: ["opacity"] }] }))).toThrow("require an empty scalar propertyMask");
    expect(() => createCheckpointStoryboard(geometryStoryboard({ objectCatalog: [{ objectId: "contour", rootShapeKind: "geometry", propertyMask: [], creation: { schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1", fill: "#4e8cff", width: 1, height: 1 } }] }))).toThrow("do not admit scalar shape creation");
    expect(() => createCheckpointStoryboard(geometryStoryboard({ checkpoints: [{ id: "start", atUs: 0, objects: [{ objectId: "contour", state: "present", properties: [] }] }, geometryCheckpoint("finish", 1_000_001, 20)] }))).toThrow("requires geometry");
    expect(() => createCheckpointStoryboard(geometryStoryboard({ checkpoints: [{ id: "start", atUs: 0, objects: [{ ...geometryObject(), properties: [{ property: "opacity", value: 1 }] }] }, geometryCheckpoint("finish", 1_000_001, 20)] }))).toThrow("must contain 0..0 entries");
    expect(() => createCheckpointStoryboard(geometryStoryboard({ recipes: [], edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "contour" }], recipeIds: [] }] }))).toThrow("without exactly one owning geometry recipe");
  });

  it("refuses incompatible or wrongly-targeted geometry morphs before any materialization route", () => {
    const incompatible = geometryStoryboard({
      checkpoints: [geometryCheckpoint("start", 0), { id: "finish", atUs: 1, objects: [{ objectId: "contour", state: "present", properties: [], geometry: { schema: "shellx-motion/shape-geometry@1", kind: "polygon", viewBox: { x: 0, y: 0, width: 100, height: 100 }, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }] } }] }],
    });
    expect(() => createCheckpointStoryboard(incompatible)).toThrow("compatible fixed-topology geometry");
    const scalarMorph = geometryMorph("wrong-target");
    expect(() => createCheckpointStoryboard(storyboard({ recipes: [scalarMorph], edges: [edge("start-finish", "start", "finish", [{ kind: "preserve", objectId: "orb" }], ["wrong-target"])] }))).toThrow("requires preserved geometry object");
    const first = geometryMorph("one"), second = geometryMorph("two");
    expect(() => createCheckpointStoryboard(geometryStoryboard({ recipes: [first, second], edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "contour" }], recipeIds: ["one", "two"] }] }))).toThrow("conflicts with another geometry recipe");
  });

  it("closes the recipe set to one edge each until recipe identity gains an edge binding", () => {
    expect(() => createCheckpointStoryboard(storyboard({ recipes: [keyframe(), keyframe("z-unused")] }))).toThrow("every recipe to be assigned");
    const states = [checkpoint("start", 0), checkpoint("middle", 1_000), checkpoint("finish", 2_000)];
    expect(() => createCheckpointStoryboard(storyboard({ checkpoints: states, recipes: [keyframe()], edges: [
      edge("a-first", "start", "middle", [{ kind: "preserve", objectId: "orb" }]),
      edge("b-second", "middle", "finish", [{ kind: "preserve", objectId: "orb" }]),
    ] }))).toThrow("reuses a recipe across edges");
  });

  it("refuses non-millisecond lowerers at endpoints that C6A cannot represent", () => {
    expect(() => createCheckpointStoryboard(storyboard({ checkpoints: [checkpoint("start", 0), checkpoint("finish", 1_000_001, "present", 100, 50)] }))).toThrow("time_resolution_unavailable");
  });

  it("preserves deferred exact-base action evidence without granting resolution authority", () => {
    const action = createTransitionRecipe({
      recipeId: "action", seed: 9,
      exactBaseRequirements: [{ resolution: "deferred-exact-base", definitionId: "enter", definitionSha256: "a".repeat(64) }],
      intent: { kind: "relation-action", roleBindings: [{ roleId: "hero", objectId: "orb" }], parameterValues: [], declaredWrites: [{ objectId: "orb", propertyMask: ["opacity"] }] },
    });
    const plan = compileCheckpointStoryboardPlan(createCheckpointStoryboard(storyboard({
      recipes: [action], checkpoints: [checkpoint("start", 0), checkpoint("finish", 1_000_000)],
      edges: [edge("start-finish", "start", "finish", [{ kind: "preserve", objectId: "orb" }], ["action"])],
    })));
    expect(plan.exactBaseRequirements).toEqual([{ resolution: "deferred-exact-base", definitionId: "enter", definitionSha256: "a".repeat(64) }]);
    expect(plan.evidence.unresolvedExactBaseRequirements).toBe(true);
    expect(() => createTransitionRecipe({ recipeId: "bad", seed: 1, exactBaseRequirements: [], intent: action.intent })).toThrow("requires exactly one deferred");
    expect(() => createTransitionRecipe({ recipeId: "old-field", seed: 1, sourceRequirements: [], exactBaseRequirements: [], intent: keyframe().intent })).toThrow("unknown field 'sourceRequirements'");
  });

  it("keeps self-contained trace admission and recipe revision lineage fail-closed", () => {
    const trace = {
      schema: "shellx-motion/private-parametric-trace@1", clip: { durationUs: 10, sampleIntervalUs: 10 },
      drawers: [{ id: "drawer", driver: { kind: "behavior", targetLayerId: "orb" }, retention: { kind: "last-samples", samples: 2 }, output: { mode: "line", width: { source: "constant", from: 1, to: 1 }, colour: { source: "constant", from: 1, to: 1 }, opacity: { source: "constant", from: 1, to: 1 }, speedLimit: 1 } }],
      caps: { perDrawer: { maxSamples: 2, maxVertices: 2, maxWorkUnits: 10, maxBytes: 1024 }, aggregate: { maxSamples: 2, maxVertices: 2, maxWorkUnits: 10, maxBytes: 1024 } },
    };
    expect(() => createTransitionRecipe({ recipeId: "trace", seed: 1, exactBaseRequirements: [], intent: { kind: "parametric-trace", outputObjectId: "orb", trace } })).toThrow("behavior- or relation-driven traces");
    const selfContained = { ...trace, drawers: [{ ...trace.drawers[0]!, driver: { kind: "parametric-graph", graph: { nodes: [{ id: "time", kind: "time-us" }, { id: "zero", kind: "constant", value: 0 }], output: { x: "time", y: "zero", z: "zero" } } } }] };
    const admitted = createTransitionRecipe({ recipeId: "trace", seed: 1, exactBaseRequirements: [], intent: { kind: "parametric-trace", outputObjectId: "orb", trace: selfContained } });
    expect(createCheckpointStoryboard(storyboard({ recipes: [admitted], checkpoints: [checkpoint("start", 0), checkpoint("finish", 1_000_001)], edges: [edge("start-finish", "start", "finish", [{ kind: "preserve", objectId: "orb" }], ["trace"])] }))).toMatchObject({ recipes: [{ recipeId: "trace", intent: { kind: "parametric-trace" } }] });
    const first = keyframe(), revision = keyframe("move", first);
    expect(revision).toMatchObject({ revision: 2, parentRevision: { id: first.id, sha256: first.sha256 } });
    expect(() => readTransitionRecipe({ ...first, revision: 5 })).toThrow("requires parentRevision");
    expect(() => readTransitionRecipe({ ...first, parentRevision: { id: first.id, sha256: first.sha256 } })).toThrow("revision 1 must not");
    expect(() => readTransitionRecipe({ ...revision, parentRevision: { ...revision.parentRevision!, sha256: "b".repeat(64) } })).toThrow("must match the supplied sha256 prefix");
  });
});
