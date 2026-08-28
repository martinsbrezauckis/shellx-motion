/** Base-independent C6B4 record admission. Exact package and action-definition facts stay resolver-only. */
import { compareCodeUnits } from "../../canonical-json";
import { readCheckpointStoryboard } from "./checkpoint-storyboard-records";
import type { CheckpointProperty, CheckpointStoryboard } from "./checkpoint-storyboard-types";
import type { CheckpointStoryboardRelationActionOwnedProperty } from "./checkpoint-storyboard-relation-action-profile-types";

export const CHECKPOINT_STORYBOARD_RELATION_ACTION_OWNED_PROPERTY_MASK = ["transform.x", "transform.y"] as const;

export function admitCheckpointStoryboardRelationActionRecordProfile(value: unknown): CheckpointStoryboard {
  const storyboard = readCheckpointStoryboard(value);
  assertCheckpointStoryboardRelationActionStaticProfile(storyboard);
  return storyboard;
}

export function assertCheckpointStoryboardRelationActionStaticProfile(storyboard: CheckpointStoryboard) {
  const mask = CHECKPOINT_STORYBOARD_RELATION_ACTION_OWNED_PROPERTY_MASK;
  if (storyboard.objectCatalog.some((catalog) => catalog.creation)) throw new Error("CheckpointStoryboard relation-action profile refuses catalog creation payloads.");
  if (storyboard.capabilityRequirements.length !== 1 || storyboard.capabilityRequirements[0] !== "renderer.gpu") throw new Error("CheckpointStoryboard relation-action profile requires exactly the renderer.gpu capability requirement.");
  if (storyboard.objectCatalog.length !== 2 || storyboard.checkpoints.length !== 2 || storyboard.edges.length !== 1 || storyboard.recipes.length !== 1) throw new Error("CheckpointStoryboard relation-action profile requires exactly two objects, two checkpoints, one edge, and one recipe.");
  const [from, to] = storyboard.checkpoints, edge = storyboard.edges[0]!, recipe = storyboard.recipes[0]!;
  if (from!.atUs !== 0 || from!.atUs % 1_000 !== 0 || to!.atUs % 1_000 !== 0 || edge.fromCheckpointId !== from!.id || edge.toCheckpointId !== to!.id || edge.lifecycle.length !== 2 || edge.recipeIds.length !== 1 || edge.recipeIds[0] !== recipe.recipeId) throw new Error("CheckpointStoryboard relation-action profile requires two preserved objects over one whole-millisecond edge beginning at zero.");
  if (edge.lifecycle.some((entry, index) => entry.kind !== "preserve" || entry.objectId !== storyboard.objectCatalog[index]!.objectId)) throw new Error("CheckpointStoryboard relation-action profile requires exact catalog-order preserve lifecycle.");
  if (storyboard.objectCatalog.some((catalog) => (catalog.rootShapeKind !== "rect" && catalog.rootShapeKind !== "ellipse") || !sameMask(catalog.propertyMask, mask))) throw new Error("CheckpointStoryboard relation-action profile requires root rect/ellipse objects with exactly transform.x/transform.y checkpoint authority.");
  if (from!.objects.length !== 2 || to!.objects.length !== 2 || storyboard.checkpoints.some((checkpoint) => checkpoint.objects.some((state) => state.state !== "present" || !sameMask(state.properties.map((entry) => entry.property), mask)))) throw new Error("CheckpointStoryboard relation-action profile requires exactly two present transform.x/transform.y states at both checkpoints.");
  if (recipe.intent.kind !== "relation-action" || recipe.exactBaseRequirements.length !== 1 || recipe.exactBaseRequirements[0]!.resolution !== "deferred-exact-base") throw new Error("CheckpointStoryboard relation-action profile requires one relation-action recipe with exactly one deferred exact-base definition.");
  const intent = recipe.intent;
  if (intent.roleBindings.length !== 2 || !strictOrder(intent.roleBindings.map((binding) => binding.roleId)) || new Set(intent.roleBindings.map((binding) => binding.objectId)).size !== 2 || !sameIds(intent.roleBindings.map((binding) => binding.objectId), storyboard.objectCatalog.map((entry) => entry.objectId))) throw new Error("CheckpointStoryboard relation-action profile requires two sorted roles bound one-to-one to the preserved catalog objects.");
  if (intent.parameterValues.length !== 0 || intent.declaredWrites.length !== 1 || !storyboard.objectCatalog.some((entry) => entry.objectId === intent.declaredWrites[0]!.objectId) || !sameMask(intent.declaredWrites[0]!.propertyMask, mask)) throw new Error("CheckpointStoryboard relation-action profile requires no parameters and exactly one target transform.x/transform.y declared write.");
  return { from: from!, to: to!, edge, recipe, intent };
}

function strictOrder(ids: readonly string[]): boolean { return ids.every((id, index) => index === 0 || compareCodeUnits(ids[index - 1]!, id) < 0); }
function sameIds(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && [...left].sort(compareCodeUnits).every((id, index) => id === [...right].sort(compareCodeUnits)[index]); }
function sameMask(actual: readonly CheckpointProperty[], expected: readonly CheckpointStoryboardRelationActionOwnedProperty[]): boolean { return actual.length === expected.length && actual.every((property, index) => property === expected[index]); }
