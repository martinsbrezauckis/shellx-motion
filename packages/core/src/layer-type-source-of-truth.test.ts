/**
 * Guards the single source of truth for "which layer types can be rendered".
 *
 * Two invariants, both aimed at one recurring defect: the engine telling an author that a layer
 * type is available when nothing will draw it.
 *
 * 1. Every member of `MotionLayerType` is renderable by at least one lane — the union of the
 *    renderer capability cards. A type cannot be advertised before something can draw it.
 * 2. No copied renderable-layer list exists outside its named executable authority. The capability
 *    cards define renderability; narrower questions, such as generated-visual or relation-action
 *    role vocabularies, have their own named authorities. Every other consumer derives through
 *    `renderableLayerTypes()` or its narrower authority. This is the check that would have caught
 *    `GENERATED_RENDERER_LAYER_TYPES` in adapters-canvas, a private copy that drifted from the
 *    cards (it listed "canvas"/"html", which no card has, and omitted particles/shader/scene3d/
 *    camera/adjustment/environment) and therefore advertised `compatibility.lanes: ["canvas"]` for
 *    packages the browser and ffmpeg lanes render perfectly well.
 *
 * Dependencies: `./capabilities` (the derived set) and a read-only production-source walk.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderableLayerTypes } from "./capabilities";
import { compareCodeUnits } from "./canonical-json";
import type { MotionLayerType } from "./types";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Exhaustive mirror of `MotionLayerType`.
 *
 * `Record<MotionLayerType, true>` makes the compiler enforce both directions: a member missing here
 * fails to satisfy the record, and a key that is not a member is an excess property. The runtime
 * assertion below then binds that compiler-checked set to the capability cards, so the union cannot
 * gain a type no lane renders (nor lose one that a lane does).
 */
const DECLARED_LAYER_TYPES: Record<MotionLayerType, true> = {
  text: true,
  shape: true,
  image: true,
  video: true,
  caption: true,
  audio: true,
  web: true,
  html: true,
  canvas: true,
  adjustment: true,
  camera: true,
  particles: true,
  points: true,
  shader: true,
  scene3d: true,
  environment: true,
  group: true
};

/**
 * Modules whose layer-type lists are named executable authorities.
 *
 * Tests and generated schema artifacts are checked through their own generator and source-to-runtime
 * contracts. Scanning those output mirrors would only require another copied allowlist here. The
 * source walk instead permits lists only in the four named runtime authorities below.
 */
const LAYER_TYPE_AUTHORITY_FILES = new Set([
  "packages/core/src/capability-cards.ts",
  "packages/core/src/gpu-capability-card.ts",
  "packages/core/src/generated-visual-layer-types.ts",
  "packages/core/src/motion-relation-action-layer-types.ts"
]);

/** Literals of only double-quoted strings — the array/`new Set([...])` idiom a copied list uses. */
const STRING_ARRAY_LITERAL = /\[(?:\s*"[^"\\]*"\s*,?)+\s*\]/g;

describe("layer type source of truth", () => {
  it("declares no layer type that no lane can render", () => {
    expect(Object.keys(DECLARED_LAYER_TYPES).sort(compareCodeUnits)).toEqual([...renderableLayerTypes()]);
  });

  it("keeps hard-coded layer-type lists confined to executable authorities", () => {
    const layerTypes = new Set<string>(renderableLayerTypes());
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const relativePath = relative(repoRoot, file).split(sep).join("/");
      // The guard itself is a test-only mirror of MotionLayerType; production sources cannot
      // hide behind it.
      if (relativePath === "packages/core/src/layer-type-source-of-truth.test.ts") continue;
      for (const literal of readFileSync(file, "utf8").match(STRING_ARRAY_LITERAL) ?? []) {
        const members = [...literal.matchAll(/"([^"\\]*)"/g)].map((match) => match[1]);
        const found = [...new Set(members.filter((member) => layerTypes.has(member)))];
        // Six or more distinct layer types, and at least two thirds of the literal being layer
        // types, is the signature of a list that means "the layer types": a list of field names or
        // feature keys that happens to contain three of them is not.
        if (found.length < 6 || found.length * 3 < members.length * 2) continue;
        if (!LAYER_TYPE_AUTHORITY_FILES.has(relativePath)) offenders.push(`${relativePath}: [${members.join(", ")}]`);
      }
    }

    expect(offenders, "A production layer-type list must be a named executable authority, or derive from "
      + "renderableLayerTypes()/renderLanesFor() in @shellx-motion/core.").toEqual([]);
  });
});

/** Every production TypeScript source file; generated artifacts have dedicated drift gates. */
function sourceFiles(): string[] {
  return [
    ...packageSourceRoots().flatMap((root) => walk(root)),
    ...walk(join(repoRoot, "scripts")),
  ];
}

function packageSourceRoots(): string[] {
  return readdirSync(join(repoRoot, "packages"))
    .map((name) => join(repoRoot, "packages", name, "src"))
    .filter((path) => safeIsDirectory(path));
}

function walk(dir: string, out: string[] = []): string[] {
  if (!safeIsDirectory(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|mts|mjs)$/.test(entry) && !entry.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

function safeIsDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
