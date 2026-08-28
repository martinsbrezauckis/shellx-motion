import { canonicalJsonSha256, compareCodeUnits } from "../../canonical-json";
import { freeze } from "../checkpoint-storyboard/checkpoint-storyboard-data";
import {
  COLLISION_SHOWCASE_DURATION_US,
  COLLISION_SHOWCASE_FRAME_COUNT,
  COLLISION_SHOWCASE_FRAME_RATE,
  COLLISION_SHOWCASE_MAX_CONTACTS_PER_TICK,
  COLLISION_SHOWCASE_PLAN_SCHEMA,
  COLLISION_SHOWCASE_RENDER_FRAME_COUNT,
  COLLISION_SHOWCASE_RENDER_FRAME_RATE,
  COLLISION_SHOWCASE_SAMPLE_EVERY_TICKS,
  COLLISION_SHOWCASE_SOLVER_ITERATIONS,
  COLLISION_SHOWCASE_SOLVER_VERSION,
  COLLISION_SHOWCASE_TICKS_PER_SECOND,
  type CollisionBodyShape,
  type CollisionShowcaseBodyCatalogEntry,
  type CollisionShowcaseBodyState,
  type CollisionShowcaseContact,
  type CollisionShowcaseFrame,
  type CollisionShowcasePlan,
  type CollisionShowcaseRecipe,
  type Vec3,
} from "./collision-showcase-types";

const Q = 1_000_000;

export interface SimBody {
  id: string;
  shape: CollisionBodyShape;
  color: string;
  dynamic: boolean;
  position: [number, number, number];
  velocity: [number, number, number];
  rotationDeg: [number, number, number];
  angularVelocity: [number, number, number];
  radius?: number;
  halfExtents?: [number, number, number];
}

export interface SimulationResult {
  bodies: readonly SimBody[];
  frames: readonly CollisionShowcaseFrame[];
  checkpoints: readonly { id: string; frameIndex: number }[];
  contacts: ContactLedger;
  maximumPairCandidates: number;
  projectedTrackCount: number;
  projectedKeyframeCount: number;
  axisAlignedBoxCollisionWithVisualRotation: boolean;
}

export class XorShift32 {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0; }
  next(): number { let value = this.state; value ^= value << 13; value ^= value >>> 17; value ^= value << 5; this.state = value >>> 0; return this.state; }
  unit(): number { return this.next() / 0x1_0000_0000; }
  signed(): number { return this.unit() * 2 - 1; }
}

export class ContactLedger {
  private tick = -1;
  private current = new Set<string>();
  private readonly entries: CollisionShowcaseContact[] = [];
  private readonly firstByPair = new Map<string, CollisionShowcaseContact>();
  maximumPerTick = 0;

  startTick(tick: number): void { this.finishTick(); this.tick = tick; this.current = new Set(); }
  add(kind: CollisionShowcaseContact["kind"], left: string, right: string): void {
    if (this.tick < 0) throw new Error("Collision contact ledger requires an active tick.");
    const [aId, bId] = compareCodeUnits(left, right) <= 0 ? [left, right] : [right, left];
    const key = `${kind}\u0000${aId}\u0000${bId}`;
    if (this.current.has(key)) return;
    if (this.current.size >= COLLISION_SHOWCASE_MAX_CONTACTS_PER_TICK) throw new Error(`Collision contacts exceed the ${COLLISION_SHOWCASE_MAX_CONTACTS_PER_TICK}-event tick ceiling.`);
    this.current.add(key);
    const entry = Object.freeze({ tick: this.tick, kind, aId, bId });
    this.entries.push(entry);
    if (!this.firstByPair.has(key)) this.firstByPair.set(key, entry);
  }
  finishTick(): void { this.maximumPerTick = Math.max(this.maximumPerTick, this.current.size); }
  evidence(): CollisionShowcasePlan["contacts"] {
    this.finishTick();
    return freeze({
      first: [...this.firstByPair.values()],
      totalEvents: this.entries.length,
      maximumPerTick: this.maximumPerTick,
      ledgerSha256: canonicalJsonSha256(this.entries),
    });
  }
}

export function completeCollisionShowcasePlan(recipe: CollisionShowcaseRecipe, simulation: SimulationResult): CollisionShowcasePlan {
  if (simulation.frames.length !== COLLISION_SHOWCASE_FRAME_COUNT) throw new Error("Collision showcase simulation did not emit the exact 61-frame schedule.");
  const framesByIndex = new Map(simulation.frames.map((frame) => [frame.frameIndex, frame]));
  const checkpoints = simulation.checkpoints.map((checkpoint) => {
    const frame = framesByIndex.get(checkpoint.frameIndex);
    if (!frame) throw new Error(`Collision showcase checkpoint ${checkpoint.id} has no emitted frame.`);
    return { ...checkpoint, atUs: frame.atUs, stateSha256: frame.stateSha256 };
  });
  const bodyCatalog = simulation.bodies.map(bodyCatalogEntry).sort((left, right) => compareCodeUnits(left.id, right.id));
  const contacts = simulation.contacts.evidence();
  const dynamicBodyCount = bodyCatalog.filter((entry) => entry.dynamic).length;
  const payload = {
    schema: COLLISION_SHOWCASE_PLAN_SCHEMA,
    solverVersion: COLLISION_SHOWCASE_SOLVER_VERSION,
    kind: recipe.kind,
    recipe,
    recipeSha256: canonicalJsonSha256(recipe),
    bodyCatalog,
    frames: simulation.frames,
    checkpoints,
    contacts,
    budget: {
      durationUs: COLLISION_SHOWCASE_DURATION_US,
      frameRate: COLLISION_SHOWCASE_FRAME_RATE,
      ticksPerSecond: COLLISION_SHOWCASE_TICKS_PER_SECOND,
      sampleEveryTicks: COLLISION_SHOWCASE_SAMPLE_EVERY_TICKS,
      solverIterations: COLLISION_SHOWCASE_SOLVER_ITERATIONS,
      frameCount: COLLISION_SHOWCASE_FRAME_COUNT,
      dynamicBodyCount,
      maximumPairCandidates: simulation.maximumPairCandidates,
      maximumContactsPerTick: contacts.maximumPerTick,
      projectedScene3dTrackCount: simulation.projectedTrackCount,
      projectedScene3dKeyframeCount: simulation.projectedKeyframeCount,
    },
    evidence: {
      authorTimeBake: true as const,
      persistentRuntimePhysics: false as const,
      rendererInvoked: false as const,
      axisAlignedBoxCollisionWithVisualRotation: simulation.axisAlignedBoxCollisionWithVisualRotation,
    },
  } satisfies Omit<CollisionShowcasePlan, "fingerprint">;
  return freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

export function collisionFrame(frameIndex: number, phase: string, bodies: readonly SimBody[]): CollisionShowcaseFrame {
  const states = bodies.map(bodyState).sort((left, right) => compareCodeUnits(left.id, right.id));
  return freeze({ frameIndex, atUs: frameAtUs(frameIndex), phase, bodies: states, stateSha256: canonicalJsonSha256(states) });
}

export function frameAtUs(frameIndex: number): number {
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= COLLISION_SHOWCASE_FRAME_COUNT) throw new Error("Collision showcase frame index is outside the fixed schedule.");
  return Number(BigInt(frameIndex) * 1_000_000n / BigInt(COLLISION_SHOWCASE_FRAME_RATE));
}

/** Exact 30 fps proof-presentation timestamp over the lower-rate author-time bake. */
export function renderFrameAtUs(frameIndex: number): number {
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= COLLISION_SHOWCASE_RENDER_FRAME_COUNT) throw new Error("Collision showcase render frame index is outside the fixed schedule.");
  return Number(BigInt(frameIndex) * 1_000_000n / BigInt(COLLISION_SHOWCASE_RENDER_FRAME_RATE));
}

export function quantize(value: number): number { const result = Math.round(value * Q) / Q; return Object.is(result, -0) ? 0 : result; }
export function quantizeBody(body: SimBody): void {
  body.position = body.position.map(quantize) as [number, number, number];
  body.velocity = body.velocity.map(quantize) as [number, number, number];
  body.rotationDeg = body.rotationDeg.map(quantize) as [number, number, number];
  body.angularVelocity = body.angularVelocity.map(quantize) as [number, number, number];
}
export function add(left: Vec3, right: Vec3): [number, number, number] { return [left[0] + right[0], left[1] + right[1], left[2] + right[2]]; }
export function subtract(left: Vec3, right: Vec3): [number, number, number] { return [left[0] - right[0], left[1] - right[1], left[2] - right[2]]; }
export function scale(value: Vec3, amount: number): [number, number, number] { return [value[0] * amount, value[1] * amount, value[2] * amount]; }
export function dot(left: Vec3, right: Vec3): number { return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]; }
export function length(value: Vec3): number { return Math.hypot(value[0], value[1], value[2]); }
export function normalize(value: Vec3, fallback: Vec3 = [1, 0, 0]): [number, number, number] { const magnitude = length(value); return magnitude <= 1e-12 ? [...fallback] : scale(value, 1 / magnitude); }
export function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }

function bodyState(body: SimBody): CollisionShowcaseBodyState { return freeze({ id: body.id, position: body.position.map(quantize) as unknown as Vec3, rotationDeg: body.rotationDeg.map(quantize) as unknown as Vec3 }); }
function bodyCatalogEntry(body: SimBody): CollisionShowcaseBodyCatalogEntry { return freeze({ id: body.id, shape: body.shape, color: body.color, dynamic: body.dynamic, ...(body.radius === undefined ? {} : { radius: body.radius }), ...(body.halfExtents === undefined ? {} : { halfExtents: body.halfExtents as Vec3 }) }); }
