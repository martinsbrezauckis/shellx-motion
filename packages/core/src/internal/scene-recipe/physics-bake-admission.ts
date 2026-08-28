import { canonicalJson, canonicalJsonSha256 } from "../../canonical-json";
import { exactRecord, freeze, snapshotSceneRecipeData } from "./scene-recipe-data";
import { readPhysicsBakeRecipe } from "./physics-bake-admission-read";
import {
  PHYSICS_BAKE_ADMISSION_CAPS,
  PHYSICS_BAKE_ADMISSION_PLAN_SCHEMA,
  type PhysicsBakeAdmissionPlan,
} from "./physics-bake-admission-types";

/** Compiles immutable provider-neutral admission evidence without selecting or invoking a simulator. */
export function compilePhysicsBakeAdmissionPlan(value: unknown): PhysicsBakeAdmissionPlan {
  const recipe = readPhysicsBakeRecipe(value), stepCount = ((recipe.endUs - recipe.startUs) * recipe.stepsPerSecond) / 1_000_000;
  const bodySteps = recipe.bodies.length * stepCount;
  if (bodySteps > PHYSICS_BAKE_ADMISSION_CAPS.bodySteps) throw new Error(`Physics bake recipe exceeds the ${PHYSICS_BAKE_ADMISSION_CAPS.bodySteps}-body-step cap.`);
  const eventById = new Map(recipe.events.map((entry) => [entry.id, entry]));
  const bodyStateSampleCount = recipe.observations.reduce((sum, entry) => entry.kind === "body-state" ? sum + entry.bodyIds.length * (1 + Math.floor(stepCount / entry.sampleEverySteps)) : sum, 0);
  if (bodyStateSampleCount > PHYSICS_BAKE_ADMISSION_CAPS.bodyStateSamples) throw new Error(`Physics bake recipe exceeds the ${PHYSICS_BAKE_ADMISSION_CAPS.bodyStateSamples}-body-state-sample cap.`);
  const contactEventUpperBound = recipe.observations.reduce((sum, entry) => entry.kind === "contact-pairs" ? sum + entry.eventIds.reduce((eventSum, eventId) => eventSum + eventById.get(eventId)!.phases.length * stepCount, 0) : sum, 0);
  if (contactEventUpperBound > PHYSICS_BAKE_ADMISSION_CAPS.contactEventUpperBound) throw new Error(`Physics bake recipe exceeds the ${PHYSICS_BAKE_ADMISSION_CAPS.contactEventUpperBound}-contact-event upper bound.`);
  const orderEvidence = {
    materialOrderSha256: canonicalJsonSha256(recipe.materials.map((entry) => entry.id)),
    bodyOrderSha256: canonicalJsonSha256(recipe.bodies.map((entry) => entry.id)),
    constraintOrderSha256: canonicalJsonSha256(recipe.constraints.map((entry) => entry.id)),
    actionOrderSha256: canonicalJsonSha256(recipe.actions.map((entry) => entry.id)),
    eventOrderSha256: canonicalJsonSha256(recipe.events.map((entry) => entry.id)),
    observationOrderSha256: canonicalJsonSha256(recipe.observations.map((entry) => entry.id)),
  };
  const identities = freeze({ ...orderEvidence, fingerprint: canonicalJsonSha256(orderEvidence) });
  const schedule = freeze({ startUs: recipe.startUs, endUs: recipe.endUs, stepsPerSecond: recipe.stepsPerSecond, stepDuration: freeze({ numeratorUs: 1_000_000 as const, denominator: recipe.stepsPerSecond }), stepCount });
  const baseBudget = {
    materialCount: recipe.materials.length,
    bodyCount: recipe.bodies.length,
    dynamicBodyCount: recipe.bodies.filter((entry) => entry.kind === "dynamic").length,
    staticBodyCount: recipe.bodies.filter((entry) => entry.kind === "static").length,
    constraintCount: recipe.constraints.length,
    actionCount: recipe.actions.length,
    eventCount: recipe.events.length,
    observationCount: recipe.observations.length,
    stepCount,
    bodySteps,
    bodyStateSampleCount,
    contactEventUpperBound,
    caps: PHYSICS_BAKE_ADMISSION_CAPS,
  };
  const base = {
    schema: PHYSICS_BAKE_ADMISSION_PLAN_SCHEMA,
    recipe,
    recipeSha256: canonicalJsonSha256(recipe),
    schedule,
    identities,
    evidence: freeze({
      providerNeutral: true as const,
      providerSelected: false as const,
      providerInvoked: false as const,
      exactRationalSchedule: true as const,
      f32Inputs: true as const,
      stableOrderedIds: true as const,
      packageRead: false as const,
      packageWritten: false as const,
      rendererInvoked: false as const,
      pixels: false as const,
    }),
  };
  let planBytes = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = Buffer.byteLength(canonicalJson({ ...base, budget: { ...baseBudget, planBytes } }), "utf8");
    if (next === planBytes) break;
    planBytes = next;
  }
  if (planBytes > PHYSICS_BAKE_ADMISSION_CAPS.planBytes) throw new Error(`Physics bake admission plan exceeds the ${PHYSICS_BAKE_ADMISSION_CAPS.planBytes}-byte cap.`);
  const payload = { ...base, budget: freeze({ ...baseBudget, planBytes }) };
  return freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

/** Recompiles an untrusted value and accepts only the exact immutable plan minted above. */
export function readPhysicsBakeAdmissionPlan(value: unknown): PhysicsBakeAdmissionPlan {
  const snapshot = snapshotSceneRecipeData(value), root = exactRecord(snapshot, ["schema", "recipe", "recipeSha256", "schedule", "identities", "budget", "evidence", "fingerprint"], [], "Physics bake admission plan");
  const compiled = compilePhysicsBakeAdmissionPlan(root.recipe);
  if (canonicalJson(snapshot) !== canonicalJson(compiled)) throw new Error("Physics bake admission plan must equal the exact compiler-minted plan.");
  return compiled;
}
