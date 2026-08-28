import { canonicalJsonSha256 } from "@shellx-motion/core";
import {
  compilePhysicsBakeAdmissionPlan,
  PHYSICS_BAKE_SCHEMA,
  readPhysicsBakeAdmissionPlan,
  snapshotSceneRecipeData,
  type PhysicsBakeAdmissionPlan,
  type PhysicsBakeRecipe,
} from "@shellx-motion/core/internal/scene-recipe";
import { PHYSICS_VISUAL_BINDING_SCHEMA } from "../../physics-visual-binding-private/physics-visual-binding-types-private.js";
import { PHYSICS_VISUAL_PRESENTATION_SCHEMA } from "../../physics-visual-presentation-private/physics-visual-presentation-types-private.js";
import { PHYSICS_VISUAL_RETAINED_SCHEMA } from "../../physics-visual-retained-private/physics-visual-retained-types-private.js";
import {
  bingoIco42PanelInnerPlane,
  bingoIco42PanelNormal,
  deriveBingoIco42Enclosure,
  type BingoIco42Enclosure,
  type BingoIco42Record,
  type BingoIco42Vec3,
} from "./bingo-icosa42-enclosure-private.js";

export { BINGO_ICO42_HULL_K, BINGO_ICO42_SAFETY_POLICY, quaternionFromPositiveZ } from "./bingo-icosa42-enclosure-private.js";

/** Private C7B6A data-only authoring boundary. It is intentionally not registered as a Motion surface. */
export const PHYSICS_SHOWCASE_SCENARIO_SCHEMA = "shellx-motion/private-physics-showcase-scenario@1" as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SCENARIO_CAPS = Object.freeze({ bingoBalls: 64, wallRows: 16, wallColumns: 16, wallBricks: 192, paletteColors: 16, renderFrames: 7_200 });

export type { BingoIco42Enclosure } from "./bingo-icosa42-enclosure-private.js";
type Vec3 = BingoIco42Vec3;

export type PhysicsShowcaseScenarioKind = "bingo" | "wrecking-wall";

export interface PhysicsShowcaseScenarioCompilation {
  readonly schema: "shellx-motion/private-physics-showcase-scenario-compilation@1";
  readonly scenario: Readonly<Record<string, unknown>>;
  /** Present only for Bingo; it makes the bounded enclosure and reserve policy inspectable data. */
  readonly enclosure?: BingoIco42Enclosure;
  readonly physicsPlan: PhysicsBakeAdmissionPlan;
  readonly physicsRecipe: PhysicsBakeRecipe;
  readonly budget: Readonly<{
    scenarioKind: PhysicsShowcaseScenarioKind;
    dynamicBodyCount: number;
    staticBodyCount: number;
    eventCount: number;
    renderFrameCount: number;
    geometryResourceCount: number;
    materialResourceCount: number;
    physics: PhysicsBakeAdmissionPlan["budget"];
    caps: typeof SCENARIO_CAPS;
  }>;
  readonly fingerprint: string;
}

const authorities = new WeakSet<object>();

/**
 * Reads one strict discriminated scenario and produces only C7B1 and C7B4 recipe/plan inputs.
 * It imports no provider, renderer, package, filesystem, or host authority.
 */
export function compilePhysicsShowcaseScenario(value: unknown): PhysicsShowcaseScenarioCompilation {
  const scenario = readScenario(value);
  const generated = scenario.kind === "bingo" ? compileBingo(scenario) : compileWall(scenario);
  const physicsPlan = compilePhysicsBakeAdmissionPlan(generated.physicsRecipe);
  const renderFrameCount = (scenario.durationUs * scenario.presentation.frameRate) / 1_000_000;
  if (!Number.isSafeInteger(renderFrameCount) || renderFrameCount < 1 || renderFrameCount > SCENARIO_CAPS.renderFrames) throw new Error("Physics showcase scenario duration and frameRate exceed the C7B4 render-frame envelope.");
  const budget = Object.freeze({
    scenarioKind: scenario.kind,
    dynamicBodyCount: physicsPlan.budget.dynamicBodyCount,
    staticBodyCount: physicsPlan.budget.staticBodyCount,
    eventCount: physicsPlan.budget.eventCount,
    renderFrameCount,
    geometryResourceCount: generated.geometryResourceCount,
    materialResourceCount: generated.materialResourceCount,
    physics: physicsPlan.budget,
    caps: SCENARIO_CAPS,
  });
  const base = Object.freeze({ schema: "shellx-motion/private-physics-showcase-scenario-compilation@1" as const, scenario, ...(generated.enclosure ? { enclosure: generated.enclosure } : {}), physicsPlan, physicsRecipe: physicsPlan.recipe, budget });
  const compilation = Object.freeze({ ...base, fingerprint: canonicalJsonSha256({ scenario, ...(generated.enclosure ? { enclosure: generated.enclosure } : {}), physicsPlanFingerprint: physicsPlan.fingerprint, budget }) });
  authorities.add(compilation);
  return compilation;
}

/** Builds the exact C7B4A data input only from a compiler-minted scenario and its exact C7B1 plan. */
export function createPhysicsShowcaseVisualBindingRecipe(compilation: PhysicsShowcaseScenarioCompilation, physicsPlan: unknown = compilation.physicsPlan): unknown {
  const admitted = requireCompilation(compilation), plan = readPhysicsBakeAdmissionPlan(physicsPlan);
  if (plan.fingerprint !== admitted.physicsPlan.fingerprint) throw new Error("Physics showcase scenario refuses an incompatible C7B1 physics-plan authority.");
  return admitted.scenario.kind === "bingo" ? bingoVisualBinding(admitted.scenario, plan) : wallVisualBinding(admitted.scenario, plan);
}

/** Builds the C7B4B retained-presentation input; visual-binding authority stays with C7B4B. */
export function createPhysicsShowcaseRetainedRenderRecipe(compilation: PhysicsShowcaseScenarioCompilation, visualBindingFingerprint: unknown): unknown {
  const admitted = requireCompilation(compilation), fingerprint = sha256(visualBindingFingerprint, "Physics showcase visualBindingFingerprint"), presentation = admitted.scenario.presentation;
  return Object.freeze({
    schema: PHYSICS_VISUAL_RETAINED_SCHEMA,
    visualBindingFingerprint: fingerprint,
    viewport: presentation.viewport,
    backgroundColor: presentation.backgroundColor,
    camera: presentation.camera,
    lighting: presentation.lighting,
  });
}

/** Builds the C7B4C data input; C7B4C still independently revalidates retained and C7B1 authority. */
export function createPhysicsShowcasePresentationRecipe(compilation: PhysicsShowcaseScenarioCompilation, retainedStaticFingerprint: unknown, physicsPlan: unknown = compilation.physicsPlan): unknown {
  const admitted = requireCompilation(compilation), retainedFingerprint = sha256(retainedStaticFingerprint, "Physics showcase retainedStaticFingerprint"), plan = readPhysicsBakeAdmissionPlan(physicsPlan);
  if (plan.fingerprint !== admitted.physicsPlan.fingerprint) throw new Error("Physics showcase scenario refuses an incompatible C7B1 presentation authority.");
  return admitted.scenario.kind === "bingo"
    ? bingoPresentation(admitted.scenario, retainedFingerprint, plan.fingerprint)
    : wallPresentation(admitted.scenario, retainedFingerprint, plan.fingerprint);
}

/** The old ten-ball and 45-brick cases, plus data-only longer/larger variants. */
export function createPhysicsShowcaseScenario(kind: "bingo" | "wrecking-wall" | "bingo-longer" | "wrecking-wall-large"): Record<string, unknown> {
  const scenario = structuredClone(DEFAULT_SCENARIOS[kind]) as Record<string, unknown>;
  return scenario;
}

const DEFAULT_SCENARIOS: Readonly<Record<"bingo" | "wrecking-wall" | "bingo-longer" | "wrecking-wall-large", Record<string, unknown>>> = Object.freeze({
  bingo: {
    schema: PHYSICS_SHOWCASE_SCENARIO_SCHEMA, id: "bingo", kind: "bingo", durationUs: 5_000_000, stepsPerSecond: 120, seed: 42, gravity: [0, -9.81, 0],
    topology: { ballCount: 10, columns: 5 },
    geometry: { ballRadius: 0.2, ballSpacing: 0.55, enclosure: { center: [0, 2, 0], visibleRadius: 2.7, panelThickness: 0.2, surfaceMargin: 0.05, proxy: "icosa42-slabs" } },
    materials: {
      ball: { friction: 0.35, restitution: 0.82, palette: ["#35a7ff", "#49d17d", "#6d5dfc", "#e84a5f", "#f6c445", "#ff7a45", "#ff5ec4", "#70d6ff", "#9ee493", "#ffffff"], emissive: 0.08 },
      enclosure: { friction: 0.5, restitution: 0.55, cageColor: "#8fdcff", cageEmissive: 0.08, cageOpacity: 0.18 },
    },
    actions: { primaryForce: { bodyIndex: 0, startStep: 120, endStep: 180, vector: [2, 0, 0] }, impulse: { bodyIndex: 1, atStep: 0, vector: [0.5, 1, 0] } },
    ids: { ballPrefix: "ball" },
    presentation: { frameRate: 60, viewport: { width: 640, height: 360 }, backgroundColor: "#07111f", camera: { position: [4.5, 3.2, 6.5], target: [0, 1.6, 0], fovDeg: 38, near: 0.1, far: 100 }, lighting: { direction: [-0.4, -0.8, -0.4], color: "#ffffff", ambient: 0.3, intensity: 1.4 } },
  },
  "bingo-longer": {
    schema: PHYSICS_SHOWCASE_SCENARIO_SCHEMA, id: "bingo-longer", kind: "bingo", durationUs: 7_500_000, stepsPerSecond: 120, seed: 4201, gravity: [0, 0, 0],
    topology: { ballCount: 16, columns: 4 },
    geometry: { ballRadius: 0.18, ballSpacing: 0.48, enclosure: { center: [0, 2.25, 0], visibleRadius: 2.75, panelThickness: 0.2, surfaceMargin: 0.05, proxy: "icosa42-slabs" } },
    materials: {
      ball: { friction: 0.02, restitution: 0.98, palette: ["#1d9bf0", "#36c275", "#7654ff", "#e5536d", "#f0be32", "#ff814f", "#e65ec2", "#63cff3"], emissive: 0.07 },
      enclosure: { friction: 0.02, restitution: 0.98, cageColor: "#9fe7ff", cageEmissive: 0.07, cageOpacity: 0.16 },
    },
    actions: { primaryForce: { bodyIndex: 0, startStep: 120, endStep: 360, vector: [5, 4, 6] }, impulse: { bodyIndex: 1, atStep: 0, vector: [0.65, 1.2, 0] } },
    ids: { ballPrefix: "ball" },
    presentation: { frameRate: 60, viewport: { width: 640, height: 360 }, backgroundColor: "#07111f", camera: { position: [5.2, 3.6, 7.2], target: [0, 1.9, 0], fovDeg: 38, near: 0.1, far: 100 }, lighting: { direction: [-0.4, -0.8, -0.4], color: "#ffffff", ambient: 0.3, intensity: 1.4 } },
  },
  "wrecking-wall": {
    schema: PHYSICS_SHOWCASE_SCENARIO_SCHEMA, id: "wrecking-wall", kind: "wrecking-wall", durationUs: 5_000_000, stepsPerSecond: 120, seed: 7, gravity: [0, -9.81, 0],
    topology: { rows: 5, columns: 9 },
    geometry: { brickSize: [1, 0.5, 0.5], brickGap: [0.05, 0.05], baseY: 0.3, groundSize: [20, 0.2, 8], impactorRadius: 1, tetherVisualSize: [0.08, 1, 0.08] },
    materials: {
      brick: { friction: 0.65, restitution: 0.08, palette: ["#d65a3a", "#f0b35b"], emissive: 0 },
      impactor: { friction: 0.4, restitution: 0.15, color: "#27364d", emissive: 0.04 },
      ground: { color: "#26364a", emissive: 0 }, tether: { color: "#d9e2ec", emissive: 0.04 },
    },
    impactor: { position: [8, 3, 0], mass: 80, ccd: true, tether: { anchorWorld: [4.5, 5.5, 0], restLength: Math.sqrt(18.5), stiffness: 2_000, damping: 80 } },
    actions: { impact: { atStep: 30, vector: [-920, 0, 0] }, push: { startStep: 60, endStep: 90, vector: [-20, 0, 0] } },
    presentation: { frameRate: 60, viewport: { width: 640, height: 360 }, backgroundColor: "#07111f", camera: { position: [12, 8, 16], target: [0, 2.2, 0], fovDeg: 42, near: 0.1, far: 120 }, lighting: { direction: [-0.4, -0.8, -0.4], color: "#ffffff", ambient: 0.3, intensity: 1.4 } },
  },
  "wrecking-wall-large": {
    schema: PHYSICS_SHOWCASE_SCENARIO_SCHEMA, id: "wrecking-wall-large", kind: "wrecking-wall", durationUs: 6_000_000, stepsPerSecond: 120, seed: 7003, gravity: [0, -9.81, 0],
    topology: { rows: 15, columns: 9 },
    geometry: { brickSize: [1, 0.5, 0.5], brickGap: [0.05, 0.05], baseY: 0.3, groundSize: [24, 0.2, 10], impactorRadius: 1.15, tetherVisualSize: [0.1, 1, 0.1] },
    materials: {
      brick: { friction: 0.64, restitution: 0.08, palette: ["#c44d36", "#ebaa55", "#a93d2b"], emissive: 0 },
      impactor: { friction: 0.4, restitution: 0.15, color: "#223248", emissive: 0.04 },
      ground: { color: "#203146", emissive: 0 }, tether: { color: "#d9e2ec", emissive: 0.04 },
    },
    impactor: { position: [10.5, 5.5, 0], mass: 120, ccd: true, tether: { anchorWorld: [5.8, 9.2, 0], restLength: Math.sqrt(35.78), stiffness: 2_500, damping: 100 } },
    actions: { impact: { atStep: 40, vector: [-1_500, 0, 0] }, push: { startStep: 80, endStep: 130, vector: [-35, 0, 0] } },
    presentation: { frameRate: 60, viewport: { width: 640, height: 360 }, backgroundColor: "#07111f", camera: { position: [18, 12, 23], target: [0, 3.8, 0], fovDeg: 43, near: 0.1, far: 150 }, lighting: { direction: [-0.4, -0.8, -0.4], color: "#ffffff", ambient: 0.3, intensity: 1.4 } },
  },
});

type Presentation = Readonly<{
  frameRate: number;
  viewport: Readonly<{ width: number; height: number }>;
  backgroundColor: string;
  camera: Readonly<{ position: readonly [number, number, number]; target: readonly [number, number, number]; fovDeg: number; near: number; far: number }>;
  lighting: Readonly<{ direction: readonly [number, number, number]; color: string; ambient: number; intensity: number }>;
}>;
type Common = Readonly<{ id: string; kind: PhysicsShowcaseScenarioKind; durationUs: number; stepsPerSecond: number; seed: number; gravity: readonly [number, number, number]; presentation: Presentation }>;
type Bingo = Common & Readonly<{
  kind: "bingo"; topology: Readonly<{ ballCount: number; columns: number }>; geometry: Readonly<{ ballRadius: number; ballSpacing: number; enclosure: BingoIco42Record }>;
  materials: Readonly<{ ball: Readonly<{ friction: number; restitution: number; palette: readonly string[]; emissive: number }>; enclosure: Readonly<{ friction: number; restitution: number; cageColor: string; cageEmissive: number; cageOpacity: number }> }>;
  actions: Readonly<{ primaryForce: Readonly<{ bodyIndex: number; startStep: number; endStep: number; vector: readonly [number, number, number] }>; impulse: Readonly<{ bodyIndex: number; atStep: number; vector: readonly [number, number, number] }> }>;
  ids: Readonly<{ ballPrefix: string; firstBallId?: string }>;
}>;
type Wall = Common & Readonly<{
  kind: "wrecking-wall"; topology: Readonly<{ rows: number; columns: number }>; geometry: Readonly<{ brickSize: readonly [number, number, number]; brickGap: readonly [number, number]; baseY: number; groundSize: readonly [number, number, number]; impactorRadius: number; tetherVisualSize: readonly [number, number, number] }>;
  materials: Readonly<{ brick: Readonly<{ friction: number; restitution: number; palette: readonly string[]; emissive: number }>; impactor: Readonly<{ friction: number; restitution: number; color: string; emissive: number }>; ground: Readonly<{ color: string; emissive: number }>; tether: Readonly<{ color: string; emissive: number }> }>;
  impactor: Readonly<{ position: readonly [number, number, number]; mass: number; ccd: boolean; tether: Readonly<{ anchorWorld: readonly [number, number, number]; restLength: number; stiffness: number; damping: number }> }>;
  actions: Readonly<{ impact: Readonly<{ atStep: number; vector: readonly [number, number, number] }>; push: Readonly<{ startStep: number; endStep: number; vector: readonly [number, number, number] }> }>;
}>;

function readScenario(value: unknown): Bingo | Wall {
  const root = record(snapshotSceneRecipeData(value), ["schema", "id", "kind", "durationUs", "stepsPerSecond", "seed", "gravity", "topology", "geometry", "materials", "actions", "presentation"], ["ids", "impactor"], "Physics showcase scenario");
  if (root.schema !== PHYSICS_SHOWCASE_SCENARIO_SCHEMA) throw new Error(`Physics showcase scenario.schema must equal ${PHYSICS_SHOWCASE_SCENARIO_SCHEMA}.`);
  const common = { id: id(root.id, "Physics showcase scenario.id"), kind: root.kind, durationUs: integer(root.durationUs, "Physics showcase scenario.durationUs", 250_000, 60_000_000), stepsPerSecond: integer(root.stepsPerSecond, "Physics showcase scenario.stepsPerSecond", 1, 240), seed: integer(root.seed, "Physics showcase scenario.seed", 0, 2_147_483_647), gravity: vec3(root.gravity, "Physics showcase scenario.gravity", -1_000, 1_000), presentation: readPresentation(root.presentation) };
  if (!Number.isInteger((common.durationUs * common.stepsPerSecond) / 1_000_000)) throw new Error("Physics showcase scenario durationUs must contain a whole number of simulation steps.");
  if (!Number.isInteger((common.durationUs * common.presentation.frameRate) / 1_000_000)) throw new Error("Physics showcase scenario durationUs must contain a whole number of C7B4 render frames.");
  const stepCount = (common.durationUs * common.stepsPerSecond) / 1_000_000;
  if (root.kind === "bingo") {
    if (Object.hasOwn(root, "impactor")) throw new Error("Bingo scenario refuses wrecking-wall impactor authority.");
    const topology = record(root.topology, ["ballCount", "columns"], [], "Bingo topology"), ballCount = integer(topology.ballCount, "Bingo topology.ballCount", 2, SCENARIO_CAPS.bingoBalls), columns = integer(topology.columns, "Bingo topology.columns", 1, 16);
    if (columns > ballCount) throw new Error("Bingo topology.columns cannot exceed ballCount.");
    const geometry = record(root.geometry, ["ballRadius", "ballSpacing", "enclosure"], [], "Bingo geometry"), enclosure = record(geometry.enclosure, ["center", "visibleRadius", "panelThickness", "surfaceMargin", "proxy"], [], "Bingo geometry.enclosure");
    const materials = record(root.materials, ["ball", "enclosure"], [], "Bingo materials"), ball = record(materials.ball, ["friction", "restitution", "palette", "emissive"], [], "Bingo ball material"), shell = record(materials.enclosure, ["friction", "restitution", "cageColor", "cageEmissive", "cageOpacity"], [], "Bingo enclosure material");
    const actions = record(root.actions, ["primaryForce", "impulse"], [], "Bingo actions"), force = record(actions.primaryForce, ["bodyIndex", "startStep", "endStep", "vector"], [], "Bingo primaryForce"), impulse = record(actions.impulse, ["bodyIndex", "atStep", "vector"], [], "Bingo impulse");
    const ids = record(root.ids, ["ballPrefix"], ["firstBallId"], "Bingo ids"), parsed: Bingo = Object.freeze({
      ...common, kind: "bingo", topology: Object.freeze({ ballCount, columns }), geometry: Object.freeze({ ballRadius: f32Number(geometry.ballRadius, "Bingo geometry.ballRadius", 0.01, 2), ballSpacing: f32Number(geometry.ballSpacing, "Bingo geometry.ballSpacing", 0.01, 10), enclosure: Object.freeze({ center: f32Vec3(enclosure.center, "Bingo geometry.enclosure.center", -100, 100), visibleRadius: f32Number(enclosure.visibleRadius, "Bingo geometry.enclosure.visibleRadius", 0.01, 100), panelThickness: f32Number(enclosure.panelThickness, "Bingo geometry.enclosure.panelThickness", 0.001, 10), surfaceMargin: f32Number(enclosure.surfaceMargin, "Bingo geometry.enclosure.surfaceMargin", 0.0001, 10), proxy: enclosure.proxy === "icosa42-slabs" ? "icosa42-slabs" as const : invalidProxy() }) }),
      materials: Object.freeze({ ball: Object.freeze({ friction: number(ball.friction, "Bingo ball material.friction", 0, 4), restitution: number(ball.restitution, "Bingo ball material.restitution", 0, 1), palette: palette(ball.palette, "Bingo ball material.palette"), emissive: number(ball.emissive, "Bingo ball material.emissive", 0, 1) }), enclosure: Object.freeze({ friction: number(shell.friction, "Bingo enclosure material.friction", 0, 4), restitution: number(shell.restitution, "Bingo enclosure material.restitution", 0, 1), cageColor: color(shell.cageColor, "Bingo enclosure material.cageColor"), cageEmissive: number(shell.cageEmissive, "Bingo enclosure material.cageEmissive", 0, 1), cageOpacity: number(shell.cageOpacity, "Bingo enclosure material.cageOpacity", 0.05, 0.95) }) }),
      actions: Object.freeze({ primaryForce: Object.freeze({ bodyIndex: integer(force.bodyIndex, "Bingo primaryForce.bodyIndex", 0, ballCount - 1), startStep: integer(force.startStep, "Bingo primaryForce.startStep", 0, stepCount - 1), endStep: integer(force.endStep, "Bingo primaryForce.endStep", 0, stepCount - 1), vector: vec3(force.vector, "Bingo primaryForce.vector", -1_000_000, 1_000_000) }), impulse: Object.freeze({ bodyIndex: integer(impulse.bodyIndex, "Bingo impulse.bodyIndex", 0, ballCount - 1), atStep: integer(impulse.atStep, "Bingo impulse.atStep", 0, stepCount - 1), vector: vec3(impulse.vector, "Bingo impulse.vector", -1_000_000, 1_000_000) }) }),
      ids: Object.freeze({ ballPrefix: id(ids.ballPrefix, "Bingo ids.ballPrefix"), ...(Object.hasOwn(ids, "firstBallId") ? { firstBallId: id(ids.firstBallId, "Bingo ids.firstBallId") } : {}) }),
    });
    validateBingoGeometry(parsed);
    if (parsed.actions.primaryForce.endStep < parsed.actions.primaryForce.startStep) throw new Error("Bingo primaryForce must use an inclusive ascending step window.");
    if (parsed.actions.primaryForce.bodyIndex === parsed.actions.impulse.bodyIndex && parsed.actions.impulse.atStep >= parsed.actions.primaryForce.startStep && parsed.actions.impulse.atStep <= parsed.actions.primaryForce.endStep) throw new Error("Bingo force and impulse authority cannot overlap on the same body step.");
    return parsed;
  }
  if (root.kind !== "wrecking-wall") throw new Error("Physics showcase scenario.kind must equal bingo or wrecking-wall.");
  if (Object.hasOwn(root, "ids")) throw new Error("Wrecking-wall scenario refuses Bingo id authority.");
  const topology = record(root.topology, ["rows", "columns"], [], "Wrecking-wall topology"), rows = integer(topology.rows, "Wrecking-wall topology.rows", 1, SCENARIO_CAPS.wallRows), columns = integer(topology.columns, "Wrecking-wall topology.columns", 1, SCENARIO_CAPS.wallColumns);
  if (rows * columns > SCENARIO_CAPS.wallBricks) throw new Error(`Wrecking-wall topology exceeds the ${SCENARIO_CAPS.wallBricks}-brick C7B6A cap.`);
  const geometry = record(root.geometry, ["brickSize", "brickGap", "baseY", "groundSize", "impactorRadius", "tetherVisualSize"], [], "Wrecking-wall geometry"), materials = record(root.materials, ["brick", "impactor", "ground", "tether"], [], "Wrecking-wall materials"), brick = record(materials.brick, ["friction", "restitution", "palette", "emissive"], [], "Wrecking-wall brick material"), sphere = record(materials.impactor, ["friction", "restitution", "color", "emissive"], [], "Wrecking-wall impactor material"), ground = record(materials.ground, ["color", "emissive"], [], "Wrecking-wall ground material"), tether = record(materials.tether, ["color", "emissive"], [], "Wrecking-wall tether material"), impactor = record(root.impactor, ["position", "mass", "ccd", "tether"], [], "Wrecking-wall impactor"), tetherInput = record(impactor.tether, ["anchorWorld", "restLength", "stiffness", "damping"], [], "Wrecking-wall impactor.tether"), actions = record(root.actions, ["impact", "push"], [], "Wrecking-wall actions"), impact = record(actions.impact, ["atStep", "vector"], [], "Wrecking-wall impact"), push = record(actions.push, ["startStep", "endStep", "vector"], [], "Wrecking-wall push");
  const parsed: Wall = Object.freeze({
    ...common, kind: "wrecking-wall", topology: Object.freeze({ rows, columns }), geometry: Object.freeze({ brickSize: positiveVec3(geometry.brickSize, "Wrecking-wall geometry.brickSize", 0.01, 100), brickGap: vec2(geometry.brickGap, "Wrecking-wall geometry.brickGap", 0, 100), baseY: number(geometry.baseY, "Wrecking-wall geometry.baseY", 0.01, 1_000), groundSize: positiveVec3(geometry.groundSize, "Wrecking-wall geometry.groundSize", 0.01, 1_000), impactorRadius: number(geometry.impactorRadius, "Wrecking-wall geometry.impactorRadius", 0.01, 100), tetherVisualSize: positiveVec3(geometry.tetherVisualSize, "Wrecking-wall geometry.tetherVisualSize", 0.01, 100) }),
    materials: Object.freeze({ brick: Object.freeze({ friction: number(brick.friction, "Wrecking-wall brick material.friction", 0, 4), restitution: number(brick.restitution, "Wrecking-wall brick material.restitution", 0, 1), palette: palette(brick.palette, "Wrecking-wall brick material.palette"), emissive: number(brick.emissive, "Wrecking-wall brick material.emissive", 0, 1) }), impactor: Object.freeze({ friction: number(sphere.friction, "Wrecking-wall impactor material.friction", 0, 4), restitution: number(sphere.restitution, "Wrecking-wall impactor material.restitution", 0, 1), color: color(sphere.color, "Wrecking-wall impactor material.color"), emissive: number(sphere.emissive, "Wrecking-wall impactor material.emissive", 0, 1) }), ground: Object.freeze({ color: color(ground.color, "Wrecking-wall ground material.color"), emissive: number(ground.emissive, "Wrecking-wall ground material.emissive", 0, 1) }), tether: Object.freeze({ color: color(tether.color, "Wrecking-wall tether material.color"), emissive: number(tether.emissive, "Wrecking-wall tether material.emissive", 0, 1) }) }),
    impactor: Object.freeze({ position: vec3(impactor.position, "Wrecking-wall impactor.position", -1_000, 1_000), mass: number(impactor.mass, "Wrecking-wall impactor.mass", 0.001, 1_000_000), ccd: boolean(impactor.ccd, "Wrecking-wall impactor.ccd"), tether: Object.freeze({ anchorWorld: vec3(tetherInput.anchorWorld, "Wrecking-wall impactor.tether.anchorWorld", -1_000, 1_000), restLength: number(tetherInput.restLength, "Wrecking-wall impactor.tether.restLength", 0.001, 10_000), stiffness: number(tetherInput.stiffness, "Wrecking-wall impactor.tether.stiffness", 0.001, 1_000_000), damping: number(tetherInput.damping, "Wrecking-wall impactor.tether.damping", 0, 1_000_000) }) }),
    actions: Object.freeze({ impact: Object.freeze({ atStep: integer(impact.atStep, "Wrecking-wall impact.atStep", 0, stepCount - 1), vector: vec3(impact.vector, "Wrecking-wall impact.vector", -1_000_000, 1_000_000) }), push: Object.freeze({ startStep: integer(push.startStep, "Wrecking-wall push.startStep", 0, stepCount - 1), endStep: integer(push.endStep, "Wrecking-wall push.endStep", 0, stepCount - 1), vector: vec3(push.vector, "Wrecking-wall push.vector", -1_000_000, 1_000_000) }) }),
  });
  validateWallGeometry(parsed);
  if (parsed.actions.push.endStep < parsed.actions.push.startStep) throw new Error("Wrecking-wall push must use an inclusive ascending step window.");
  if (parsed.actions.impact.atStep >= parsed.actions.push.startStep && parsed.actions.impact.atStep <= parsed.actions.push.endStep) throw new Error("Wrecking-wall impact and push authority cannot overlap on the impactor step.");
  return parsed;
}

function compileBingo(scenario: Bingo): { physicsRecipe: unknown; geometryResourceCount: number; materialResourceCount: number; enclosure: BingoIco42Enclosure } {
  const enclosure = deriveBingoIco42Enclosure(scenario.geometry.enclosure, scenario.geometry.ballRadius);
  const balls = Array.from({ length: scenario.topology.ballCount }, (_entry, index) => {
    const generatedId = `${scenario.ids.ballPrefix}-${String(index).padStart(2, "0")}`;
    return dynamicBody(index === 0 && scenario.ids.firstBallId ? scenario.ids.firstBallId : generatedId, bingoInitialPosition(scenario, index), "ball", { kind: "sphere", radius: scenario.geometry.ballRadius });
  });
  const statics = enclosure.panels.map((panel) => staticBody(panel.id, panel.position, panel.size, "wall", panel.rotation));
  const forceBody = balls[scenario.actions.primaryForce.bodyIndex]!.id, impulseBody = balls[scenario.actions.impulse.bodyIndex]!.id;
  return { physicsRecipe: { schema: PHYSICS_BAKE_SCHEMA, id: scenario.id, startUs: 0, endUs: scenario.durationUs, stepsPerSecond: scenario.stepsPerSecond, seed: scenario.seed, units: units(), world: { gravity: scenario.gravity }, materials: [{ id: "ball", friction: scenario.materials.ball.friction, restitution: scenario.materials.ball.restitution }, { id: "wall", friction: scenario.materials.enclosure.friction, restitution: scenario.materials.enclosure.restitution }], bodies: [...balls, ...statics], constraints: [], actions: [{ id: "force", kind: "force", startStep: scenario.actions.primaryForce.startStep, endStep: scenario.actions.primaryForce.endStep, bodyId: forceBody, vector: scenario.actions.primaryForce.vector }, { id: "impulse", kind: "impulse", atStep: scenario.actions.impulse.atStep, bodyId: impulseBody, vector: scenario.actions.impulse.vector }], events: [{ id: "ball-floor", kind: "collision-pair", bodyA: forceBody, bodyB: enclosure.floorPanelId, phases: ["start", "stop"] }], observations: [{ id: "body-states", kind: "body-state", bodyIds: balls.map((entry) => entry.id), sampleEverySteps: 2 }, { id: "contacts", kind: "contact-pairs", eventIds: ["ball-floor"], sampleEverySteps: 4 }] }, geometryResourceCount: 2, materialResourceCount: scenario.materials.ball.palette.length + 1, enclosure };
}

function compileWall(scenario: Wall): { physicsRecipe: unknown; geometryResourceCount: number; materialResourceCount: number; enclosure?: undefined } {
  const [brickWidth, brickHeight, brickDepth] = scenario.geometry.brickSize, [gapX, gapY] = scenario.geometry.brickGap;
  const bricks = Array.from({ length: scenario.topology.rows }, (_row, row) => Array.from({ length: scenario.topology.columns }, (_column, column) => dynamicBody(`brick-r${String(row).padStart(2, "0")}-c${String(column).padStart(2, "0")}`, [(column - (scenario.topology.columns - 1) / 2) * (brickWidth + gapX), scenario.geometry.baseY + row * (brickHeight + gapY), 0], "brick", { kind: "box", size: scenario.geometry.brickSize }))).flat();
  const eventWidth = Math.max(2, String(bricks.length - 1).length), eventId = (index: number) => `impact-contact-${String(index).padStart(eventWidth, "0")}`;
  return { physicsRecipe: { schema: PHYSICS_BAKE_SCHEMA, id: scenario.id, startUs: 0, endUs: scenario.durationUs, stepsPerSecond: scenario.stepsPerSecond, seed: scenario.seed, units: units(), world: { gravity: scenario.gravity }, materials: [{ id: "brick", friction: scenario.materials.brick.friction, restitution: scenario.materials.brick.restitution }, { id: "sphere", friction: scenario.materials.impactor.friction, restitution: scenario.materials.impactor.restitution }], bodies: [...bricks, staticBody("ground", [0, 0, 0], scenario.geometry.groundSize, "brick"), dynamicBody("sphere", scenario.impactor.position, "sphere", { kind: "sphere", radius: scenario.geometry.impactorRadius }, scenario.impactor.mass, scenario.impactor.ccd)], constraints: [{ id: "tether", kind: "distance", bodyA: "sphere", bodyB: null, anchorA: [0, 0, 0], anchorB: scenario.impactor.tether.anchorWorld, restLength: scenario.impactor.tether.restLength, stiffness: scenario.impactor.tether.stiffness, damping: scenario.impactor.tether.damping }], actions: [{ id: "impact", kind: "impulse", atStep: scenario.actions.impact.atStep, bodyId: "sphere", vector: scenario.actions.impact.vector }, { id: "push", kind: "force", startStep: scenario.actions.push.startStep, endStep: scenario.actions.push.endStep, bodyId: "sphere", vector: scenario.actions.push.vector }], events: bricks.map((brick, index) => ({ id: eventId(index), kind: "collision-pair", bodyA: brick.id, bodyB: "sphere", phases: ["start", "stop"] })), observations: [{ id: "body-states", kind: "body-state", bodyIds: [...bricks.map((entry) => entry.id), "sphere"], sampleEverySteps: 2 }, { id: "contacts", kind: "contact-pairs", eventIds: bricks.map((_brick, index) => eventId(index)), sampleEverySteps: 2 }] }, geometryResourceCount: 4, materialResourceCount: scenario.materials.brick.palette.length + 3 };
}

function bingoVisualBinding(scenario: Bingo, plan: PhysicsBakeAdmissionPlan): unknown {
  const dynamicIds = plan.recipe.bodies.filter((body) => body.kind === "dynamic").map((body) => body.id);
  return Object.freeze({ schema: PHYSICS_VISUAL_BINDING_SCHEMA, physicsPlanFingerprint: plan.fingerprint, frameRate: scenario.presentation.frameRate, interpolation: { position: "linear" as const, rotation: "slerp-shortest" as const }, resources: { geometry: [{ id: "ball", kind: "sphere", radius: scenario.geometry.ballRadius, quality: "cinematic" }], materials: scenario.materials.ball.palette.map((baseColor, index) => ({ id: `color-${String(index).padStart(2, "0")}`, kind: "basic", baseColor, emissive: scenario.materials.ball.emissive })) }, bindings: dynamicIds.map((bodyId, index) => ({ bodyId, geometryRef: "ball", materialRef: `color-${String(index % scenario.materials.ball.palette.length).padStart(2, "0")}` })) });
}

function wallVisualBinding(scenario: Wall, plan: PhysicsBakeAdmissionPlan): unknown {
  const dynamicIds = plan.recipe.bodies.filter((body) => body.kind === "dynamic").map((body) => body.id), palette = scenario.materials.brick.palette;
  return Object.freeze({ schema: PHYSICS_VISUAL_BINDING_SCHEMA, physicsPlanFingerprint: plan.fingerprint, frameRate: scenario.presentation.frameRate, interpolation: { position: "linear" as const, rotation: "slerp-shortest" as const }, resources: { geometry: [{ id: "brick", kind: "box", size: scenario.geometry.brickSize }, { id: "sphere", kind: "sphere", radius: scenario.geometry.impactorRadius, quality: "cinematic" }], materials: [...palette.map((baseColor, index) => ({ id: `brick-${String.fromCharCode(97 + index)}`, kind: "basic", baseColor, emissive: scenario.materials.brick.emissive })), { id: "sphere", kind: "basic", baseColor: scenario.materials.impactor.color, emissive: scenario.materials.impactor.emissive }] }, bindings: dynamicIds.map((bodyId, index) => ({ bodyId, geometryRef: bodyId === "sphere" ? "sphere" : "brick", materialRef: bodyId === "sphere" ? "sphere" : `brick-${String.fromCharCode(97 + index % palette.length)}` })) });
}

function bingoPresentation(scenario: Bingo, retainedStaticFingerprint: string, physicsPlanFingerprint: string): unknown {
  return Object.freeze({ schema: PHYSICS_VISUAL_PRESENTATION_SCHEMA, retainedStaticFingerprint, physicsPlanFingerprint, additionalResources: { geometry: [{ id: "z-cage-sphere", kind: "sphere", radius: scenario.geometry.enclosure.visibleRadius, quality: "cinematic" }], materials: [{ id: "z-cage-ice", kind: "basic", baseColor: scenario.materials.enclosure.cageColor, emissive: scenario.materials.enclosure.cageEmissive }] }, staticCollisionBindings: [], constraintBindings: [], presentationBindings: [{ id: "cage", geometryRef: "z-cage-sphere", materialRef: "z-cage-ice", opacity: scenario.materials.enclosure.cageOpacity, position: scenario.geometry.enclosure.center, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }] });
}

function wallPresentation(scenario: Wall, retainedStaticFingerprint: string, physicsPlanFingerprint: string): unknown {
  return Object.freeze({ schema: PHYSICS_VISUAL_PRESENTATION_SCHEMA, retainedStaticFingerprint, physicsPlanFingerprint, additionalResources: { geometry: [{ id: "z-ground-visual", kind: "box", size: scenario.geometry.groundSize }, { id: "z-tether-visual", kind: "box", size: scenario.geometry.tetherVisualSize }], materials: [{ id: "z-ground-matte", kind: "basic", baseColor: scenario.materials.ground.color, emissive: scenario.materials.ground.emissive }, { id: "z-tether-steel", kind: "basic", baseColor: scenario.materials.tether.color, emissive: scenario.materials.tether.emissive }] }, staticCollisionBindings: [{ bodyId: "ground", geometryRef: "z-ground-visual", materialRef: "z-ground-matte" }], constraintBindings: [{ constraintId: "tether", geometryRef: "z-tether-visual", materialRef: "z-tether-steel" }], presentationBindings: [] });
}

function bingoInitialPosition(scenario: Bingo, index: number): Vec3 {
  const { center, visibleRadius } = scenario.geometry.enclosure, radius = scenario.geometry.ballRadius, columns = scenario.topology.columns;
  const x = center[0] + (index % columns - (columns - 1) / 2) * scenario.geometry.ballSpacing;
  const y = center[1] - visibleRadius / 2 - radius / 4 + Math.floor(index / columns) * scenario.geometry.ballSpacing;
  return tuple3([f32(x), f32(y), center[2]]);
}

function requireCompilation(value: PhysicsShowcaseScenarioCompilation): PhysicsShowcaseScenarioCompilation & Readonly<{ scenario: Bingo | Wall }> {
  if (!value || typeof value !== "object" || !authorities.has(value)) throw new Error("Physics showcase scenario requires a compiler-minted scenario compilation.");
  return value as PhysicsShowcaseScenarioCompilation & Readonly<{ scenario: Bingo | Wall }>;
}
function units() { return { length: "meter" as const, angle: "radian" as const, time: "second" as const, upAxis: "y" as const, forwardAxis: "-z" as const }; }
function dynamicBody(idValue: string, position: readonly number[], materialRef: string, collider: unknown, mass = 1, ccd = false) { return { id: idValue, kind: "dynamic" as const, collider, materialRef, position, rotation: [0, 0, 0, 1], collisionGroup: 1, collisionMask: 0xffff, mass, linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0], ccd }; }
function staticBody(idValue: string, position: readonly number[], size: readonly number[], materialRef: string, rotation: readonly number[] = [0, 0, 0, 1]) { return { id: idValue, kind: "static" as const, collider: { kind: "box", size }, materialRef, position, rotation, collisionGroup: 1, collisionMask: 0xffff }; }
function validateBingoGeometry(scenario: Bingo): void {
  const { ballRadius: radius, ballSpacing: spacing } = scenario.geometry;
  if (spacing < radius * 2) throw new Error("Bingo ballSpacing must avoid initial ball overlap.");
  const enclosure = deriveBingoIco42Enclosure(scenario.geometry.enclosure, radius), visibleLimit = enclosure.record.visibleRadius - enclosure.record.surfaceMargin;
  for (let index = 0; index < scenario.topology.ballCount; index += 1) {
    const position = bingoInitialPosition(scenario, index), distance = Math.hypot(position[0] - enclosure.record.center[0], position[1] - enclosure.record.center[1], position[2] - enclosure.record.center[2]);
    if (distance + radius > visibleLimit + 1e-6) throw new Error("Bingo topology and ball radius must fit inside the declared enclosure sphere.");
    for (const panel of enclosure.panels) {
      const normal = bingoIco42PanelNormal(panel.rotation), actualInnerPlane = bingoIco42PanelInnerPlane(enclosure.record.center, panel);
      const centerPlane = dot(normal, position.map((component, axis) => component - enclosure.record.center[axis]!));
      if (centerPlane + radius > actualInnerPlane) throw new Error("Bingo topology and ball radius must fit inside every emitted enclosure panel.");
    }
  }
}
function validateWallGeometry(scenario: Wall): void {
  const [brickWidth, brickHeight, brickDepth] = scenario.geometry.brickSize, [gapX] = scenario.geometry.brickGap, [groundWidth, , groundDepth] = scenario.geometry.groundSize, footprintWidth = scenario.topology.columns * brickWidth + (scenario.topology.columns - 1) * gapX;
  if (footprintWidth > groundWidth || brickDepth > groundDepth) throw new Error("Wrecking-wall brick footprint must fit the declared ground x/depth.");
  if (scenario.geometry.baseY < brickHeight / 2) throw new Error("Wrecking-wall baseY must be at least half the brick height.");
  if (scenario.geometry.tetherVisualSize[1] !== 1) throw new Error("Wrecking-wall tetherVisualSize must use unit Y length for C7B4C.");
}
function record(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a plain object.`); const result = value as Record<string, unknown>, allowed = new Set([...required, ...optional]), unknown = Object.keys(result).find((key) => !allowed.has(key)); if (unknown) throw new Error(`${label} has unknown field '${unknown}'.`); const missing = required.find((key) => !Object.hasOwn(result, key)); if (missing) throw new Error(`${label} requires ${missing}.`); return result; }
function integer(value: unknown, label: string, minimum: number, maximum: number): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be a safe integer in ${minimum}..${maximum}.`); return Object.is(value, -0) ? 0 : value; }
function number(value: unknown, label: string, minimum: number, maximum: number): number { if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} must be finite and in ${minimum}..${maximum}.`); return Object.is(value, -0) ? 0 : value; }
function f32Number(value: unknown, label: string, minimum: number, maximum: number): number { const normalized = f32(number(value, label, minimum, maximum)); if (normalized < minimum || normalized > maximum) throw new Error(`${label} cannot be represented in the admitted f32 range.`); return normalized; }
function f32(value: number): number { const result = Math.fround(value); if (!Number.isFinite(result)) throw new Error("Physics showcase f32 value must be finite."); return Object.is(result, -0) ? 0 : result; }
function tuple3(value: readonly number[]): Vec3 { return Object.freeze([value[0]!, value[1]!, value[2]!]); }
function dot(left: readonly number[], right: readonly number[]): number { return left.reduce((sum, value, index) => sum + value * right[index]!, 0); }
function id(value: unknown, label: string): string { if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a safe stable id.`); return value; }
function sha256(value: unknown, label: string): string { if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lower-case SHA-256 identity.`); return value; }
function boolean(value: unknown, label: string): boolean { if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`); return value; }
function color(value: unknown, label: string): string { if (typeof value !== "string" || !/^#[a-fA-F0-9]{6}$/.test(value)) throw new Error(`${label} must be #RRGGBB.`); return value.toLowerCase(); }
function vec2(value: unknown, label: string, minimum: number, maximum: number): readonly [number, number] { if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label} must contain exactly two entries.`); return Object.freeze(value.map((entry, index) => number(entry, `${label}[${index}]`, minimum, maximum))) as unknown as readonly [number, number]; }
function vec3(value: unknown, label: string, minimum: number, maximum: number): readonly [number, number, number] { if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label} must contain exactly three entries.`); return Object.freeze(value.map((entry, index) => number(entry, `${label}[${index}]`, minimum, maximum))) as unknown as readonly [number, number, number]; }
function f32Vec3(value: unknown, label: string, minimum: number, maximum: number): Vec3 { if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label} must contain exactly three entries.`); return tuple3(value.map((entry, index) => f32Number(entry, `${label}[${index}]`, minimum, maximum))); }
function positiveVec3(value: unknown, label: string, minimum: number, maximum: number): readonly [number, number, number] { return vec3(value, label, minimum, maximum); }
function palette(value: unknown, label: string): readonly string[] { if (!Array.isArray(value) || value.length < 1 || value.length > SCENARIO_CAPS.paletteColors) throw new Error(`${label} must contain 1..${SCENARIO_CAPS.paletteColors} explicit colors.`); return Object.freeze(value.map((entry, index) => color(entry, `${label}[${index}]`))); }
function invalidProxy(): never { throw new Error("Bingo geometry.enclosure.proxy must equal icosa42-slabs."); }
function readPresentation(value: unknown): Presentation {
  const root = record(value, ["frameRate", "viewport", "backgroundColor", "camera", "lighting"], [], "Physics showcase presentation"), viewport = record(root.viewport, ["width", "height"], [], "Physics showcase presentation.viewport"), camera = record(root.camera, ["position", "target", "fovDeg", "near", "far"], [], "Physics showcase presentation.camera"), lighting = record(root.lighting, ["direction", "color", "ambient", "intensity"], [], "Physics showcase presentation.lighting");
  const parsedCamera = Object.freeze({ position: vec3(camera.position, "Physics showcase presentation.camera.position", -10_000, 10_000), target: vec3(camera.target, "Physics showcase presentation.camera.target", -10_000, 10_000), fovDeg: number(camera.fovDeg, "Physics showcase presentation.camera.fovDeg", 1, 179), near: number(camera.near, "Physics showcase presentation.camera.near", 0.001, 1_000), far: number(camera.far, "Physics showcase presentation.camera.far", 0.002, 100_000) });
  const parsedLighting = Object.freeze({ direction: vec3(lighting.direction, "Physics showcase presentation.lighting.direction", -1, 1), color: color(lighting.color, "Physics showcase presentation.lighting.color"), ambient: number(lighting.ambient, "Physics showcase presentation.lighting.ambient", 0, 1), intensity: number(lighting.intensity, "Physics showcase presentation.lighting.intensity", 0, 4) });
  validatePresentation(parsedCamera, parsedLighting);
  return Object.freeze({ frameRate: integer(root.frameRate, "Physics showcase presentation.frameRate", 1, 120), viewport: Object.freeze({ width: integer(viewport.width, "Physics showcase presentation.viewport.width", 1, 1_920), height: integer(viewport.height, "Physics showcase presentation.viewport.height", 1, 1_080) }), backgroundColor: color(root.backgroundColor, "Physics showcase presentation.backgroundColor"), camera: parsedCamera, lighting: parsedLighting });
}
function validatePresentation(camera: Presentation["camera"], lighting: Presentation["lighting"]): void {
  const position = camera.position.map(Math.fround) as unknown as readonly [number, number, number], target = camera.target.map(Math.fround) as unknown as readonly [number, number, number], direction = lighting.direction.map(Math.fround) as unknown as readonly [number, number, number], near = Math.fround(camera.near), far = Math.fround(camera.far);
  if (near >= far || Math.hypot(position[0]! - target[0]!, position[1]! - target[1]!, position[2]! - target[2]!) < 1e-6 || Math.hypot(direction[0]!, direction[1]!, direction[2]!) < 1e-6) throw new Error("Physics showcase camera and lighting vectors must be non-degenerate and near must precede far.");
  if (Math.hypot(position[0]! - target[0]!, position[2]! - target[2]!) < 1e-6) throw new Error("Physics showcase camera view cannot be parallel to the fixed y-up axis.");
}
