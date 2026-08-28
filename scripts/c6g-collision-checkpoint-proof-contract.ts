import assert from "node:assert/strict";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { MotionPackage } from "../packages/core/src/types";
import {
  COLLISION_SHOWCASE_RECIPE_SCHEMA,
  compileCollisionShowcaseRecipe,
  lowerCollisionShowcasePlan,
  type CollisionShowcaseLowering,
  type CollisionShowcasePlan,
  type CollisionShowcaseRecipe,
} from "../packages/core/src/internal/collision-showcase/collision-showcase";

export const c6gProofRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoScratchRoot = join(c6gProofRepoRoot, ".scratch");

export interface CollisionCheckpointProofArguments {
  outputRoot: string;
  expectedCommit: string;
}

export interface CollisionCheckpointProofCase {
  slug: "bingo" | "wrecking";
  plan: CollisionShowcasePlan;
  lowering: CollisionShowcaseLowering;
  pkg: MotionPackage;
  targetLayerIds: readonly string[];
}

const recipes = Object.freeze([
  Object.freeze({
    schema: COLLISION_SHOWCASE_RECIPE_SCHEMA,
    kind: "bingo-sphere-3d@1",
    seed: 2_975_908_062,
    speed: 3.4,
    gravity: -1.1,
    restitution: 0.92,
    cageRadius: 2.2,
    ballRadius: 0.28,
    selectedBallId: "bingo-ball-07",
    mixingFrame: 6,
    selectedFrame: 46,
  }),
  Object.freeze({
    schema: COLLISION_SHOWCASE_RECIPE_SCHEMA,
    kind: "wrecking-wall-3d@1",
    seed: 487_201,
    gravity: -8,
    restitution: 0.18,
    swingSpeed: 6.5,
    tetherLength: 2.8,
    releaseAngleDeg: -70,
    impactFrame: 24,
    fallingFrame: 32,
  }),
] satisfies readonly CollisionShowcaseRecipe[]);

export function parseCollisionCheckpointProofArguments(args: string[]): CollisionCheckpointProofArguments {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  assert.equal(normalized.length, 4, usage());
  assert.equal(normalized[0], "--output-root", usage());
  assert.equal(normalized[2], "--expected-commit", usage());
  assert(isAbsolute(normalized[1] ?? ""), usage());
  assert(/^[a-f0-9]{40}$/.test(normalized[3] ?? ""), usage());
  const outputRoot = resolve(normalized[1]!);
  const fromScratch = relative(repoScratchRoot, outputRoot);
  assert(fromScratch.length > 0 && fromScratch !== ".." && !fromScratch.startsWith(`..${sep}`) && !isAbsolute(fromScratch), `Output root must be a child of ${repoScratchRoot}.`);
  return { outputRoot, expectedCommit: normalized[3]! };
}

export function buildCollisionCheckpointProofCases(): readonly CollisionCheckpointProofCase[] {
  return recipes.map((recipe): CollisionCheckpointProofCase => {
    const plan = compileCollisionShowcaseRecipe(recipe);
    const lowering = lowerCollisionShowcasePlan(plan);
    const slug = plan.kind === "bingo-sphere-3d@1" ? "bingo" : "wrecking";
    const expectedCheckpointIds = slug === "bingo"
      ? ["idle", "mixing", "selected", "reveal"]
      : ["intact", "impact", "falling", "end"];
    assert.deepEqual(plan.checkpoints.map((checkpoint) => checkpoint.id), expectedCheckpointIds, `${slug} checkpoint topology changed.`);
    const targetLayerIds = lowering.motion.layers.filter((layer) => layer.type === "scene3d").map((layer) => layer.id);
    assert(targetLayerIds.length > 0, `${slug} lowering has no Scene3D target layer.`);
    const manifest = Object.freeze({
      schema: "shellx-motion/package-manifest@1" as const,
      id: lowering.motion.id,
      name: lowering.motion.name,
      motion: "motion.json",
      assets: [] as string[],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["gpu"], hosts: ["motion"] },
    });
    const pkg: MotionPackage = Object.freeze({ root: c6gProofRepoRoot, manifest, motion: lowering.motion });
    return Object.freeze({ slug, plan, lowering, pkg, targetLayerIds: Object.freeze(targetLayerIds) });
  });
}

function usage(): string {
  return "Usage: pnpm run c6g:collision-checkpoint-proof -- --output-root /absolute/repo/.scratch/fresh-run --expected-commit <40-hex-commit>";
}
