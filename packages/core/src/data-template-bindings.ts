import { applyTemplateValues, type TemplateValue } from "./template";
import type { MotionDocument, MotionPackage } from "./types";

/**
 * Applies row keys declared by a package template through the same typed binding authority used by
 * `motion.template.apply`. A provided template key must reach a real binding or expansion refuses
 * before package copy or rendering. Later replacement/layer/document stages retain precedence.
 */
export function applyMotionRowTemplateValues(
  pkg: MotionPackage,
  motion: MotionDocument,
  row: Record<string, unknown>,
  rowId: string
): MotionDocument {
  if (!pkg.template) return motion;

  const inputSchema = record(pkg.template.metadata?.inputSchema);
  const inputProperties = record(inputSchema?.properties);
  const declaredIds = new Set([
    ...pkg.template.params.map((param) => param.id),
    ...Object.keys(inputProperties ?? {})
  ]);
  const provided = Object.fromEntries(Object.entries(row).filter(([key]) => declaredIds.has(key)));
  if (Object.keys(provided).length === 0) return motion;

  const nonValues = Object.entries(provided).filter((entry) => !isTemplateValue(entry[1])).map(([key]) => key);
  if (nonValues.length > 0) {
    throw new Error(`Motion data row ${rowId} template value(s) must be string, number, boolean, or null: ${nonValues.join(", ")}.`);
  }

  const applied = applyTemplateValues({ ...pkg, motion }, provided as Record<string, TemplateValue>);
  if (!applied.ok) {
    const detail = applied.errors.map((error) => `${error.paramId || "<template>"}: ${error.message}`).join("; ");
    throw new Error(`Motion data row ${rowId} template value(s) could not be applied: ${detail}.`);
  }

  const appliedIds = new Set(applied.changedParams);
  const unappliedIds = Object.keys(provided).filter((key) => !appliedIds.has(key));
  if (unappliedIds.length > 0) {
    const warnings = applied.warnings.length > 0 ? ` ${applied.warnings.join(" ")}` : "";
    throw new Error(`Motion data row ${rowId} template value(s) reached no writable binding: ${unappliedIds.join(", ")}.${warnings}`);
  }
  return applied.motion;
}

function isTemplateValue(value: unknown): value is TemplateValue {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
