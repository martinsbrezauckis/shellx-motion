import { canonicalJsonSha256 } from "../../canonical-json";
import { compileGpuScene3DAnimationStaticPlan } from "../../gpu-scene3d-animation-composition";
import { readMotionScene3DAnimationDescriptor } from "../../motion-scene3d-animation-read";
import type { MotionScene3DAnimationTrack } from "../../motion-scene3d-animation-types";
import type { MotionDocument, MotionLayer, MotionScene3DMeshGeometry, MotionScene3DMeshObject, MotionVec3 } from "../../types";
import { loadSchemaSync, validateDocumentSync } from "../../validate";
import { freeze } from "../checkpoint-storyboard/checkpoint-storyboard-data";
import { compileCollisionShowcaseRecipe } from "./collision-showcase-compile";
import { appendGeometry, cuboidGeometry, geometrySha256, sphereGeometry } from "./collision-showcase-geometry";
import { quantize } from "./collision-showcase-simulation";
import {
  COLLISION_SHOWCASE_LOWERING_SCHEMA,
  type CollisionShowcaseGeometryEvidence,
  type CollisionShowcaseLowering,
} from "./collision-showcase-lowering-types";
import type { CollisionShowcaseBodyCatalogEntry, CollisionShowcasePlan } from "./collision-showcase-types";

const PLAN_FIELDS = ["schema", "solverVersion", "kind", "recipe", "recipeSha256", "bodyCatalog", "frames", "checkpoints", "contacts", "budget", "evidence", "fingerprint"] as const;
const BRICK_HALF_EXTENTS: MotionVec3 = [0.24, 0.22, 0.32];
const WRECKING_BALL_RADIUS = 0.6;
const WRECKING_ANCHOR: MotionVec3 = [-1.2, 2.6, 0];
// The authored schedule includes the exact document-end sample. One extra microsecond keeps
// ordinary end-exclusive layer activity visible at 5_000_000us; static planning still clips the
// layer topology to the five-second document and no later playhead is admissible.
const CHECKPOINT_LAYER_DURATION_MS = 5_000.001;

/** Lowers only a recompiled C6G-A authority to ordinary static Scene3D data and bounded tracks. */
export function lowerCollisionShowcasePlan(value: unknown): CollisionShowcaseLowering {
  const plan = recompilePlanAuthority(value);
  const lowered = plan.kind === "bingo-sphere-3d@1" ? lowerBingo(plan) : lowerWrecking(plan);
  const validation = validateDocumentSync(loadSchemaSync("motion"), lowered.motion);
  if (!validation.ok) throw new Error(`Collision showcase lowering produced invalid Motion data at ${validation.errors[0]?.path}: ${validation.errors[0]?.message}`);
  const strictPreview = compileGpuScene3DAnimationStaticPlan(lowered.motion);
  if (!strictPreview.ok) throw new Error(`Collision showcase lowering is outside strict Scene3D preview admission: ${strictPreview.failure.message}`);
  const animationBudget = strictPreview.plan.animationStaticPlan.budget;
  if (animationBudget.trackCount !== plan.budget.projectedScene3dTrackCount || animationBudget.keyframeCount !== plan.budget.projectedScene3dKeyframeCount) {
    throw new Error("Collision showcase lowering no longer matches its C6G-A projected track and keyframe budget.");
  }
  const budget = freeze({
    ...sceneBudget(lowered.motion.layers),
    trackCount: animationBudget.trackCount,
    keyframeCount: animationBudget.keyframeCount,
    planWorkUnits: animationBudget.planWorkUnits,
    frameWorkUnits: animationBudget.frameWorkUnits,
  });
  const motionSha256 = canonicalJsonSha256(lowered.motion);
  const payload = {
    schema: COLLISION_SHOWCASE_LOWERING_SCHEMA,
    kind: plan.kind,
    planFingerprint: plan.fingerprint,
    motion: lowered.motion,
    motionSha256,
    geometry: lowered.geometry,
    budget,
    evidence: {
      planRecompiled: true as const,
      ordinaryScene3d: true as const,
      ordinaryScene3dAnimation: true as const,
      fixedHashedGeometry: true as const,
      fusedTetherRotationDerived: plan.kind === "wrecking-wall-3d@1",
      strictPreviewAdmitted: true as const,
      rendererInvoked: false as const,
      packageWritten: false as const,
    },
    strictPreviewStaticFingerprint: strictPreview.plan.fingerprint,
  };
  return freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

function lowerBingo(plan: CollisionShowcasePlan): { motion: MotionDocument; geometry: readonly CollisionShowcaseGeometryEvidence[] } {
  const sphere = sphereGeometry(), sphereHash = geometrySha256(sphere), layerId = "c6g-bingo-balls";
  const objects = plan.bodyCatalog.map((body) => meshObject(body, sphere, sphereHash, firstState(plan, body.id).position, firstState(plan, body.id).rotationDeg, body.radius ?? 1));
  const cageRadius = plan.recipe.kind === "bingo-sphere-3d@1" ? plan.recipe.cageRadius : 1;
  const cage = mesh("bingo-cage-shell", sphere, sphereHash, [0, 0, 0], [0, 0, 0], cageRadius, "#7dd3fc", 0.35);
  const tracks: MotionScene3DAnimationTrack[] = plan.bodyCatalog.map((body) => vectorTrack(`pos-${body.id}`, layerId, body.id, "position", plan, body.id, "position"));
  const selectedId = plan.recipe.kind === "bingo-sphere-3d@1" ? plan.recipe.selectedBallId : "";
  const selectedFrame = plan.recipe.kind === "bingo-sphere-3d@1" ? plan.recipe.selectedFrame : 0;
  tracks.push({ id: `select-${selectedId}`, locator: { layerId, scope: "object", objectId: selectedId, property: "emissive" }, keyframes: [{ atUs: plan.frames[selectedFrame]!.atUs, value: 0.35, easing: "linear" }, { atUs: plan.frames.at(-1)!.atUs, value: 1, easing: "linear" }] });
  const motion = documentFor(plan, [sceneLayer(layerId, objects), sceneLayer("c6g-bingo-cage", [cage], 0.18)], tracks, "Bingo Sphere Collision");
  return { motion, geometry: freeze([geometryEvidence("unit-sphere", sphere, sphereHash)]) };
}

function lowerWrecking(plan: CollisionShowcasePlan): { motion: MotionDocument; geometry: readonly CollisionShowcaseGeometryEvidence[] } {
  const sphere = sphereGeometry(WRECKING_BALL_RADIUS), brick = cuboidGeometry(BRICK_HALF_EXTENTS);
  const tetherLength = plan.recipe.kind === "wrecking-wall-3d@1" ? plan.recipe.tetherLength : 1;
  const ballTether = appendGeometry(sphere, cuboidGeometry([0.035, tetherLength / 2, 0.035], [0, tetherLength / 2, 0]));
  const brickHash = geometrySha256(brick), ballHash = geometrySha256(ballTether), layerId = "c6g-wrecking-scene";
  const objects = plan.bodyCatalog.map((body) => body.id === "wrecking-ball"
    ? mesh(body.id, ballTether, ballHash, firstState(plan, body.id).position, [0, 0, tetherAngle(firstState(plan, body.id).position)], 1, body.color, 0.15)
    : meshObject(body, brick, brickHash, firstState(plan, body.id).position, firstState(plan, body.id).rotationDeg, 1));
  const tracks: MotionScene3DAnimationTrack[] = plan.bodyCatalog.map((body) => vectorTrack(`pos-${body.id}`, layerId, body.id, "position", plan, body.id, "position"));
  tracks.push({ id: "rot-wrecking-tether", locator: { layerId, scope: "object", objectId: "wrecking-ball", property: "rotationDeg" }, keyframes: TETHER_ROTATION_FRAMES.map((frameIndex) => { const frame = plan.frames[frameIndex]!; return { atUs: frame.atUs, value: [0, 0, tetherAngle(stateAt(frame, "wrecking-ball").position)], easing: "linear" }; }) });
  const motion = documentFor(plan, [sceneLayer(layerId, objects)], tracks, "Wrecking Wall Collision");
  return { motion, geometry: freeze([geometryEvidence("brick-cuboid", brick, brickHash), geometryEvidence("wrecking-ball-tether", ballTether, ballHash)]) };
}

function documentFor(plan: CollisionShowcasePlan, layers: MotionLayer[], tracks: MotionScene3DAnimationTrack[], name: string): MotionDocument {
  const animation = readMotionScene3DAnimationDescriptor({ schema: "shellx-motion/scene3d-animation@1", tracks });
  return freeze({ schema: "shellx-motion/motion@1", id: `c6g-${plan.kind.startsWith("bingo") ? "bingo" : "wrecking"}-${plan.fingerprint.slice(0, 16)}`, name, durationMs: 5_000, fps: 30, width: 1_280, height: 720, assets: [], layers, scene3dAnimation: animation, provenance: { sourceApp: "shellx-motion", createdBy: "c6g-collision-showcase-lowering", workflow: "author-time-collision-bake" } });
}

function sceneLayer(id: string, objects: MotionScene3DMeshObject[], opacity = 1): MotionLayer {
  const bingo = id.startsWith("c6g-bingo");
  return { id, type: "scene3d", startMs: 0, durationMs: CHECKPOINT_LAYER_DURATION_MS, opacity, scene3d: { schema: "shellx-motion/scene3d@2", camera: bingo ? { position: [0, 0.3, 6.4], target: [0, 0.05, 0], fovDeg: 40, near: 0.1, far: 100 } : { position: [6, 2.8, 5.6], target: [-0.15, 0.85, 0], fovDeg: 36, near: 0.1, far: 100 }, lighting: { ambient: 0.32, direction: [-0.4, -0.8, -0.5], intensity: 1.35, color: "#ffffff" }, backgroundColor: bingo ? "#050816" : "#09090b", objects } };
}

function meshObject(body: CollisionShowcaseBodyCatalogEntry, geometry: MotionScene3DMeshGeometry, hash: string, position: readonly number[], rotation: readonly number[], scale: number): MotionScene3DMeshObject {
  return mesh(body.id, geometry, hash, position, rotation, scale, body.color, body.shape === "sphere" ? 0.06 : 0);
}
function mesh(id: string, geometry: MotionScene3DMeshGeometry, hash: string, position: readonly number[], rotation: readonly number[], scale: number, color: string, emissive: number): MotionScene3DMeshObject {
  return { id, primitive: "mesh", geometry, source: { format: "gltf", meshIndex: 0, primitiveIndex: 0, geometrySha256: hash }, position: [...position] as MotionVec3, rotationDeg: [...rotation] as MotionVec3, scale, color, emissive };
}
function vectorTrack(id: string, layerId: string, objectId: string, property: "position" | "rotationDeg", plan: CollisionShowcasePlan, bodyId: string, field: "position" | "rotationDeg", frameIndices?: readonly number[]): MotionScene3DAnimationTrack {
  const frames = frameIndices ? frameIndices.map((frameIndex) => plan.frames[frameIndex]!) : plan.frames;
  return { id, locator: { layerId, scope: "object", objectId, property }, keyframes: frames.map((frame) => ({ atUs: frame.atUs, value: [...stateAt(frame, bodyId)[field]] as MotionVec3, easing: "linear" })) };
}
function firstState(plan: CollisionShowcasePlan, id: string) { return stateAt(plan.frames[0]!, id); }
function stateAt(frame: CollisionShowcasePlan["frames"][number], id: string) { const state = frame.bodies.find((body) => body.id === id); if (!state) throw new Error(`Collision showcase plan frame ${frame.frameIndex} is missing ${id}.`); return state; }
function tetherAngle(position: readonly number[]): number { return quantize(Math.atan2(position[0] - WRECKING_ANCHOR[0], WRECKING_ANCHOR[1] - position[1]) * 180 / Math.PI); }
function geometryEvidence(id: CollisionShowcaseGeometryEvidence["id"], geometry: MotionScene3DMeshGeometry, hash: string): CollisionShowcaseGeometryEvidence { return freeze({ id, geometrySha256: hash, vertexCount: geometry.positions.length / 3, indexCount: geometry.indices.length }); }
function sceneBudget(layers: readonly MotionLayer[]) { let objects = 0, vertices = 0, indices = 0; for (const layer of layers) for (const object of layer.scene3d?.objects ?? []) { objects += 1; if (object.primitive === "mesh") { vertices += object.geometry.positions.length / 3; indices += object.geometry.indices.length; } } return { sceneLayerCount: layers.length, sceneObjectCount: objects, meshVertexCount: vertices, meshIndexCount: indices }; }

function recompilePlanAuthority(value: unknown): CollisionShowcasePlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Collision showcase lowering requires a C6G-A plan object.");
  let prototype: object | null, keys: PropertyKey[]; try { prototype = Object.getPrototypeOf(value); keys = Reflect.ownKeys(value); } catch { throw new Error("Collision showcase plan reflection failed."); }
  if ((prototype !== Object.prototype && prototype !== null) || keys.length !== PLAN_FIELDS.length || keys.some((key) => typeof key !== "string" || !PLAN_FIELDS.includes(key as typeof PLAN_FIELDS[number]))) throw new Error("Collision showcase lowering requires the exact C6G-A plan envelope.");
  const fields = new Map<string, unknown>();
  for (const key of keys as string[]) { let descriptor: PropertyDescriptor | undefined; try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { throw new Error("Collision showcase plan reflection failed."); } if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error(`Collision showcase plan.${key} must be an enumerable data field.`); fields.set(key, descriptor.value); }
  const plan = compileCollisionShowcaseRecipe(fields.get("recipe"));
  for (const [field, expected] of [["schema", plan.schema], ["solverVersion", plan.solverVersion], ["kind", plan.kind], ["recipeSha256", plan.recipeSha256], ["fingerprint", plan.fingerprint]] as const) if (fields.get(field) !== expected) throw new Error(`Collision showcase plan ${field} is stale or forged.`);
  return plan;
}

const TETHER_ROTATION_FRAMES = Object.freeze([...Array.from({ length: 27 }, (_entry, index) => index * 2), 56, 60]);
