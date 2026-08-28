/** Source-only C6G-A entrypoint for bounded author-time 3D collision showcase plans. */
export {
  BINGO_BALL_COLORS,
  BINGO_BALL_IDS,
  COLLISION_SHOWCASE_DURATION_US,
  COLLISION_SHOWCASE_FRAME_COUNT,
  COLLISION_SHOWCASE_FRAME_RATE,
  COLLISION_SHOWCASE_MAX_CONTACTS_PER_TICK,
  COLLISION_SHOWCASE_MAX_DYNAMIC_BODIES,
  COLLISION_SHOWCASE_MAX_PAIRS,
  COLLISION_SHOWCASE_PLAN_SCHEMA,
  COLLISION_SHOWCASE_QUANTIZATION,
  COLLISION_SHOWCASE_RECIPE_SCHEMA,
  COLLISION_SHOWCASE_RENDER_FRAME_COUNT,
  COLLISION_SHOWCASE_RENDER_FRAME_RATE,
  COLLISION_SHOWCASE_SAMPLE_EVERY_TICKS,
  COLLISION_SHOWCASE_SOLVER_ITERATIONS,
  COLLISION_SHOWCASE_SOLVER_VERSION,
  COLLISION_SHOWCASE_TICKS_PER_SECOND,
  WRECKING_BRICK_IDS,
  type BingoCollisionShowcaseRecipe,
  type CollisionShowcaseBodyCatalogEntry,
  type CollisionShowcaseBodyState,
  type CollisionShowcaseContact,
  type CollisionShowcaseFrame,
  type CollisionShowcaseKind,
  type CollisionShowcasePlan,
  type CollisionShowcaseRecipe,
  type Vec3,
  type WreckingCollisionShowcaseRecipe,
} from "./collision-showcase-types";
export { readCollisionShowcaseRecipe } from "./collision-showcase-read";
export { compileCollisionShowcaseRecipe } from "./collision-showcase-compile";
export { frameAtUs, renderFrameAtUs } from "./collision-showcase-simulation";
export { COLLISION_SHOWCASE_LOWERING_SCHEMA, type CollisionShowcaseGeometryEvidence, type CollisionShowcaseLowering } from "./collision-showcase-lowering-types";
export { lowerCollisionShowcasePlan } from "./collision-showcase-lower";
