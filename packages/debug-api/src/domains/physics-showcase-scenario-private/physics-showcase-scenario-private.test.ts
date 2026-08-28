import { readFile, rm } from "node:fs/promises";
import { canonicalJson } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import {
  BINGO_ICO42_HULL_K,
  compilePhysicsShowcaseScenario,
  createPhysicsShowcasePresentationRecipe,
  createPhysicsShowcaseRetainedRenderRecipe,
  createPhysicsShowcaseScenario,
  createPhysicsShowcaseVisualBindingRecipe,
  PHYSICS_SHOWCASE_SCENARIO_SCHEMA,
  quaternionFromPositiveZ,
} from "./unadopted/physics-showcase-scenario-private.js";
import { evaluatePhysicsVisualBindingFrame } from "../physics-visual-binding-private/physics-visual-binding-private.js";
import { compilePhysicsVisualPresentationFramePlan, compilePhysicsVisualPresentationStaticPlan } from "../physics-visual-presentation-private/physics-visual-presentation-private.js";
import { compilePhysicsVisualRetainedStaticPlan } from "../physics-visual-retained-private/physics-visual-retained-private.js";
import { physicsVisualFixture } from "../physics-visual-retained-private/physics-visual-retained.test-support.js";

describe("C7B6A private variable physics-showcase scenario compiler", () => {
  it("replaces Bingo's six-box enclosure globally while preserving all wall identities", () => {
    const bingo = compilePhysicsShowcaseScenario(createPhysicsShowcaseScenario("bingo"));
    const wall = compilePhysicsShowcaseScenario(createPhysicsShowcaseScenario("wrecking-wall"));
    expect(bingo.physicsPlan.fingerprint).toBe("c582bdea16f5bb16904978cd7143b5dfb75adb2085c3807ebc4e64958eededc8");
    expect(wall.physicsPlan.fingerprint).toBe("81c24a23965d280bf72bffce4a98e0150dd356afa6d34dd97d930915d4579f34");
    expect(bingo.budget).toMatchObject({ scenarioKind: "bingo", dynamicBodyCount: 10, staticBodyCount: 42, eventCount: 1, renderFrameCount: 300, geometryResourceCount: 2, materialResourceCount: 11 });
    expect(wall.budget).toMatchObject({ scenarioKind: "wrecking-wall", dynamicBodyCount: 46, staticBodyCount: 1, eventCount: 45, renderFrameCount: 300, geometryResourceCount: 4, materialResourceCount: 5 });

    const bingoBinding = createPhysicsShowcaseVisualBindingRecipe(bingo) as any;
    const wallBinding = createPhysicsShowcaseVisualBindingRecipe(wall) as any;
    expect(bingoBinding.resources.materials.map((entry: { baseColor: string }) => entry.baseColor)).toEqual(["#35a7ff", "#49d17d", "#6d5dfc", "#e84a5f", "#f6c445", "#ff7a45", "#ff5ec4", "#70d6ff", "#9ee493", "#ffffff"]);
    expect(wallBinding.resources.materials.map((entry: { baseColor: string }) => entry.baseColor)).toEqual(["#d65a3a", "#f0b35b", "#27364d"]);
    expect(createPhysicsShowcaseRetainedRenderRecipe(bingo, "a".repeat(64))).toMatchObject({ viewport: { width: 640, height: 360 }, backgroundColor: "#07111f", camera: { position: [4.5, 3.2, 6.5] } });
    expect(createPhysicsShowcasePresentationRecipe(wall, "b".repeat(64))).toMatchObject({ staticCollisionBindings: [{ bodyId: "ground" }], constraintBindings: [{ constraintId: "tether" }], additionalResources: { materials: [{ baseColor: "#26364a" }, { baseColor: "#d9e2ec" }] } });
  });

  it("derives one strict, canonical and f32-safe icosa42 enclosure for physics and the single cage presentation", () => {
    const compilation = compilePhysicsShowcaseScenario(createPhysicsShowcaseScenario("bingo")), enclosure = compilation.enclosure!;
    const panels = enclosure.panels, bodies = compilation.physicsPlan.recipe.bodies;
    expect(enclosure.record).toEqual({ center: [0, 2, 0], visibleRadius: Math.fround(2.7), panelThickness: Math.fround(0.2), surfaceMargin: Math.fround(0.05), proxy: "icosa42-slabs" });
    expect(enclosure.policy).toMatchObject({ reserveRule: "equal-surface-margin", solverAndF32Reserve: enclosure.record.surfaceMargin, certifiedHullK: BINGO_ICO42_HULL_K + enclosure.policy.f32NormalHullReserve });
    expect(panels).toHaveLength(42);
    expect(panels.map((panel) => panel.id)).toEqual(Array.from({ length: 42 }, (_entry, index) => `wall-panel-${String(index).padStart(2, "0")}`));
    expect(panels.slice(0, 12).every((panel, index) => panel.source.kind === "icosa-vertex" && panel.source.vertexIndices[0] === index)).toBe(true);
    expect(panels.slice(12).every((panel) => panel.source.kind === "icosa-edge-midpoint" && panel.source.vertexIndices.length === 2 && panel.source.vertexIndices[0]! < panel.source.vertexIndices[1]!)).toBe(true);
    expect(new Set(panels.slice(12).map((panel) => panel.source.vertexIndices.join("/"))).size).toBe(30);
    expect(bodies.filter((body) => body.kind === "static").map((body) => body.id)).toEqual(panels.map((panel) => panel.id));
    expect(compilation.physicsPlan.recipe.events).toEqual([{ id: "ball-floor", kind: "collision-pair", bodyA: "ball-00", bodyB: enclosure.floorPanelId, phases: ["start", "stop"] }]);
    expect(enclosure.floorPanelId).toBe("wall-panel-30");
    for (const panel of panels) {
      expect([...panel.normal, ...panel.position, ...panel.rotation, ...panel.size].every((value) => Object.is(value, Math.fround(value)))).toBe(true);
      expect(Math.hypot(...panel.normal)).toBeCloseTo(1, 6);
      for (const [axis, value] of rotatePositiveZ(panel.rotation).entries()) expect(value).toBeCloseTo(panel.normal[axis]!, 6);
      expect(panel.size).toEqual([Math.fround(5.4), Math.fround(5.4), Math.fround(0.2)]);
      // This is the physical f32 transform, not the ideal normal/plane used during derivation.
      expect(actualInnerPlane(enclosure.record.center, panel.position, panel.rotation, panel.size[2])).toBeLessThanOrEqual(enclosure.panelInnerPlaneDistance);
    }
    const hullK = certifiedHullRadius(panels.map((panel) => panel.normal));
    expect(BINGO_ICO42_HULL_K).toBe(1.07046626931927);
    expect(hullK).toBeCloseTo(BINGO_ICO42_HULL_K, 5);
    expect(hullK).toBeLessThanOrEqual(enclosure.policy.certifiedHullK);
    expect(enclosure.certifiedBallSurfaceRadius).toBeLessThanOrEqual(enclosure.record.visibleRadius - enclosure.record.surfaceMargin);
    expect(enclosure.tangentHalfExtent).toBeGreaterThanOrEqual(enclosure.certifiedBallSurfaceRadius);
    const presentation = createPhysicsShowcasePresentationRecipe(compilation, "a".repeat(64)) as any;
    expect(presentation.staticCollisionBindings).toEqual([]);
    expect(presentation.presentationBindings).toEqual([{ id: "cage", geometryRef: "z-cage-sphere", materialRef: "z-cage-ice", opacity: 0.18, position: enclosure.record.center, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }]);
    expect(presentation.additionalResources.geometry).toEqual([{ id: "z-cage-sphere", kind: "sphere", radius: enclosure.record.visibleRadius, quality: "cinematic" }]);
    const visual = createPhysicsShowcaseVisualBindingRecipe(compilation) as any;
    expect(visual.resources.geometry).toEqual([{ id: "ball", kind: "sphere", radius: (compilation.scenario.geometry as any).ballRadius, quality: "cinematic" }]);
    expect(quaternionFromPositiveZ([0, 0, -1])).toEqual([0, 1, 0, 0]);
  });

  it("translates every cage slab and initial-grid ball from the same enclosure center", () => {
    const base = compilePhysicsShowcaseScenario(createPhysicsShowcaseScenario("bingo"));
    const shifted = createPhysicsShowcaseScenario("bingo"); (shifted.geometry as any).enclosure.center = [1.5, 3, -0.75];
    const moved = compilePhysicsShowcaseScenario(shifted), center = [1.5, 3, -0.75], delta = [1.5, 1, -0.75];
    expect(moved.enclosure!.record.center).toEqual(center);
    for (const [index, panel] of moved.enclosure!.panels.entries()) for (const axis of [0, 1, 2]) expect(panel.position[axis]! - moved.enclosure!.record.center[axis]!).toBeCloseTo(base.enclosure!.panels[index]!.position[axis]! - base.enclosure!.record.center[axis]!, 5);
    const beforeBalls = base.physicsPlan.recipe.bodies.filter((body) => body.kind === "dynamic"), afterBalls = moved.physicsPlan.recipe.bodies.filter((body) => body.kind === "dynamic");
    for (const [index, ball] of afterBalls.entries()) for (const axis of [0, 1, 2]) expect(ball.position[axis]! - moved.enclosure!.record.center[axis]!).toBeCloseTo(beforeBalls[index]!.position[axis]! - base.enclosure!.record.center[axis]!, 5);
    expect((createPhysicsShowcasePresentationRecipe(moved, "b".repeat(64)) as any).presentationBindings[0]!.position).toEqual(center);
  });

  it("adds a longer Bingo and a three-times-larger wall through data alone", () => {
    const longer = compilePhysicsShowcaseScenario(createPhysicsShowcaseScenario("bingo-longer"));
    const larger = compilePhysicsShowcaseScenario(createPhysicsShowcaseScenario("wrecking-wall-large"));
    expect(longer.budget).toMatchObject({ scenarioKind: "bingo", dynamicBodyCount: 16, staticBodyCount: 42, renderFrameCount: 450 });
    expect(larger.budget).toMatchObject({ scenarioKind: "wrecking-wall", dynamicBodyCount: 136, eventCount: 135, renderFrameCount: 360 });
    expect(larger.physicsPlan.recipe.bodies.filter((body) => body.kind === "dynamic").map((body) => body.id).at(-2)).toBe("brick-r14-c08");
    expect((createPhysicsShowcaseVisualBindingRecipe(larger) as any).bindings).toHaveLength(136);
    expect((createPhysicsShowcasePresentationRecipe(longer, "c".repeat(64)) as any).presentationBindings[0]).toMatchObject({ id: "cage", opacity: 0.16, materialRef: "z-cage-ice" });
  });

  it("admits only geometry and presentation values that each reach the downstream C7B4 recipe", () => {
    const base = compilePhysicsShowcaseScenario(createPhysicsShowcaseScenario("wrecking-wall"));
    const widerGap = createPhysicsShowcaseScenario("wrecking-wall"); ((widerGap.geometry as any).brickGap)[0] = 0.15;
    const tallerGap = createPhysicsShowcaseScenario("wrecking-wall"); ((tallerGap.geometry as any).brickGap)[1] = 0.12;
    const widerPlan = compilePhysicsShowcaseScenario(widerGap).physicsPlan, tallerPlan = compilePhysicsShowcaseScenario(tallerGap).physicsPlan;
    const body = (plan: typeof base.physicsPlan, id: string) => plan.recipe.bodies.find((entry) => entry.id === id)!;
    expect(body(widerPlan, "brick-r00-c01").position[0]).toBeLessThan(body(base.physicsPlan, "brick-r00-c01").position[0]);
    expect(body(tallerPlan, "brick-r01-c00").position[1]).toBeGreaterThan(body(base.physicsPlan, "brick-r01-c00").position[1]);

    const thirdGap = createPhysicsShowcaseScenario("wrecking-wall"); (thirdGap.geometry as any).brickGap = [0.05, 0.05, 0];
    expect(() => compilePhysicsShowcaseScenario(thirdGap)).toThrow(/exactly two entries/i);
    const legacyEnclosure = createPhysicsShowcaseScenario("bingo"); (legacyEnclosure.geometry as any).enclosure.size = [1, 1, 1];
    expect(() => compilePhysicsShowcaseScenario(legacyEnclosure)).toThrow(/unknown field 'size'/i);
    const badProxy = createPhysicsShowcaseScenario("bingo"); (badProxy.geometry as any).enclosure.proxy = "legacy-boxes";
    expect(() => compilePhysicsShowcaseScenario(badProxy)).toThrow(/proxy must equal/i);
    const tooNarrow = createPhysicsShowcaseScenario("bingo"); (tooNarrow.geometry as any).enclosure.visibleRadius = 0.3;
    expect(() => compilePhysicsShowcaseScenario(tooNarrow)).toThrow(/positive ball-center hull|fit inside/i);
    const overlap = createPhysicsShowcaseScenario("bingo"); (overlap.geometry as any).ballSpacing = 0.39;
    expect(() => compilePhysicsShowcaseScenario(overlap)).toThrow(/avoid initial ball overlap/i);
    const radiusOverflow = createPhysicsShowcaseScenario("bingo"); (radiusOverflow.geometry as any).enclosure.visibleRadius = 0.8;
    expect(() => compilePhysicsShowcaseScenario(radiusOverflow)).toThrow(/fit inside the declared enclosure sphere/i);
    const marginOverflow = createPhysicsShowcaseScenario("bingo"); (marginOverflow.geometry as any).enclosure.surfaceMargin = 2;
    expect(() => compilePhysicsShowcaseScenario(marginOverflow)).toThrow(/positive ball-center hull/i);
    const groundOverflow = createPhysicsShowcaseScenario("wrecking-wall"); ((groundOverflow.geometry as any).groundSize)[0] = 8;
    expect(() => compilePhysicsShowcaseScenario(groundOverflow)).toThrow(/footprint/i);
    const depthGroundOverflow = createPhysicsShowcaseScenario("wrecking-wall"); ((depthGroundOverflow.geometry as any).groundSize)[2] = 0.4;
    expect(() => compilePhysicsShowcaseScenario(depthGroundOverflow)).toThrow(/footprint/i);
    const lowBase = createPhysicsShowcaseScenario("wrecking-wall"); (lowBase.geometry as any).baseY = 0.24;
    expect(() => compilePhysicsShowcaseScenario(lowBase)).toThrow(/half the brick height/i);
    const badTether = createPhysicsShowcaseScenario("wrecking-wall"); ((badTether.geometry as any).tetherVisualSize)[1] = 0.9;
    expect(() => compilePhysicsShowcaseScenario(badTether)).toThrow(/unit Y/i);

    const nearEqualsFar = createPhysicsShowcaseScenario("bingo"); (nearEqualsFar.presentation as any).camera.near = 100;
    expect(() => compilePhysicsShowcaseScenario(nearEqualsFar)).toThrow(/near must precede far/i);
    const coincidentCamera = createPhysicsShowcaseScenario("bingo"); (coincidentCamera.presentation as any).camera.target = [4.5, 3.2, 6.5];
    expect(() => compilePhysicsShowcaseScenario(coincidentCamera)).toThrow(/non-degenerate/i);
    const verticalCamera = createPhysicsShowcaseScenario("bingo"); (verticalCamera.presentation as any).camera.target = [4.5, 1.6, 6.5];
    expect(() => compilePhysicsShowcaseScenario(verticalCamera)).toThrow(/fixed y-up/i);
    const noLight = createPhysicsShowcaseScenario("bingo"); (noLight.presentation as any).lighting.direction = [0, 0, 0];
    expect(() => compilePhysicsShowcaseScenario(noLight)).toThrow(/non-degenerate/i);
    const farNear = createPhysicsShowcaseScenario("bingo"); (farNear.presentation as any).camera.near = 1_001;
    expect(() => compilePhysicsShowcaseScenario(farNear)).toThrow(/1\.\.1000/i);
    const brightLight = createPhysicsShowcaseScenario("bingo"); (brightLight.presentation as any).lighting.intensity = 4.1;
    expect(() => compilePhysicsShowcaseScenario(brightLight)).toThrow(/0\.\.4/i);
  });

  it("feeds compiler-produced default recipes through the accepted C7B4A/B/C compilers", async () => {
    for (const [kind, expected] of [["bingo", "5bda7c27e907a234ebbfc2572b189dbef345c939a26a15e2b8561068f1b3d69c"], ["wall", "84de05667680d74a4116d8ac52692ef45ecfd6b93e56046f6bc2ba2ae620ef64"]] as const) {
      const fixture = await physicsVisualFixture(kind);
      try {
        // The fixture's C7B4A plan already came from createPhysicsShowcaseVisualBindingRecipe.
        expect(fixture.visualPlan.recipe).toEqual(createPhysicsShowcaseVisualBindingRecipe(fixture.compilation, fixture.physicsPlan));
        const retained = compilePhysicsVisualRetainedStaticPlan(fixture.visualPlan, createPhysicsShowcaseRetainedRenderRecipe(fixture.compilation, fixture.visualPlan.fingerprint) as any);
        const presentation = compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, createPhysicsShowcasePresentationRecipe(fixture.compilation, retained.fingerprint, fixture.physicsPlan) as any);
        expect(presentation.fingerprint).toBe(expected);
        expect(compilePhysicsVisualPresentationFramePlan(presentation, 0).bindings).not.toHaveLength(0);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  }, 90_000);

  it("keeps every actual C7B2 state and every C7B4A/C frame, including terminal, inside the data-visible sphere margin", async () => {
    const fixture = await physicsVisualFixture("bingo");
    try {
      const enclosure = fixture.compilation.enclosure!, radius = ((fixture.compilation.scenario.geometry as any).ballRadius as number);
      const retained = compilePhysicsVisualRetainedStaticPlan(fixture.visualPlan, createPhysicsShowcaseRetainedRenderRecipe(fixture.compilation, fixture.visualPlan.fingerprint) as any);
      const presentation = compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, createPhysicsShowcasePresentationRecipe(fixture.compilation, retained.fingerprint, fixture.physicsPlan) as any);
      const limit = enclosure.record.visibleRadius - enclosure.record.surfaceMargin;
      const dynamicIds = fixture.physicsPlan.recipe.bodies.filter((body) => body.kind === "dynamic").map((body) => body.id), dynamicIdSet = new Set(dynamicIds);
      expect(fixture.visualPlan.recipe.bindings.map((binding) => binding.bodyId)).toEqual(dynamicIds);
      for (const observation of fixture.provider.bodyStateObservations) for (const sample of observation.samples) {
        const balls = sample.states.filter((state) => dynamicIdSet.has(state.bodyId));
        expect(balls.map((state) => state.bodyId)).toEqual(dynamicIds);
        for (const state of balls) expect(surfaceDistance(state.position, enclosure.record.center, radius)).toBeLessThanOrEqual(limit);
      }
      for (let frameIndex = 0; frameIndex <= fixture.visualPlan.schedule.terminalFrameIndex; frameIndex += 1) {
        const visual = evaluatePhysicsVisualBindingFrame(fixture.visualPlan, frameIndex);
        const rendered = compilePhysicsVisualPresentationFramePlan(presentation, frameIndex);
        for (const binding of visual.bindings) expect(surfaceDistance(binding.position, enclosure.record.center, radius)).toBeLessThanOrEqual(limit);
        for (const binding of rendered.bindings.slice(0, visual.bindings.length)) expect(surfaceDistance(binding.modelMatrix.slice(12, 15), enclosure.record.center, radius)).toBeLessThanOrEqual(limit);
      }
      expect(presentation.instanceSlots.filter((slot) => slot.kind === "presentation")).toHaveLength(1);
      expect(presentation.instanceSlots.filter((slot) => slot.kind === "static-collision")).toHaveLength(0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 90_000);

  it("is deterministic across cloned input and refuses unknown, invalid, unstable, and overlapping authority before provider or renderer input", () => {
    const first = compilePhysicsShowcaseScenario(createPhysicsShowcaseScenario("bingo"));
    const second = compilePhysicsShowcaseScenario(structuredClone(createPhysicsShowcaseScenario("bingo")));
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(canonicalJson(first.physicsPlan)).toBe(canonicalJson(second.physicsPlan));
    const unknown = createPhysicsShowcaseScenario("bingo"); unknown.provider = "rapier";
    expect(() => compilePhysicsShowcaseScenario(unknown)).toThrow(/unknown field/i);
    const palette = createPhysicsShowcaseScenario("bingo"); ((palette.materials as any).ball.palette)[0] = "blue";
    expect(() => compilePhysicsShowcaseScenario(palette)).toThrow(/#RRGGBB/i);
    const unstable = createPhysicsShowcaseScenario("bingo"); (unstable.ids as any).firstBallId = "not a stable id";
    expect(() => compilePhysicsShowcaseScenario(unstable)).toThrow(/safe stable id/i);
    const overlap = createPhysicsShowcaseScenario("bingo"); (overlap.actions as any).impulse = { bodyIndex: 0, atStep: 120, vector: [0, 1, 0] };
    expect(() => compilePhysicsShowcaseScenario(overlap)).toThrow(/cannot overlap/i);
    const wrongPlan = compilePhysicsShowcaseScenario(createPhysicsShowcaseScenario("wrecking-wall"));
    expect(() => createPhysicsShowcaseVisualBindingRecipe(first, wrongPlan.physicsPlan)).toThrow(/incompatible C7B1/i);
    expect(() => createPhysicsShowcaseRetainedRenderRecipe(structuredClone(first), "a".repeat(64))).toThrow(/compiler-minted/i);
  });

  it("remains private: it has no Debug command, public barrel, CLI, SDK, connector, or final-video expansion", async () => {
    const [publicIndex, commandRegistry, cli, sdk, connectors, finalVideo] = await Promise.all([
      readFile(new URL("../../index.ts", import.meta.url), "utf8"),
      readFile(new URL("../../command-registry.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../../cli/src/main.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../../sdk/src/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../../connectors/src/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../physics-visual-installed-final-video-private/physics-visual-installed-final-video-private.ts", import.meta.url), "utf8"),
    ]);
    expect(PHYSICS_SHOWCASE_SCENARIO_SCHEMA).toMatch(/private-physics-showcase-scenario/u);
    expect([publicIndex, commandRegistry, cli, sdk, connectors, finalVideo].join("\n")).not.toMatch(/physics-showcase-scenario|PhysicsShowcaseScenario|C7B6A|C7B6C|Ico42|icosa42/u);
  });
});

function rotatePositiveZ([x, y, z, w]: readonly number[]): readonly [number, number, number] {
  const vector: readonly [number, number, number] = [2 * (x! * z! + y! * w!), 2 * (y! * z! - x! * w!), 1 - 2 * (x! * x! + y! * y!)];
  const length = Math.hypot(...vector);
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}
function actualInnerPlane(center: readonly number[], position: readonly number[], rotation: readonly number[], thickness: number): number {
  const normal = rotatePositiveZ(rotation);
  return normal.reduce((sum, component, axis) => sum + component * (position[axis]! - center[axis]!), 0) - thickness / 2;
}
function certifiedHullRadius(normals: readonly (readonly number[])[]): number {
  let maximum = 0;
  for (let first = 0; first < normals.length; first += 1) for (let second = first + 1; second < normals.length; second += 1) for (let third = second + 1; third < normals.length; third += 1) {
    const [a, b, c] = [normals[first]!, normals[second]!, normals[third]!], cross = (left: readonly number[], right: readonly number[]) => [left[1]! * right[2]! - left[2]! * right[1]!, left[2]! * right[0]! - left[0]! * right[2]!, left[0]! * right[1]! - left[1]! * right[0]!] as const;
    const determinant = a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!);
    if (Math.abs(determinant) < 1e-9) continue;
    const ab = cross(a, b), bc = cross(b, c), ca = cross(c, a), point = [(bc[0] + ca[0] + ab[0]) / determinant, (bc[1] + ca[1] + ab[1]) / determinant, (bc[2] + ca[2] + ab[2]) / determinant] as const;
    if (normals.every((normal) => normal[0]! * point[0] + normal[1]! * point[1] + normal[2]! * point[2] <= 1 + 1e-8)) maximum = Math.max(maximum, Math.hypot(...point));
  }
  return maximum;
}
function surfaceDistance(position: readonly number[], center: readonly number[], radius: number): number { return Math.hypot(position[0]! - center[0]!, position[1]! - center[1]!, position[2]! - center[2]!) + radius; }
