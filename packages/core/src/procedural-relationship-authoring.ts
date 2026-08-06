import { canonicalJson } from "./canonical-json";
import { validateMotionProceduralGraph } from "./procedural-relationship-validate";
import {
  MOTION_PROCEDURAL_SCHEMA,
  type MotionProceduralAudioEnvelope,
  type MotionProceduralGraph,
  type MotionProceduralRelationship,
} from "./procedural-relationship-types";
import type { MotionDocument } from "./types";

export interface MotionProceduralAuthoringResult {
  motion: MotionDocument;
  changedPath: string;
  action: "inserted" | "updated" | "enabled" | "disabled" | "detached" | "envelopes-updated";
}

export function setMotionProceduralRelationship(
  motion: MotionDocument,
  relationship: MotionProceduralRelationship,
): MotionProceduralAuthoringResult {
  const graph = cloneGraph(motion.relationships);
  const index = graph.relationships.findIndex((item) => item.id === relationship.id);
  if (index < 0) graph.relationships.push(structuredClone(relationship));
  else graph.relationships[index] = structuredClone(relationship);
  const result = checked(motion, graph, `/relationships/relationships/${relationship.id}`, index < 0 ? "inserted" : "updated");
  // Value equality, so it must not depend on key insertion order or on the host locale: an
  // agent that re-sends the same relationship with keys in a different order has to be told it is
  // a no-op on every machine, not only on the one the comparator's locale happened to agree with.
  if (index >= 0 && canonicalJson(motion.relationships!.relationships[index]) === canonicalJson(relationship)) {
    throw new Error(`Procedural relationship ${relationship.id} already matches the requested value.`);
  }
  return result;
}

export function setMotionProceduralRelationshipEnabled(
  motion: MotionDocument,
  relationshipId: string,
  enabled: boolean,
): MotionProceduralAuthoringResult {
  const graph = requiredGraph(motion);
  const relationship = graph.relationships.find((item) => item.id === relationshipId);
  if (!relationship) throw new Error(`Unknown procedural relationship: ${relationshipId}.`);
  if (relationship.enabled === enabled) {
    throw new Error(`Procedural relationship ${relationshipId} is already ${enabled ? "enabled" : "disabled"}.`);
  }
  relationship.enabled = enabled;
  return checked(motion, graph, `/relationships/relationships/${relationshipId}/enabled`, enabled ? "enabled" : "disabled");
}

export function setMotionProceduralAudioEnvelopes(
  motion: MotionDocument,
  audioEnvelopes: MotionProceduralAudioEnvelope[],
): MotionProceduralAuthoringResult {
  const graph = requiredGraph(motion);
  graph.audioEnvelopes = structuredClone(audioEnvelopes);
  return checked(motion, graph, "/relationships/audioEnvelopes", "envelopes-updated");
}

export function detachMotionProceduralRelationship(
  motion: MotionDocument,
  relationshipId: string,
): MotionProceduralAuthoringResult {
  const graph = requiredGraph(motion);
  const remaining = graph.relationships.filter((item) => item.id !== relationshipId);
  if (remaining.length === graph.relationships.length) throw new Error(`Unknown procedural relationship: ${relationshipId}.`);
  const next = structuredClone(motion);
  if (remaining.length) next.relationships = { ...graph, relationships: remaining };
  else delete next.relationships;
  return { motion: next, changedPath: `/relationships/relationships/${relationshipId}`, action: "detached" };
}

function checked(
  motion: MotionDocument,
  graph: MotionProceduralGraph,
  changedPath: string,
  action: MotionProceduralAuthoringResult["action"],
): MotionProceduralAuthoringResult {
  const validation = validateMotionProceduralGraph(graph, motion);
  if (!validation.ok) {
    const first = validation.issues[0];
    throw new Error(`Procedural relationship edit invalid at ${first.path}: ${first.message}`);
  }
  return { motion: { ...structuredClone(motion), relationships: graph }, changedPath, action };
}

function requiredGraph(motion: MotionDocument): MotionProceduralGraph {
  if (!motion.relationships) throw new Error("Motion document has no procedural relationships.");
  return structuredClone(motion.relationships);
}

function cloneGraph(value: MotionProceduralGraph | undefined): MotionProceduralGraph {
  return value ? structuredClone(value) : { schema: MOTION_PROCEDURAL_SCHEMA, relationships: [] };
}
