/**
 * Host gate for the editable-lowering Template-to-Cut connector (dry-run render).
 *
 * Two different acceptance rules meet here, deliberately:
 *   - The RENDER receipt must stay exactly `not_run`. This run passes `--dry-run-render`, so no media
 *     is produced and `not_run` is the only honest word. It is asserted directly rather than through
 *     `assertReceiptSucceeded`, which maps `not_run` onto a SKIPPED job and would reject it — that
 *     rejection is correct, and it is why widening this line would be a real loss of truth.
 *   - The CONNECTOR receipt is judged by the shared contract rule in `scripts/render-smoke-status.ts`.
 *     Template-to-Cut previews on the `auto` lane, which resolves to native for this fixture, so the
 *     honest outcome is a `warning` naming the native case-folding advisory. There is no render, so
 *     no motion measurement can appear and none is accepted.
 */
import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";
import { assertReceiptSucceeded, FONT_FALLBACK_ADVISORY, NATIVE_CASE_FOLD_ADVISORY } from "./render-smoke-status";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packageRoot = join(repoRoot, "fixtures/cut-native-static-package");
const outDir = join(repoRoot, ".scratch", "connectors", "template-cut-smoke");

await rm(outDir, { recursive: true, force: true });

const result = await runCli([
  "connector",
  "template-to-cut",
  packageRoot,
  "--out",
  outDir,
  "--cut-import-mode",
  "editable_lowering",
  "--dry-run-render",
  "--set",
  "title=Template Smoke",
  "--set",
  "accentColor=#ff006e",
]);

assert(result.ok, `Template-to-Cut smoke failed: ${JSON.stringify(result, null, 2)}`);

const template = readObject(result.template, "result.template");
const preview = readObject(result.preview, "result.preview");
const render = readObject(result.render, "result.render");
const artifacts = readArray(result.artifacts);
const cutPlanArtifact = artifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "cut_plan");
const renderedMedia = artifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "rendered_media");
const packageDir = readString(result.packageDir, "packageDir");
const templateReceiptPath = readString(readObjectField(template, "receiptPath", "template.receiptPath"), "template.receiptPath");
const previewPath = readString(readObjectField(preview, "outputPath", "preview.outputPath"), "preview.outputPath");
const previewReceiptPath = readString(readObjectField(preview, "receiptPath", "preview.receiptPath"), "preview.receiptPath");
const renderReceiptPath = readString(readObjectField(render, "receiptPath", "render.receiptPath"), "render.receiptPath");
const connectorReceiptPath = readString(result.receiptPath, "receiptPath");
const cutPlanPath = readString(result.cutPlanPath, "cutPlanPath");

assert.deepEqual(readObjectField(template, "changedParams", "template.changedParams"), ["title", "accentColor"]);
assert(readObjectField(preview, "ok", "preview.ok") === true, "Template-to-Cut smoke should render a native preview.");
assert(readObjectField(render, "required", "render.required") === false, "Editable Template-to-Cut smoke should not require rendered media.");
assert(readObjectField(render, "dryRun", "render.dryRun") === true, "Template-to-Cut smoke should stay dry-run for host verification.");
assert(readObjectField(cutPlanArtifact, "status", "cut_plan.status") === "available", "cut_plan artifact should be available.");
assert(readObjectField(cutPlanArtifact, "primary", "cut_plan.primary") === true, "editable cut_plan artifact should be primary.");
assert(renderedMedia === undefined, "editable Template-to-Cut smoke must not create a rendered_media artifact.");

await stat(packageDir);
await stat(templateReceiptPath);
await stat(previewPath);
await stat(previewReceiptPath);
await stat(renderReceiptPath);
await stat(connectorReceiptPath);
await stat(cutPlanPath);

const renderReceipt = readJsonObject(await readFile(renderReceiptPath, "utf8"), "render receipt");
const connectorReceipt = readJsonObject(await readFile(connectorReceiptPath, "utf8"), "connector receipt");
const cutPlan = readJsonObject(await readFile(cutPlanPath, "utf8"), "cut plan");

// Exact on purpose: a dry run that reports anything other than `not_run` is claiming work it did not
// do. See the header — this is the assertion the shared rule must NOT be pointed at.
assert(readObjectField(renderReceipt, "status", "renderReceipt.status") === "not_run", `expected not_run render receipt, got ${String(readObjectField(renderReceipt, "status", "renderReceipt.status"))}`);
// `auto` preview lane: native folds case, browser falls back on fonts. Either is honest, both name
// themselves, and anything else fails.
const connectorSuccess = assertReceiptSucceeded(connectorReceipt, {
  label: "Template-to-Cut connector",
  expectedAdvisories: [NATIVE_CASE_FOLD_ADVISORY, FONT_FALLBACK_ADVISORY]
});
assert(readObjectField(cutPlan, "schema", "cutPlan.schema") === "shellx-motion/cut-import-plan@1", "cut import plan schema mismatch.");
assert(readObjectField(cutPlan, "mode", "cutPlan.mode") === "editable_lowering", `expected editable_lowering mode, got ${String(readObjectField(cutPlan, "mode", "cutPlan.mode"))}`);

console.log(JSON.stringify({
  ok: true,
  command: "connector.template-cut-smoke",
  packageRoot,
  packageDir,
  cutPlanPath,
  template: {
    changedParams: readObjectField(template, "changedParams", "template.changedParams"),
    receiptPath: templateReceiptPath
  },
  preview: {
    outputPath: previewPath,
    receiptPath: previewReceiptPath
  },
  render: {
    required: readObjectField(render, "required", "render.required"),
    dryRun: readObjectField(render, "dryRun", "render.dryRun"),
    receiptPath: renderReceiptPath,
    receiptStatus: readObjectField(renderReceipt, "status", "renderReceipt.status")
  },
  receiptPath: connectorReceiptPath,
  connector: {
    receiptStatus: connectorSuccess.status,
    jobOutcome: connectorSuccess.outcome,
    acceptedWarnings: connectorSuccess.warnings,
    matchedAdvisories: connectorSuccess.matchedAdvisories
  },
  artifacts
}, null, 2));

function readJsonObject(text: string, label: string): object {
  const parsed: unknown = JSON.parse(text);
  return readObject(parsed, label);
}

function readObject(value: unknown, label: string): object {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `expected ${label} object, got ${typeof value}`);
  return value;
}

function readObjectField(value: unknown, key: string, label: string): unknown {
  const record = readObject(value, label);
  return Reflect.get(record, key);
}

function readArray(value: unknown): unknown[] {
  assert(Array.isArray(value), "expected array");
  return value;
}

function readString(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0, `missing ${label}`);
  return value;
}
