/** Persisted-graph checks that bind each procedural SDK mutation to its requested change. */
import { canonicalJson } from "./cache.js";
import { hasPersistedProceduralAudioEnvelope } from "./procedural-audio-envelope-client.js";
import type { MotionSdkOperation } from "./types.js";

export function validProceduralMutationSemantics(
  operation: MotionSdkOperation,
  request: Record<string, unknown>,
  output: Record<string, unknown>,
): boolean {
  const state = plainRecord(output.state);
  const graph = plainRecord(state?.graph);
  const relationships = Array.isArray(graph?.relationships) ? graph.relationships : [];
  if (operation === "proceduralSet") {
    const requested = plainRecord(request.relationship);
    const stored = relationships.find((item) => plainRecord(item)?.id === requested?.id);
    return Boolean(requested && stored && sameCanonical(stored, requested));
  }
  if (operation === "proceduralSetEnabled") {
    const stored = relationships.find((item) => plainRecord(item)?.id === request.relationshipId);
    return plainRecord(stored)?.enabled === request.enabled;
  }
  if (operation === "proceduralDetach") {
    return !relationships.some((item) => plainRecord(item)?.id === request.relationshipId);
  }
  if (operation === "proceduralBake") {
    const bake = plainRecord(output.bake);
    const ids = Array.isArray(bake?.relationshipIds) ? bake.relationshipIds : [];
    const requested = Array.isArray(request.relationshipIds) ? request.relationshipIds : null;
    return (!requested || sameCanonical(ids, [...new Set(requested)]))
      && ids.every((id) => !relationships.some((item) => plainRecord(item)?.id === id));
  }
  return operation === "proceduralAudioEnvelopeProduce"
    && hasPersistedProceduralAudioEnvelope(output, request);
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  return (prototype === Object.prototype || prototype === null)
    && descriptors.every((descriptor) => "value" in descriptor)
    ? value as Record<string, unknown>
    : null;
}
function sameCanonical(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}
