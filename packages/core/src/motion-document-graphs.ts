import { validateMotionCompositingGraph } from "./compositing-graph-validate";
import { validateMotionProceduralGraph } from "./procedural-relationship-validate";
import { validateMotionBehaviors } from "./motion-behavior-validate";
import { validateMotionRelations } from "./motion-relation-validate";
import { validateMotionRelationActions } from "./motion-relation-actions-public-read";
import { validateMotionScene3DAnimationDocument } from "./motion-scene3d-animation-document";
import { validateMotionLayoutGapAnimationDocument } from "./motion-layout-gap-animation-document";
import { motionDocumentRootPreflight } from "./motion-document-root-preflight";

type ValidationError = { path: string; message: string };

/** Validate optional document-level graphs without growing the legacy schema orchestrator. */
export function validateMotionDocumentGraphs(record: Record<string, unknown>, errors: ValidationError[]): void {
  const rootProblem = motionDocumentRootPreflight(record);
  if (rootProblem) { errors.push(rootProblem); return; }
  if (!Array.isArray(record.layers)) return;
  if (record.compositing !== undefined) {
    const result = validateMotionCompositingGraph(record.compositing, {
      width: Number(record.width),
      height: Number(record.height),
      layers: record.layers as never[],
    });
    errors.push(...result.issues.map(({ path, message }) => ({ path, message })));
  }
  if (record.relationships !== undefined) {
    const result = validateMotionProceduralGraph(record.relationships, {
      durationMs: Number(record.durationMs),
      fps: Number(record.fps),
      layers: record.layers as Array<{ id: string; type?: string }>,
    });
    errors.push(...result.issues.map(({ path, message }) => ({ path, message })));
  }
  if (record.behaviors !== undefined) {
    const result = validateMotionBehaviors(record.behaviors, {
      durationMs: Number(record.durationMs),
      layers: record.layers,
      relationships: record.relationships,
    });
    if (!result.ok) errors.push(...result.issues);
  }
  if (record.relations !== undefined) {
    const result = validateMotionRelations(record.relations, {
      durationMs: record.durationMs,
      layers: record.layers,
      relationships: record.relationships,
      behaviors: record.behaviors,
    });
    if (!result.ok) errors.push(...result.issues);
  }
  if (record.scene3dAnimation !== undefined) {
    const result = validateMotionScene3DAnimationDocument(record.scene3dAnimation, {
      durationMs: record.durationMs,
      layers: record.layers,
    });
    if (!result.ok) errors.push(...result.issues);
  }
  if (record.layoutGapAnimation !== undefined) {
    const result = validateMotionLayoutGapAnimationDocument(record.layoutGapAnimation, record as never);
    if (!result.ok) errors.push(...result.issues);
  }
  if (record.relationActions !== undefined) {
    const result = validateMotionRelationActions(record.relationActions);
    if (!result.ok) errors.push({ path: "/relationActions", message: result.message });
  }
}
