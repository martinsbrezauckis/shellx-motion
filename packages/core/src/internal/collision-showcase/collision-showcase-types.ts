export const COLLISION_SHOWCASE_RECIPE_SCHEMA = "shellx-motion/collision-showcase-recipe@1" as const;
export const COLLISION_SHOWCASE_PLAN_SCHEMA = "shellx-motion/private-collision-showcase-plan@1" as const;
export const COLLISION_SHOWCASE_SOLVER_VERSION = "motion.collision-showcase-fixed-step@2" as const;

export const COLLISION_SHOWCASE_DURATION_US = 5_000_000;
/** Author-time physics samples. Renderer proof frames use the separate 30 fps schedule below. */
export const COLLISION_SHOWCASE_FRAME_RATE = 12;
export const COLLISION_SHOWCASE_RENDER_FRAME_RATE = 30;
export const COLLISION_SHOWCASE_RENDER_FRAME_COUNT = 151;
export const COLLISION_SHOWCASE_TICKS_PER_SECOND = 120;
export const COLLISION_SHOWCASE_SAMPLE_EVERY_TICKS = 10;
export const COLLISION_SHOWCASE_SOLVER_ITERATIONS = 6;
export const COLLISION_SHOWCASE_FRAME_COUNT = 61;
export const COLLISION_SHOWCASE_MAX_DYNAMIC_BODIES = 16;
export const COLLISION_SHOWCASE_MAX_PAIRS = 120;
export const COLLISION_SHOWCASE_MAX_CONTACTS_PER_TICK = 128;
export const COLLISION_SHOWCASE_QUANTIZATION = 0.000001;

export const BINGO_BALL_IDS = Object.freeze(Array.from({ length: 10 }, (_entry, index) => `bingo-ball-${String(index + 1).padStart(2, "0")}`));
export const BINGO_BALL_COLORS = Object.freeze([
  "#ff6b6b", "#ff9f43", "#f6e05e", "#68d391", "#4fd1c5",
  "#63b3ed", "#a78bfa", "#f687b3", "#ed8936", "#90cdf4",
]);
export const WRECKING_BRICK_IDS = Object.freeze(Array.from({ length: 15 }, (_entry, index) => `brick-r${Math.floor(index / 5) + 1}-c${index % 5 + 1}`));

export type Vec3 = readonly [number, number, number];
export type CollisionShowcaseKind = "bingo-sphere-3d@1" | "wrecking-wall-3d@1";

export interface BingoCollisionShowcaseRecipe {
  schema: typeof COLLISION_SHOWCASE_RECIPE_SCHEMA;
  kind: "bingo-sphere-3d@1";
  seed: number;
  speed: number;
  gravity: number;
  restitution: number;
  cageRadius: number;
  ballRadius: number;
  selectedBallId: string;
  mixingFrame: number;
  selectedFrame: number;
}

export interface WreckingCollisionShowcaseRecipe {
  schema: typeof COLLISION_SHOWCASE_RECIPE_SCHEMA;
  kind: "wrecking-wall-3d@1";
  seed: number;
  gravity: number;
  restitution: number;
  swingSpeed: number;
  tetherLength: number;
  releaseAngleDeg: number;
  impactFrame: number;
  fallingFrame: number;
}

export type CollisionShowcaseRecipe = BingoCollisionShowcaseRecipe | WreckingCollisionShowcaseRecipe;
export type CollisionBodyShape = "sphere" | "box";

export interface CollisionShowcaseBodyCatalogEntry {
  id: string;
  shape: CollisionBodyShape;
  color: string;
  dynamic: boolean;
  radius?: number;
  halfExtents?: Vec3;
}

export interface CollisionShowcaseBodyState {
  id: string;
  position: Vec3;
  rotationDeg: Vec3;
}

export interface CollisionShowcaseFrame {
  frameIndex: number;
  atUs: number;
  phase: string;
  bodies: readonly CollisionShowcaseBodyState[];
  stateSha256: string;
}

export interface CollisionShowcaseContact {
  tick: number;
  kind: "sphere-sphere" | "sphere-volume" | "sphere-box" | "box-box" | "box-ground";
  aId: string;
  bId: string;
}

export interface CollisionShowcasePlan {
  schema: typeof COLLISION_SHOWCASE_PLAN_SCHEMA;
  solverVersion: typeof COLLISION_SHOWCASE_SOLVER_VERSION;
  kind: CollisionShowcaseKind;
  recipe: CollisionShowcaseRecipe;
  recipeSha256: string;
  bodyCatalog: readonly CollisionShowcaseBodyCatalogEntry[];
  frames: readonly CollisionShowcaseFrame[];
  checkpoints: readonly { id: string; frameIndex: number; atUs: number; stateSha256: string }[];
  contacts: Readonly<{
    first: readonly CollisionShowcaseContact[];
    totalEvents: number;
    maximumPerTick: number;
    ledgerSha256: string;
  }>;
  budget: Readonly<{
    durationUs: typeof COLLISION_SHOWCASE_DURATION_US;
    frameRate: typeof COLLISION_SHOWCASE_FRAME_RATE;
    ticksPerSecond: typeof COLLISION_SHOWCASE_TICKS_PER_SECOND;
    sampleEveryTicks: typeof COLLISION_SHOWCASE_SAMPLE_EVERY_TICKS;
    solverIterations: typeof COLLISION_SHOWCASE_SOLVER_ITERATIONS;
    frameCount: typeof COLLISION_SHOWCASE_FRAME_COUNT;
    dynamicBodyCount: number;
    maximumPairCandidates: number;
    maximumContactsPerTick: number;
    projectedScene3dTrackCount: number;
    projectedScene3dKeyframeCount: number;
  }>;
  evidence: Readonly<{
    authorTimeBake: true;
    persistentRuntimePhysics: false;
    rendererInvoked: false;
    axisAlignedBoxCollisionWithVisualRotation: boolean;
  }>;
  fingerprint: string;
}
