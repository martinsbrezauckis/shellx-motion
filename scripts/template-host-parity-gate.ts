import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMotionPackage } from "../packages/core/src/package";
import { assertProductTemplateContract } from "./template-product-pack-catalog";

const RICH_HOST_FAMILIES = [
  { dir: "cinematic-fog-title", cutId: "builtin.motion.cinematic-fog-title", control: "fogDensity" },
  { dir: "editorial-liquid-surface", cutId: "builtin.motion.editorial-liquid-surface", control: "waveHeight" },
  { dir: "keyed-subject-promo", cutId: "builtin.motion.keyed-subject-promo", control: "spillSuppression" },
  { dir: "tracked-callout-overlay", cutId: "builtin.motion.tracked-callout-overlay", control: "calloutTitle" }
] as const;
const RICH_HOST_DIRS: ReadonlySet<string> = new Set(RICH_HOST_FAMILIES.map((family) => family.dir));

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packRoot = resolve(optionValue("--template-root") ?? join(repoRoot, "templates", "shellx-product-pack"));
const canvasRoot = resolve(requiredOption("--canvas-root"));
const cutRoot = resolve(requiredOption("--cut-root"));
const outPath = resolve(optionValue("--out") ?? join(repoRoot, ".scratch", "template-host-parity", "evidence.json"));

const packageDirs = (await readdir(packRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
// Checked against the CONTRACT, not a fixed total: the implementation tree holds the public
// families plus the ones the export manifest withholds, and the published tree holds only the
// public families. A hard-coded count would be wrong in one of those trees.
assertProductTemplateContract(packageDirs);

const motionFamilies: MotionFamilyEvidence[] = [];
for (const dir of packageDirs) {
  const packageRoot = join(packRoot, dir);
  const pkg = await loadMotionPackage(packageRoot);
  assert(pkg.template, `${dir} must include TemplateIR`);
  assert(pkg.manifest.compatibility?.hosts?.includes("shellx-motion"), `${dir} must advertise shellx-motion`);
  if (RICH_HOST_DIRS.has(dir)) {
    for (const host of ["shellx-canvas", "shellx-cut"]) {
      assert(pkg.manifest.compatibility?.hosts?.includes(host), `${dir} must advertise ${host}`);
    }
  }
  const qualityManifest = pkg.template.metadata?.qualityTargets?.manifest;
  if (qualityManifest) await stat(join(packageRoot, qualityManifest));
  motionFamilies.push({
    dir,
    packageId: pkg.manifest.id,
    templateId: pkg.template.id,
    hosts: [...(pkg.manifest.compatibility?.hosts ?? [])],
    lanes: [...(pkg.manifest.compatibility?.lanes ?? [])],
    controls: pkg.template.params.length,
    qualityManifest: qualityManifest ?? null
  });
}

const cutCatalogPaths = [
  join(cutRoot, "schema", "generate_templates.json"),
  join(cutRoot, "schema", "generate_templates_motion_rich.json")
];
const cutCatalogs = await Promise.all(cutCatalogPaths.map(readJson));
const cutTemplates = cutCatalogs.flatMap((catalog) => arrayField(catalog, "templates"));
for (const family of RICH_HOST_FAMILIES) {
  const entry = cutTemplates.find((template) => recordField(template, "id") === family.cutId);
  assert(entry, `Cut Generate is missing ${family.cutId}`);
  const lowering = objectField(entry, "lowering");
  assert.equal(recordField(lowering, "verb"), "motion.template_to_cut", `${family.cutId} must use the Motion bridge`);
  assert.equal(recordField(objectField(lowering, "args"), "template"), family.dir, `${family.cutId} must map to ${family.dir}`);
  assert(family.control in objectField(entry, "params"), `${family.cutId} must expose ${family.control}`);
}
const cutSkillPath = join(cutRoot, "skill", "shellx-cut", "SKILL.md");
const cutReferencePath = join(cutRoot, "skill", "shellx-cut", "reference.md");
const cutAgentText = `${await readFile(cutSkillPath, "utf8")}\n${await readFile(cutReferencePath, "utf8")}`;

const canvasWorkflowPath = join(canvasRoot, "docs", "motion-product-template-workflows.md");
const canvasActionPath = join(canvasRoot, "app", "src", "lib", "agent", "action-catalog.ts");
const canvasSkillPath = join(canvasRoot, "SKILL.md");
const canvasAgentText = `${await readFile(canvasWorkflowPath, "utf8")}\n${await readFile(canvasActionPath, "utf8")}\n${await readFile(canvasSkillPath, "utf8")}`;
for (const family of RICH_HOST_FAMILIES) {
  assert(cutAgentText.includes(family.cutId), `Cut agent guidance is missing ${family.cutId}`);
  assert(canvasAgentText.includes(family.dir), `Canvas agent guidance is missing ${family.dir}`);
}
for (const required of ["generate.preview", "generate.insert", "Edit in Motion", "motion.link.refresh"]) {
  assert(cutAgentText.includes(required), `Cut workflow guidance is missing ${required}`);
}
for (const required of ["motion.openPackage()", "motion.state(sessionId)", "motion.renderRevision(sessionId)", "Refresh render"]) {
  assert(canvasAgentText.includes(required), `Canvas workflow guidance is missing ${required}`);
}

const evidence = {
  ok: true,
  schema: "shellx-motion/template-host-parity@1",
  catalogTemplateCount: motionFamilies.length,
  richHostFamilyCount: RICH_HOST_FAMILIES.length,
  motion: { packRoot, families: motionFamilies },
  canvas: {
    root: canvasRoot,
    workflowPath: canvasWorkflowPath,
    workflowSha256: await sha256File(canvasWorkflowPath),
    actionCatalogSha256: await sha256File(canvasActionPath),
    agentWorkflow: "cut-linked-package -> path-free openPackage -> projected edits -> renderRevision"
  },
  cut: {
    root: cutRoot,
    catalogPaths: cutCatalogPaths,
    catalogSha256: await Promise.all(cutCatalogPaths.map(sha256File)),
    agentWorkflow: "generate.list/describe -> preview -> insert -> Edit in Motion -> refresh"
  },
  resourcePolicy: {
    browserProcessesLaunched: 0,
    renderedMediaCreated: 0,
    validation: "schema, package, catalog, and agent-contract checks only"
  }
};
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...evidence, evidencePath: outPath }, null, 2));

interface MotionFamilyEvidence {
  dir: string;
  packageId: string;
  templateId: string;
  hosts: string[];
  lanes: string[];
  controls: number;
  qualityManifest: string | null;
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name: string): string {
  const value = optionValue(name);
  assert(value, `${name} is required`);
  return value;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function objectField(value: unknown, key: string): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), `${key} parent must be an object`);
  const field = (value as Record<string, unknown>)[key];
  assert(field && typeof field === "object" && !Array.isArray(field), `${key} must be an object`);
  return field as Record<string, unknown>;
}

function arrayField(value: unknown, key: string): Array<Record<string, unknown>> {
  assert(value && typeof value === "object" && !Array.isArray(value), `${key} parent must be an object`);
  const field = (value as Record<string, unknown>)[key];
  assert(Array.isArray(field), `${key} must be an array`);
  return field as Array<Record<string, unknown>>;
}

function recordField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
