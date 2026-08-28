/** Repeatable real P2B fixture smoke; removes only its exact private output. */
import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runCli } from "../packages/cli/src/main";
import { verifyAttestedArtifactHandleReference, type AttestedArtifactHandleReference } from "../packages/core/src/index";
import { assertPrivateRepoScratchPath, preparePrivateRepoScratch } from "./repo-scratch.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const fixturePath = join(repoRoot, "fixtures", "canvas", "shape-text-frame-selection.json");
const scratchRoot = await preparePrivateRepoScratch(repoRoot);
const outDir = join(scratchRoot, "connectors", "canvas-story-hero");

await assertPrivateRepoScratchPath(repoRoot, outDir);
await rm(outDir, { recursive: true, force: true });

const result = await runCli(["connector", "canvas-to-cut", fixturePath, "--out", outDir]);
assert(result.ok, `Canvas fixture P2B smoke failed: ${JSON.stringify(result, null, 2)}`);

const render = object(result.render, "render");
const artifacts = array(result.artifacts, "artifacts");
const renderedMedia = artifacts.find((artifact) => field(artifact, "role", "artifact") === "rendered_media");
const cutPlanPath = string(result.cutPlanPath, "cutPlanPath");
assert(field(render, "required", "render") === true, "P2B fixture delivery must require rendered media.");
assert(field(render, "dryRun", "render") === false, "P2B fixture delivery must be real, not dry-run.");
assert(field(render, "frameLane", "render") === "browser", "P2B fixture delivery must use Browser frames.");
assert(field(renderedMedia, "mediaType", "rendered_media") === "video/mp4", "P2B fixture delivery must emit MP4 media.");
assert(field(renderedMedia, "status", "rendered_media") === "available", "P2B fixture rendered media must be available.");

const cutPlan = object(JSON.parse(await readFile(cutPlanPath, "utf8")) as unknown, "cut plan");
assert(field(cutPlan, "mode", "cut plan") === "rendered_media", "P2B fixture plan must import rendered media.");
const operation = object(array(field(cutPlan, "operations", "cut plan"), "operations")[0], "first plan operation");
const renderedPlan = object(field(operation, "renderedMedia", "first plan operation"), "rendered media plan");
assert(field(renderedPlan, "dryRun", "rendered media plan") === false, "Cut plan must reference real media.");
const handle = object(field(renderedPlan, "handle", "rendered media plan"), "artifact handle reference");
const verified = await verifyAttestedArtifactHandleReference(outDir, handle as unknown as AttestedArtifactHandleReference, { requiredReceiptRoles: ["render", "connector"] });
await stat(verified.path);

console.log(JSON.stringify({
  ok: true,
  command: "connector.canvas-fixture-cut-smoke",
  fixturePath,
  outDir,
  cutPlanPath,
  renderedMediaPath: verified.path,
  cutApplication: "not attempted; Motion returns a Cut import plan only"
}, null, 2));

function object(value: unknown, label: string): object {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `expected ${label} object`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `expected ${label} array`);
  return value;
}

function field(value: unknown, key: string, label: string): unknown {
  return Reflect.get(object(value, label), key);
}

function string(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0, `missing ${label}`);
  return value;
}
