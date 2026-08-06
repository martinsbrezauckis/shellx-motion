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
 * Every problem found in one Canvas fixture, reported together.
 *
 * The parser collects instead of throwing on the first failure so a caller learns the whole
 * contract from a single call. `message` is the joined list (what a plain string error surface
 * shows); `problems` is the structured form the debug API returns as `result.problems`.
 */
export class CanvasFixtureError extends Error {
  readonly problems: CanvasFixtureProblem[];

  constructor(problems: CanvasFixtureProblem[]) {
    super(`Canvas fixture has ${problems.length} problem${problems.length === 1 ? "" : "s"}: ${problems
      .map((problem) => `${problem.path}: ${problem.message}${problem.correction ? ` (${problem.correction})` : ""}`)
      .join("; ")}`);
    this.name = "CanvasFixtureError";
    this.problems = problems;
  }
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
