/**
 * Bounded primitive and nested-value validation for Canvas frame selections.
 *
 * Kept separate from the selection-level reader so the structural entry point owns document
 * sequencing while these helpers own bounded parsing and individual diagnostics.
 */
import { renderableLayerTypes, type MotionSafeArea } from "@shellx-motion/core";
import {
  CanvasFixtureProblemCollector,
  MAX_CANVAS_EDIT_STACK_ENTRIES_PER_OUTPUT,
  MAX_CANVAS_SAFE_AREAS_PER_FRAME,
  canvasLayerKindCorrection
} from "./fixture-contract";
import type { CanvasImageEditorOutput, CanvasLayer, JsonRecord } from "./fixture-parse";

export function parseSafeAreas(
  input: unknown,
  path: string,
  problems: CanvasFixtureProblemCollector
): Record<string, MotionSafeArea> | undefined {
  if (input === undefined) return undefined;
  const safeAreas = expectRecord(input, path, problems);
  if (!safeAreas) return undefined;
  const parsed: Record<string, MotionSafeArea> = {};
  let safeAreaCount = 0;
  for (const areaId in safeAreas) {
    if (!Object.hasOwn(safeAreas, areaId)) continue;
    if (safeAreaCount >= MAX_CANVAS_SAFE_AREAS_PER_FRAME) {
      problems.add({ path, message: `must contain at most ${MAX_CANVAS_SAFE_AREAS_PER_FRAME} safe areas` });
      break;
    }
    safeAreaCount += 1;
    const value = safeAreas[areaId];
    if (areaId.length === 0) {
      problems.add({ path, message: "must not contain an empty safe-area id" });
      continue;
    }
    const area = expectRecord(value, `${path}.${areaId}`, problems);
    if (!area) continue;
    const parsedArea: MotionSafeArea = {};
    for (const edge of ["top", "right", "bottom", "left"] as const) {
      if (edge in area) {
        const inset = expectNumber(area, edge, `${path}.${areaId}`, problems);
        if (inset === null) continue;
        if (inset < 0) {
          problems.add({ path: `${path}.${areaId}.${edge}`, message: "must be a non-negative finite number" });
          continue;
        }
        parsedArea[edge] = inset;
      }
    }
    for (const [key, areaValue] of Object.entries(area)) {
      if (key.startsWith("x-")) parsedArea[key as `x-${string}`] = areaValue;
    }
    parsed[areaId] = parsedArea;
  }
  return parsed;
}

export function parseLayer(input: unknown, path: string, problems: CanvasFixtureProblemCollector): CanvasLayer {
  const layer = expectRecord(input, path, problems);
  if (!layer) return { id: "", kind: "", startMs: 0, durationMs: 0 };
  const kind = expectString(layer, "kind", path, problems);
  if (kind !== null) assertRenderableKind(kind, path, problems);
  return {
    ...layer,
    id: expectString(layer, "id", path, problems) ?? "",
    kind: kind ?? "",
    startMs: expectNumber(layer, "startMs", path, problems) ?? 0,
    durationMs: expectNumber(layer, "durationMs", path, problems) ?? 0
  };
}

/** Reject a layer kind no renderer lane can consume, naming the correction when one exists. */
function assertRenderableKind(kind: string, path: string, problems: CanvasFixtureProblemCollector): void {
  const renderable = renderableLayerTypes();
  if (renderable.includes(kind)) return;
  const correction = canvasLayerKindCorrection(kind);
  problems.add({
    path: `${path}.kind`,
    message: `no Motion render lane supports "${kind}" layers; accepted kinds are ${renderable.join(", ")}`,
    ...(correction ? { correction } : {})
  });
}

export function parseImageEditorOutput(
  input: unknown,
  path: string,
  problems: CanvasFixtureProblemCollector
): CanvasImageEditorOutput {
  const output = expectRecord(input, path, problems);
  if (!output) return emptyImageEditorOutput();
  return {
    id: expectString(output, "id", path, problems) ?? "",
    assetId: expectString(output, "assetId", path, problems) ?? "",
    kind: expectString(output, "kind", path, problems) ?? "",
    path: expectString(output, "path", path, problems) ?? "",
    mimeType: expectString(output, "mimeType", path, problems) ?? "",
    width: expectNumber(output, "width", path, problems) ?? 0,
    height: expectNumber(output, "height", path, problems) ?? 0,
    sha256: expectString(output, "sha256", path, problems) ?? "",
    receiptId: typeof output.receiptId === "string" ? output.receiptId : undefined,
    editStack: expectBoundedArray(
      output,
      "editStack",
      path,
      problems,
      MAX_CANVAS_EDIT_STACK_ENTRIES_PER_OUTPUT,
      "edit-stack entries"
    ) ?? []
  };
}

function emptyImageEditorOutput(): CanvasImageEditorOutput {
  return { id: "", assetId: "", kind: "", path: "", mimeType: "", width: 0, height: 0, sha256: "", receiptId: undefined, editStack: [] };
}

export function expectRecord(input: unknown, path: string, problems: CanvasFixtureProblemCollector): JsonRecord | null {
  const record = readRecord(input);
  if (!record) {
    problems.add({ path, message: "must be an object" });
    return null;
  }
  return record;
}

export function expectString(record: JsonRecord, key: string, path: string, problems: CanvasFixtureProblemCollector): string | null {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    problems.add({ path: `${path}.${key}`, message: "must be a non-empty string" });
    return null;
  }
  return value;
}

export function expectNumber(record: JsonRecord, key: string, path: string, problems: CanvasFixtureProblemCollector): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    problems.add({ path: `${path}.${key}`, message: "must be a finite number" });
    return null;
  }
  return value;
}

export function expectBoundedArray(
  record: JsonRecord,
  key: string,
  path: string,
  problems: CanvasFixtureProblemCollector,
  maxItems: number,
  itemLabel: string
): unknown[] | null {
  const value = record[key];
  if (!Array.isArray(value)) {
    problems.add({ path: `${path}.${key}`, message: "must be an array" });
    return null;
  }
  if (value.length > maxItems) {
    problems.add({ path: `${path}.${key}`, message: `must contain at most ${maxItems} ${itemLabel}` });
  }
  return value.slice(0, maxItems);
}

/** Shallow plain-object view of an unknown value, or null for arrays, null, and non-objects. */
export function readRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as JsonRecord : null;
}
