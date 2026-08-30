/**
 * Keep the installed gradient-authoring example tied to Core validation and its exact render lane.
 * The example is an agent-facing contract, so a prose-only update must not be able to advertise an
 * ellipse that validates nowhere or one of the strict lanes cannot render faithfully.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BROWSER_CAPABILITY,
  GPU_CAPABILITY,
  NATIVE_CAPABILITY,
  loadSchema,
  matchRendererCapability,
  matchRendererCapabilityCards,
  validateDocument,
  type MotionDocument,
  type MotionLayer,
} from "../packages/core/src/index";

const GRADIENT_SECTION = "## Gradients: use `layer.gradient`, not stacked shapes";
const LANE_CLAIM = "Browser faithfully renders gradients on the closed legacy primitives";
const PUBLIC_LANE_CLAIM = "linear and radial gradients on browser-renderable closed";

async function main(): Promise<void> {
  const skill = await read("skill/shellx-motion/SKILL.md");
  const example = extractGradientExample(skill);
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1",
    id: "motion_gradient_skill_example",
    name: "Gradient skill example",
    durationMs: 4000,
    fps: 30,
    width: 1920,
    height: 1080,
    background: "#080b14",
    assets: [],
    layers: [example],
    provenance: { sourceApp: "shellx-motion", createdBy: "gradient-authoring-contract" }
  };

  const validation = await validateDocument(await loadSchema("motion"), motion);
  if (!validation.ok) throw new Error(`The installed gradient skill example must validate: ${JSON.stringify(validation.errors)}`);

  const cards = matchRendererCapabilityCards(motion, { target: "preview", output: "png-frame" });
  if (cards.recommendedLane !== "browser") {
    throw new Error(`The installed gradient skill example must recommend Browser, got ${String(cards.recommendedLane)}.`);
  }
  assertLane("browser", matchRendererCapability(motion, BROWSER_CAPABILITY).ok, true);
  assertLane("gpu", matchRendererCapability(motion, GPU_CAPABILITY).ok, false);
  assertLane("native", matchRendererCapability(motion, NATIVE_CAPABILITY).ok, false);

  const features = await read("docs/public/FEATURES.md");
  if (!skill.includes(LANE_CLAIM)) throw new Error("The installed skill must state the exact Browser gradient primitive contract.");
  if (!features.toLowerCase().includes(PUBLIC_LANE_CLAIM)) throw new Error("docs/public/FEATURES.md must state the Browser gradient primitive contract.");

  console.log("gradient-authoring-contract: skill example validates and matches Browser-only gradient lanes.");
}

function extractGradientExample(skill: string): MotionLayer {
  const sectionIndex = skill.indexOf(GRADIENT_SECTION);
  if (sectionIndex < 0) throw new Error(`Missing installed skill section ${JSON.stringify(GRADIENT_SECTION)}.`);
  const fence = /```jsonc\n([\s\S]*?)\n```/.exec(skill.slice(sectionIndex));
  if (!fence) throw new Error("The installed gradient skill example must be a JSONC code fence.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1]);
  } catch (error) {
    throw new Error(`The installed gradient skill example is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The installed gradient skill example must be one layer object.");
  return parsed as MotionLayer;
}

function assertLane(lane: string, actual: boolean, expected: boolean): void {
  if (actual !== expected) throw new Error(`The installed gradient skill example lane ${lane} must be ${expected ? "admitted" : "refused"}.`);
}

async function read(path: string): Promise<string> {
  return readFile(resolve(path), "utf8");
}

await main();
