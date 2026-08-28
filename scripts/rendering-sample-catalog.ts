/**
 * Validates the public rendering-sample catalog and generates its agent reference.
 *
 * This deliberately validates source packages without rendering: render readiness is host-specific,
 * while a public sample must remain structurally valid, capability-matched, fingerprinted, and
 * discoverable in every source checkout. A host proves pixels separately with the emitted receipt.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  MOTION_EXPORT_PRESETS,
  canonicalJsonSha256,
  loadSchema,
  validateAgainstPublishedSchema,
  validateDocument,
  type JsonSchemaDocument
} from "../packages/core/src/index";

const ROOT = resolve(import.meta.dirname, "..");
const CATALOG_PATH = "docs/public/rendering-sample-catalog.json";
const SCHEMA_PATH = "schemas/rendering-sample-catalog.schema.json";
const DOCUMENTATION_PATH = "docs/public/RENDERING_SAMPLES.md";
const ACTIONS_SCHEMA_PATH = "schemas/actions.json";
const DEBUG_SCHEMA_PATH = "schemas/debug.json";
const FAMILY_AUTHORITIES_PATH = "docs/public/rendering-sample-family-authorities.json";
const FAMILY_AUTHORITIES_SCHEMA_PATH = "schemas/rendering-sample-family-authorities.schema.json";
const MOTION_LAYER_TYPES_SOURCE_PATH = "packages/core/src/types.ts";
const SOURCE_PREFIX = ["pnpm", "--filter", "@shellx-motion/cli", "run", "cli", "--"];
const SOURCE_PLACEHOLDER = "{samplePath}";
const INSTALLED_PLACEHOLDER = "{packageRoot}";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Catalog = Record<string, unknown>;
type Capability = Record<string, unknown>;
type Sample = Record<string, unknown>;
interface PublicFamilyAuthorities {
  families: Capability[];
  primaryLayerTypeFamilies: Capability[];
}

export async function validateRenderingSampleCatalog(root = ROOT): Promise<string[]> {
  const errors: string[] = [];
  const catalogPath = resolve(root, CATALOG_PATH);
  const schemaPath = resolve(root, SCHEMA_PATH);
  const catalog = readJson(catalogPath, CATALOG_PATH, errors);
  const schema = readJson(schemaPath, SCHEMA_PATH, errors);
  if (!catalog || !schema) return errors;

  for (const error of validateAgainstPublishedSchema(schema, catalog)) {
    errors.push(`${CATALOG_PATH}${error.path || "/"}: ${error.message}`);
  }
  if (errors.length > 0) return errors;

  const typedCatalog = catalog as Catalog;
  assertCatalogFingerprint(typedCatalog, errors);
  const publicFamilyAuthorities = readPublicFamilyAuthorities(root, errors);
  assertAuthority(typedCatalog, root, errors);
  assertPublicExport(typedCatalog, root, errors);

  const capabilities = readRecordArray(typedCatalog.capabilities, "capabilities", errors);
  const samples = readRecordArray(typedCatalog.samples, "samples", errors);
  const workflowBindings = readRecordArray(typedCatalog.familyWorkflowBindings, "familyWorkflowBindings", errors);
  const agentToolBoundaries = readRecordArray(typedCatalog.agentToolBoundaries, "agentToolBoundaries", errors);
  if (!capabilities || !samples || !workflowBindings || !agentToolBoundaries || !publicFamilyAuthorities) return errors;

  const expected = expectedCapabilities();
  const actualIds = capabilities.map((capability) => String(capability.id));
  const expectedIds = expected.map((capability) => capability.id);
  if (!arraysEqual(actualIds, expectedIds)) {
    errors.push(`capabilities must exactly equal the authoritative published rendering-capability set. Expected ${JSON.stringify(expectedIds)}, got ${JSON.stringify(actualIds)}.`);
  }

  const capabilityById = new Map<string, Capability>();
  for (const capability of capabilities) {
    const id = String(capability.id);
    if (capabilityById.has(id)) errors.push(`capabilities contains duplicate id ${id}.`);
    capabilityById.set(id, capability);
    const authority = expected.find((candidate) => candidate.id === id);
    if (!authority) continue;
    if (capability.surface !== authority.surface) errors.push(`${id}: surface must be ${authority.surface}.`);
    if (!arraysEqual(readStringArray(capability.requiredCompatibilityLanes), authority.requiredCompatibilityLanes)) {
      errors.push(`${id}: requiredCompatibilityLanes must be ${JSON.stringify(authority.requiredCompatibilityLanes)}.`);
    }
  }

  const sampleIds = new Set<string>();
  const samplesByCapability = new Map<string, number>();
  const validatedPackages = new Map<string, Promise<{ lanes: string[]; fingerprint: string }>>();
  for (const sample of samples) {
    const id = String(sample.id);
    if (sampleIds.has(id)) errors.push(`samples contains duplicate id ${id}.`);
    sampleIds.add(id);
    const capabilityId = String(sample.capabilityId);
    if (!isFamilyEvidenceSample(sample)) {
      samplesByCapability.set(capabilityId, (samplesByCapability.get(capabilityId) ?? 0) + 1);
    }
    const capability = capabilityById.get(capabilityId);
    if (!capability) {
      errors.push(`${id}: references unknown capability ${capabilityId}.`);
      continue;
    }
    validateInvocation(id, sample.invocation, errors);
    validateCapabilityInvocation(id, capabilityId, sample.invocation, root, errors);
    validateArtifactAndReceipt(id, capability, sample, errors);
    const source = asRecord(sample.source);
    const path = source?.path;
    if (source?.kind !== "motion-package" || typeof path !== "string") {
      errors.push(`${id}: source must name a motion-package path.`);
      continue;
    }
    if (!isSafeRelativePath(path)) {
      errors.push(`${id}: source path must stay under the published checkout: ${path}.`);
      continue;
    }
    const validation = validatedPackages.get(path) ?? validatePackage(root, path);
    validatedPackages.set(path, validation);
    try {
      const packageFacts = await validation;
      if (source.fingerprint !== packageFacts.fingerprint) {
        errors.push(`${id}: source fingerprint is stale for ${path}; expected ${packageFacts.fingerprint}, got ${String(source.fingerprint)}.`);
      }
      const requiredLanes = readStringArray(capability.requiredCompatibilityLanes);
      for (const lane of requiredLanes) {
        if (!packageFacts.lanes.includes(lane)) errors.push(`${id}: ${path} does not advertise required compatibility lane ${lane}.`);
      }
    } catch (error) {
      errors.push(`${id}: ${(error as Error).message}`);
    }
  }

  for (const capability of capabilities) {
    const id = String(capability.id);
    const count = samplesByCapability.get(id) ?? 0;
    if (count !== 1) errors.push(`${id}: expected exactly one truthful public sample, found ${count}.`);
  }
  assertPublicCapabilityFamilies(typedCatalog, root, samples, workflowBindings, publicFamilyAuthorities, errors);
  assertAgentToolBoundaries(agentToolBoundaries, root, errors);

  const documentationPath = resolve(root, DOCUMENTATION_PATH);
  try {
    const generated = renderRenderingSampleCatalogDoc(typedCatalog);
    if (!existsSync(documentationPath)) {
      errors.push(`${DOCUMENTATION_PATH} is missing; run pnpm docs:rendering-samples.`);
    } else if (readFileSync(documentationPath, "utf8") !== generated) {
      errors.push(`${DOCUMENTATION_PATH} is stale; run pnpm docs:rendering-samples and commit the result.`);
    }
  } catch (error) {
    errors.push(`${DOCUMENTATION_PATH} cannot be generated from this catalog: ${(error as Error).message}`);
  }
  return errors;
}

export function renderRenderingSampleCatalogDoc(catalog: Catalog): string {
  const capabilities = readRecordArray(catalog.capabilities, "capabilities", []) ?? [];
  const samples = readRecordArray(catalog.samples, "samples", []) ?? [];
  const families = readRecordArray(catalog.publicCapabilityFamilies, "publicCapabilityFamilies", []) ?? [];
  const familyBindings = readRecordArray(catalog.familySampleBindings, "familySampleBindings", []) ?? [];
  const workflowBindings = readRecordArray(catalog.familyWorkflowBindings, "familyWorkflowBindings", []) ?? [];
  const agentToolBoundaries = readRecordArray(catalog.agentToolBoundaries, "agentToolBoundaries", []) ?? [];
  const primaryLayerTypeFamilies = readRecordArray(asRecord(catalog.authoritativeCapabilitySet)?.primaryLayerTypeFamilies, "primaryLayerTypeFamilies", []) ?? [];
  const blockers = renderingSampleReleaseBlockers(catalog);
  const samplesByCapability = new Map(samples.filter((sample) => !isFamilyEvidenceSample(sample)).map((sample) => [String(sample.capabilityId), sample]));
  const fingerprint = String(catalog.fingerprint);
  const sections = capabilities.map((capability) => {
    const sample = samplesByCapability.get(String(capability.id));
    if (!sample) throw new Error(`Cannot generate rendering-sample documentation: ${String(capability.id)} has no sample.`);
    const source = asRecord(sample.source)!;
    const artifact = asRecord(sample.expectedArtifact)!;
    const receipt = asRecord(sample.expectedReceipt)!;
    return [
      `### \`${capability.id}\` — ${capability.title}`,
      "",
      "Source checkout:",
      "```bash",
      argvText(readStringArray(asRecord(sample.invocation)?.sourceCheckout), String(source.path), ".scratch/rendering-samples"),
      "```",
      "",
      "Installed package:",
      "```bash",
      argvText(readStringArray(asRecord(sample.invocation)?.installed), "<package-root>", ".scratch/rendering-samples"),
      "```",
      "",
      `Limitation: ${String(sample.limitations)}`,
      ""
    ].join("\n");
  });
  return [
    "# Rendering samples for agents",
    "",
    "This page is generated from [`rendering-sample-catalog.json`](rendering-sample-catalog.json). It is the one public, machine-readable mapping from each published **delivery-output** capability to one canonical checked-in package, with explicitly tagged supplemental samples when a broader family needs additional source evidence; it does not contain rendered media.",
    "",
    `Catalog fingerprint: \`${fingerprint}\`. Validate it and every package with \`pnpm run docs:rendering-samples:check\`.`,
    "",
    "This is a delivery-output catalog foundation. Its delivery set is mechanically derived from the documented preview/final routes and `MOTION_EXPORT_PRESETS`. The primary MotionLayerType map below is a discoverability index only: it maps each public layer type to one relevant rendering family, but does **not** claim every authoring mutation, inspector control, or tool has a sample. Catalog coverage is derived from the checked [public family authority inventory](rendering-sample-family-authorities.json), so an added public authority blocks until it has matching checked package or workflow evidence.",
    "",
    "Run `pnpm run rendering-samples:proof` to execute every registered workflow in fresh proof-owned `.scratch/rendering-samples-proof/run-*` roots. It validates each declared output and succeeded receipt operation; it is the separate runtime source-workflow gate, not installed/native qualification. Catalog coverage being ready below does not claim that a fresh runtime proof has passed.",
    "",
    "`familyWorkflowBindings` is an exclusive runtime plan: it proves only the source, commands, outputs, and receipts named by its own bound rows. Canonical invocations without their own bound workflow are checked structural recipes, not executed runtime proof; they need their own fresh release/native evidence before any delivery, installed, or host-qualification claim.",
    "",
    `## Catalog coverage: ${blockers.length === 0 ? "ready" : "blocked"}`,
    "",
    blockers.length === 0
      ? "Every catalog-authority rendering family has a checked sample or workflow registration. Runtime readiness still requires `pnpm run rendering-samples:proof`."
      : `R5/R6 catalog coverage is deliberately **blocked** by ${blockers.length} public rendering family/families. A passing delivery-subset validation does not make R5/R6 complete. Run \`pnpm run docs:rendering-samples:release-gate\` to fail closed until this table is empty.`,
    "",
    ...unregisteredFamilyDocumentation(families),
    ...agentToolBoundaryDocumentation(agentToolBoundaries),
    ...primaryLayerTypeFamilyDocumentation(families, primaryLayerTypeFamilies),
    ...registeredFamilyDocumentation(families, familyBindings, samples),
    ...registeredWorkflowDocumentation(families, workflowBindings),
    ...registeredInterchangeDocumentation(families, familyBindings),
    ...registeredDirectRendererApiDocumentation(families, familyBindings, samples),
    "",
    "| Capability | Rendering route | Checked-in sample | Expected artifact | Expected receipt |",
    "|---|---|---|---|---|",
    ...capabilities.map((capability) => {
      const sample = samplesByCapability.get(String(capability.id))!;
      const source = asRecord(sample.source)!;
      const artifact = asRecord(sample.expectedArtifact)!;
      const receipt = asRecord(sample.expectedReceipt)!;
      return `| \`${capability.id}\` | ${capability.title} | \`${source.path}\` | \`${artifact.path}\` (${artifact.mediaType}) | \`${receipt.operation}\` / ${receipt.location} |`;
    }),
    "",
    "## Canonical invocations and limits",
    "",
    ...sections
  ].join("\n");
}

function primaryLayerTypeFamilyDocumentation(families: Capability[], mappings: Capability[]): string[] {
  if (mappings.length === 0) return [];
  const familyById = new Map(families.map((family) => [String(family.id), family]));
  return [
    "",
    "## Primary public layer-type discovery map",
    "",
    "Each public `MotionLayerType` has one primary rendering-family pointer. This is not a complete mutation or tool index; use Action/Debug discovery for the exact operation contract.",
    "",
    "| Motion layer type | Primary rendering family |",
    "|---|---|",
    ...mappings.map((mapping) => {
      const familyId = String(mapping.familyId);
      const family = familyById.get(familyId);
      return `| \`${String(mapping.layerType)}\` | \`${familyId}\` — ${String(family?.title ?? "missing")} |`;
    })
  ];
}

function unregisteredFamilyDocumentation(families: Capability[]): string[] {
  const unregistered = families.filter((family) => String(family.registration) === "not-registered");
  if (unregistered.length === 0) return ["Every inventoried public rendering family has a checked registration."];
  return [
    "| Unregistered public family | Public documentation | Machine authority | Why it blocks the release gate |",
    "|---|---|---|---|",
    ...unregistered.map((family) => {
      const documentation = asRecord(family.documentation)!;
      const authority = asRecord(family.machineAuthority)!;
      return `| \`${family.id}\` — ${family.title} | \`${documentation.path}#${documentation.anchor}\` | \`${authority.path}:${authority.id}\` | ${family.limitation} |`;
    })
  ];
}

/** Routes agent-only record/authoring surfaces without silently promoting them to delivery evidence. */
function agentToolBoundaryDocumentation(boundaries: Capability[]): string[] {
  if (boundaries.length === 0) return [];
  return [
    "",
    "## Agent non-delivery tool boundaries",
    "",
    "This is a routing index, not a rendering or delivery catalog. Use the named Debug/MCP command family and source boundary; a refusal is the product boundary, not a fallback prompt.",
    "",
    "| Surface | Debug/MCP route | Source boundary | Refusal boundary |",
    "|---|---|---|---|",
    ...boundaries.map((boundary) => `| ${String(boundary.title)} | ${readStringArray(boundary.debugCommandIds).map((id) => `\`${id}\``).join(", ")} | ${String(boundary.sourceBoundary)} Sources: ${readStringArray(boundary.sourcePaths).map((path) => `\`${path}\``).join(", ")}. | ${String(boundary.refusalBoundary)} |`)
  ];
}

function registeredFamilyDocumentation(families: Capability[], bindings: Capability[], samples: Sample[]): string[] {
  const registered = families.filter((family) => String(family.registration) === "registered");
  if (registered.length === 0) return [];
  const samplesById = new Map(samples.map((sample) => [String(sample.id), sample]));
  const recipesByFamilySample = new Map(bindings.map((binding) => [`${String(binding.familyId)}:${String(binding.sampleId)}`, binding]));
  return [
    "",
    "## Registered public family samples",
    "",
    "| Family | Checked source/render sample | Sample role | Capability-specific recipe evidence | Public limit |",
    "|---|---|---|---|---|",
    ...registered.flatMap((family) => readStringArray(family.sampleIds).map((sampleId) => {
      const sample = samplesById.get(sampleId);
      const source = asRecord(sample?.source);
      const binding = recipesByFamilySample.get(`${String(family.id)}:${sampleId}`);
      const recipe = asRecord(binding?.capabilityRecipe);
      const role = sample && isFamilyEvidenceSample(sample) ? "supplemental family evidence" : "canonical delivery sample";
      return `| \`${family.id}\` | \`${sampleId}\` — \`${String(source?.path ?? "missing")}\` | ${role} | \`${String(recipe?.path ?? "missing")}\` | ${String(family.limitation)} |`;
    }))
  ];
}

function registeredWorkflowDocumentation(families: Capability[], bindings: Capability[]): string[] {
  const familyById = new Map(families.map((family) => [String(family.id), family]));
  if (bindings.length === 0) return [];
  return [
    "",
    "## Registered workflow evidence",
    "",
    "| Family | Checked workflow | Public input or source | Contract evidence | Public limit |",
    "|---|---|---|---|---|",
    ...bindings.map((binding) => {
      const family = familyById.get(String(binding.familyId));
      const kind = String(binding.kind);
      const workflow = kind === "package-script"
        ? `\`pnpm run ${String(binding.packageScript)}\``
        : `\`${readStringArray(binding.sourceCheckout).map(shellToken).join(" ")}\``;
      const source = kind === "package-script"
        ? [String(binding.scriptPath), ...readStringArray(binding.inputPaths)].map((path) => `\`${path}\``).join(", ")
        : `\`${String(asRecord(binding.input)?.path)}\``;
      const contracts = [
        ...readStringArray(binding.commandIds).map((id) => `\`${id}\``),
        ...readStringArray(binding.receiptOperations).map((operation) => `\`${operation}\` receipt`)
      ].join(", ");
      return `| \`${String(binding.familyId)}\` — ${String(family?.title ?? "registered workflow")} | ${workflow} | ${source} | ${contracts} | ${String(binding.limitation)} |`;
    }),
    ""
  ];
}

function registeredInterchangeDocumentation(families: Capability[], bindings: Capability[]): string[] {
  const familyById = new Map(families.map((family) => [String(family.id), family]));
  const interchangeBindings = bindings.filter((binding) => asRecord(binding.interchangeEvidence));
  if (interchangeBindings.length === 0) return [];
  return [
    "",
    "## Registered interchange source invocations",
    "",
    ...interchangeBindings.flatMap((binding) => {
      const evidence = asRecord(binding.interchangeEvidence)!;
      const input = asRecord(evidence.source)!;
      const artifact = asRecord(evidence.expectedArtifact)!;
      const receipts = readRecordArray(evidence.expectedReceipts, "expectedReceipts", []) ?? [];
      const family = familyById.get(String(binding.familyId));
      return [
        `### \`${String(binding.familyId)}\` — ${String(family?.title ?? "registered interchange")}`,
        "",
        `Checked input: \`${String(input.path)}\` (${String(input.mediaType)}). The checked lowered package is the binding sample; the import writes a new package, never into that fixture.`,
        "",
        "Source checkout:",
        "```bash",
        readStringArray(evidence.sourceCheckout).map(shellToken).join(" "),
        "```",
        "",
        "Installed package:",
        "```bash",
        readStringArray(evidence.installed).map(shellToken).join(" "),
        "```",
        "",
        `Expected artifact: \`${String(artifact.path)}\` (${String(artifact.mediaType)}). Expected receipts: ${receipts.map((receipt) => `\`${String(receipt.operation)}\` / ${String(receipt.location)}`).join(", ")}.`,
        "",
        "The explicit local write tier is an authorization requirement, not an installed-build qualification; read the lowering and diagnostics receipts before claiming representation or pixel output.",
        ""
      ];
    })
  ];
}

/** Documents source-only direct APIs separately so a refused CLI route is never advertised. */
function registeredDirectRendererApiDocumentation(families: Capability[], bindings: Capability[], samples: Sample[]): string[] {
  const familyById = new Map(families.map((family) => [String(family.id), family]));
  const sampleById = new Map(samples.map((sample) => [String(sample.id), sample]));
  const directBindings = bindings.filter((binding) => isRendererBrowserDirectApiInvocation(sampleById.get(String(binding.sampleId))?.invocation));
  if (directBindings.length === 0) return [];
  return [
    "",
    "## Registered direct renderer source invocations",
    "",
    ...directBindings.flatMap((binding) => {
      const family = familyById.get(String(binding.familyId));
      const sample = sampleById.get(String(binding.sampleId));
      const source = asRecord(sample?.source)!;
      const invocation = asRecord(sample?.invocation)!;
      const loader = asRecord(invocation.packageLoader)!;
      const renderer = asRecord(invocation.renderer)!;
      const artifact = asRecord(sample?.expectedArtifact)!;
      const receipt = asRecord(sample?.expectedReceipt)!;
      const sourcePaths = readStringArray(invocation.sourcePaths);
      return [
        `### \`${String(binding.familyId)}\` — ${String(family?.title ?? "direct renderer source route")}`,
        "",
        `Checked package: \`${String(source.path)}\`. This is a source-only package API route: there is no CLI, Debug/Action preview, or installed-command equivalent for this document shape.`,
        "",
        "Source API shape (not a shell command):",
        "```ts",
        `import { ${String(loader.export)} } from "${String(loader.module)}";`,
        `import { ${String(renderer.export)} } from "${String(renderer.module)}";`,
        "",
        `const pkg = await ${String(loader.export)}("${String(source.path)}");`,
        `const result = await ${String(renderer.export)}(pkg, { atMs: ${String(invocation.atMs)}, outDir: "${String(invocation.outDir)}" });`,
        "if (!result.ok) throw new Error(result.error.message);",
        "```",
        "",
        `Checked source route: ${sourcePaths.map((path) => `\`${path}\``).join(", ")}.`,
        "",
        `Expected artifact: \`${String(artifact.path)}\` (${String(artifact.mediaType)}). Expected receipt: \`${String(receipt.operation)}\` / ${String(receipt.location)} with \`output.gpuScene3dAnimation.schema = shellx-motion/gpu-scene3d-animation-preview-receipt@1\`.`,
        "",
        `Limitation: ${String(sample?.limitations)}`,
        ""
      ];
    })
  ];
}

function isFamilyEvidenceSample(sample: Sample): boolean {
  return sample.sampleRole === "family-evidence";
}

function expectedCapabilities(): Array<{ id: string; surface: string; requiredCompatibilityLanes: string[] }> {
  return [
    ...["native", "browser", "gpu"].map((lane) => ({ id: `preview.${lane}-png@1`, surface: "preview", requiredCompatibilityLanes: [lane] })),
    { id: "render.native-png-still@1", surface: "render", requiredCompatibilityLanes: ["native"] },
    { id: "render.native-mp4-h264@1", surface: "render", requiredCompatibilityLanes: ["native"] },
    ...MOTION_EXPORT_PRESETS.map((preset) => ({ id: `render.browser-${preset}@1`, surface: "render", requiredCompatibilityLanes: ["browser"] })),
    { id: "render.gpu-mp4-h264@1", surface: "render", requiredCompatibilityLanes: ["gpu"] },
    { id: "render-batch.mixed-preset@1", surface: "render-batch", requiredCompatibilityLanes: ["browser"] }
  ];
}

function assertAuthority(catalog: Catalog, root: string, errors: string[]): void {
  const authority = asRecord(catalog.authoritativeCapabilitySet);
  const sources = readStringArray(authority?.sources);
  const expectedSources = [
    "docs/public/rendering.md",
    "packages/core/src/export-presets.ts",
    MOTION_LAYER_TYPES_SOURCE_PATH,
    FAMILY_AUTHORITIES_PATH,
    FAMILY_AUTHORITIES_SCHEMA_PATH
  ];
  if (!arraysEqual(sources, expectedSources)) errors.push(`authoritativeCapabilitySet.sources must be ${JSON.stringify(expectedSources)}.`);
  for (const path of sources) {
    if (!existsSync(resolve(root, path))) errors.push(`authoritative capability source is missing: ${path}.`);
  }
}

function readPublicFamilyAuthorities(root: string, errors: string[]): PublicFamilyAuthorities | undefined {
  const authorityPath = resolve(root, FAMILY_AUTHORITIES_PATH);
  const authoritySchemaPath = resolve(root, FAMILY_AUTHORITIES_SCHEMA_PATH);
  const authority = readJson(authorityPath, FAMILY_AUTHORITIES_PATH, errors);
  const authoritySchema = readJson(authoritySchemaPath, FAMILY_AUTHORITIES_SCHEMA_PATH, errors);
  if (!authority || !authoritySchema) return undefined;
  for (const error of validateAgainstPublishedSchema(authoritySchema, authority)) {
    errors.push(`${FAMILY_AUTHORITIES_PATH}${error.path || "/"}: ${error.message}`);
  }
  const families = readRecordArray(asRecord(authority)?.families, "public rendering-family authorities", errors);
  const primaryLayerTypeFamilies = readRecordArray(asRecord(authority)?.primaryLayerTypeFamilies, "public primary layer-type families", errors);
  if (!families || !primaryLayerTypeFamilies) return undefined;
  const seen = new Set<string>();
  for (const family of families) {
    const id = String(family.id);
    if (seen.has(id)) errors.push(`${FAMILY_AUTHORITIES_PATH} contains duplicate id ${id}.`);
    seen.add(id);
  }
  return { families, primaryLayerTypeFamilies };
}

/**
 * The public layer-type union is type-only, so read its source declaration
 * directly instead of creating a second runtime list that could drift.
 */
function readPublicMotionLayerTypes(root: string, errors: string[]): string[] | undefined {
  const path = resolve(root, MOTION_LAYER_TYPES_SOURCE_PATH);
  try {
    const source = readFileSync(path, "utf8");
    const declaration = /export\s+type\s+MotionLayerType\s*=\s*((?:\s*\|\s*"[^"\\]+"\s*)+);/.exec(source);
    if (!declaration) throw new Error("cannot find the exported literal union");
    const layerTypes = [...declaration[1]!.matchAll(/"([^"\\]+)"/g)].map((match) => match[1]!);
    if (layerTypes.length === 0 || new Set(layerTypes).size !== layerTypes.length) throw new Error("must contain one or more unique literal members");
    return layerTypes;
  } catch (error) {
    errors.push(`${MOTION_LAYER_TYPES_SOURCE_PATH} cannot provide the public MotionLayerType union: ${(error as Error).message}`);
    return undefined;
  }
}

function assertPrimaryLayerTypeFamilyCoverage(
  catalog: Catalog,
  root: string,
  authorityMappings: Capability[],
  catalogFamilies: Capability[],
  errors: string[]
): void {
  const layerTypes = readPublicMotionLayerTypes(root, errors);
  if (!layerTypes) return;
  const authorityKeys = primaryLayerTypeFamilyKeys(authorityMappings);
  const authorityTypes = authorityMappings.map((mapping) => String(mapping.layerType));
  if (!arraysEqual(authorityTypes, layerTypes)) {
    errors.push(`${FAMILY_AUTHORITIES_PATH}.primaryLayerTypeFamilies must exactly map the public MotionLayerType union in declaration order. Expected ${JSON.stringify(layerTypes)}, got ${JSON.stringify(authorityTypes)}.`);
  }
  if (new Set(authorityKeys).size !== authorityKeys.length) {
    errors.push(`${FAMILY_AUTHORITIES_PATH}.primaryLayerTypeFamilies contains duplicate layerType/familyId mappings.`);
  }
  const familyIds = new Set(catalogFamilies.map((family) => String(family.id)));
  for (const mapping of authorityMappings) {
    const layerType = String(mapping.layerType);
    const familyId = String(mapping.familyId);
    if (!familyIds.has(familyId)) errors.push(`${FAMILY_AUTHORITIES_PATH}.primaryLayerTypeFamilies maps ${layerType} to unknown registered family ${familyId}.`);
  }
  const catalogAuthority = asRecord(catalog.authoritativeCapabilitySet);
  const catalogMappings = readRecordArray(catalogAuthority?.primaryLayerTypeFamilies, "authoritativeCapabilitySet.primaryLayerTypeFamilies", errors);
  if (!catalogMappings) return;
  if (!arraysEqual(primaryLayerTypeFamilyKeys(catalogMappings), authorityKeys)) {
    errors.push(`authoritativeCapabilitySet.primaryLayerTypeFamilies must exactly match ${FAMILY_AUTHORITIES_PATH}.primaryLayerTypeFamilies so agent discovery cannot drift from the public authority.`);
  }
}

function primaryLayerTypeFamilyKeys(mappings: Capability[]): string[] {
  return mappings.map((mapping) => `${String(mapping.layerType)}:${String(mapping.familyId)}`);
}

/** Returns the deliberate blockers for R5/R6 rendering-family catalog coverage. */
export function renderingSampleReleaseBlockers(catalog: Catalog): string[] {
  const families = readRecordArray(catalog.publicCapabilityFamilies, "publicCapabilityFamilies", []) ?? [];
  return families
    .filter((family) => family.registration === "not-registered")
    .map((family) => String(family.id));
}

function assertPublicCapabilityFamilies(
  catalog: Catalog,
  root: string,
  samples: Sample[],
  workflowBindings: Capability[],
  publicFamilyAuthorities: PublicFamilyAuthorities,
  errors: string[]
): void {
  const families = readRecordArray(catalog.publicCapabilityFamilies, "publicCapabilityFamilies", errors);
  const bindings = readRecordArray(catalog.familySampleBindings, "familySampleBindings", errors);
  if (!families || !bindings) return;
  const expectedIds = publicFamilyAuthorities.families.map((family) => String(family.id));
  const actualIds = families.map((family) => String(family.id));
  if (!arraysEqual(actualIds, expectedIds)) {
    errors.push(`publicCapabilityFamilies must exactly equal the checked public rendering-family authority inventory. Expected ${JSON.stringify(expectedIds)}, got ${JSON.stringify(actualIds)}.`);
  }

  const actions = readJson(resolve(root, ACTIONS_SCHEMA_PATH), ACTIONS_SCHEMA_PATH, errors) as Catalog | undefined;
  const debug = readJson(resolve(root, DEBUG_SCHEMA_PATH), DEBUG_SCHEMA_PATH, errors) as Catalog | undefined;
  const actionIds = new Set((readRecordArray(actions?.actions, "actions", errors) ?? []).map((action) => String(action.id)));
  const debugCommands = new Set(readStringArray(debug?.commands));
  const familiesById = new Map(families.map((family) => [String(family.id), family]));
  const samplesById = new Map(samples.map((sample) => [String(sample.id), sample]));
  const authoritiesById = new Map(publicFamilyAuthorities.families.map((family) => [String(family.id), family]));
  assertPrimaryLayerTypeFamilyCoverage(catalog, root, publicFamilyAuthorities.primaryLayerTypeFamilies, families, errors);
  const boundSampleIds = new Map<string, string[]>();
  const bindingsByFamily = new Map<string, Capability[]>();
  const workflowsByFamily = new Map<string, Capability[]>();
  const boundFamilyEvidenceSampleIds = new Set<string>();
  const seenBindings = new Set<string>();
  for (const binding of bindings) {
    const familyId = String(binding.familyId);
    const sampleId = String(binding.sampleId);
    const bindingId = `${familyId}:${sampleId}`;
    if (seenBindings.has(bindingId)) errors.push(`familySampleBindings contains duplicate binding ${bindingId}.`);
    seenBindings.add(bindingId);
    const family = familiesById.get(familyId);
    if (!family) {
      errors.push(`familySampleBinding ${bindingId} references unknown public capability family.`);
      continue;
    }
    const sample = samplesById.get(sampleId);
    if (!sample) {
      errors.push(`familySampleBinding ${bindingId} references unknown checked delivery sample.`);
      continue;
    }
    const ids = boundSampleIds.get(familyId) ?? [];
    ids.push(sampleId);
    boundSampleIds.set(familyId, ids);
    const familyBindings = bindingsByFamily.get(familyId) ?? [];
    familyBindings.push(binding);
    bindingsByFamily.set(familyId, familyBindings);
    if (isFamilyEvidenceSample(sample)) boundFamilyEvidenceSampleIds.add(sampleId);
    validateCapabilityRecipe(bindingId, binding.capabilityRecipe, sample, root, errors);
  }

  const packageJson = readJson(resolve(root, "package.json"), "package.json", errors) as Catalog | undefined;
  for (const binding of workflowBindings) {
    const familyId = String(binding.familyId);
    const family = familiesById.get(familyId);
    if (!family) {
      errors.push(`familyWorkflowBinding ${familyId}:${String(binding.title)} references unknown public capability family.`);
      continue;
    }
    const familyWorkflows = workflowsByFamily.get(familyId) ?? [];
    familyWorkflows.push(binding);
    workflowsByFamily.set(familyId, familyWorkflows);
    validateFamilyWorkflowBinding(binding, root, packageJson, debug, errors);
  }

  for (const sample of samples) {
    const id = String(sample.id);
    if (isFamilyEvidenceSample(sample) && !boundFamilyEvidenceSampleIds.has(id)) {
      errors.push(`${id}: family-evidence samples must be bound to a registered public capability family.`);
    }
  }

  for (const family of families) {
    const id = String(family.id);
    const expected = authoritiesById.get(id);
    if (!expected) continue;
    const title = expected.title;
    const expectedDocumentation = asRecord(expected.documentation);
    const documentationPath = expectedDocumentation?.path;
    const documentationAnchor = expectedDocumentation?.anchor;
    const expectedAuthority = asRecord(expected.machineAuthority);
    const authorityPath = expectedAuthority?.path;
    const authorityKind = expectedAuthority?.kind;
    const authorityId = expectedAuthority?.id;
    if (family.title !== title) errors.push(`${id}: title must be ${JSON.stringify(title)}.`);
    const documentation = asRecord(family.documentation);
    if (documentation?.path !== documentationPath || documentation.anchor !== documentationAnchor) {
      errors.push(`${id}: documentation must be ${documentationPath}#${documentationAnchor}.`);
    } else {
      const path = resolve(root, documentationPath);
      if (!existsSync(path)) errors.push(`${id}: public documentation source is missing: ${documentationPath}.`);
      else if (!markdownContainsAnchor(readFileSync(path, "utf8"), documentationAnchor)) errors.push(`${id}: public documentation source has no #${documentationAnchor} heading: ${documentationPath}.`);
    }
    const authority = asRecord(family.machineAuthority);
    if (authority?.path !== authorityPath || authority.kind !== authorityKind || authority.id !== authorityId) {
      errors.push(`${id}: machineAuthority must be ${authorityPath}:${authorityKind}:${authorityId}.`);
    } else if (authorityPath === ACTIONS_SCHEMA_PATH && !actionIds.has(authorityId)) {
      errors.push(`${id}: machine authority action is absent from ${ACTIONS_SCHEMA_PATH}: ${authorityId}.`);
    } else if (authorityPath === DEBUG_SCHEMA_PATH && !debugCommands.has(authorityId)) {
      errors.push(`${id}: machine authority debug command is absent from ${DEBUG_SCHEMA_PATH}: ${authorityId}.`);
    }
    const sampleIds = readStringArray(family.sampleIds);
    const bindingIds = boundSampleIds.get(id) ?? [];
    const familyWorkflows = workflowsByFamily.get(id) ?? [];
    if (family.registration === "registered") {
      if (sampleIds.length === 0 && familyWorkflows.length === 0) errors.push(`${id}: registered family must name at least one checked sample id or checked workflow binding.`);
      for (const sampleId of sampleIds) {
        if (!samplesById.has(sampleId)) errors.push(`${id}: registered sampleIds references unknown checked delivery sample ${sampleId}.`);
      }
      if (!arraysEqual(sampleIds, bindingIds)) {
        errors.push(`${id}: registered sampleIds must exactly match familySampleBindings so the checked sample's source, invocation, artifact, and receipt authority is reused.`);
      }
      assertRegisteredFamilyEvidence(id, bindingsByFamily.get(id) ?? [], samplesById, root, debug, errors);
    } else {
      if (sampleIds.length !== 0) errors.push(`${id}: not-registered family must not name sampleIds.`);
      if (bindingIds.length !== 0) errors.push(`${id}: not-registered family must not have a familySampleBinding.`);
      if (familyWorkflows.length !== 0) errors.push(`${id}: not-registered family must not have a familyWorkflowBinding.`);
    }
  }

  const blockers = renderingSampleReleaseBlockers(catalog);
  const releaseGate = asRecord(catalog.releaseGate);
  const expectedGateState = blockers.length === 0 ? "ready" : "blocked";
  if (releaseGate?.state !== expectedGateState) errors.push(`releaseGate.state must be ${expectedGateState} for the computed unregistered public family set.`);
  if (!arraysEqual(readStringArray(releaseGate?.blockers), blockers)) {
    errors.push(`releaseGate.blockers must exactly equal the unregistered public family ids: ${JSON.stringify(blockers)}.`);
  }
}

/**
 * Keep the non-delivery routing index finite and tied to public contracts.
 * This table is deliberately separate from family/sample coverage: none of
 * these entries can be read as a rendering or delivery qualification.
 */
function assertAgentToolBoundaries(boundaries: Capability[], root: string, errors: string[]): void {
  const expectedIds = [
    "checkpoint-storyboard",
    "layout-gap-animation",
    "procedural-bindings",
    "scene3d-animation",
    "particle-field-v1",
    "particle-field-v2-compute"
  ];
  const actualIds = boundaries.map((boundary) => String(boundary.id));
  if (!arraysEqual(actualIds, expectedIds)) {
    errors.push(`agentToolBoundaries must exactly route ${JSON.stringify(expectedIds)}, got ${JSON.stringify(actualIds)}.`);
  }
  const debug = readJson(resolve(root, DEBUG_SCHEMA_PATH), DEBUG_SCHEMA_PATH, errors) as Catalog | undefined;
  const knownCommands = new Set(readStringArray(debug?.commands));
  const seen = new Set<string>();
  for (const boundary of boundaries) {
    const id = String(boundary.id);
    if (seen.has(id)) errors.push(`agentToolBoundaries contains duplicate id ${id}.`);
    seen.add(id);
    for (const commandId of readStringArray(boundary.debugCommandIds)) {
      if (!knownCommands.has(commandId)) errors.push(`agentToolBoundary ${id} references absent public Debug/MCP command ${commandId}.`);
    }
    const sourcePaths = readStringArray(boundary.sourcePaths);
    for (const sourcePath of sourcePaths) {
      try {
        const facts = lstatSync(resolve(root, sourcePath));
        if (!isSafeRelativePath(sourcePath) || !facts.isFile() || facts.isSymbolicLink()) throw new Error("not a regular public source file");
      } catch (error) {
        errors.push(`agentToolBoundary ${id} source path is missing or unsafe: ${sourcePath} (${(error as Error).message}).`);
      }
    }
    const roots = [...new Set(sourcePaths.map((sourcePath) => sourcePath.split("/")[0]!).filter(Boolean))];
    assertPositivePublicExportPaths(root, roots, `agentToolBoundary ${id} source`, errors);
  }
}

/**
 * Some public families describe a combination that cannot truthfully be inferred
 * from a sample id or delivery lane. Keep the narrow structural requirements
 * here so registrations remain fail-closed even when their evidence is split
 * between complementary checked packages.
 */
function assertRegisteredFamilyEvidence(
  familyId: string,
  bindings: Capability[],
  samplesById: Map<string, Sample>,
  root: string,
  debug: Catalog | undefined,
  errors: string[]
): void {
  if (familyId === "family.html-css-and-canvas@1") {
    const hasContainedWebSource = bindings.some((binding) => hasRecipeExpectedValues(binding, [
      ["/layers/0/id", "html-composition"],
      ["/layers/0/type", "web"],
      ["/layers/0/source", "index.html"],
      ["/layers/0/allowedOrigins", []]
    ]));
    if (!hasContainedWebSource) {
      errors.push(`${familyId}: registered binding must pin one contained package-local web layer with its HTML source and empty allowed-origins list; this source evidence does not qualify html-snippet import or canvas execution.`);
    }
    return;
  }

  if (familyId === "family.transition-presets@1") {
    const hasSerializedTransitions = bindings.some((binding) => hasRecipeExpectedValues(binding, [
      ["/layers/0/id", "title"],
      ["/layers/0/transitions/in/type", "slide"],
      ["/layers/0/transitions/in/direction", "left"],
      ["/layers/0/transitions/in/distance", 80],
      ["/layers/0/transitions/in/durationMs", 500],
      ["/layers/2/id", "accent"],
      ["/layers/2/transitions/in/type", "wipe"],
      ["/layers/2/transitions/in/durationMs", 350]
    ]));
    if (!hasSerializedTransitions) {
      errors.push(`${familyId}: registered binding must pin the checked title slide and accent wipe transition records; this source evidence does not qualify a preset-apply revision or receipt.`);
    }
    return;
  }

  if (familyId === "family.lottie-and-dotlottie@1") {
    assertLottieAndDotLottieEvidence(bindings, samplesById, root, debug, errors);
    return;
  }
  if (familyId === "family.path-reveals@1") {
    if (!bindings.some(hasCheckedPathRevealEvidence)) {
      errors.push(`${familyId}: registered bindings must prove one browser-compatible shape path/freeform with a visible positive stroke, rich-set-owned finite pathReveal start/end values, and an animated end track from 0 to 1.`);
    }
    return;
  }
  if (familyId === "family.analytic-particle-field-compute@2") {
    const sampleId = "sample.tidal-reassembly.v2-particle-compute.gpu-preview@1";
    const sample = samplesById.get(sampleId);
    const source = asRecord(sample?.source);
    const manifest = source?.path
      ? readFamilyJson(resolve(root, String(source.path), "manifest.json"), `${sampleId} manifest`, errors)
      : undefined;
    const hasTidalV2Recipe = bindings.length === 1
      && bindings[0]?.sampleId === sampleId
      && hasRecipeExpectedValues(bindings[0]!, [
        ["/layers/2/id", "tide-field"],
        ["/layers/2/type", "particles"],
        ["/layers/2/emitter/count", 100000],
        ["/layers/2/emitter/shape", "circle"],
        ["/layers/2/emitter/field/schema", "shellx-motion/particle-field@2"],
        ["/layers/2/emitter/field/sources/0/kind", "flow"],
        ["/layers/2/emitter/field/sources/1/kind", "turbulence"],
        ["/layers/2/emitter/field/sources/2/kind", "collision"],
        ["/layers/2/emitter/field/sources/3/kind", "impact"],
        ["/layers/2/emitter/origins/0/weight", 0.36],
        ["/layers/2/emitter/origins/1/weight", 0.36],
        ["/layers/2/emitter/origins/2/weight", 0.28],
        ["/layers/2/emitter/trail/samples", 2],
        ["/layers/2/emitter/shading/mode", "glow"]
      ]);
    const manifestRecord = asRecord(manifest);
    const hasStrictGpuDataOnlyManifest = arraysEqual(readStringArray(asRecord(manifestRecord?.compatibility)?.lanes), ["gpu", "ffmpeg"])
      && manifestRecord?.workflow === "v020-particle-field-v2-sample"
      && asRecord(manifestRecord?.metadata)?.particleCount === 100000
      && asRecord(manifestRecord?.metadata)?.sourceAssetPolicy === "typed-data-only-no-external-assets";
    if (!sample || source?.path !== "fixtures/packages/gpu-v020-tidal-reassembly" || !hasTidalV2Recipe || !hasStrictGpuDataOnlyManifest) {
      errors.push(`${familyId}: registration requires the checked gpu-v020-tidal-reassembly fixture, exact particle-field@2/100000/origin/source/trail/shading evidence, and its strict GPU data-only manifest. It is bounded analytic compute, not game physics, arbitrary compute, retained physics, or host qualification.`);
    }
    return;
  }
  if (familyId === "family.scene3d-animation-gpu-preview@1") {
    const sampleId = "sample.scene3d-animation.direct-gpu-preview@1";
    const sample = samplesById.get(sampleId);
    const source = asRecord(sample?.source);
    const invocation = asRecord(sample?.invocation);
    const manifest = source?.path
      ? readFamilyJson(resolve(root, String(source.path), "manifest.json"), `${sampleId} manifest`, errors)
      : undefined;
    const hasPersistedAnimationRecipe = bindings.length === 1
      && bindings[0]?.sampleId === sampleId
      && hasRecipeExpectedValues(bindings[0]!, [
        ["/schema", "shellx-motion/motion@1"],
        ["/layers/0/id", "world"],
        ["/layers/0/type", "scene3d"],
        ["/layers/0/scene3d/schema", "shellx-motion/scene3d@1"],
        ["/scene3dAnimation/schema", "shellx-motion/scene3d-animation@1"],
        ["/scene3dAnimation/tracks/0/locator/layerId", "world"],
        ["/scene3dAnimation/tracks/0/locator/scope", "background"],
        ["/scene3dAnimation/tracks/0/keyframes/0/atUs", 0],
        ["/scene3dAnimation/tracks/1/locator/scope", "lighting"],
        ["/scene3dAnimation/tracks/1/locator/property", "intensity"],
        ["/scene3dAnimation/tracks/1/keyframes/0/atUs", 500000],
        ["/scene3dAnimation/tracks/1/keyframes/0/value", 1.5]
      ]);
    const manifestRecord = asRecord(manifest);
    const hasAssetFreeGpuPackage = arraysEqual(readStringArray(manifestRecord?.assets), [])
      && arraysEqual(readStringArray(asRecord(manifestRecord?.compatibility)?.lanes), ["gpu"]);
    if (!sample || source?.path !== "fixtures/packages/gpu-scene3d-animation-preview"
      || !isRendererBrowserDirectApiInvocation(invocation) || !hasPersistedAnimationRecipe || !hasAssetFreeGpuPackage) {
      errors.push(`${familyId}: registration requires the checked asset-free gpu-scene3d-animation-preview package, exact persisted scene3dAnimation@1 track evidence, and the direct renderer-browser GPU PNG API; it does not qualify general glTF animation, browser/native parity, final media, or an installed/public host.`);
    }
    return;
  }
  if (familyId === "family.environments-and-depth@1") {
    const hasEnvironmentEffect = bindings.some((binding) => {
      const expectedValues = readRecordArray(asRecord(binding.capabilityRecipe)?.expectedJsonValues, "expectedJsonValues", []);
      if (!expectedValues) return false;
      const environmentLayers = new Set(expectedValues.flatMap((evidence) => {
        const match = /^\/layers\/([0-9]+)\/type$/.exec(String(evidence.pointer));
        return match && evidence.value === "environment" ? [match[1]!] : [];
      }));
      return [...environmentLayers].some((layer) =>
        expectedValues.some((evidence) => evidence.pointer === `/layers/${layer}/environment/schema` && evidence.value === "shellx-motion/environment@1")
        && expectedValues.some((evidence) => evidence.pointer === `/layers/${layer}/environment/kind` && typeof evidence.value === "string" && evidence.value.length > 0)
        && expectedValues.some((evidence) => typeof evidence.pointer === "string" && evidence.pointer.startsWith(`/layers/${layer}/effects/`))
      );
    });
    const hasCameraBackedDepthComposition = bindings.some((binding) => {
      const expectedValues = readRecordArray(asRecord(binding.capabilityRecipe)?.expectedJsonValues, "expectedJsonValues", []);
      if (!expectedValues) return false;
      const hasCamera = expectedValues.some((evidence) => /^\/layers\/[0-9]+\/type$/.test(String(evidence.pointer)) && evidence.value === "camera");
      const depthLayers = new Set(expectedValues.flatMap((evidence) => {
        const match = /^\/layers\/([0-9]+)\/depth$/.exec(String(evidence.pointer));
        return match && typeof evidence.value === "number" && Number.isFinite(evidence.value) ? [match[1]!] : [];
      }));
      return hasCamera && depthLayers.size >= 2;
    });
    if (!hasEnvironmentEffect || !hasCameraBackedDepthComposition) {
      errors.push(`${familyId}: registered bindings must jointly prove an environment layer with an exact environment record and effect, plus one checked sample with a camera and exact depth values on at least two layers.`);
    }
    return;
  }

  if (familyId === "family.compositing-graphs@1") {
    const hasTypedGraph = bindings.some((binding) => hasRecipeExpectedValues(binding, [
      ["/compositing/schema", "shellx-motion/compositing-graph@1"],
      ["/compositing/nodes/0/type", "source"],
      ["/compositing/nodes/6/type", "matte"],
      ["/compositing/nodes/7/type", "blend"],
      ["/compositing/nodes/8/type", "output"],
      ["/compositing/edges/0/from/nodeId", "content"],
      ["/compositing/edges/0/to/nodeId", "move"],
      ["/compositing/edges/4/from/nodeId", "matte-source"],
      ["/compositing/edges/4/to/nodeId", "matte"],
      ["/compositing/edges/4/to/port", "matte"],
      ["/compositing/edges/5/to/nodeId", "blend"],
      ["/compositing/edges/5/to/port", "background"],
      ["/compositing/edges/6/to/port", "foreground"],
      ["/compositing/edges/7/to/nodeId", "output"]
    ]));
    const hasDirectParitySource = bindings.some((binding) => hasRecipeExpectedValues(binding, [
      ["/layers/2/type", "shape"],
      ["/layers/2/matte/type", "alpha"],
      ["/layers/2/matte/sourceLayerId", "direct-matte"],
      ["/layers/2/blendMode", "screen"],
      ["/layers/2/effects/blur", 3]
    ]));
    if (!hasTypedGraph || !hasDirectParitySource) {
      errors.push(`${familyId}: registered bindings must jointly pin the data-only compositing graph's source/matte/blend/output topology and its checked direct alpha-matte/screen/blur parity source.`);
    }
    return;
  }

}

function hasRecipeExpectedValues(binding: Capability, expected: ReadonlyArray<readonly [string, Json]>): boolean {
  const values = readRecordArray(asRecord(binding.capabilityRecipe)?.expectedJsonValues, "expectedJsonValues", []);
  if (!values) return false;
  return expected.every(([pointer, value]) => values.some((evidence) =>
    evidence.pointer === pointer
    && Object.prototype.hasOwnProperty.call(evidence, "value")
    && canonicalJsonSha256(evidence.value as Json) === canonicalJsonSha256(value)
  ));
}

function hasCheckedPathRevealEvidence(binding: Capability): boolean {
  const expectedValues = readRecordArray(asRecord(binding.capabilityRecipe)?.expectedJsonValues, "expectedJsonValues", []) ?? [];
  const layerIds = new Set(expectedValues.flatMap((evidence) => {
    const match = /^\/layers\/([0-9]+)\/pathReveal\/start$/.exec(String(evidence.pointer));
    return match ? [match[1]!] : [];
  }));
  return [...layerIds].some((layerId) => {
    const start = expectedValue(expectedValues, `/layers/${layerId}/pathReveal/start`);
    const end = expectedValue(expectedValues, `/layers/${layerId}/pathReveal/end`);
    const endTrackValues = expectedValues
      .filter((evidence) => new RegExp(`^/layers/${layerId}/keyframes/pathReveal\\.end/[0-9]+/value$`).test(String(evidence.pointer)))
      .map((evidence) => evidence.value);
    return expectedValue(expectedValues, `/layers/${layerId}/type`) === "shape"
      && ["path", "freeform"].includes(String(expectedValue(expectedValues, `/layers/${layerId}/shape`)))
      && hasNonEmptyString(expectedValue(expectedValues, `/layers/${layerId}/x-path`))
      && hasNonEmptyString(expectedValue(expectedValues, `/layers/${layerId}/x-path-viewBox`))
      && hasVisibleStroke(expectedValue(expectedValues, `/layers/${layerId}/style/stroke`))
      && isPositiveFiniteNumber(expectedValue(expectedValues, `/layers/${layerId}/style/strokeWidth`))
      && isUnitIntervalNumber(start)
      && isUnitIntervalNumber(end)
      && endTrackValues.includes(0)
      && endTrackValues.includes(1);
  });
}

function expectedValue(values: Capability[], pointer: string): unknown {
  return values.find((value) => value.pointer === pointer)?.value;
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasVisibleStroke(value: unknown): value is string {
  return hasNonEmptyString(value) && value.trim().toLowerCase() !== "transparent";
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isUnitIntervalNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function assertLottieAndDotLottieEvidence(
  bindings: Capability[],
  samplesById: Map<string, Sample>,
  root: string,
  debug: Catalog | undefined,
  errors: string[]
): void {
  const familyId = "family.lottie-and-dotlottie@1";
  const expected = [
    {
      sampleId: "sample.lottie-primitives-lowered.browser-preview@1",
      sourceApp: "lottie",
      command: "lottie-import",
      inputPath: "fixtures/imports/lottie-primitives/input.json",
      inputMediaType: "application/json",
      outputPath: ".scratch/rendering-samples/lottie-primitives-import",
      packageSource: "source/input.lottie.json"
    },
    {
      sampleId: "sample.dotlottie-primitives-lowered.browser-preview@1",
      sourceApp: "dotlottie",
      command: "dotlottie-import",
      inputPath: "fixtures/imports/dotlottie-primitives/input.lottie",
      inputMediaType: "application/vnd.lottie",
      outputPath: ".scratch/rendering-samples/dotlottie-primitives-import",
      packageSource: "source/input.lottie"
    }
  ] as const;
  if (bindings.length !== expected.length) {
    errors.push(`${familyId}: registration requires exactly one checked Lottie package and one checked dotLottie package.`);
  }

  for (const requirement of expected) {
    const binding = bindings.find((candidate) => candidate.sampleId === requirement.sampleId);
    const sample = samplesById.get(requirement.sampleId);
    if (!binding || !sample) {
      errors.push(`${familyId}: missing required checked import evidence ${requirement.sampleId}.`);
      continue;
    }
    const source = asRecord(sample.source);
    const packagePath = typeof source?.path === "string" ? source.path : "";
    const manifest = readFamilyJson(resolve(root, packagePath, "manifest.json"), `${requirement.sampleId} manifest`, errors);
    const motion = readFamilyJson(resolve(root, packagePath, "motion.json"), `${requirement.sampleId} motion`, errors);
    const lower = readFamilyJson(resolve(root, packagePath, "receipts/adapter-lowering.receipt.json"), `${requirement.sampleId} lowering receipt`, errors);
    const diagnostics = readFamilyJson(resolve(root, packagePath, "receipts/adapter-diagnostics.receipt.json"), `${requirement.sampleId} diagnostics receipt`, errors);
    assertJsonValue(`${requirement.sampleId} manifest`, manifest, "/sourceApp", requirement.sourceApp, errors);
    assertJsonValue(`${requirement.sampleId} motion`, motion, "/provenance/sourceApp", requirement.sourceApp, errors);
    assertJsonValue(`${requirement.sampleId} manifest`, manifest, "/data/adapter/id", "adapter.lottie", errors);
    assertJsonValue(`${requirement.sampleId} manifest`, manifest, "/data/adapter/source", requirement.packageSource, errors);
    assertJsonValue(`${requirement.sampleId} manifest`, manifest, "/data/adapter/loweringReceipt", "receipts/adapter-lowering.receipt.json", errors);
    assertJsonValue(`${requirement.sampleId} manifest`, manifest, "/data/adapter/diagnosticsReceipt", "receipts/adapter-diagnostics.receipt.json", errors);
    assertJsonValue(`${requirement.sampleId} lowering receipt`, lower, "/schema", "shellx-motion/receipt@1", errors);
    assertJsonValue(`${requirement.sampleId} lowering receipt`, lower, "/operation", "adapter.lower", errors);
    assertJsonValue(`${requirement.sampleId} diagnostics receipt`, diagnostics, "/schema", "shellx-motion/receipt@1", errors);
    assertJsonValue(`${requirement.sampleId} diagnostics receipt`, diagnostics, "/operation", "adapter.diagnostics", errors);

    const evidence = asRecord(binding.interchangeEvidence);
    if (!evidence) {
      errors.push(`${familyId}: ${requirement.sampleId} must name checked import-output evidence.`);
      continue;
    }
    const input = asRecord(evidence.source);
    const inputPath = typeof input?.path === "string" ? input.path : "";
    const inputHash = typeof input?.sha256 === "string" ? input.sha256 : "";
    if (evidence.kind !== "import-output-evidence" || inputPath !== requirement.inputPath || input?.mediaType !== requirement.inputMediaType) {
      errors.push(`${familyId}: ${requirement.sampleId} must bind the exact checked ${requirement.sourceApp} input fixture and media type.`);
    }
    try {
      if (sha256(readFileSync(resolve(root, inputPath))) !== inputHash) {
        errors.push(`${familyId}: ${requirement.sampleId} import input fingerprint is stale for ${inputPath}.`);
      }
      if (sha256(readFileSync(resolve(root, packagePath, requirement.packageSource))) !== inputHash) {
        errors.push(`${familyId}: ${requirement.sampleId} checked output does not preserve the exact declared import source.`);
      }
    } catch (error) {
      errors.push(`${familyId}: ${requirement.sampleId} cannot read checked import input/output source: ${(error as Error).message}`);
    }
    const sourceInvocation = [
      ...SOURCE_PREFIX, "debug", requirement.command, "--tier", "write_local", "--trusted-local-tier",
      "--source", requirement.inputPath, "--out", requirement.outputPath
    ];
    const installedInvocation = [
      "shellx-motion", "debug", requirement.command, "--tier", "write_local", "--trusted-local-tier",
      "--source", "<input-file>", "--out", requirement.outputPath
    ];
    if (!arraysEqual(readStringArray(evidence.sourceCheckout), sourceInvocation) || !arraysEqual(readStringArray(evidence.installed), installedInvocation)) {
      errors.push(`${familyId}: ${requirement.sampleId} import invocations must use the public ${requirement.command} route, explicit write_local grant, and bounded output path.`);
    }
    const artifact = asRecord(evidence.expectedArtifact);
    if (artifact?.kind !== "directory" || artifact.path !== requirement.outputPath || artifact.mediaType !== "application/vnd.shellx.motion.package") {
      errors.push(`${familyId}: ${requirement.sampleId} import output must be a bounded Motion-package directory under .scratch/rendering-samples/.`);
    }
    const receiptShapes = readRecordArray(evidence.expectedReceipts, "expectedReceipts", []) ?? [];
    const expectedShapes = ["adapter.lower", "adapter.diagnostics"];
    if (!arraysEqual(receiptShapes.map((receipt) => String(receipt.operation)), expectedShapes)
      || receiptShapes.some((receipt) => receipt.schema !== "shellx-motion/receipt@1" || receipt.location !== "inside-output-directory")) {
      errors.push(`${familyId}: ${requirement.sampleId} must expect adapter.lower and adapter.diagnostics receipts inside its output package.`);
    }
    assertLottieImportContract(debug, requirement, errors);
  }
}

function assertLottieImportContract(
  debug: Catalog | undefined,
  requirement: { sourceApp: string },
  errors: string[]
): void {
  const command = `motion.${requirement.sourceApp}.import`;
  const contracts = readRecordArray(debug?.contracts, "debug contracts", []) ?? [];
  const contract = contracts.find((candidate) => candidate.command === command);
  const expected = asRecord(readRecordArray(contract?.expectedReceipts, "expectedReceipts", [])?.[0]);
  if (expected?.operation !== "adapter.lower" || expected.mode !== "emits" || expected.required !== true
    || !arraysEqual(readStringArray(expected.artifactRoles), ["motion_package", "adapter_lowering_receipt"])) {
    errors.push(`family.lottie-and-dotlottie@1: ${command} must publicly contract an emitted adapter.lower receipt with motion_package and adapter_lowering_receipt artifacts.`);
  }
}

function validateFamilyWorkflowBinding(
  binding: Capability,
  root: string,
  packageJson: Catalog | undefined,
  debug: Catalog | undefined,
  errors: string[]
): void {
  const familyId = String(binding.familyId);
  const title = String(binding.title);
  const label = `familyWorkflowBinding ${familyId}:${title}`;
  const commandIds = readStringArray(binding.commandIds);
  const receiptOperations = readStringArray(binding.receiptOperations);
  const proofOutputs = readRecordArray(binding.proofOutputs, "proofOutputs", errors);
  if (!proofOutputs || proofOutputs.length === 0) {
    errors.push(`${label} must declare one or more proof outputs for rendering-samples:proof.`);
  } else {
    const outputPaths = new Set<string>();
    for (const output of proofOutputs) {
      const outputPath = typeof output.path === "string" ? output.path : "";
      const kind = output.kind;
      const mediaType = output.mediaType;
      if (!isSafeRelativePath(outputPath) || outputPaths.has(outputPath)) {
        errors.push(`${label} proof output path must be unique and safely relative: ${outputPath}.`);
      }
      outputPaths.add(outputPath);
      if ((kind === "directory" && mediaType !== "application/vnd.shellx.motion.package")
        || (kind === "file" && !["application/json", "video/mp4"].includes(String(mediaType)))) {
        errors.push(`${label} proof output ${outputPath} has an unsupported kind/media type contract.`);
      }
    }
  }
  const contracts = readRecordArray(debug?.contracts, "debug contracts", []) ?? [];
  for (const commandId of commandIds) {
    const contract = contracts.find((candidate) => candidate.command === commandId);
    if (!contract) {
      errors.push(`${label} references absent public Debug command ${commandId}.`);
      continue;
    }
    const operations = new Set((readRecordArray(contract.expectedReceipts, "expectedReceipts", []) ?? []).map((receipt) => String(receipt.operation)));
    for (const operation of receiptOperations) {
      if (operations.has(operation)) continue;
      const anyCommandSupportsOperation = contracts.some((candidate) => candidate.command !== commandId
        && (readRecordArray(candidate.expectedReceipts, "expectedReceipts", []) ?? []).some((receipt) => String(receipt.operation) === operation));
      if (!anyCommandSupportsOperation) errors.push(`${label} names receipt operation ${operation}, but no public Debug contract emits or reads it.`);
    }
  }
  if (binding.kind === "package-script") {
    const packageScript = typeof binding.packageScript === "string" ? binding.packageScript : "";
    const scriptPath = typeof binding.scriptPath === "string" ? binding.scriptPath : "";
    if (!isSafeRelativePath(scriptPath) || !existsSync(resolve(root, scriptPath))) {
      errors.push(`${label} package-script path is missing or unsafe: ${scriptPath}.`);
      return;
    }
    const scripts = asRecord(packageJson?.scripts);
    if (scripts?.[packageScript] !== `tsx ${scriptPath}`) {
      errors.push(`${label} must name an exact public package script for ${scriptPath}.`);
    }
    const source = readFileSync(resolve(root, scriptPath), "utf8");
    if (!source.includes("renderingSamplesProofRoot")) {
      errors.push(`${label} must use renderingSamplesProofRoot so the proof runner can isolate its destructive scratch scope.`);
    }
    for (const marker of readStringArray(binding.sourceMarkers)) {
      if (!source.includes(marker)) errors.push(`${label} script evidence is missing required source marker ${JSON.stringify(marker)}.`);
    }
    for (const inputPath of readStringArray(binding.inputPaths)) {
      if (!isSafeRelativePath(inputPath) || !existsSync(resolve(root, inputPath))) {
        errors.push(`${label} input path is missing or unsafe: ${inputPath}.`);
      } else if (!scriptReferencesCheckedPath(source, inputPath)) {
        errors.push(`${label} script evidence does not reference its checked input path ${inputPath}.`);
      }
    }
    return;
  }
  if (binding.kind !== "cli-import") {
    errors.push(`${label} must use a supported checked workflow kind.`);
    return;
  }
  const input = asRecord(binding.input);
  const inputPath = typeof input?.path === "string" ? input.path : "";
  const inputHash = typeof input?.sha256 === "string" ? input.sha256 : "";
  try {
    const facts = lstatSync(resolve(root, inputPath));
    if (!isSafeRelativePath(inputPath) || !facts.isFile() || facts.isSymbolicLink()) throw new Error("not a regular published input file");
    if (sha256(readFileSync(resolve(root, inputPath))) !== inputHash) errors.push(`${label} input fingerprint is stale for ${inputPath}.`);
  } catch (error) {
    errors.push(`${label} cannot read checked workflow input ${inputPath}: ${(error as Error).message}`);
  }
  const source = readStringArray(binding.sourceCheckout);
  const installed = readStringArray(binding.installed);
  const authorityTier = typeof binding.authorityTier === "string" ? binding.authorityTier : undefined;
  if (!isPublicSourceCliInvocation(source)) {
    errors.push(`${label} must use the public source-checkout CLI route.`);
  }
  if (installed[0] !== "shellx-motion") {
    errors.push(`${label} must use the public installed CLI route.`);
  }
  for (const [name, argv] of [["source-checkout", source], ["installed", installed]] as const) {
    const actualTier = flagValue(argv, "--tier");
    const trusted = argv.includes("--trusted-local-tier");
    if (authorityTier) {
      if (actualTier !== authorityTier || !trusted) {
        errors.push(`${label} must declare its required ${authorityTier} local-authority route exactly in the ${name} invocation.`);
      }
    } else if (actualTier || trusted) {
      errors.push(`${label} must not imply a local authority tier without an explicit authorityTier declaration.`);
    }
  }
  if (!source.includes(inputPath) || !installed.includes("<input-file>")) {
    errors.push(`${label} must bind the checked source input and an installed-build input placeholder.`);
  }
  for (const argv of [source, installed]) {
    const out = flagValue(argv, "--out");
    if (!out?.startsWith(".scratch/rendering-samples/")) errors.push(`${label} output must stay under .scratch/rendering-samples/.`);
  }
  if (proofOutputs && (proofOutputs.length !== 1 || proofOutputs[0]?.kind !== "directory" || proofOutputs[0]?.mediaType !== "application/vnd.shellx.motion.package")) {
    errors.push(`${label} cli-import proof must declare exactly one Motion-package directory output, so the proof runner can replace only --out.`);
  }
}

function isPublicSourceCliInvocation(argv: string[]): boolean {
  return arraysEqual(argv.slice(0, SOURCE_PREFIX.length), SOURCE_PREFIX);
}

function scriptReferencesCheckedPath(source: string, inputPath: string): boolean {
  if (source.includes(inputPath)) return true;
  return inputPath.split("/").every((part) => part.length > 0 && (source.includes(`"${part}"`) || source.includes(`'${part}'`)));
}

function readFamilyJson(path: string, label: string, errors: string[]): Json | undefined {
  try {
    const facts = lstatSync(path);
    if (!facts.isFile() || facts.isSymbolicLink()) throw new Error("not a regular file");
    return JSON.parse(readFileSync(path, "utf8")) as Json;
  } catch (error) {
    errors.push(`${label} is not readable JSON: ${(error as Error).message}`);
    return undefined;
  }
}

function assertJsonValue(label: string, document: Json | undefined, pointer: string, expected: Json, errors: string[]): void {
  if (!document) return;
  const actual = jsonPointerValue(document, pointer);
  if (actual === undefined || canonicalJsonSha256(actual) !== canonicalJsonSha256(expected)) {
    errors.push(`${label} must expose ${pointer} as ${JSON.stringify(expected)}.`);
  }
}

function validateCapabilityRecipe(bindingId: string, input: unknown, sample: Sample, root: string, errors: string[]): void {
  const recipe = asRecord(input);
  const path = recipe?.path;
  const source = asRecord(sample.source);
  const sourcePath = source?.path;
  if (recipe?.kind !== "json-pointer-evidence" || typeof path !== "string" || typeof sourcePath !== "string") {
    errors.push(`familySampleBinding ${bindingId} must provide a json-pointer-evidence recipe inside its checked sample source.`);
    return;
  }
  if (!isSafeRelativePath(path) || !isSafeRelativePath(sourcePath)) {
    errors.push(`familySampleBinding ${bindingId}: capability recipe path must stay under its checked sample source.`);
    return;
  }
  const sourceRoot = resolve(root, sourcePath);
  const recipePath = resolve(root, path);
  const recipeRelative = relative(sourceRoot, recipePath);
  if (!isSafeRelativePath(recipeRelative) || !recipePath.startsWith(`${sourceRoot}${sep}`)) {
    errors.push(`familySampleBinding ${bindingId}: capability recipe ${path} must be a regular file inside ${sourcePath}.`);
    return;
  }
  let recipeDocument: Json;
  try {
    const facts = lstatSync(recipePath);
    if (!facts.isFile() || facts.isSymbolicLink()) throw new Error("not a regular file");
    recipeDocument = JSON.parse(readFileSync(recipePath, "utf8")) as Json;
  } catch (error) {
    errors.push(`familySampleBinding ${bindingId}: capability recipe ${path} is unreadable JSON: ${(error as Error).message}`);
    return;
  }
  const expectedValues = readRecordArray(recipe.expectedJsonValues, "expectedJsonValues", errors);
  if (!expectedValues || expectedValues.length === 0) {
    errors.push(`familySampleBinding ${bindingId}: capability recipe must name nonempty expectedJsonValues.`);
    return;
  }
  for (const evidence of expectedValues) {
    const pointer = evidence.pointer;
    if (typeof pointer !== "string" || !Object.prototype.hasOwnProperty.call(evidence, "value")) {
      errors.push(`familySampleBinding ${bindingId}: every expectedJsonValues entry needs pointer and value.`);
      continue;
    }
    const actual = jsonPointerValue(recipeDocument, pointer);
    if (actual === undefined) {
      errors.push(`familySampleBinding ${bindingId}: capability recipe ${path} does not expose expected JSON pointer ${pointer}.`);
    } else if (canonicalJsonSha256(actual) !== canonicalJsonSha256(evidence.value as Json)) {
      errors.push(`familySampleBinding ${bindingId}: capability recipe ${path} does not match expected JSON value at ${pointer}.`);
    }
  }
}

function jsonPointerValue(document: Json, pointer: string): Json | undefined {
  if (!pointer.startsWith("/")) return undefined;
  let current: unknown = document;
  for (const token of pointer.slice(1).split("/")) {
    const segment = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return undefined;
      const index = Number(segment);
      if (index >= current.length) return undefined;
      current = current[index];
    } else if (typeof current === "object" && current !== null && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else return undefined;
  }
  return current as Json;
}

function assertPublicExport(catalog: Catalog, root: string, errors: string[]): void {
  const exported = asRecord(catalog.publicExport);
  if (!exported) return;
  for (const path of Object.values(exported)) {
    if (typeof path !== "string" || !existsSync(resolve(root, path))) errors.push(`public-export target is missing: ${String(path)}.`);
  }
  const manifestPath = resolve(root, "scripts/public-export-manifest.json");
  // Positive selection is an implementation-tree property. The manifest and
  // exporter are deliberately absent from a released source tree, where the
  // public contract can instead prove every catalog target and support root is
  // present without asking for private publication policy.
  if (!existsSync(manifestPath)) {
    for (const required of ["schemas", "docs/public", "fixtures", "scripts"]) {
      if (!existsSync(resolve(root, required))) errors.push(`public source release is missing required ${required} root.`);
    }
    return;
  }
  const manifest = readJson(manifestPath, "scripts/public-export-manifest.json", errors) as Catalog | undefined;
  const include = readRecordArray(manifest?.include, "public export include", errors) ?? [];
  const includedRoots = new Set(include.map((entry) => String(entry.path)));
  for (const path of Object.values(exported)) {
    if (typeof path !== "string") continue;
    if (!["schemas", "docs/public"].some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) || !includedRoots.has(path.startsWith("schemas/") ? "schemas" : "docs/public")) {
      errors.push(`${path} is not positively included by scripts/public-export-manifest.json.`);
    }
  }
  for (const required of ["fixtures", "scripts"]) {
    if (!includedRoots.has(required)) errors.push(`scripts/public-export-manifest.json must include ${required}; rendering samples depend on public ${required}.`);
  }
}

/** Direct source recipes may name implementation paths only when the exporter selects their roots. */
function assertPositivePublicExportPaths(root: string, requiredRoots: string[], label: string, errors: string[]): void {
  const manifestPath = resolve(root, "scripts/public-export-manifest.json");
  if (!existsSync(manifestPath)) return;
  const manifest = readJson(manifestPath, "scripts/public-export-manifest.json", errors) as Catalog | undefined;
  const include = readRecordArray(manifest?.include, "public export include", errors) ?? [];
  const includedRoots = new Set(include.map((entry) => String(entry.path)));
  for (const requiredRoot of requiredRoots) {
    if (!includedRoots.has(requiredRoot)) errors.push(`${label} is not positively included by scripts/public-export-manifest.json: missing ${requiredRoot}.`);
  }
}

function assertCatalogFingerprint(catalog: Catalog, errors: string[]): void {
  const actual = typeof catalog.fingerprint === "string" ? catalog.fingerprint : "";
  const expected = canonicalJsonSha256(withoutFingerprint(catalog));
  if (actual !== expected) errors.push(`catalog fingerprint is stale; expected ${expected}, got ${actual}.`);
}

function validateInvocation(id: string, input: unknown, errors: string[]): void {
  const invocation = asRecord(input);
  if (isRendererBrowserDirectApiInvocation(invocation)) return;
  const source = readStringArray(invocation?.sourceCheckout);
  const installed = readStringArray(invocation?.installed);
  if (!arraysEqual(source.slice(0, SOURCE_PREFIX.length), SOURCE_PREFIX) || source.filter((arg) => arg === SOURCE_PLACEHOLDER).length !== 1) {
    errors.push(`${id}: sourceCheckout must use the canonical pnpm workspace invocation and exactly one ${SOURCE_PLACEHOLDER} placeholder.`);
  }
  if (installed[0] !== "shellx-motion" || installed.filter((arg) => arg === INSTALLED_PLACEHOLDER).length !== 1) {
    errors.push(`${id}: installed must use shellx-motion and exactly one ${INSTALLED_PLACEHOLDER} placeholder.`);
  }
  for (const argv of [source, installed]) {
    if (argv.some((arg) => ["--dry-run", "--force", "--trusted-local-tier", "--tier"].includes(arg))) {
      errors.push(`${id}: catalog examples must not imply dry-run, force, or an authority tier.`);
    }
  }
}

function isRendererBrowserDirectApiInvocation(input: unknown): boolean {
  return asRecord(input)?.kind === "renderer-browser-direct-api";
}

function validateCapabilityInvocation(id: string, capabilityId: string, input: unknown, root: string, errors: string[]): void {
  const invocation = asRecord(input);
  if (isRendererBrowserDirectApiInvocation(invocation)) {
    validateRendererBrowserDirectApiInvocation(id, capabilityId, invocation!, root, errors);
    return;
  }
  const source = readStringArray(invocation?.sourceCheckout);
  const installed = readStringArray(invocation?.installed);
  const sourceCommand = source.slice(SOURCE_PREFIX.length);
  const installedCommand = installed.slice(1);
  const expected = expectedInvocation(capabilityId);
  for (const [form, argv] of [["sourceCheckout", sourceCommand], ["installed", installedCommand]] as const) {
    if (argv[0] !== expected.command) errors.push(`${id}: ${form} must invoke ${expected.command} for ${capabilityId}.`);
    for (const [flag, value] of Object.entries(expected.flags)) {
      if (flagValue(argv, flag) !== value) errors.push(`${id}: ${form} must use ${flag} ${value} for ${capabilityId}.`);
    }
    for (const flag of expected.absentFlags) {
      if (argv.includes(flag)) errors.push(`${id}: ${form} must not use ${flag} for ${capabilityId}.`);
    }
    if (flagValue(argv, "--out") === undefined || !flagValue(argv, "--out")!.startsWith("{out}/")) {
      errors.push(`${id}: ${form} must place its expected artifact under the {out}/ placeholder.`);
    }
  }
}

function validateRendererBrowserDirectApiInvocation(id: string, capabilityId: string, invocation: Capability, root: string, errors: string[]): void {
  const expectedPaths = [
    "packages/core/src/index.ts",
    "packages/core/src/package.ts",
    "packages/renderer-browser/src/index.ts",
    "packages/renderer-browser/src/gpu-points-preview.ts",
    "packages/renderer-browser/src/gpu-preview-output.ts"
  ];
  const packageLoader = asRecord(invocation.packageLoader);
  const renderer = asRecord(invocation.renderer);
  const sourcePaths = readStringArray(invocation.sourcePaths);
  if (capabilityId !== "preview.gpu-png@1") {
    errors.push(`${id}: renderer-browser direct API evidence may only supplement preview.gpu-png@1.`);
  }
  if (packageLoader?.module !== "@shellx-motion/core" || packageLoader.export !== "loadMotionPackage"
    || renderer?.module !== "@shellx-motion/renderer-browser" || renderer.export !== "renderMotionGpuPreview") {
    errors.push(`${id}: direct source invocation must load via @shellx-motion/core loadMotionPackage and call @shellx-motion/renderer-browser renderMotionGpuPreview.`);
  }
  if (!arraysEqual(sourcePaths, expectedPaths)) {
    errors.push(`${id}: direct source invocation must bind the exact exported loader, direct preview implementation, and GPU Scene3D receipt source paths.`);
  }
  if (invocation.atMs !== 500 || invocation.outDir !== ".scratch/rendering-samples/gpu-scene3d-animation-preview") {
    errors.push(`${id}: direct source invocation must use the checked 500ms playhead and bounded gpu-scene3d-animation-preview output directory.`);
  }
  for (const path of sourcePaths) {
    if (!isSafeRelativePath(path) || !existsSync(resolve(root, path))) errors.push(`${id}: direct source invocation path is missing or unsafe: ${path}.`);
  }
  const receiptSource = resolve(root, "packages/renderer-browser/src/gpu-preview-output.ts");
  if (existsSync(receiptSource)) {
    const source = readFileSync(receiptSource, "utf8");
    if (!source.includes("GPU_SCENE3D_ANIMATION_PREVIEW_RECEIPT_SCHEMA") || !source.includes("gpuScene3dAnimation")) {
      errors.push(`${id}: direct source invocation must retain the versioned GPU Scene3D animation receipt namespace.`);
    }
  }
  assertPositivePublicExportPaths(root, ["fixtures", "packages"], `${id} direct source recipe`, errors);
}

function expectedInvocation(capabilityId: string): { command: string; flags: Record<string, string>; absentFlags: string[] } {
  const preview = /^preview\.(native|browser|gpu)-png@1$/.exec(capabilityId);
  if (preview) return { command: "preview", flags: { "--lane": preview[1]! }, absentFlags: ["--frame-lane", "--preset"] };
  if (capabilityId === "render.native-png-still@1") return { command: "render", flags: { "--lane": "native" }, absentFlags: ["--frame-lane", "--preset"] };
  if (capabilityId === "render.native-mp4-h264@1") return { command: "render", flags: { "--lane": "ffmpeg", "--frame-lane": "native", "--preset": "mp4-h264" }, absentFlags: [] };
  if (capabilityId === "render.gpu-mp4-h264@1") return { command: "render", flags: { "--lane": "ffmpeg", "--frame-lane": "gpu", "--preset": "mp4-h264" }, absentFlags: [] };
  if (capabilityId === "render-batch.mixed-preset@1") return { command: "render-batch", flags: {}, absentFlags: ["--lane", "--frame-lane", "--preset"] };
  const browser = /^render\.browser-(.+)@1$/.exec(capabilityId);
  if (browser && MOTION_EXPORT_PRESETS.includes(browser[1] as typeof MOTION_EXPORT_PRESETS[number])) {
    return { command: "render", flags: { "--lane": "ffmpeg", "--frame-lane": "browser", "--preset": browser[1]! }, absentFlags: [] };
  }
  return { command: "__unknown__", flags: {}, absentFlags: [] };
}

function flagValue(argv: string[], flag: string): string | undefined {
  const indexes = argv.flatMap((value, index) => value === flag ? [index] : []);
  return indexes.length === 1 ? argv[indexes[0]! + 1] : undefined;
}

function validateArtifactAndReceipt(id: string, capability: Capability, sample: Sample, errors: string[]): void {
  const artifact = asRecord(sample.expectedArtifact);
  const receipt = asRecord(sample.expectedReceipt);
  const surface = capability.surface;
  const operation = receipt?.operation;
  const directRendererApi = isRendererBrowserDirectApiInvocation(sample.invocation);
  if (surface === "preview" && !directRendererApi && operation !== "preview.frame") errors.push(`${id}: preview samples must expect a preview.frame receipt.`);
  if (surface === "preview" && directRendererApi && (operation !== "preview.gpu.frame" || receipt?.location !== "inline-return")) {
    errors.push(`${id}: direct renderer preview evidence must expect an inline preview.gpu.frame receipt.`);
  }
  if (surface === "render" && operation !== "render.final") errors.push(`${id}: render samples must expect a render.final receipt.`);
  if (surface === "render-batch" && operation !== "render.batch") errors.push(`${id}: batch samples must expect a render.batch receipt.`);
  if (surface === "preview" && (artifact?.kind !== "file" || artifact.mediaType !== "image/png")) errors.push(`${id}: preview samples must expect one PNG file.`);
  if (surface === "render-batch" && artifact?.kind !== "per-row-files") errors.push(`${id}: batch samples must expect per-row files.`);
  const artifactExpectation = expectedArtifact(String(capability.id));
  if (artifactExpectation && (artifact?.kind !== artifactExpectation.kind || artifact?.mediaType !== artifactExpectation.mediaType)) {
    errors.push(`${id}: expected artifact for ${String(capability.id)} must be ${artifactExpectation.kind} / ${artifactExpectation.mediaType}.`);
  }
  const output = typeof artifact?.path === "string" ? artifact.path : "";
  if (!output.startsWith(".scratch/rendering-samples/")) errors.push(`${id}: expected artifact path must stay under .scratch/rendering-samples/.`);
  if (directRendererApi) {
    const invocation = asRecord(sample.invocation)!;
    const expectedPath = `${String(invocation.outDir)}/pkg_gpu_scene3d_animation_preview-gpu-${String(invocation.atMs)}.png`;
    if (output !== expectedPath) errors.push(`${id}: direct renderer output must use the renderer-minted package-id GPU PNG path ${expectedPath}.`);
  }
}

function expectedArtifact(capabilityId: string): { kind: string; mediaType: string } | undefined {
  if (capabilityId.startsWith("preview.")) return { kind: "file", mediaType: "image/png" };
  if (capabilityId === "render.native-png-still@1" || capabilityId === "render.browser-png-frame@1") return { kind: "file", mediaType: "image/png" };
  if (capabilityId === "render.native-mp4-h264@1" || capabilityId === "render.browser-mp4-h264@1" || capabilityId === "render.browser-mp4-hevc@1" || capabilityId === "render.gpu-mp4-h264@1") return { kind: "file", mediaType: "video/mp4" };
  if (capabilityId === "render.browser-webm-av1@1" || capabilityId === "render.browser-webm-vp9@1" || capabilityId === "render.browser-webm-vp9-alpha@1") return { kind: "file", mediaType: "video/webm" };
  if (capabilityId === "render.browser-gif@1") return { kind: "file", mediaType: "image/gif" };
  if (capabilityId === "render.browser-mov-prores@1") return { kind: "file", mediaType: "video/quicktime" };
  if (capabilityId === "render.browser-png-sequence@1") return { kind: "directory", mediaType: "image/png" };
  if (capabilityId === "render.browser-jpeg-frame@1") return { kind: "file", mediaType: "image/jpeg" };
  if (capabilityId === "render-batch.mixed-preset@1") return { kind: "per-row-files", mediaType: "application/x-shellx-motion-batch" };
  return undefined;
}

async function validatePackage(root: string, path: string): Promise<{ lanes: string[]; fingerprint: string }> {
  const absolute = resolve(root, path);
  const relativePath = relative(root, absolute);
  if (!isSafeRelativePath(relativePath) || !absolute.startsWith(`${root}${sep}`)) throw new Error(`sample path escapes repository root: ${path}.`);
  assertNoSymlinks(absolute, path);
  const manifestPath = resolve(absolute, "manifest.json");
  const motionPath = resolve(absolute, "motion.json");
  if (!existsSync(manifestPath) || !existsSync(motionPath)) throw new Error(`${path} is not a Motion package with manifest.json and motion.json.`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const motion = JSON.parse(await readFile(motionPath, "utf8"));
  const [manifestSchema, motionSchema] = await Promise.all([loadSchema("packageManifest"), loadSchema("motion")]);
  for (const [name, schema, document] of [["manifest", manifestSchema, manifest], ["motion", motionSchema, motion]] as const) {
    const result = await validateDocument(schema, document);
    if (!result.ok) throw new Error(`${path}/${name}.json fails Motion validation: ${result.errors[0]?.path ?? "/"} ${result.errors[0]?.message ?? "invalid"}.`);
  }
  const lanes = Array.isArray(manifest.compatibility?.lanes) ? manifest.compatibility.lanes.filter((lane: unknown): lane is string => typeof lane === "string") : [];
  return { lanes, fingerprint: treeFingerprint(absolute) };
}

function treeFingerprint(root: string): string {
  const files: Array<{ path: string; sha256: string }> = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const rel = relative(root, absolute).split("\\").join("/");
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`sample source contains a symbolic link: ${rel}.`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) files.push({ path: rel, sha256: sha256(readFileSync(absolute)) });
      else throw new Error(`sample source contains a non-regular file: ${rel}.`);
    }
  };
  visit(root);
  files.sort((left, right) => compareCodeUnits(left.path, right.path));
  return canonicalJsonSha256({ schema: "shellx-motion/sample-source-tree@1", files });
}

function argvText(argv: string[], packagePath: string, outputRoot: string): string {
  return argv.map((arg) => arg === SOURCE_PLACEHOLDER || arg === INSTALLED_PLACEHOLDER ? packagePath : arg.replace("{out}", outputRoot)).map(shellToken).join(" ");
}

function shellToken(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./{}<>-]+$/.test(value) ? value : JSON.stringify(value);
}

function readJson(path: string, label: string, errors: string[]): JsonSchemaDocument | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JsonSchemaDocument;
  } catch (error) {
    errors.push(`${label} is not readable JSON: ${(error as Error).message}`);
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readRecordArray(value: unknown, label: string, errors: string[]): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value) || value.some((item) => !asRecord(item))) {
    errors.push(`${label} must be an object array.`);
    return undefined;
  }
  return value as Record<string, unknown>[];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function markdownContainsAnchor(markdown: string, expectedAnchor: string): boolean {
  return markdown.split("\n").some((line) => {
    const match = /^(?:#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    return match !== null && markdownAnchor(match[1]!) === expectedAnchor;
  });
}

function markdownAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function assertNoSymlinks(root: string, label: string): void {
  const rootStats = lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error(`${label} is not a regular directory.`);
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) throw new Error(`${label} contains a symbolic link: ${relative(root, absolute)}.`);
      if (stats.isDirectory()) visit(absolute);
    }
  };
  visit(root);
}

function withoutFingerprint(value: Catalog): Json {
  const { fingerprint: _fingerprint, ...rest } = value;
  return rest as Json;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const check = process.argv.includes("--check");
  const releaseGate = process.argv.includes("--release-gate");
  if ((write && check) || (write && releaseGate) || (check && releaseGate)) throw new Error("Choose one of --write, --check, or --release-gate.");
  if (write) {
    const catalog = JSON.parse(await readFile(resolve(ROOT, CATALOG_PATH), "utf8")) as Catalog;
    await writeFile(resolve(ROOT, DOCUMENTATION_PATH), renderRenderingSampleCatalogDoc(catalog), "utf8");
    console.log(`Wrote ${DOCUMENTATION_PATH}.`);
    return;
  }
  const errors = await validateRenderingSampleCatalog(ROOT);
  if (errors.length > 0) {
    console.error(`rendering-sample-catalog: ${errors.length} problem(s):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  const catalog = JSON.parse(await readFile(resolve(ROOT, CATALOG_PATH), "utf8")) as Catalog;
  const blockers = renderingSampleReleaseBlockers(catalog);
  if (releaseGate && blockers.length > 0) {
    console.error(`rendering-sample-catalog: RELEASE GATE BLOCKED — ${blockers.length} public rendering family/families lack truthful sample registrations:`);
    for (const blocker of blockers) console.error(`  - ${blocker}`);
    process.exitCode = 1;
    return;
  }
  console.log(`rendering-sample-catalog: OK — delivery-output foundation is current and validated; rendering-family catalog coverage is ${blockers.length === 0 ? "ready" : `blocked (${blockers.length} families)`}. Runtime readiness requires rendering-samples:proof.`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
