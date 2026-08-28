import { readCollisionShowcaseRecipe } from "./collision-showcase-read";
import { completeCollisionShowcasePlan } from "./collision-showcase-simulation";
import { simulateBingoCollisionShowcase } from "./collision-showcase-bingo";
import { assertWreckingCollisionGeometry, simulateWreckingCollisionShowcase } from "./collision-showcase-wrecking";
import type { CollisionShowcasePlan } from "./collision-showcase-types";

/** Compiles one bounded author-time collision bake plan. It performs no I/O or renderer work. */
export function compileCollisionShowcaseRecipe(value: unknown): CollisionShowcasePlan {
  const recipe = readCollisionShowcaseRecipe(value);
  if (recipe.kind === "wrecking-wall-3d@1") assertWreckingCollisionGeometry(recipe);
  const simulation = recipe.kind === "bingo-sphere-3d@1"
    ? simulateBingoCollisionShowcase(recipe)
    : simulateWreckingCollisionShowcase(recipe);
  return completeCollisionShowcasePlan(recipe, simulation);
}
