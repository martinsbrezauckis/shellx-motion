import {
  assertExactInput,
  assertIndex,
  commitParticleEmitter,
  exactAnalyticTrail,
  exactParticleOrigin,
  exactParticleShading,
  exactParticleSource,
  moveArrayEntry,
  originLimit,
  readParticleStructuralState,
  requireField,
  requireV2Field,
  sameData,
  sourceLimit,
} from "./motion-particle-structural-support";
import { PARTICLE_FIELD_V2_SCHEMA } from "./particle-field-types";
import type { MotionDocument, MotionParticleEmitter } from "./types";
import type {
  TimelineParticleAnalyticTrailAdd,
  TimelineParticleAnalyticTrailRemove,
  TimelineParticleAnalyticTrailReplace,
  TimelineParticleCollisionAxisUpdate,
  TimelineParticleFieldSourceDelete,
  TimelineParticleFieldSourceInsert,
  TimelineParticleFieldSourceMove,
  TimelineParticleFieldSourceReplace,
  TimelineParticleOriginDelete,
  TimelineParticleOriginInsert,
  TimelineParticleOriginMove,
  TimelineParticleOriginReplace,
  TimelineParticleShadingAdd,
  TimelineParticleShadingRemove,
  TimelineParticleShadingReplace,
  TimelineParticleStructuralAction,
  TimelineParticleStructuralInspect,
  TimelineParticleStructuralInspection,
  TimelineParticleStructuralMutationResult,
} from "./motion-particle-structural-types";

export type {
  TimelineParticleAnalyticTrailAdd,
  TimelineParticleAnalyticTrailRemove,
  TimelineParticleAnalyticTrailReplace,
  TimelineParticleCollisionAxisUpdate,
  TimelineParticleFieldSourceDelete,
  TimelineParticleFieldSourceInsert,
  TimelineParticleFieldSourceMove,
  TimelineParticleFieldSourceReplace,
  TimelineParticleOriginDelete,
  TimelineParticleOriginInsert,
  TimelineParticleOriginMove,
  TimelineParticleOriginReplace,
  TimelineParticleShadingAdd,
  TimelineParticleShadingRemove,
  TimelineParticleShadingReplace,
  TimelineParticleStructuralInspect,
  TimelineParticleStructuralInspection,
  TimelineParticleStructuralMutationResult,
} from "./motion-particle-structural-types";

/** Inspects only bounded authored structural records; it never evaluates particles or exposes history. */
export function inspectMotionParticleStructure(motion: MotionDocument, input: TimelineParticleStructuralInspect): TimelineParticleStructuralInspection {
  assertExactInput(input, ["layerId"], "Particle structural inspection");
  const state = readParticleStructuralState(motion, input.layerId, false);
  return {
    layerId: state.layer.id,
    field: state.field ? structuredClone(state.field) : null,
    origins: state.emitter.origins ? structuredClone(state.emitter.origins) : null,
    trail: state.emitter.trail ? structuredClone(state.emitter.trail) : null,
    shading: state.emitter.shading ? structuredClone(state.emitter.shading) : null,
    limits: { maxSources: state.field ? sourceLimit(state.field) : null, maxOrigins: state.field?.schema === PARTICLE_FIELD_V2_SCHEMA ? originLimit() : null },
  };
}

export function insertMotionParticleFieldSource(motion: MotionDocument, input: TimelineParticleFieldSourceInsert): TimelineParticleStructuralMutationResult {
  assertExactInput(input, ["layerId", "index", "source"], "Particle field source insert");
  const state = readParticleStructuralState(motion, input.layerId, true), field = requireField(state);
  assertIndex(input.index, 0, field.sources.length, "Particle field source insertion index");
  if (field.sources.length >= sourceLimit(field)) throw new Error(`Particle field cannot exceed ${sourceLimit(field)} sources.`);
  const source = exactParticleSource(input.source, field.schema), emitter = structuredClone(state.emitter);
  emitter.field!.sources.splice(input.index, 0, source as never);
  return mutation(motion, state, emitter, "source-inserted", [`/layers/${state.layer.id}/emitter/field/sources`], input.index);
}

export function replaceMotionParticleFieldSource(motion: MotionDocument, input: TimelineParticleFieldSourceReplace): TimelineParticleStructuralMutationResult {
  assertExactInput(input, ["layerId", "index", "source"], "Particle field source replace");
  const state = readParticleStructuralState(motion, input.layerId, true), field = requireField(state);
  assertIndex(input.index, 0, field.sources.length - 1, "Particle field source index");
  const source = exactParticleSource(input.source, field.schema);
  if (sameData(field.sources[input.index], source)) throw new Error("Particle field source replace did not change the source.");
  const emitter = structuredClone(state.emitter);
  emitter.field!.sources[input.index] = source as never;
  return mutation(motion, state, emitter, "source-replaced", [`/layers/${state.layer.id}/emitter/field/sources/${input.index}`], input.index);
}

export function moveMotionParticleFieldSource(motion: MotionDocument, input: TimelineParticleFieldSourceMove): TimelineParticleStructuralMutationResult {
  assertExactInput(input, ["layerId", "fromIndex", "toIndex"], "Particle field source move");
  const state = readParticleStructuralState(motion, input.layerId, true), field = requireField(state);
  assertIndex(input.fromIndex, 0, field.sources.length - 1, "Particle field source fromIndex");
  assertIndex(input.toIndex, 0, field.sources.length - 1, "Particle field source toIndex");
  if (input.fromIndex === input.toIndex) throw new Error("Particle field source move did not change the source order.");
  const emitter = structuredClone(state.emitter);
  moveArrayEntry(emitter.field!.sources, input.fromIndex, input.toIndex);
  return mutation(motion, state, emitter, "source-moved", [`/layers/${state.layer.id}/emitter/field/sources`], input.toIndex);
}

export function deleteMotionParticleFieldSource(motion: MotionDocument, input: TimelineParticleFieldSourceDelete): TimelineParticleStructuralMutationResult {
  assertExactInput(input, ["layerId", "index"], "Particle field source delete");
  const state = readParticleStructuralState(motion, input.layerId, true), field = requireField(state);
  assertIndex(input.index, 0, field.sources.length - 1, "Particle field source index");
  if (field.sources.length <= 1) throw new Error("Particle field source delete must leave at least one source.");
  const emitter = structuredClone(state.emitter);
  emitter.field!.sources.splice(input.index, 1);
  return mutation(motion, state, emitter, "source-deleted", [`/layers/${state.layer.id}/emitter/field/sources`]);
}

export function insertMotionParticleOrigin(motion: MotionDocument, input: TimelineParticleOriginInsert): TimelineParticleStructuralMutationResult {
  assertExactInput(input, ["layerId", "index", "origin"], "Particle origin insert");
  const state = readParticleStructuralState(motion, input.layerId, true);
  requireV2Field(state);
  const origins = state.emitter.origins ?? [];
  assertIndex(input.index, 0, origins.length, "Particle origin insertion index");
  if (origins.length >= originLimit()) throw new Error(`Particle origins cannot exceed ${originLimit()} entries.`);
  const emitter = structuredClone(state.emitter), origin = exactParticleOrigin(input.origin);
  emitter.origins = structuredClone(origins);
  emitter.origins.splice(input.index, 0, origin);
  return mutation(motion, state, emitter, "origin-inserted", [`/layers/${state.layer.id}/emitter/origins`], input.index);
}

export function replaceMotionParticleOrigin(motion: MotionDocument, input: TimelineParticleOriginReplace): TimelineParticleStructuralMutationResult {
  assertExactInput(input, ["layerId", "index", "origin"], "Particle origin replace");
  const state = readParticleStructuralState(motion, input.layerId, true);
  requireV2Field(state);
  const origins = state.emitter.origins;
  if (!origins) throw new Error(`Particles layer ${state.layer.id} has no origins to replace.`);
  assertIndex(input.index, 0, origins.length - 1, "Particle origin index");
  const origin = exactParticleOrigin(input.origin);
  if (sameData(origins[input.index], origin)) throw new Error("Particle origin replace did not change the origin.");
  const emitter = structuredClone(state.emitter);
  emitter.origins![input.index] = origin;
  return mutation(motion, state, emitter, "origin-replaced", [`/layers/${state.layer.id}/emitter/origins/${input.index}`], input.index);
}

export function moveMotionParticleOrigin(motion: MotionDocument, input: TimelineParticleOriginMove): TimelineParticleStructuralMutationResult {
  assertExactInput(input, ["layerId", "fromIndex", "toIndex"], "Particle origin move");
  const state = readParticleStructuralState(motion, input.layerId, true);
  requireV2Field(state);
  const origins = state.emitter.origins;
  if (!origins) throw new Error(`Particles layer ${state.layer.id} has no origins to move.`);
  assertIndex(input.fromIndex, 0, origins.length - 1, "Particle origin fromIndex");
  assertIndex(input.toIndex, 0, origins.length - 1, "Particle origin toIndex");
  if (input.fromIndex === input.toIndex) throw new Error("Particle origin move did not change the origin order.");
  const emitter = structuredClone(state.emitter);
  moveArrayEntry(emitter.origins!, input.fromIndex, input.toIndex);
  return mutation(motion, state, emitter, "origin-moved", [`/layers/${state.layer.id}/emitter/origins`], input.toIndex);
}

export function deleteMotionParticleOrigin(motion: MotionDocument, input: TimelineParticleOriginDelete): TimelineParticleStructuralMutationResult {
  assertExactInput(input, ["layerId", "index"], "Particle origin delete");
  const state = readParticleStructuralState(motion, input.layerId, true);
  requireV2Field(state);
  const origins = state.emitter.origins;
  if (!origins) throw new Error(`Particles layer ${state.layer.id} has no origins to delete.`);
  assertIndex(input.index, 0, origins.length - 1, "Particle origin index");
  if (origins.length <= 1) throw new Error("Particle origin delete must leave at least one origin.");
  const emitter = structuredClone(state.emitter);
  emitter.origins!.splice(input.index, 1);
  return mutation(motion, state, emitter, "origin-deleted", [`/layers/${state.layer.id}/emitter/origins`]);
}

/** Axis is structural collision-kind data; collision position/restitution remain existing rich controls. */
export function updateMotionParticleCollisionAxis(motion: MotionDocument, input: TimelineParticleCollisionAxisUpdate): TimelineParticleStructuralMutationResult {
  assertExactInput(input, ["layerId", "index", "axis"], "Particle collision axis update");
  const state = readParticleStructuralState(motion, input.layerId, true), field = requireV2Field(state);
  assertIndex(input.index, 0, field.sources.length - 1, "Particle collision source index");
  if (input.axis !== "x" && input.axis !== "y") throw new Error("Particle collision axis must be x or y.");
  const source = field.sources[input.index];
  if (source?.kind !== "collision") throw new Error(`Particle field source ${input.index} is not a collision source.`);
  if (source.axis === input.axis) throw new Error("Particle collision axis update did not change the axis.");
  const emitter = structuredClone(state.emitter);
  (emitter.field!.sources[input.index] as Extract<typeof source, { kind: "collision" }>).axis = input.axis;
  return mutation(motion, state, emitter, "collision-axis-updated", [`/layers/${state.layer.id}/emitter/field/sources/${input.index}/axis`], input.index);
}

export function addMotionParticleAnalyticTrail(motion: MotionDocument, input: TimelineParticleAnalyticTrailAdd): TimelineParticleStructuralMutationResult {
  assertExactInput(input, ["layerId", "trail"], "Particle analytic trail add");
  const state = readParticleStructuralState(motion, input.layerId, true);
  requireV2Field(state);
  if (state.emitter.trail) throw new Error("Particle analytic trail is already present; use replace.");
  const emitter = structuredClone(state.emitter);
  emitter.trail = exactAnalyticTrail(input.trail);
  return mutation(motion, state, emitter, "trail-added", [`/layers/${state.layer.id}/emitter/trail`]);
}

export function replaceMotionParticleAnalyticTrail(motion: MotionDocument, input: TimelineParticleAnalyticTrailReplace): TimelineParticleStructuralMutationResult {
  assertExactInput(input, ["layerId", "trail"], "Particle analytic trail replace");
  const state = readParticleStructuralState(motion, input.layerId, true);
  requireV2Field(state);
  if (!state.emitter.trail) throw new Error("Particle analytic trail is absent; use add.");
  const trail = exactAnalyticTrail(input.trail);
  if (sameData(state.emitter.trail, trail)) throw new Error("Particle analytic trail replace did not change the trail.");
  const emitter = structuredClone(state.emitter);
  emitter.trail = trail;
  return mutation(motion, state, emitter, "trail-replaced", [`/layers/${state.layer.id}/emitter/trail`]);
}

export function removeMotionParticleAnalyticTrail(motion: MotionDocument, input: TimelineParticleAnalyticTrailRemove): TimelineParticleStructuralMutationResult {
  assertExactInput(input, ["layerId"], "Particle analytic trail remove");
  const state = readParticleStructuralState(motion, input.layerId, true);
  requireV2Field(state);
  if (!state.emitter.trail) throw new Error("Particle analytic trail is already absent.");
  const emitter = structuredClone(state.emitter);
  delete emitter.trail;
  return mutation(motion, state, emitter, "trail-removed", [`/layers/${state.layer.id}/emitter/trail`]);
}

export function addMotionParticleShading(motion: MotionDocument, input: TimelineParticleShadingAdd): TimelineParticleStructuralMutationResult {
  assertExactInput(input, ["layerId", "shading"], "Particle shading add");
  const state = readParticleStructuralState(motion, input.layerId, true);
  requireV2Field(state);
  if (state.emitter.shading) throw new Error("Particle shading is already present; use replace.");
  const emitter = structuredClone(state.emitter);
  emitter.shading = exactParticleShading(input.shading);
  return mutation(motion, state, emitter, "shading-added", [`/layers/${state.layer.id}/emitter/shading`]);
}

export function replaceMotionParticleShading(motion: MotionDocument, input: TimelineParticleShadingReplace): TimelineParticleStructuralMutationResult {
  assertExactInput(input, ["layerId", "shading"], "Particle shading replace");
  const state = readParticleStructuralState(motion, input.layerId, true);
  requireV2Field(state);
  if (!state.emitter.shading) throw new Error("Particle shading is absent; use add.");
  const shading = exactParticleShading(input.shading);
  if (sameData(state.emitter.shading, shading)) throw new Error("Particle shading replace did not change the shading.");
  const emitter = structuredClone(state.emitter);
  emitter.shading = shading;
  return mutation(motion, state, emitter, "shading-replaced", [`/layers/${state.layer.id}/emitter/shading`]);
}

export function removeMotionParticleShading(motion: MotionDocument, input: TimelineParticleShadingRemove): TimelineParticleStructuralMutationResult {
  assertExactInput(input, ["layerId"], "Particle shading remove");
  const state = readParticleStructuralState(motion, input.layerId, true);
  requireV2Field(state);
  if (!state.emitter.shading) throw new Error("Particle shading is already absent.");
  const emitter = structuredClone(state.emitter);
  delete emitter.shading;
  return mutation(motion, state, emitter, "shading-removed", [`/layers/${state.layer.id}/emitter/shading`]);
}

function mutation(
  motion: MotionDocument,
  state: ReturnType<typeof readParticleStructuralState>,
  emitter: MotionParticleEmitter,
  action: TimelineParticleStructuralAction,
  changedPaths: string[],
  index?: number,
): TimelineParticleStructuralMutationResult {
  const committed = commitParticleEmitter(motion, state, emitter);
  return { ...committed, layerId: state.layer.id, action, changedPaths, ...(index === undefined ? {} : { index }) };
}
