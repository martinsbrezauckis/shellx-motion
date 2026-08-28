/**
 * The published, machine-readable contract for a Canvas frame-selection document.
 *
 * Role: one place that states what `motion.canvas.package` accepts — the schema ids, the required
 * fields per level, the layer kinds any render lane can consume, and a minimal document that
 * actually converts. Before this module existed the contract lived only inside the imperative
 * parser, and the only way to discover it was to call the command, read the single field it named,
 * fix that field, and call again; a blind agent needed thirteen round trips.
 *
 * Dependencies: `@shellx-motion/core` for `renderableLayerTypes()` — the layer kinds are NOT
 * re-listed here, they are read from the renderer capability cards so this contract cannot promise
 * a kind the lanes refuse.
 *
 * Primary callers: `./fixture-parse` (rejection messages), `packages/debug-api/src/domains/
 * integration.ts` (surfaces the contract on every rejection), and
 * `packages/debug-api/src/command-metadata-surfaces.ts` (argument-schema description).
 */
import { renderableLayerTypes } from "@shellx-motion/core";

/** Frame-selection payload schema ids Motion accepts, canonical first. */
export const CANVAS_FIXTURE_SCHEMAS = [
  "shellx-motion/canvas-frame-selection@1",
  "shellx-canvas/frame-selection@1"
] as const;

/**
 * One rejected thing about a fixture: where it is, what is wrong, and — when the mistake has a
 * single known correction — exactly what to write instead.
 */
export interface CanvasFixtureProblem {
  /** Dotted path to the offending value, e.g. `frames[0].layers[1].kind`. */
  path: string;
  /** What is wrong, phrased as the requirement the value failed. */
  message: string;
  /** The exact edit that fixes it, when there is exactly one. */
  correction?: string;
}

/**
 * Canvas fixture structural limits. They bound the in-memory adapter projection before it becomes
 * MotionIR, while leaving ordinary Canvas selections comfortably below every limit.
 */
export const MAX_CANVAS_FRAME_COUNT = 128;
export const MAX_CANVAS_LAYERS_PER_FRAME = 1_024;
export const MAX_CANVAS_TOTAL_LAYER_COUNT = 4_096;
export const MAX_CANVAS_IMAGE_EDITOR_OUTPUTS = 1_024;
export const MAX_CANVAS_SAFE_AREAS_PER_FRAME = 64;
export const MAX_CANVAS_EDIT_STACK_ENTRIES_PER_OUTPUT = 256;

/** The bounded structured diagnostic surface returned by Canvas import failures. */
export const MAX_CANVAS_FIXTURE_PROBLEMS = 256;
/** The plain Error message is a convenience surface, not an unbounded duplicate of problems. */
export const MAX_CANVAS_FIXTURE_ERROR_MESSAGE_BYTES = 64 * 1024;
/** Keeps one pathological input value from dominating the bounded structured diagnostic result. */
export const MAX_CANVAS_FIXTURE_PROBLEM_FIELD_BYTES = 4 * 1024;

/**
 * Collect unique fixture diagnostics without allowing a malformed array to amplify response size.
 *
 * Existing, normally sized invalid selections retain every diagnostic. Once the collection would
 * exceed its limit, the final retained slot becomes a deterministic summary of omitted entries.
 */
export class CanvasFixtureProblemCollector {
  private readonly entries: CanvasFixtureProblem[] = [];
  private readonly seen = new Set<string>();
  private omittedProblemCount = 0;

  add(problem: CanvasFixtureProblem): void {
    // Once the bounded result has its omission summary, do not retain more unique fingerprints or
    // format more attacker-controlled fields merely to count omitted diagnostics.
    if (this.omittedProblemCount > 0) {
      this.omittedProblemCount += 1;
      return;
    }
    const bounded = boundCanvasFixtureProblem(problem);
    const key = `${bounded.path}\u0000${bounded.message}\u0000${bounded.correction ?? ""}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);

    if (this.entries.length < MAX_CANVAS_FIXTURE_PROBLEMS) {
      this.entries.push(bounded);
      return;
    }

    // Preserve the public array cap and make room for the deterministic truncation summary.
    this.entries.pop();
    this.omittedProblemCount = 2;
  }

  get problems(): CanvasFixtureProblem[] {
    if (this.omittedProblemCount === 0) return [...this.entries];
    return [
      ...this.entries,
      {
        path: "fixture",
        message: `${this.omittedProblemCount} additional Canvas fixture problem${this.omittedProblemCount === 1 ? "" : "s"} omitted after the ${MAX_CANVAS_FIXTURE_PROBLEMS}-problem limit.`
      }
    ];
  }

  get omittedCount(): number {
    return this.omittedProblemCount;
  }

  get hasProblems(): boolean {
    return this.entries.length > 0;
  }
}

/**
 * Canvas fixture problems, reported together up to the explicit collection cap.
 *
 * The parser collects instead of throwing on the first failure so a caller learns the whole
 * contract from a single call. `message` is the bounded joined list (what a plain string error
 * surface shows); `problems` is the bounded structured form the debug API returns as
 * `result.problems`. When the collection limit is reached, the final problem and
 * `omittedProblemCount` carry the deterministic omission summary.
 */
export class CanvasFixtureError extends Error {
  readonly problems: CanvasFixtureProblem[];
  readonly omittedProblemCount: number;

  constructor(problems: CanvasFixtureProblem[], omittedProblemCount = 0) {
    super(canvasFixtureErrorMessage(problems, omittedProblemCount));
    this.name = "CanvasFixtureError";
    this.problems = [...problems];
    this.omittedProblemCount = omittedProblemCount;
  }
}

function boundCanvasFixtureProblem(problem: CanvasFixtureProblem): CanvasFixtureProblem {
  return {
    path: takeUtf8Bytes(problem.path, MAX_CANVAS_FIXTURE_PROBLEM_FIELD_BYTES),
    message: takeUtf8Bytes(problem.message, MAX_CANVAS_FIXTURE_PROBLEM_FIELD_BYTES),
    ...(problem.correction === undefined
      ? {}
      : { correction: takeUtf8Bytes(problem.correction, MAX_CANVAS_FIXTURE_PROBLEM_FIELD_BYTES) })
  };
}

function canvasFixtureErrorMessage(problems: CanvasFixtureProblem[], omittedProblemCount: number): string {
  const totalProblemCount = problems.length - (omittedProblemCount > 0 ? 1 : 0) + omittedProblemCount;
  const prefix = `Canvas fixture has ${totalProblemCount} problem${totalProblemCount === 1 ? "" : "s"}`
    + (omittedProblemCount > 0 ? ` (${omittedProblemCount} omitted after the ${MAX_CANVAS_FIXTURE_PROBLEMS}-problem limit)` : "")
    + ": ";
  const entries = problems.map((problem) => `${problem.path}: ${problem.message}${problem.correction ? ` (${problem.correction})` : ""}`);
  let included = 0;
  let message = prefix;

  for (const entry of entries) {
    const separator = included === 0 ? "" : "; ";
    const remaining = entries.length - included;
    const suffix = remaining > 0 ? `; ${remaining} listed problem${remaining === 1 ? "" : "s"} omitted from the error message after the ${MAX_CANVAS_FIXTURE_ERROR_MESSAGE_BYTES}-byte limit.` : "";
    if (Buffer.byteLength(message, "utf8") + Buffer.byteLength(separator, "utf8") + Buffer.byteLength(entry, "utf8") + Buffer.byteLength(suffix, "utf8") > MAX_CANVAS_FIXTURE_ERROR_MESSAGE_BYTES) {
      return takeUtf8Bytes(`${message}${suffix}`, MAX_CANVAS_FIXTURE_ERROR_MESSAGE_BYTES);
    }
    message += `${separator}${entry}`;
    included += 1;
  }

  return takeUtf8Bytes(message, MAX_CANVAS_FIXTURE_ERROR_MESSAGE_BYTES);
}

function takeUtf8Bytes(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  // UTF-8 code points occupy at most four bytes, so at most three continuation bytes can cross
  // the boundary. Back up to the start of that code point before decoding the retained prefix.
  for (let offset = 0; offset < 3 && end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000; offset += 1) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

/** Required fields per document level, mirroring what `./fixture-parse` enforces. */
export const CANVAS_FIXTURE_REQUIRED_FIELDS = {
  fixture: ["schema", "selectedFrameId", "project", "brand", "frames", "imageEditorOutputs"],
  project: ["id", "name"],
  brand: ["tokens"],
  frame: ["id", "name", "durationMs", "fps", "width", "height", "layers"],
  layer: ["id", "kind", "startMs", "durationMs"],
  imageEditorOutput: ["id", "assetId", "kind", "path", "mimeType", "width", "height", "sha256", "editStack"]
} as const;

/**
 * Smallest fixture that converts and renders. Kept executable rather than illustrative: the
 * adapter test suite feeds this exact object through `convertCanvasFrameToMotionPackage`, so an
 * example that stopped working would fail CI instead of misleading an agent.
 */
export const CANVAS_FIXTURE_EXAMPLE = {
  schema: "shellx-canvas/frame-selection@1",
  selectedFrameId: "frame_intro",
  project: { id: "demo", name: "Demo" },
  brand: { tokens: {} },
  frames: [
    {
      id: "frame_intro",
      name: "Intro",
      durationMs: 1000,
      fps: 30,
      width: 1920,
      height: 1080,
      background: "#f8fafc",
      layers: [
        {
          id: "panel",
          kind: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 100, y: 100, width: 600, height: 300, opacity: 1 },
          style: { fill: "#2563eb" }
        }
      ]
    }
  ],
  imageEditorOutputs: []
} as const;

/**
 * The whole accepted contract in one value, for tool surfaces to publish verbatim.
 *
 * `layerKinds` is computed, not written down: it is the union of every renderer capability card's
 * layer types, which is the same list each lane's runtime gate tests against.
 */
export function canvasFixtureContract(): {
  schemas: string[];
  requiredFields: Record<string, string[]>;
  layerKinds: string[];
  shapeNote: string;
  example: unknown;
} {
  return {
    schemas: [...CANVAS_FIXTURE_SCHEMAS],
    requiredFields: Object.fromEntries(
      Object.entries(CANVAS_FIXTURE_REQUIRED_FIELDS).map(([level, fields]) => [level, [...fields]])
    ),
    layerKinds: [...renderableLayerTypes()],
    shapeNote: 'Rectangles, ellipses and stars are kind "shape" with a shape field: {"kind":"shape","shape":"rect"}. '
      + 'There is no "rect", "ellipse" or "circle" layer kind.',
    example: CANVAS_FIXTURE_EXAMPLE
  };
}

/**
 * The single known correction for a layer `kind` no lane can render, when one exists.
 *
 * Only geometry names are mapped, and only onto Motion's three shape values. The mapping produces
 * a correction *message*, never a silent rewrite of the author's document — see the module header
 * of `./fixture-parse` for why the importer refuses instead of coercing.
 *
 * @param kind the rejected layer kind, as written in the fixture.
 * @returns the exact replacement to write, or undefined when the kind is simply unknown.
 */
export function canvasLayerKindCorrection(kind: string): string | undefined {
  const shape = SHAPE_ALIASES.get(kind.toLowerCase());
  return shape ? `write {"kind":"shape","shape":"${shape}"} instead of {"kind":"${kind}"}` : undefined;
}

/** Geometry names agents reach for, mapped to the shape value Motion's renderers understand. */
const SHAPE_ALIASES = new Map<string, string>([
  ["rect", "rect"],
  ["rectangle", "rect"],
  ["box", "rect"],
  ["square", "rect"],
  ["rounded-rect", "rect"],
  ["roundedrect", "rect"],
  ["ellipse", "ellipse"],
  ["circle", "ellipse"],
  ["oval", "ellipse"],
  ["dot", "ellipse"],
  ["star", "star"]
]);
