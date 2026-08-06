import type {
  MotionSdkSpatialInterpolation,
  MotionSdkSpatialTangentMode,
  MotionSdkTimelineEdit,
  MotionSdkTimelineReceiptOperation,
} from "./timeline-edit-types.js";

export interface NormalizedSpatialTimelineEdit {
  command:
    | "motion.timeline.spatial.position.upsert"
    | "motion.timeline.spatial.position.move"
    | "motion.timeline.spatial.position.delete";
  args: Record<string, unknown>;
  edit: MotionSdkTimelineEdit;
}

export function normalizeSpatialTimelineEdit(value: unknown): NormalizedSpatialTimelineEdit | null {
  const edit = plainRecord(value);
  if (!edit || typeof edit.kind !== "string" || !edit.kind.startsWith("spatial.position.")) return null;
  const kind = edit.kind;
  const allowed = kind === "spatial.position.upsert"
    ? ["kind", "layerId", "atMs", "x", "y", "easing", "spatial"]
    : kind === "spatial.position.move" ? ["kind", "layerId", "fromMs", "toMs"]
      : kind === "spatial.position.delete" ? ["kind", "layerId", "atMs"] : null;
  if (!allowed) throw new Error(`Unsupported timeline edit kind: ${kind}.`);
  const unknown = Object.keys(edit).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Timeline spatial edit contains unsupported field ${unknown}.`);
  const layerId = boundedString(edit.layerId, "layerId");
  if (kind === "spatial.position.move") {
    const fromMs = nonNegative(edit.fromMs, "fromMs"); const toMs = nonNegative(edit.toMs, "toMs");
    const normalized: MotionSdkTimelineEdit = { kind: "spatial.position.move", layerId, fromMs, toMs };
    return { command: "motion.timeline.spatial.position.move", args: { layerId, fromMs, toMs }, edit: normalized };
  }
  const atMs = nonNegative(edit.atMs, "atMs");
  if (kind === "spatial.position.delete") {
    const normalized: MotionSdkTimelineEdit = { kind: "spatial.position.delete", layerId, atMs };
    return { command: "motion.timeline.spatial.position.delete", args: { layerId, atMs }, edit: normalized };
  }
  const x = coordinate(edit.x, "x"); const y = coordinate(edit.y, "y");
  const easing = edit.easing === undefined ? undefined : boundedString(edit.easing, "easing");
  const spatial = edit.spatial === undefined ? undefined : spatialInterpolation(edit.spatial);
  const normalized: MotionSdkTimelineEdit = { kind: "spatial.position.upsert", layerId, atMs, x, y, ...(easing ? { easing } : {}), ...(spatial ? { spatial } : {}) };
  return { command: "motion.timeline.spatial.position.upsert", args: { layerId, atMs, x, y, ...(easing ? { easing } : {}), ...(spatial ? { spatial } : {}) }, edit: normalized };
}

export function spatialTimelineReceiptOperation(kind: unknown): MotionSdkTimelineReceiptOperation | null {
  if (kind === "spatial.position.upsert") return "timeline.spatial.position.upsert";
  if (kind === "spatial.position.move") return "timeline.spatial.position.move";
  if (kind === "spatial.position.delete") return "timeline.spatial.position.delete";
  return null;
}

export function validateSpatialTimelineEdit(value: unknown): string | null | false {
  const edit = plainRecord(value);
  if (!edit || typeof edit.kind !== "string" || !edit.kind.startsWith("spatial.position.")) return false;
  try { normalizeSpatialTimelineEdit(value); return null; }
  catch (error) { return error instanceof Error ? error.message : "Timeline spatial edit is invalid."; }
}

function spatialInterpolation(value: unknown): MotionSdkSpatialInterpolation {
  const spatial = plainRecord(value); const incoming = plainRecord(spatial?.in); const outgoing = plainRecord(spatial?.out);
  const mode = spatial?.mode;
  if ((mode !== "linear" && mode !== "smooth" && mode !== "broken" && mode !== "auto") || !incoming || !outgoing) {
    throw new Error("Timeline spatial edit requires a supported tangent mode and in/out handles.");
  }
  return {
    mode: mode as MotionSdkSpatialTangentMode,
    in: { x: coordinate(incoming.x, "spatial.in.x"), y: coordinate(incoming.y, "spatial.in.y") },
    out: { x: coordinate(outgoing.x, "spatial.out.x"), y: coordinate(outgoing.y, "spatial.out.y") },
  };
}

function boundedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || value !== value.trim()) throw new Error(`Timeline spatial edit requires bounded ${label}.`);
  return value;
}
function nonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Timeline spatial edit requires non-negative ${label}.`);
  return value;
}
function coordinate(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000) throw new Error(`Timeline spatial edit requires bounded finite ${label}.`);
  return value;
}
function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}
