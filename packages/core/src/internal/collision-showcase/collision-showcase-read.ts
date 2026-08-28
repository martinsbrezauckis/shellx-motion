import {
  exactRecord,
  finite,
  safeId,
  snapshotCheckpointStoryboardData,
} from "../checkpoint-storyboard/checkpoint-storyboard-data";
import {
  BINGO_BALL_IDS,
  COLLISION_SHOWCASE_RECIPE_SCHEMA,
  type BingoCollisionShowcaseRecipe,
  type CollisionShowcaseRecipe,
  type WreckingCollisionShowcaseRecipe,
} from "./collision-showcase-types";

const BINGO_FIELDS = [
  "schema", "kind", "seed", "speed", "gravity", "restitution", "cageRadius", "ballRadius",
  "selectedBallId", "mixingFrame", "selectedFrame",
] as const;
const WRECKING_FIELDS = [
  "schema", "kind", "seed", "gravity", "restitution", "swingSpeed", "tetherLength",
  "releaseAngleDeg", "impactFrame", "fallingFrame",
] as const;

export function readCollisionShowcaseRecipe(value: unknown): CollisionShowcaseRecipe {
  const snapshot = snapshotCheckpointStoryboardData(value);
  const root = exactRecord(snapshot, ["schema", "kind", "seed"], [...BINGO_FIELDS, ...WRECKING_FIELDS], "Collision showcase recipe");
  if (root.schema !== COLLISION_SHOWCASE_RECIPE_SCHEMA) throw new Error(`Collision showcase recipe schema must equal ${COLLISION_SHOWCASE_RECIPE_SCHEMA}.`);
  if (root.kind === "bingo-sphere-3d@1") return readBingo(root);
  if (root.kind === "wrecking-wall-3d@1") return readWrecking(root);
  throw new Error("Collision showcase recipe kind must be bingo-sphere-3d@1 or wrecking-wall-3d@1.");
}

function readBingo(value: Record<string, unknown>): BingoCollisionShowcaseRecipe {
  const root = exactRecord(value, BINGO_FIELDS, [], "Bingo collision showcase recipe");
  const recipe: BingoCollisionShowcaseRecipe = {
    schema: COLLISION_SHOWCASE_RECIPE_SCHEMA,
    kind: "bingo-sphere-3d@1",
    seed: uint32(root.seed, "Bingo seed"),
    speed: finite(root.speed, "Bingo speed", 1, 6),
    gravity: finite(root.gravity, "Bingo gravity", -6, 6),
    restitution: finite(root.restitution, "Bingo restitution", 0.4, 1),
    cageRadius: finite(root.cageRadius, "Bingo cageRadius", 1.8, 3),
    ballRadius: finite(root.ballRadius, "Bingo ballRadius", 0.18, 0.38),
    selectedBallId: safeId(root.selectedBallId, "Bingo selectedBallId"),
    mixingFrame: integer(root.mixingFrame, "Bingo mixingFrame", 1, 20),
    selectedFrame: integer(root.selectedFrame, "Bingo selectedFrame", 36, 54),
  };
  if (!BINGO_BALL_IDS.includes(recipe.selectedBallId)) throw new Error("Bingo selectedBallId must name one of the ten stable balls.");
  if (recipe.mixingFrame >= recipe.selectedFrame) throw new Error("Bingo mixingFrame must precede selectedFrame.");
  if (recipe.ballRadius * 5 > recipe.cageRadius) throw new Error("Bingo ballRadius is too large for the closed ten-ball cage profile.");
  return Object.freeze(recipe);
}

function readWrecking(value: Record<string, unknown>): WreckingCollisionShowcaseRecipe {
  const root = exactRecord(value, WRECKING_FIELDS, [], "Wrecking collision showcase recipe");
  const recipe: WreckingCollisionShowcaseRecipe = {
    schema: COLLISION_SHOWCASE_RECIPE_SCHEMA,
    kind: "wrecking-wall-3d@1",
    seed: uint32(root.seed, "Wrecking seed"),
    gravity: finite(root.gravity, "Wrecking gravity", -15, -1),
    restitution: finite(root.restitution, "Wrecking restitution", 0.05, 0.65),
    swingSpeed: finite(root.swingSpeed, "Wrecking swingSpeed", 2, 10),
    tetherLength: finite(root.tetherLength, "Wrecking tetherLength", 2, 4),
    releaseAngleDeg: finite(root.releaseAngleDeg, "Wrecking releaseAngleDeg", -85, -35),
    impactFrame: integer(root.impactFrame, "Wrecking impactFrame", 18, 36),
    fallingFrame: integer(root.fallingFrame, "Wrecking fallingFrame", 24, 52),
  };
  if (recipe.impactFrame >= recipe.fallingFrame) throw new Error("Wrecking impactFrame must precede fallingFrame.");
  return Object.freeze(recipe);
}

function uint32(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 0xffff_ffff) throw new Error(`${label} must be a non-zero uint32.`);
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer in ${minimum}..${maximum}.`);
  return value;
}
