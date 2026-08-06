/**
 * Structural reader for a Canvas frame-selection document.
 *
 * Role: turn an untrusted JSON payload into the typed `CanvasFrameSelection` the converter builds a
 * Motion package from — and, when it cannot, say everything that is wrong in one answer.
 *
 * Two behaviours here are deliberate and are the reason this module was split out of `./index`:
 *
 * 1. REPORT EVERYTHING AT ONCE. The reader accumulates `CanvasFixtureProblem`s and throws a single
 *    `CanvasFixtureError` at the end instead of throwing on the first bad field. The previous
 *    one-field-per-call behaviour made an agent binary-search the contract: thirteen calls to learn
 *    a six-field document.
 *
 * 2. REFUSE UNRENDERABLE LAYER KINDS, DO NOT COERCE THEM. A layer whose `kind` no renderer lane can
 *    consume (`"rect"`, `"ellipse"`, `"circle"`, …) is rejected with the exact correction to write
 *    (`{"kind":"shape","shape":"rect"}`). Coercing would be a second silent rewrite of the author's
 *    declaration: it guesses intent from an undocumented field, it would leave the emitted motion
 *    disagreeing with the document the receipt's `inputHash` attests to, and it would create a
 *    permanent second vocabulary (`kind:"rect"` vs `shape:"rect"`) that has to be kept in sync
 *    forever. The renderable set is read from `renderableLayerTypes()` — the union of the renderer
 *    capability cards — so the importer refuses exactly what the lanes refuse.
 *
 * The kind gate applies to hidden layers too, unlike the render-time gate in
 * `unrenderableMotionLayers`, which skips them because no lane rasterizes a hidden layer. The two
 * ask different questions off the same card-derived set: this one asks "is this document
 * well-formed" (a hidden `kind:"rect"` is still a kind that does not exist, and breaks the moment
 * the layer is shown), the render-time one asks "can a lane render this package as it stands".
 *
 * Dependencies: `@shellx-motion/core` (`renderableLayerTypes`, `verifyIntegrationEnvelope`),
 * `./fixture-contract`. Primary caller: `convertCanvasFrameToMotionPackage` in `./index`.
 */
import { renderableLayerTypes, verifyIntegrationEnvelope, type MotionSafeArea, type ShellXIntegrationNegotiation } from "@shellx-motion/core";
import {
  CANVAS_FIXTURE_SCHEMAS,
  CanvasFixtureError,
  canvasLayerKindCorrection,
  type CanvasFixtureProblem
} from "./fixture-contract";

export type JsonRecord = Record<string, unknown>;

export interface CanvasFrameSelection {
  schema: "shellx-motion/canvas-frame-selection@1" | "shellx-canvas/frame-selection@1";
  integration?: unknown;
  negotiation?: ShellXIntegrationNegotiation;
  identity?: {
    schema: "shellx-motion/package-identity@1";
    packageId: string;
    motionId: string;
  };
  selectedFrameId: string;
  project: {
    id: string;
    name: string;
  };
  brand: {
    tokens: JsonRecord;
  };
  frames: CanvasFrame[];
  imageEditorOutputs: CanvasImageEditorOutput[];
}

export interface CanvasFrame {
  id: string;
  name: string;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  background?: string;
  safeAreas?: Record<string, MotionSafeArea>;
  layers: CanvasLayer[];
}

export interface CanvasLayer extends JsonRecord {
  id: string;
  kind: string;
  startMs: number;
  durationMs: number;
}

export interface CanvasImageEditorOutput {
  id: string;
  assetId: string;
  kind: string;
  path: string;
  mimeType: string;
  width: number;
  height: number;
  sha256: string;
  receiptId?: string;
  editStack: unknown[];
}

/**
 * Read and structurally check a Canvas frame-selection document.
 *
 * @param input untrusted parsed JSON.
 * @returns the typed selection when every check passes.
 * @throws {CanvasFixtureError} carrying EVERY problem found, never just the first.
 */
export function parseCanvasFrameSelection(input: unknown): CanvasFrameSelection {
  const problems: CanvasFixtureProblem[] = [];
  const root = expectRecord(input, "fixture", problems);
  if (!root) throw new CanvasFixtureError(problems);

  const schema = readSchemaId(root, problems);
  // The envelope and identity blocks only exist on the canonical schema; checking them under an
  // unknown schema id would report problems the caller cannot act on yet.
  const negotiation = schema === "shellx-motion/canvas-frame-selection@1"
    ? readNegotiation(root.integration, schema, problems)
    : undefined;
  const identity = schema === "shellx-motion/canvas-frame-selection@1"
    ? parseCanvasPackageIdentity(root.identity, problems)
    : undefined;

  const selectedFrameId = expectString(root, "selectedFrameId", "fixture", problems);
  const project = parseProject(root.project, problems);
  const brand = parseBrand(root.brand, problems);
  const frameValues = expectArray(root, "frames", "fixture", problems);
  const frames = (frameValues ?? []).map((frame, index) => parseFrame(frame, `frames[${index}]`, problems));
  const outputValues = expectArray(root, "imageEditorOutputs", "fixture", problems);
  const imageEditorOutputs = (outputValues ?? []).map((output, index) =>
    parseImageEditorOutput(output, `imageEditorOutputs[${index}]`, problems)
  );

  if (problems.length > 0) throw new CanvasFixtureError(problems);

  return {
    schema: schema as CanvasFrameSelection["schema"],
    ...(root.integration !== undefined ? { integration: root.integration } : {}),
    ...(negotiation ? { negotiation } : {}),
    ...(identity ? { identity } : {}),
    selectedFrameId: selectedFrameId as string,
    project: project as CanvasFrameSelection["project"],
    brand: brand as CanvasFrameSelection["brand"],
    frames: frames as CanvasFrame[],
    imageEditorOutputs: imageEditorOutputs as CanvasImageEditorOutput[]
  };
}

function readSchemaId(root: JsonRecord, problems: CanvasFixtureProblem[]): string | null {
  const schema = expectString(root, "schema", "fixture", problems);
  if (schema === null) return null;
  if (!(CANVAS_FIXTURE_SCHEMAS as readonly string[]).includes(schema)) {
    problems.push({
      path: "fixture.schema",
      message: `Unsupported Canvas fixture schema: ${schema}`,
      correction: `use one of ${CANVAS_FIXTURE_SCHEMAS.join(" or ")}`
    });
    return null;
  }
  return schema;
}

function readNegotiation(
  integration: unknown,
  schema: string,
  problems: CanvasFixtureProblem[]
): ShellXIntegrationNegotiation | undefined {
  try {
    return verifyIntegrationEnvelope(integration, {
      producer: "shellx-canvas",
      consumer: "shellx-motion",
      mode: "canvas.bridge",
      payloadSchema: schema
    }).negotiation;
  } catch (error) {
    problems.push({ path: "fixture.integration", message: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

function parseCanvasPackageIdentity(
  input: unknown,
  problems: CanvasFixtureProblem[]
): CanvasFrameSelection["identity"] {
  const value = expectRecord(input, "fixture.identity", problems);
  if (!value) return undefined;
  const allowed = new Set(["schema", "packageId", "motionId"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) problems.push({ path: "fixture.identity", message: `contains unknown field: ${key}` });
  }
  const schema = expectString(value, "schema", "fixture.identity", problems);
  if (schema !== null && schema !== "shellx-motion/package-identity@1") {
    problems.push({
      path: "fixture.identity.schema",
      message: `Unsupported Canvas package identity schema: ${schema}`,
      correction: 'use "shellx-motion/package-identity@1"'
    });
  }
  const packageId = expectString(value, "packageId", "fixture.identity", problems);
  const motionId = expectString(value, "motionId", "fixture.identity", problems);
  if (schema === null || packageId === null || motionId === null) return undefined;
  return { schema: "shellx-motion/package-identity@1", packageId, motionId };
}

function parseProject(input: unknown, problems: CanvasFixtureProblem[]): CanvasFrameSelection["project"] | null {
  const project = expectRecord(input, "project", problems);
  if (!project) return null;
  const id = expectString(project, "id", "project", problems);
  const name = expectString(project, "name", "project", problems);
  return id !== null && name !== null ? { id, name } : null;
}

function parseBrand(input: unknown, problems: CanvasFixtureProblem[]): CanvasFrameSelection["brand"] | null {
  const brand = expectRecord(input, "brand", problems);
  if (!brand) return null;
  const tokens = expectRecord(brand.tokens, "brand.tokens", problems);
  return tokens ? { tokens } : null;
}

function parseFrame(input: unknown, path: string, problems: CanvasFixtureProblem[]): CanvasFrame {
  const frame = expectRecord(input, path, problems);
  if (!frame) return emptyFrame();
  const layerValues = expectArray(frame, "layers", path, problems);
  return {
    id: expectString(frame, "id", path, problems) ?? "",
    name: expectString(frame, "name", path, problems) ?? "",
    durationMs: expectNumber(frame, "durationMs", path, problems) ?? 0,
    fps: expectNumber(frame, "fps", path, problems) ?? 0,
    width: expectNumber(frame, "width", path, problems) ?? 0,
    height: expectNumber(frame, "height", path, problems) ?? 0,
    background: typeof frame.background === "string" ? frame.background : undefined,
    safeAreas: parseSafeAreas(frame.safeAreas, `${path}.safeAreas`, problems),
    layers: (layerValues ?? []).map((layer, index) => parseLayer(layer, `${path}.layers[${index}]`, problems))
  };
}

function emptyFrame(): CanvasFrame {
  return { id: "", name: "", durationMs: 0, fps: 0, width: 0, height: 0, background: undefined, safeAreas: undefined, layers: [] };
}

function parseSafeAreas(
  input: unknown,
  path: string,
  problems: CanvasFixtureProblem[]
): Record<string, MotionSafeArea> | undefined {
  if (input === undefined) return undefined;
  const safeAreas = expectRecord(input, path, problems);
  if (!safeAreas) return undefined;
  const parsed: Record<string, MotionSafeArea> = {};
  for (const [areaId, value] of Object.entries(safeAreas)) {
    if (areaId.length === 0) {
      problems.push({ path, message: "must not contain an empty safe-area id" });
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
          problems.push({ path: `${path}.${areaId}.${edge}`, message: "must be a non-negative finite number" });
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

function parseLayer(input: unknown, path: string, problems: CanvasFixtureProblem[]): CanvasLayer {
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

/**
 * Reject a layer kind no renderer lane can consume, naming the correction when one exists.
 *
 * The accepted set is `renderableLayerTypes()` — the union of the renderer capability cards, which
 * is the same data every lane's runtime gate tests `layer.type` against. Accepting a kind here that
 * the lanes refuse is precisely the defect this check exists to close: a package that packages
 * cleanly, validates as valid, and then cannot be previewed or rendered by anything.
 */
function assertRenderableKind(kind: string, path: string, problems: CanvasFixtureProblem[]): void {
  const renderable = renderableLayerTypes();
  if (renderable.includes(kind)) return;
  const correction = canvasLayerKindCorrection(kind);
  problems.push({
    path: `${path}.kind`,
    message: `no Motion render lane supports "${kind}" layers; accepted kinds are ${renderable.join(", ")}`,
    ...(correction ? { correction } : {})
  });
}

function parseImageEditorOutput(input: unknown, path: string, problems: CanvasFixtureProblem[]): CanvasImageEditorOutput {
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
    editStack: expectArray(output, "editStack", path, problems) ?? []
  };
}

function emptyImageEditorOutput(): CanvasImageEditorOutput {
  return { id: "", assetId: "", kind: "", path: "", mimeType: "", width: 0, height: 0, sha256: "", receiptId: undefined, editStack: [] };
}

function expectRecord(input: unknown, path: string, problems: CanvasFixtureProblem[]): JsonRecord | null {
  const record = readRecord(input);
  if (!record) {
    problems.push({ path, message: "must be an object" });
    return null;
  }
  return record;
}

function expectString(record: JsonRecord, key: string, path: string, problems: CanvasFixtureProblem[]): string | null {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    problems.push({ path: `${path}.${key}`, message: "must be a non-empty string" });
    return null;
  }
  return value;
}

function expectNumber(record: JsonRecord, key: string, path: string, problems: CanvasFixtureProblem[]): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    problems.push({ path: `${path}.${key}`, message: "must be a finite number" });
    return null;
  }
  return value;
}

function expectArray(record: JsonRecord, key: string, path: string, problems: CanvasFixtureProblem[]): unknown[] | null {
  const value = record[key];
  if (!Array.isArray(value)) {
    problems.push({ path: `${path}.${key}`, message: "must be an array" });
    return null;
  }
  return value;
}

/**
 * Shallow plain-object view of an unknown value, or null when it is not one.
 *
 * @param value candidate value from parsed canvas JSON.
 * @returns a copy of the own enumerable entries, or null for arrays, null, and non-objects.
 */
export function readRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
