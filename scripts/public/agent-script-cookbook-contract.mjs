#!/usr/bin/env node
/**
 * Keeps the agent-authored-script cookbook honest and mechanically usable.
 *
 * The document is a public, agent-facing capability reference. Its small JavaScript samples must
 * remain parseable on their own, and the taxonomy must not quietly drop a requested effect family
 * or turn planned engine primitives into an implied shipped API. This is intentionally a source
 * check, not an execution harness: rendered package proof belongs to each concrete package's
 * preview/final receipt.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const COOKBOOK = resolve(ROOT, "docs/public/agent-authored-scripts.md");
const SKILL_REFERENCE = resolve(ROOT, "skill/shellx-motion/references/agent-authored-scripts.md");
const TIMELINE_AUTHORING_GUIDES = [
  "skill/shellx-motion/references/checkpoint-storyboard.md",
  "skill/shellx-motion/references/timeline-relations.md",
  "skill/shellx-motion/references/timeline-relation-actions.md",
];
const cookbook = readFileSync(COOKBOOK, "utf8");
const skillReference = readFileSync(SKILL_REFERENCE, "utf8");
const failures = [];

const REQUIRED = [
  "Multiple sparks drawing lines",
  "Detailed light-drone animation / swarm rebuild",
  "Fireworks",
  "Sand / magnetic graphite",
  "Laser, engraving, and path reveal",
  "Pulsating countdown",
  "Endless tunnel in / out",
  "Factorial-type workflows",
  "Odds-board / reel-like effects",
  "Code rain",
  "Infinity paths and horizon fields",
  "Black hole / singularity / wormhole",
  "Galaxies, spiral arms, starfields, and twinkle",
  "Tree and leaf-vein skeleton growth",
  "Flowers opening and nature growth",
  "Sun and day/night cycles",
  "Lissajous, rose curves, spirals, hypotrochoids, and epicycles",
  "Superformula and calculated-result forms",
  "Strange attractors and complex-plane mappings",
  "Harmonic and interference waves",
  "Fractal / recursive forms and calculated growth",
  "Gravity and orbit",
  "Attraction / repulsion / magnetic charge",
  "Springs, constraints, and collision",
  "Turbulence, curl-like flow, advection",
  "Vortices, shockwaves, wave interference, field ripples",
  "Tractor beam",
  "Shield impact",
  "Energy arc",
  "Orbital debris",
  "Plasma core",
  "Teleport / disassembly",
  "Magnetic sand",
  "Drone formation"
];

for (const marker of REQUIRED) {
  if (!cookbook.includes(marker)) failures.push(`cookbook is missing required technique marker: ${marker}`);
}

for (const marker of [
  "Works today: data Motion",
  "Works today: package-local canvas script",
  "Works today but bake at author time",
  "Planned engine work (not yet an API)",
  "Script **import** remains blocked",
  "approved-agent-entry provenance",
  "`motion.package.script.author`",
  "local filesystem location or package claims alone are not trust evidence",
  "4,201 shape layers",
  "48 MB",
  "bounded `points` layer",
  "`sin` / `cos`",
  "GPU instancing"
]) {
  if (!cookbook.includes(marker)) failures.push(`cookbook is missing route/security boundary: ${marker}`);
}

for (const marker of [
  "browser-only single-subpath stroked `pathReveal`",
  "static bounded `effects.trail` on points/particles",
  "`pathReveal.start` / `pathReveal.end`",
  "refuses this browser-only feature",
  "Multi-subpath reveal, geometry generation/morph, arbitrary-layer or",
  "planned engine work."
]) {
  if (!cookbook.includes(marker)) failures.push(`cookbook is missing current path/trail boundary: ${marker}`);
}
if (cookbook.includes("first-class path reveal/growing strokes")) {
  failures.push("cookbook still describes the integrated single-subpath pathReveal primitive as planned.");
}
for (const stale of ["until v0.2 adds provenance resolution", "does not make script imports safe, attest script provenance"]) {
  if (cookbook.includes(stale)) failures.push(`cookbook contains stale provenance/host wording: ${stale}`);
}

if (!skillReference.includes("Script import is blocked")) {
  failures.push("skill reference no longer carries the script-import refusal.");
}
if (!skillReference.includes("Planned engine work (not yet an API)")) {
  failures.push("skill reference no longer distinguishes planned engine features.");
}
if (!skillReference.includes("single-subpath stroked `pathReveal`") || !skillReference.includes("Native refuses `pathReveal`")) {
  failures.push("skill reference no longer carries the current browser-only pathReveal boundary.");
}
if (!skillReference.includes("approved-agent-entry provenance") || !skillReference.includes("`motion.package.script.author`")) {
  failures.push("skill reference no longer carries the current approved-agent-entry provenance boundary.");
}

// The three Debug/MCP-only timeline guides deliberately carry complete closed argument objects.
// Keep those small operator specimens parser- and contract-checked in the existing docs gate so
// prose cannot turn a nested descriptor/definition into an illustrative, uncallable shape.
const timelineSnippets = [];
for (const guidePath of TIMELINE_AUTHORING_GUIDES) {
  const guide = readFileSync(resolve(ROOT, guidePath), "utf8");
  const snippets = [...guide.matchAll(/```json timeline-command=([a-z][a-z0-9.-]+)\n([\s\S]*?)```/g)];
  if (snippets.length === 0) failures.push(`${guidePath} has no contract-tagged JSON argument snippets.`);
  const allJsonFences = [...guide.matchAll(/```(?:json|jsonc)(?:[^\n]*)\n([\s\S]*?)```/g)];
  if (allJsonFences.length !== snippets.length) failures.push(`${guidePath} has JSON/JSONC snippets outside the timeline command contract.`);
  for (const [index, match] of snippets.entries()) {
    try {
      const args = JSON.parse(match[2]);
      timelineSnippets.push({ guidePath, index: index + 1, command: match[1], args });
    } catch (error) {
      failures.push(`${guidePath} snippet ${index + 1} is not parseable JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (timelineSnippets.length > 0) {
  const validatorProgram = `
    import { readFileSync } from "node:fs";
    import { DEBUG_COMMAND_CONTRACTS } from "./packages/debug-api/src/command-metadata.ts";
    import { dispatchCheckpointStoryboardRecordLifecycleCommand } from "./packages/debug-api/src/domains/checkpoint-storyboard-record-lifecycle.ts";
    import { dispatchSurfaceStateCommand } from "./packages/debug-api/src/domains/surface-state.ts";
    import { readTimelineRelationActionIntent } from "./packages/debug-api/src/domains/timeline-relation-actions.ts";
    import { readTimelineRelationIntent } from "./packages/debug-api/src/domains/timeline-relations.ts";
    import { readDataRecipeCheckpointDescriptor } from "./packages/core/src/internal/checkpoint-storyboard/checkpoint-storyboard-data-recipe-read.ts";
    import { validateMcpToolCall } from "./packages/debug-server/src/mcp-args-validation.ts";
    import { mcpToolName } from "./packages/debug-server/src/mcp-tool-shape.ts";

    const snippets = JSON.parse(readFileSync(0, "utf8"));
    const failures = [];
    const contracts = new Map(DEBUG_COMMAND_CONTRACTS.map((contract) => [contract.command, contract]));
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const contractFor = (snippet) => {
      const contract = contracts.get(snippet.command);
      if (!contract) failures.push(snippet.guidePath + " snippet " + snippet.index + " names absent Debug command " + snippet.command + ".");
      return contract;
    };
    const mcpValidation = (command, args) => {
      const contract = contracts.get(command);
      if (!contract) return { missing: true };
      return validateMcpToolCall({ toolName: mcpToolName(contract.command), contract, toolArguments: { args } });
    };
    const expectsMcpAcceptance = (snippet) => {
      const invalid = mcpValidation(snippet.command, snippet.args);
      if (invalid?.missing) return;
      if (invalid) failures.push(snippet.guidePath + " snippet " + snippet.index + " is refused by the production MCP published-args validator: " + invalid.error.message);
    };
    const expectsDomainAcceptance = async (snippet) => {
      if (snippet.command === "motion.timeline.checkpoint-storyboard.create" || snippet.command === "motion.timeline.checkpoint-storyboard.inspect") {
        // The lifecycle's reader is private. Its dispatcher reaches that parser before it observes
        // a host store, so this is the production no-I/O route for the two public specimens.
        const result = await dispatchCheckpointStoryboardRecordLifecycleCommand(snippet.command, snippet.args, {});
        if (!result || result.ok || result.error?.code !== "capability_unavailable") failures.push(snippet.guidePath + " snippet " + snippet.index + " is not accepted by the checkpoint Debug domain parser.");
        if (snippet.command === "motion.timeline.checkpoint-storyboard.create") readDataRecipeCheckpointDescriptor(snippet.args.descriptor);
        return;
      }
      if (snippet.command.startsWith("motion.timeline.relations.")) {
        const result = readTimelineRelationIntent(snippet.command, snippet.args);
        if (!result?.ok) failures.push(snippet.guidePath + " snippet " + snippet.index + " is refused by the timeline-relations Debug reader: " + (result?.problem ?? "unknown command"));
        return;
      }
      if (snippet.command.startsWith("motion.timeline.relation-actions.")) {
        const result = readTimelineRelationActionIntent(snippet.command, snippet.args);
        if (!result?.ok) failures.push(snippet.guidePath + " snippet " + snippet.index + " is refused by the timeline-relation-actions Debug reader: " + (result?.problem ?? "unknown command"));
        return;
      }
      if (snippet.command === "motion.state") {
        const result = await dispatchSurfaceStateCommand("motion.state", snippet.args, {});
        if (!result || result.ok || result.error?.code !== "capability_unavailable") failures.push(snippet.guidePath + " snippet " + snippet.index + " is not accepted by the motion.state Debug reader.");
      }
    };
    for (const snippet of snippets) {
      try {
        if (!contractFor(snippet)) continue;
        expectsMcpAcceptance(snippet);
        await expectsDomainAcceptance(snippet);
      } catch (error) {
        failures.push(snippet.guidePath + " snippet " + snippet.index + " fails its production Debug/Core validation: " + (error instanceof Error ? error.message : String(error)));
      }
    }
    const relation = snippets.find((snippet) => snippet.command === "motion.timeline.relations.upsert");
    const action = snippets.find((snippet) => snippet.command === "motion.timeline.relation-actions.upsert");
    const checkpoint = snippets.find((snippet) => snippet.command === "motion.timeline.checkpoint-storyboard.create");
    if (!relation || !action || !checkpoint) {
      failures.push("timeline authoring hostile regressions lack their required tagged specimens.");
    } else {
      const blankRoot = clone(relation.args); blankRoot.packageRoot = "  ";
      const blankCreator = clone(action.args); blankCreator.createdBy = "  ";
      const zeroWidth = clone(checkpoint.args); zeroWidth.descriptor.recipe.parameters.strokeWidth = 0;
      for (const [label, command, args, reader] of [
        ["whitespace-only packageRoot", relation.command, blankRoot, () => readTimelineRelationIntent(relation.command, blankRoot)],
        ["whitespace-only createdBy", action.command, blankCreator, () => readTimelineRelationActionIntent(action.command, blankCreator)],
      ]) {
        const schemaFailure = mcpValidation(command, args);
        if (schemaFailure?.missing || schemaFailure) failures.push(label + " should reach its production Debug reader as a syntactic string.");
        const result = reader();
        if (!result || result.ok) failures.push(label + " is accepted by its production Debug reader.");
      }
      const schemaFailure = mcpValidation(checkpoint.command, zeroWidth);
      const violations = schemaFailure?.error?.detail?.violations;
      if (!schemaFailure || schemaFailure.missing || !Array.isArray(violations) || !violations.some((violation) => violation.argument === "descriptor.recipe.parameters.strokeWidth" && violation.kind === "not_above_exclusive_minimum")) {
        failures.push("checkpoint zero strokeWidth is not refused by the production MCP exclusiveMinimum validator.");
      }
    }
    process.stdout.write(JSON.stringify(failures));
  `;
  try {
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", validatorProgram], {
      cwd: ROOT,
      input: JSON.stringify(timelineSnippets),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    failures.push(...JSON.parse(output));
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : String(error);
    failures.push(`timeline authoring guide contract could not run the Debug/Core validators: ${stderr}`);
  }
}

const snippets = [...cookbook.matchAll(/```js cookbook-testable\n([\s\S]*?)```/g)].map((match) => match[1]);
if (snippets.length < 5) failures.push(`cookbook has ${snippets.length} testable snippets; expected at least 5.`);

const temporaryRoot = mkdtempSync(join(tmpdir(), "shellx-motion-cookbook-"));
try {
  for (const [index, snippet] of snippets.entries()) {
    const path = join(temporaryRoot, `snippet-${index + 1}.mjs`);
    writeFileSync(path, snippet, "utf8");
    try {
      execFileSync(process.execPath, ["--check", path], { stdio: "pipe" });
    } catch (error) {
      const stderr = error && typeof error === "object" && "stderr" in error
        ? String(error.stderr)
        : String(error);
      failures.push(`cookbook snippet ${index + 1} does not parse: ${stderr.trim()}`);
    }
  }
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}

if (failures.length > 0) {
  console.error(`agent-script-cookbook-contract failed (${failures.length}):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`agent-script-cookbook-contract: OK — ${snippets.length} parseable snippets and ${REQUIRED.length} technique markers.`);
}
