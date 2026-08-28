/** Runtime execution of the code-owned two-stage Motion validation contract. */
import { buildMotionPublicSchema } from "./motion-public-schema";
import { motionValidationReport, type MotionValidationReport, type MotionValidationStage } from "./motion-validation-contract";
import { validateAgainstPublishedSchema, type JsonSchemaDocument } from "./published-schema-check";
import { motionDocumentRootPreflight } from "./motion-document-root-preflight";
import { loadSchema, validateDocument, type ValidationResult } from "./validate";

const MOTION_STRUCTURAL_SCHEMA: JsonSchemaDocument = buildMotionPublicSchema();

export type TwoStageMotionValidationResult =
  | { ok: true; report: MotionValidationReport }
  | { ok: false; stage: MotionValidationStage; errors: Array<{ path: string; message: string }>; report: MotionValidationReport };

/**
 * Evaluate the Motion document contract in its published order.
 *
 * The runtime validator deliberately retains detailed scalar diagnostics as
 * part of stage two; that compatibility detail does not expand the schema's
 * public guarantee. Package-local semantic checks must report a semantic-stage
 * failure with `motionValidationReport` after this function succeeds.
 */
export async function validateMotionDocumentInStages(
  document: unknown,
  structuralSchema: JsonSchemaDocument = MOTION_STRUCTURAL_SCHEMA,
): Promise<TwoStageMotionValidationResult> {
  const rootProblem = motionDocumentRootPreflight(document);
  if (rootProblem) return { ok: false, stage: "structural", errors: [rootProblem], report: motionValidationReport("structural") };
  const structuralErrors = validateAgainstPublishedSchema(structuralSchema, document);
  if (structuralErrors.length > 0) {
    return { ok: false, stage: "structural", errors: structuralErrors, report: motionValidationReport("structural") };
  }
  const semantic = await validateDocument(await loadSchema("motion"), document);
  if (!semantic.ok) return semanticFailure(semantic);
  return { ok: true, report: motionValidationReport() };
}

function semanticFailure(result: Exclude<ValidationResult, { ok: true }>): TwoStageMotionValidationResult {
  return { ok: false, stage: "semantic", errors: result.errors, report: motionValidationReport("semantic") };
}
