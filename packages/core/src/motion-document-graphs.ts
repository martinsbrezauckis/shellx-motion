import { validateMotionCompositingGraph } from "./compositing-graph-validate";
import { validateMotionProceduralGraph } from "./procedural-relationship-validate";

type ValidationError = { path: string; message: string };

/** Validate optional document-level graphs without growing the legacy schema orchestrator. */
export function validateMotionDocumentGraphs(record: Record<string, unknown>, errors: ValidationError[]): void {
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
}
