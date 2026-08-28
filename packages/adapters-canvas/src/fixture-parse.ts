/**
 * Structural reader for a Canvas frame-selection document.
 *
 * Role: turn an untrusted JSON payload into the typed `CanvasFrameSelection` the converter builds a
 * Motion package from — and, when it cannot, say everything that is wrong in one answer.
 *
 * Two behaviours here are deliberate and are the reason this module was split out of `./index`:
 *
 * 1. REPORT THE FULL BOUNDED SET AT ONCE. The reader accumulates `CanvasFixtureProblem`s and throws
 *    a single `CanvasFixtureError` at the end instead of throwing on the first bad field. The
 *    previous one-field-per-call behaviour made an agent binary-search the contract: thirteen calls
 *    to learn a six-field document. The explicit collection cap keeps malformed payloads bounded;
 *    its final entry and omission count say when diagnostics were omitted.
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
 * Dependencies: `@shellx-motion/core` (`verifyIntegrationEnvelope`), `./fixture-contract`, and
 * `./fixture-parse-validation`. Primary caller: `convertCanvasFrameToMotionPackage` in `./index`.
 */
import { verifyIntegrationEnvelope, type MotionSafeArea, type ShellXIntegrationNegotiation } from "@shellx-motion/core";
import {
  CANVAS_FIXTURE_SCHEMAS,
  CanvasFixtureError,
  CanvasFixtureProblemCollector,
  MAX_CANVAS_FRAME_COUNT,
  MAX_CANVAS_IMAGE_EDITOR_OUTPUTS,
  MAX_CANVAS_LAYERS_PER_FRAME,
  MAX_CANVAS_TOTAL_LAYER_COUNT
} from "./fixture-contract";
import {
  expectBoundedArray,
  expectNumber,
  expectRecord,
  expectString,
  parseImageEditorOutput,
  parseLayer,
  parseSafeAreas,
  readRecord
} from "./fixture-parse-validation";

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
 * @throws {CanvasFixtureError} carrying every problem up to the explicit cap, never just the first.
 */
export function parseCanvasFrameSelection(input: unknown): CanvasFrameSelection {
  const problems = new CanvasFixtureProblemCollector();
  const root = expectRecord(input, "fixture", problems);
  if (!root) throw fixtureError(problems);

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
  const frameValues = expectBoundedArray(root, "frames", "fixture", problems, MAX_CANVAS_FRAME_COUNT, "frames");
  const layerBudget: CanvasLayerBudget = { count: 0 };
  const frames = (frameValues ?? []).map((frame, index) => parseFrame(frame, `frames[${index}]`, problems, layerBudget));
  const outputValues = expectBoundedArray(
    root,
    "imageEditorOutputs",
    "fixture",
    problems,
    MAX_CANVAS_IMAGE_EDITOR_OUTPUTS,
    "image-editor outputs"
  );
  const imageEditorOutputs = (outputValues ?? []).map((output, index) =>
    parseImageEditorOutput(output, `imageEditorOutputs[${index}]`, problems)
  );

  if (problems.hasProblems) throw fixtureError(problems);

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

interface CanvasLayerBudget {
  count: number;
}

function fixtureError(problems: CanvasFixtureProblemCollector): CanvasFixtureError {
  return new CanvasFixtureError(problems.problems, problems.omittedCount);
}

function readSchemaId(root: JsonRecord, problems: CanvasFixtureProblemCollector): string | null {
  const schema = expectString(root, "schema", "fixture", problems);
  if (schema === null) return null;
  if (!(CANVAS_FIXTURE_SCHEMAS as readonly string[]).includes(schema)) {
    problems.add({
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
  problems: CanvasFixtureProblemCollector
): ShellXIntegrationNegotiation | undefined {
  try {
    return verifyIntegrationEnvelope(integration, {
      producer: "shellx-canvas",
      consumer: "shellx-motion",
      mode: "canvas.bridge",
      payloadSchema: schema
    }).negotiation;
  } catch (error) {
    problems.add({ path: "fixture.integration", message: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

function parseCanvasPackageIdentity(
  input: unknown,
  problems: CanvasFixtureProblemCollector
): CanvasFrameSelection["identity"] {
  const value = expectRecord(input, "fixture.identity", problems);
  if (!value) return undefined;
  const allowed = new Set(["schema", "packageId", "motionId"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) problems.add({ path: "fixture.identity", message: `contains unknown field: ${key}` });
  }
  const schema = expectString(value, "schema", "fixture.identity", problems);
  if (schema !== null && schema !== "shellx-motion/package-identity@1") {
    problems.add({
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

function parseProject(input: unknown, problems: CanvasFixtureProblemCollector): CanvasFrameSelection["project"] | null {
  const project = expectRecord(input, "project", problems);
  if (!project) return null;
  const id = expectString(project, "id", "project", problems);
  const name = expectString(project, "name", "project", problems);
  return id !== null && name !== null ? { id, name } : null;
}

function parseBrand(input: unknown, problems: CanvasFixtureProblemCollector): CanvasFrameSelection["brand"] | null {
  const brand = expectRecord(input, "brand", problems);
  if (!brand) return null;
  const tokens = expectRecord(brand.tokens, "brand.tokens", problems);
  return tokens ? { tokens } : null;
}

function parseFrame(
  input: unknown,
  path: string,
  problems: CanvasFixtureProblemCollector,
  layerBudget: CanvasLayerBudget
): CanvasFrame {
  const frame = expectRecord(input, path, problems);
  if (!frame) return emptyFrame();
  const layerValues = takeLayerBudget(
    expectBoundedArray(frame, "layers", path, problems, MAX_CANVAS_LAYERS_PER_FRAME, "layers") ?? [],
    problems,
    layerBudget
  );
  return {
    id: expectString(frame, "id", path, problems) ?? "",
    name: expectString(frame, "name", path, problems) ?? "",
    durationMs: expectNumber(frame, "durationMs", path, problems) ?? 0,
    fps: expectNumber(frame, "fps", path, problems) ?? 0,
    width: expectNumber(frame, "width", path, problems) ?? 0,
    height: expectNumber(frame, "height", path, problems) ?? 0,
    background: typeof frame.background === "string" ? frame.background : undefined,
    safeAreas: parseSafeAreas(frame.safeAreas, `${path}.safeAreas`, problems),
    layers: layerValues.map((layer, index) => parseLayer(layer, `${path}.layers[${index}]`, problems))
  };
}

function takeLayerBudget(
  layers: unknown[],
  problems: CanvasFixtureProblemCollector,
  budget: CanvasLayerBudget
): unknown[] {
  const available = Math.max(0, MAX_CANVAS_TOTAL_LAYER_COUNT - budget.count);
  if (layers.length > available) {
    problems.add({
      path: "fixture.frames",
      message: `must contain at most ${MAX_CANVAS_TOTAL_LAYER_COUNT} aggregate layers`
    });
  }
  const admitted = layers.slice(0, available);
  budget.count += admitted.length;
  return admitted;
}

function emptyFrame(): CanvasFrame {
  return { id: "", name: "", durationMs: 0, fps: 0, width: 0, height: 0, background: undefined, safeAreas: undefined, layers: [] };
}

export { readRecord } from "./fixture-parse-validation";
