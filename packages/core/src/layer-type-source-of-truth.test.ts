/**
 * Guards the single source of truth for "which layer types can be rendered".
 *
 * Two invariants, both aimed at one recurring defect: the engine telling an author that a layer
 * type is available when nothing will draw it.
 *
 * 1. Every member of `MotionLayerType` is renderable by at least one lane — the union of the
 *    renderer capability cards. A type cannot be advertised before something can draw it.
 * 2. No second hard-coded layer-type list exists anywhere in the source. The capability cards are
 *    the only place the set is written down; every other consumer derives it through
 *    `renderableLayerTypes()`. This is the check that would have caught
 *    `GENERATED_RENDERER_LAYER_TYPES` in adapters-canvas, a private copy that drifted from the
 *    cards (it listed "canvas"/"html", which no card has, and omitted particles/shader/scene3d/
 *    camera/adjustment/environment) and therefore advertised `compatibility.lanes: ["canvas"]` for
 *    packages the browser and ffmpeg lanes render perfectly well.
 *
 * Dependencies: `./capabilities` (the derived set) and a read-only filesystem walk of the repo.
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
  adjustment: true,
  camera: true,
  particles: true,
  shader: true,
  scene3d: true,
  environment: true
};

/**
 * Literals that legitimately list six or more layer types without deriving them from the cards.
 *
 * Keyed by path + exact sorted member set, not by file: a new or edited literal in one of these
 * files still fails, so an allowlist entry cannot become a hiding place. Each entry states which
 * question its list answers — if the answer is "which types can be rendered", it does not belong
 * here, it belongs in `renderableLayerTypes()`.
 */
const ALLOWED_LAYER_TYPE_LISTS: Array<{ path: string; members: string[]; because: string }> = [
  {
    path: "packages/core/src/capability-cards.ts",
    members: ["text", "shape", "image", "video", "web", "caption", "camera", "particles", "adjustment", "shader", "scene3d", "environment"],
    because: "The browser card. The capability-card catalog IS the source of truth."
  },
  {
    path: "packages/core/src/capability-cards.ts",
    members: ["text", "shape", "image", "video", "web", "caption", "audio", "camera", "particles", "adjustment", "shader", "scene3d", "environment"],
    because: "The ffmpeg card. The capability-card catalog IS the source of truth."
  },
  {
    path: "packages/core/src/capability-cards.ts",
    members: ["text", "shape", "image", "video", "web", "caption", "audio"],
    because: "The connector card. The capability-card catalog IS the source of truth."
  },
  {
    path: "packages/core/src/validate.ts",
    members: ["shape", "text", "caption", "image", "video", "particles", "shader", "scene3d", "environment"],
    because: "Answers a different question: which types are VISUAL (depth ordering, motion blur), "
      + "not which types a lane renders — `audio` draws nothing and camera/adjustment/web are drawn "
      + "but are not things a camera parallaxes against. Written once, as "
      + "GENERATED_VISUAL_LAYER_TYPES; validate.ts previously carried it twice."
  },
  {
    path: "packages/adapters-cut/src/editable-receiver-allowlist.test.ts",
    members: ["text", "shape", "caption", "image", "video", "audio"],
    because: "Answers a different question: what ShellX Cut accepts as an editable receiver, which "
      + "is another product's capability and not a Motion render lane."
  },
  {
    path: "schemas/canvas-frame-selection.schema.json",
    members: ["adjustment", "audio", "camera", "caption", "environment", "image", "particles", "scene3d", "shader", "shape", "text", "video", "web"],
    because: "The published Canvas layer.kind enum, already pinned to renderableLayerTypes() by "
      + "packages/adapters-canvas/src/schema-contract.test.ts, which fails if it drifts."
  }
];

/** Literals of only double-quoted strings — the array/`new Set([...])` idiom a copied list uses. */
const STRING_ARRAY_LITERAL = /\[(?:\s*"[^"\\]*"\s*,?)+\s*\]/g;

describe("layer type source of truth", () => {
  it("declares no layer type that no lane can render", () => {
    expect(Object.keys(DECLARED_LAYER_TYPES).sort(compareCodeUnits)).toEqual([...renderableLayerTypes()]);
  });

  it("keeps exactly one hard-coded layer-type list in the repo", () => {
    const layerTypes = new Set<string>([...renderableLayerTypes(), "group", "html", "canvas"]);
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const relativePath = relative(repoRoot, file).split(sep).join("/");
      // This file necessarily quotes the sets it permits; scanning itself would flag its own
      // allowlist. Nothing here is read at runtime by the engine.
      if (relativePath === "packages/core/src/layer-type-source-of-truth.test.ts") continue;
      for (const literal of readFileSync(file, "utf8").match(STRING_ARRAY_LITERAL) ?? []) {
        const members = [...literal.matchAll(/"([^"\\]*)"/g)].map((match) => match[1]);
        const found = [...new Set(members.filter((member) => layerTypes.has(member)))];
        // Six or more distinct layer types, and at least two thirds of the literal being layer
        // types, is the signature of a list that means "the layer types": a list of field names or
        // feature keys that happens to contain three of them is not.
        if (found.length < 6 || found.length * 3 < members.length * 2) continue;
        const allowed = ALLOWED_LAYER_TYPE_LISTS.some((entry) =>
          entry.path === relativePath && sameMembers(entry.members, members));
        if (!allowed) offenders.push(`${relativePath}: [${members.join(", ")}]`);
      }
    }

    expect(offenders, "A hard-coded layer-type list must not be copied out of the renderer capability "
      + "cards: derive it from renderableLayerTypes()/renderLanesFor() in @shellx-motion/core, or add an "
      + "ALLOWED_LAYER_TYPE_LISTS entry saying which other question the list answers.").toEqual([]);
  });
});

function sameMembers(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort(compareCodeUnits).every((value, index) => value === [...right].sort(compareCodeUnits)[index]);
}

/** Every shipped source file: package sources, build/verification scripts, published schemas. */
function sourceFiles(): string[] {
  return [
    ...packageSourceRoots().flatMap((root) => walk(root)),
    ...walk(join(repoRoot, "scripts")),
    ...walk(join(repoRoot, "schemas"))
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
    else if (/\.(ts|mts|mjs|json)$/.test(entry)) out.push(path);
  }
  return out;
}

function safeIsDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
