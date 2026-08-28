import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonSha256 } from "../packages/core/src/index";
import { renderRenderingSampleCatalogDoc, renderingSampleReleaseBlockers, validateRenderingSampleCatalog } from "./rendering-sample-catalog";

const repository = resolve(import.meta.dirname, "..");
const hasImplementationExportManifest = existsSync(join(repository, "scripts/public-export-manifest.json"));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-rendering-samples-"));
  roots.push(root);
  // A public export includes the whole scripts root, but this focused fixture
  // needs only the directory to prove the no-manifest branch.
  await mkdir(join(root, "scripts"), { recursive: true });
  for (const file of [
    "docs/public/rendering-sample-catalog.json",
    "docs/public/rendering-sample-family-authorities.json",
    "docs/public/RENDERING_SAMPLES.md",
    "docs/public/rendering.md",
    "docs/public/FEATURES.md",
    "docs/public/DEBUG_API_COMMANDS.md",
    "docs/public/path-reveals.md",
    "docs/public/trails.md",
    "docs/public/templates.md",
    "docs/public/cutout-rigging.md",
    "docs/public/transition-presets.md",
    "skill/shellx-motion/references/layout-gap-animation.md",
    "skill/shellx-motion/references/particle-fields.md",
    "schemas/actions.json",
    "schemas/debug.json",
    "schemas/rendering-sample-catalog.schema.json",
    "schemas/rendering-sample-family-authorities.schema.json",
    "package.json",
    "packages/core/src/export-presets.ts",
    "packages/core/src/types.ts",
    "packages/core/src/index.ts",
    "packages/core/src/package.ts",
    "packages/renderer-browser/src/index.ts",
    "packages/renderer-browser/src/gpu-points-preview.ts",
    "packages/renderer-browser/src/gpu-preview-output.ts",
    "scripts/render-audio-smoke.ts",
    "scripts/render-caption-smoke.ts",
    "scripts/canvas-package-preview-smoke.ts",
    "scripts/tracking-analysis-smoke.ts",
    "scripts/keying-roto-workflow-smoke.ts",
    "scripts/cutout-rig-bake-workflow-smoke.ts"
  ]) {
    const target = join(root, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(repository, file), target);
  }
  const manifest = "scripts/public-export-manifest.json";
  if (existsSync(join(repository, manifest))) {
    const target = join(root, manifest);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(repository, manifest), target);
  }
  for (const name of [
    "procedural-relationships",
    "keyframed-lower-third",
    "compositing-direct-parity",
    "compositing-graph-parity",
    "gpu-points-preview",
    "gpu-g9-orbital-depth",
    "gpu-v020-tidal-reassembly",
    "fixed-scene3d",
    "gpu-scene3d-animation-preview",
    "environment-rain-cinematic",
    "rich-depth-promo",
    "gpu-v25b2-tideglass-almanac",
    "batch-card",
    "editable-lower-third",
    "path-reveal-browser",
    "hyperframes-card",
    "gpu-material-admitted",
    "gpu-v25c-second-take",
    "lottie-primitives-lowered",
    "dotlottie-primitives-lowered"
  ]) {
    await cp(join(repository, "fixtures/packages", name), join(root, "fixtures/packages", name), { recursive: true });
  }
  await cp(
    join(repository, "templates/shellx-product-pack/keyed-subject-promo"),
    join(root, "templates/shellx-product-pack/keyed-subject-promo"),
    { recursive: true }
  );
  await cp(
    join(repository, "templates/shellx-product-pack/tracked-callout-overlay"),
    join(root, "templates/shellx-product-pack/tracked-callout-overlay"),
    { recursive: true }
  );
  for (const file of [
    "fixtures/imports/lottie-primitives/input.json",
    "fixtures/imports/dotlottie-primitives/input.lottie",
    "fixtures/imports/gltf-triangle/input.gltf",
    "fixtures/imports/html-snippet/input.html",
    "fixtures/canvas/frame-selection.json"
  ]) {
    const target = join(root, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(repository, file), target);
  }
  return root;
}

async function synchronizeCatalog(root: string, catalog: Record<string, unknown>): Promise<void> {
  const withoutFingerprint = { ...catalog };
  delete withoutFingerprint.fingerprint;
  catalog.fingerprint = canonicalJsonSha256(withoutFingerprint);
  await writeFile(join(root, "docs/public/rendering-sample-catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  await writeFile(join(root, "docs/public/RENDERING_SAMPLES.md"), renderRenderingSampleCatalogDoc(catalog), "utf8");
}

describe("rendering sample catalog", () => {
  it("accepts the checked-in catalog, its generated documentation, and every registered package", async () => {
    await expect(validateRenderingSampleCatalog(repository)).resolves.toEqual([]);
  });

  it("validates the generated public source without the implementation export manifest", async () => {
    const root = await fixture();
    await rm(join(root, "scripts/public-export-manifest.json"), { force: true });

    await expect(validateRenderingSampleCatalog(root)).resolves.toEqual([]);
  });

  it("clears the full R5/R6 release gate only when every public rendering family has a checked registration", async () => {
    const catalog = JSON.parse(await readFile(join(repository, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    expect(renderingSampleReleaseBlockers(catalog)).toEqual([]);
  });

  it("maps every declared public MotionLayerType to one authoritative rendering family", async () => {
    const catalog = JSON.parse(await readFile(join(repository, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const authority = JSON.parse(await readFile(join(repository, "docs/public/rendering-sample-family-authorities.json"), "utf8")) as Record<string, unknown>;
    const source = await readFile(join(repository, "packages/core/src/types.ts"), "utf8");
    const union = /export\s+type\s+MotionLayerType\s*=\s*((?:\s*\|\s*"[^"\\]+"\s*)+);/.exec(source)!;
    const layerTypes = [...union[1]!.matchAll(/"([^"\\]+)"/g)].map((match) => match[1]);
    const primary = authority.primaryLayerTypeFamilies as Array<Record<string, unknown>>;
    expect(primary.map((mapping) => mapping.layerType)).toEqual(layerTypes);
    expect((catalog.authoritativeCapabilitySet as Record<string, unknown>).primaryLayerTypeFamilies).toEqual(primary);
  });

  it("fails closed when the public MotionLayerType authority leaves a union member unmapped", async () => {
    const root = await fixture();
    const catalog = JSON.parse(await readFile(join(root, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const authorityPath = join(root, "docs/public/rendering-sample-family-authorities.json");
    const authority = JSON.parse(await readFile(authorityPath, "utf8")) as Record<string, unknown>;
    const mappings = authority.primaryLayerTypeFamilies as Array<Record<string, unknown>>;
    authority.primaryLayerTypeFamilies = mappings.filter((mapping) => mapping.layerType !== "group");
    (catalog.authoritativeCapabilitySet as Record<string, unknown>).primaryLayerTypeFamilies = authority.primaryLayerTypeFamilies;
    await writeFile(authorityPath, `${JSON.stringify(authority, null, 2)}\n`, "utf8");
    await synchronizeCatalog(root, catalog);

    const errors = await validateRenderingSampleCatalog(root);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("primaryLayerTypeFamilies must exactly map the public MotionLayerType union in declaration order")
    ]));
  });

  it("registers workflow-backed families with checked source samples, commands, receipt contracts, and explicit limits", async () => {
    const catalog = JSON.parse(await readFile(join(repository, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const families = catalog.publicCapabilityFamilies as Array<Record<string, unknown>>;
    expect(families.filter((family) => [
      "family.keying-and-roto@1",
      "family.tracking-and-stabilization@1",
      "family.fixed-scene3d-and-gltf@1",
      "family.cutout-rig-bake@1",
    ].includes(String(family.id))).map((family) => [family.id, family.registration, family.sampleIds])).toEqual([
      ["family.keying-and-roto@1", "registered", ["sample.keyed-subject-promo.browser-preview@1"]],
      ["family.tracking-and-stabilization@1", "registered", ["sample.tracked-callout-overlay.browser-preview@1"]],
      ["family.fixed-scene3d-and-gltf@1", "registered", [
        "sample.fixed-scene3d.browser-preview@1",
        "sample.gltf-orbital-scene3d.gpu-preview@1",
        "sample.gltf-orbital-package-boundary.gpu-preview@1"
      ]],
      ["family.cutout-rig-bake@1", "registered", ["sample.second-take-cutout-pivot.gpu-preview@1"]]
    ]);
    const workflows = catalog.familyWorkflowBindings as Array<Record<string, unknown>>;
    expect(workflows.filter((workflow) => [
      "family.keying-and-roto@1",
      "family.tracking-and-stabilization@1",
      "family.fixed-scene3d-and-gltf@1",
      "family.cutout-rig-bake@1"
    ].includes(String(workflow.familyId))).map((workflow) => [workflow.familyId, workflow.kind, workflow.commandIds, workflow.receiptOperations])).toEqual([
      ["family.keying-and-roto@1", "package-script", ["motion.keying.apply", "motion.keying.inspect", "motion.roto.upsert", "motion.roto.tracking.detach"], ["keying.apply", "roto.upsert", "roto.tracking.detach"]],
      ["family.tracking-and-stabilization@1", "package-script", ["motion.analysis.tracking.request", "motion.analysis.tracking.inspect", "motion.analysis.tracking.apply", "motion.analysis.tracking.verify", "motion.analysis.tracking.detach"], ["analysis.tracking.request", "analysis.tracking.apply", "analysis.tracking.detach"]],
      ["family.fixed-scene3d-and-gltf@1", "cli-import", ["motion.scene3d.gltf.import"], ["adapter.lower"]],
      ["family.cutout-rig-bake@1", "package-script", ["motion.timeline.cutout.rig.bake"], ["timeline.cutout.rig.bake"]]
    ]);
    await expect(validateRenderingSampleCatalog(repository)).resolves.toEqual([]);
  });

  it("registers the bounded v2 analytic particle-compute fixture with exact structural evidence", async () => {
    const catalog = JSON.parse(await readFile(join(repository, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const family = (catalog.publicCapabilityFamilies as Array<Record<string, unknown>>).find((candidate) => candidate.id === "family.analytic-particle-field-compute@2")!;
    const sample = (catalog.samples as Array<Record<string, unknown>>).find((candidate) => candidate.id === "sample.tidal-reassembly.v2-particle-compute.gpu-preview@1")!;
    const binding = (catalog.familySampleBindings as Array<Record<string, unknown>>).find((candidate) => candidate.sampleId === sample.id)!;
    expect(family).toMatchObject({
      registration: "registered",
      machineAuthority: { path: "schemas/debug.json", kind: "debug-command", id: "motion.timeline.particles.field.source.insert" },
      sampleIds: [sample.id]
    });
    expect(sample).toMatchObject({
      sampleRole: "family-evidence",
      source: { path: "fixtures/packages/gpu-v020-tidal-reassembly" },
      expectedArtifact: { mediaType: "image/png" }
    });
    expect((binding.capabilityRecipe as Record<string, unknown>).expectedJsonValues).toEqual(expect.arrayContaining([
      { pointer: "/layers/2/emitter/count", value: 100000 },
      { pointer: "/layers/2/emitter/field/schema", value: "shellx-motion/particle-field@2" },
      { pointer: "/layers/2/emitter/field/sources/0/kind", value: "flow" },
      { pointer: "/layers/2/emitter/field/sources/3/kind", value: "impact" },
      { pointer: "/layers/2/emitter/trail/samples", value: 2 },
      { pointer: "/layers/2/emitter/shading/mode", value: "glow" }
    ]));
    await expect(validateRenderingSampleCatalog(repository)).resolves.toEqual([]);
  });

  it("generates explicit proof scope and the non-delivery agent-routing boundaries", async () => {
    const catalog = JSON.parse(await readFile(join(repository, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    expect((catalog.agentToolBoundaries as Array<Record<string, unknown>>).map((boundary) => boundary.id)).toEqual([
      "checkpoint-storyboard",
      "layout-gap-animation",
      "procedural-bindings",
      "scene3d-animation",
      "particle-field-v1",
      "particle-field-v2-compute"
    ]);
    const document = renderRenderingSampleCatalogDoc(catalog);
    expect(document).toContain("`familyWorkflowBindings` is an exclusive runtime plan");
    expect(document).toContain("Canonical invocations without their own bound workflow are checked structural recipes");
    expect(document).toContain("## Agent non-delivery tool boundaries");
    expect(document).toContain("Fixed analytic particle field v2");
  });

  it("fails closed when a workflow loses its checked command or fixture binding", async () => {
    const root = await fixture();
    const catalog = JSON.parse(await readFile(join(root, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const workflows = catalog.familyWorkflowBindings as Array<Record<string, unknown>>;
    const tracking = workflows.find((workflow) => workflow.familyId === "family.tracking-and-stabilization@1")!;
    const gltf = workflows.find((workflow) => workflow.familyId === "family.fixed-scene3d-and-gltf@1")!;
    tracking.commandIds = ["motion.analysis.tracking.missing"];
    (gltf.input as Record<string, unknown>).sha256 = "0".repeat(64);
    await synchronizeCatalog(root, catalog);

    const errors = await validateRenderingSampleCatalog(root);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("references absent public Debug command motion.analysis.tracking.missing"),
      expect.stringContaining("input fingerprint is stale for fixtures/imports/gltf-triangle/input.gltf")
    ]));
  });

  it("registers Lottie and dotLottie only with paired checked import-output evidence", async () => {
    const catalog = JSON.parse(await readFile(join(repository, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const family = (catalog.publicCapabilityFamilies as Array<Record<string, unknown>>).find((candidate) => candidate.id === "family.lottie-and-dotlottie@1")!;
    expect(family).toMatchObject({
      registration: "registered",
      sampleIds: [
        "sample.lottie-primitives-lowered.browser-preview@1",
        "sample.dotlottie-primitives-lowered.browser-preview@1"
      ]
    });
    await expect(validateRenderingSampleCatalog(repository)).resolves.toEqual([]);
  });

  it("keeps documented Lottie import arguments rooted in the source-checkout caller", async () => {
    const catalog = JSON.parse(await readFile(join(repository, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const bindings = (catalog.familySampleBindings as Array<Record<string, unknown>>).filter((binding) => binding.familyId === "family.lottie-and-dotlottie@1");
    const expected = new Map([
      ["sample.lottie-primitives-lowered.browser-preview@1", ["fixtures/imports/lottie-primitives/input.json", ".scratch/rendering-samples/lottie-primitives-import"]],
      ["sample.dotlottie-primitives-lowered.browser-preview@1", ["fixtures/imports/dotlottie-primitives/input.lottie", ".scratch/rendering-samples/dotlottie-primitives-import"]]
    ]);
    for (const binding of bindings) {
      const invocation = (binding.interchangeEvidence as Record<string, unknown>).sourceCheckout as string[];
      const [sourcePath, outputPath] = expected.get(binding.sampleId as string)!;
      expect(invocation[invocation.indexOf("--source") + 1]).toBe(sourcePath);
      expect(invocation[invocation.indexOf("--out") + 1]).toBe(outputPath);
      expect([sourcePath, outputPath].some((path) => path.split("/").includes(".."))).toBe(false);
      expect(relative(repository, resolve(repository, sourcePath)).replaceAll("\\", "/")).toBe(sourcePath);
      expect(relative(repository, resolve(repository, outputPath)).replaceAll("\\", "/")).toBe(outputPath);
    }
  });

  it("registers environments and depth only with paired checked source evidence", async () => {
    const catalog = JSON.parse(await readFile(join(repository, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const family = (catalog.publicCapabilityFamilies as Array<Record<string, unknown>>).find((candidate) => candidate.id === "family.environments-and-depth@1")!;
    expect(family).toMatchObject({
      registration: "registered",
      sampleIds: [
        "sample.environment-rain-cinematic.browser-preview@1",
        "sample.rich-depth-promo.browser-preview@1"
      ]
    });
    await expect(validateRenderingSampleCatalog(repository)).resolves.toEqual([]);
  });

  it("registers compositing only with the paired graph and direct-parity fixture evidence", async () => {
    const catalog = JSON.parse(await readFile(join(repository, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const family = (catalog.publicCapabilityFamilies as Array<Record<string, unknown>>).find((candidate) => candidate.id === "family.compositing-graphs@1")!;
    expect(family).toMatchObject({
      registration: "registered",
      sampleIds: [
        "sample.compositing-graph-parity.browser-preview@1",
        "sample.compositing-direct-parity.browser-preview@1"
      ]
    });
    await expect(validateRenderingSampleCatalog(repository)).resolves.toEqual([]);
  });

  it("registers the keyed-subject source package alongside the checked mutation-and-detach workflow", async () => {
    const catalog = JSON.parse(await readFile(join(repository, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const family = (catalog.publicCapabilityFamilies as Array<Record<string, unknown>>).find((candidate) => candidate.id === "family.keying-and-roto@1")!;
    expect(family).toMatchObject({
      registration: "registered",
      sampleIds: ["sample.keyed-subject-promo.browser-preview@1"]
    });
    const workflow = (catalog.familyWorkflowBindings as Array<Record<string, unknown>>).find((candidate) => candidate.familyId === family.id)!;
    expect(workflow).toMatchObject({
      packageScript: "keying-roto-workflow:smoke",
      inputPaths: ["fixtures/packages/gpu-material-admitted/assets/poster.png"],
      receiptOperations: ["keying.apply", "roto.upsert", "roto.tracking.detach"]
    });
    await expect(validateRenderingSampleCatalog(repository)).resolves.toEqual([]);
  });

  it("accepts a bound supplemental family-evidence sample without displacing the canonical delivery sample", async () => {
    const root = await fixture();
    const catalog = JSON.parse(await readFile(join(root, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const families = catalog.publicCapabilityFamilies as Array<Record<string, unknown>>;
    const family = families[0]!;
    const samples = catalog.samples as Array<Record<string, unknown>>;
    const canonicalSample = samples.find((sample) => sample.id === "sample.keyframed-lower-third.browser-preview@1")!;
    const sampleId = "sample.synthetic-family-evidence@1";
    samples.push({ ...structuredClone(canonicalSample), id: sampleId, sampleRole: "family-evidence" });
    family.sampleIds = [...(family.sampleIds as string[]), sampleId];
    catalog.familySampleBindings = [...(catalog.familySampleBindings as Array<Record<string, unknown>>), {
      familyId: family.id,
      sampleId,
      capabilityRecipe: {
        kind: "json-pointer-evidence",
        path: "fixtures/packages/keyframed-lower-third/motion.json",
        expectedJsonValues: [{ pointer: "/layers/0/type", value: "shape" }]
      }
    }];
    const blockers = renderingSampleReleaseBlockers(catalog);
    catalog.releaseGate = {
      schema: "shellx-motion/rendering-sample-release-gate@1",
      state: "ready",
      blockers
    };
    await synchronizeCatalog(root, catalog);

    await expect(validateRenderingSampleCatalog(root)).resolves.toEqual([]);
    expect((family.sampleIds as string[])).toContain(sampleId);
  });

  it("rejects an unbound supplemental family-evidence sample", async () => {
    const root = await fixture();
    const catalog = JSON.parse(await readFile(join(root, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const samples = catalog.samples as Array<Record<string, unknown>>;
    const canonicalSample = samples.find((sample) => sample.id === "sample.keyframed-lower-third.browser-preview@1")!;
    samples.push({ ...structuredClone(canonicalSample), id: "sample.unbound-family-evidence@1", sampleRole: "family-evidence" });
    await synchronizeCatalog(root, catalog);

    const errors = await validateRenderingSampleCatalog(root);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("sample.unbound-family-evidence@1: family-evidence samples must be bound to a registered public capability family.")
    ]));
  });

  it("rejects a bogus family registration before it can clear a blocking family", async () => {
    const root = await fixture();
    const catalog = JSON.parse(await readFile(join(root, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const family = (catalog.publicCapabilityFamilies as Array<Record<string, unknown>>)[0]!;
    const sampleId = "sample.missing-family-proof@1";
    family.registration = "registered";
    family.sampleIds = [sampleId];
    catalog.familySampleBindings = [{
      familyId: family.id,
      sampleId,
      capabilityRecipe: {
        kind: "json-pointer-evidence",
        path: "fixtures/packages/keyframed-lower-third/motion.json",
        expectedJsonValues: [{ pointer: "/layers/0/type", value: "shape" }]
      }
    }];
    catalog.releaseGate = {
      schema: "shellx-motion/rendering-sample-release-gate@1",
      state: "blocked",
      blockers: renderingSampleReleaseBlockers(catalog)
    };
    await synchronizeCatalog(root, catalog);

    const errors = await validateRenderingSampleCatalog(root);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("references unknown checked delivery sample sample.missing-family-proof@1"),
      expect.stringContaining("familySampleBinding family.2d-geometry-text-keyframes@1:sample.missing-family-proof@1 references unknown checked delivery sample")
    ]));
  });

  it("fails closed when a registered capability recipe's expected source value drifts", async () => {
    const root = await fixture();
    const catalog = JSON.parse(await readFile(join(root, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const binding = (catalog.familySampleBindings as Array<Record<string, unknown>>)[0]!;
    const evidence = (binding.capabilityRecipe as Record<string, unknown>).expectedJsonValues as Array<Record<string, unknown>>;
    evidence[0]!.value = "text";
    await synchronizeCatalog(root, catalog);

    const errors = await validateRenderingSampleCatalog(root);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("capability recipe fixtures/packages/keyframed-lower-third/motion.json does not match expected JSON value at /layers/0/type")
    ]));
  });

  it("fails closed when the particle-and-trail source evidence no longer matches its checked package", async () => {
    const root = await fixture();
    const catalog = JSON.parse(await readFile(join(root, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const binding = (catalog.familySampleBindings as Array<Record<string, unknown>>).find((candidate) => candidate.sampleId === "sample.gpu-orbital-particle-trails-preview@1")!;
    const evidence = (binding.capabilityRecipe as Record<string, unknown>).expectedJsonValues as Array<Record<string, unknown>>;
    evidence[0]!.value = "points";
    await synchronizeCatalog(root, catalog);

    const errors = await validateRenderingSampleCatalog(root);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("capability recipe fixtures/packages/gpu-g9-orbital-depth/motion.json does not match expected JSON value at /layers/4/type")
    ]));
  });

  it("fails closed when the v2 analytic particle registration loses its descriptor proof", async () => {
    const root = await fixture();
    const catalog = JSON.parse(await readFile(join(root, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const binding = (catalog.familySampleBindings as Array<Record<string, unknown>>).find((candidate) => candidate.sampleId === "sample.tidal-reassembly.v2-particle-compute.gpu-preview@1")!;
    const evidence = (binding.capabilityRecipe as Record<string, unknown>).expectedJsonValues as Array<Record<string, unknown>>;
    (binding.capabilityRecipe as Record<string, unknown>).expectedJsonValues = evidence.filter((entry) => entry.pointer !== "/layers/2/emitter/field/schema");
    await synchronizeCatalog(root, catalog);

    const errors = await validateRenderingSampleCatalog(root);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("family.analytic-particle-field-compute@2: registration requires the checked gpu-v020-tidal-reassembly fixture")
    ]));
  });

  it("fails closed when a Lottie import input no longer matches its checked lowered package", async () => {
    const root = await fixture();
    const catalog = JSON.parse(await readFile(join(root, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const binding = (catalog.familySampleBindings as Array<Record<string, unknown>>).find((candidate) => candidate.sampleId === "sample.lottie-primitives-lowered.browser-preview@1")!;
    const source = (binding.interchangeEvidence as Record<string, unknown>).source as Record<string, unknown>;
    source.sha256 = "0".repeat(64);
    await synchronizeCatalog(root, catalog);

    const errors = await validateRenderingSampleCatalog(root);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("sample.lottie-primitives-lowered.browser-preview@1 import input fingerprint is stale")
    ]));
  });

  it("fails closed when the environment source evidence no longer matches its checked package", async () => {
    const root = await fixture();
    const catalog = JSON.parse(await readFile(join(root, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const binding = (catalog.familySampleBindings as Array<Record<string, unknown>>).find((candidate) => candidate.sampleId === "sample.environment-rain-cinematic.browser-preview@1")!;
    const evidence = (binding.capabilityRecipe as Record<string, unknown>).expectedJsonValues as Array<Record<string, unknown>>;
    evidence[1]!.value = "shellx-motion/environment@0";
    await synchronizeCatalog(root, catalog);

    const errors = await validateRenderingSampleCatalog(root);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("capability recipe fixtures/packages/environment-rain-cinematic/motion.json does not match expected JSON value at /layers/0/environment/schema")
    ]));
  });

  it("refuses an environment-and-depth registration that retains only the environment half", async () => {
    const root = await fixture();
    const catalog = JSON.parse(await readFile(join(root, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const family = (catalog.publicCapabilityFamilies as Array<Record<string, unknown>>).find((candidate) => candidate.id === "family.environments-and-depth@1")!;
    family.sampleIds = ["sample.environment-rain-cinematic.browser-preview@1"];
    catalog.familySampleBindings = (catalog.familySampleBindings as Array<Record<string, unknown>>).filter((binding) => binding.sampleId !== "sample.rich-depth-promo.browser-preview@1");
    catalog.releaseGate = {
      schema: "shellx-motion/rendering-sample-release-gate@1",
      state: "blocked",
      blockers: renderingSampleReleaseBlockers(catalog)
    };
    await synchronizeCatalog(root, catalog);

    const errors = await validateRenderingSampleCatalog(root);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("family.environments-and-depth@1: registered bindings must jointly prove an environment layer with an exact environment record and effect, plus one checked sample with a camera and exact depth values on at least two layers.")
    ]));
  });

  it("refuses a glTF CLI workflow that omits its explicit local-authority contract", async () => {
    const root = await fixture();
    const catalog = JSON.parse(await readFile(join(root, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const workflow = (catalog.familyWorkflowBindings as Array<Record<string, unknown>>).find((candidate) => candidate.familyId === "family.fixed-scene3d-and-gltf@1")!;
    delete workflow.authorityTier;
    await synchronizeCatalog(root, catalog);

    const errors = await validateRenderingSampleCatalog(root);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("must not imply a local authority tier without an explicit authorityTier declaration")
    ]));
  });

  it("registers persisted Scene3D animation only through the bounded direct GPU PNG source route", async () => {
    const catalog = JSON.parse(await readFile(join(repository, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const family = (catalog.publicCapabilityFamilies as Array<Record<string, unknown>>).find((candidate) => candidate.id === "family.scene3d-animation-gpu-preview@1")!;
    const sample = (catalog.samples as Array<Record<string, unknown>>).find((candidate) => candidate.id === "sample.scene3d-animation.direct-gpu-preview@1")!;
    expect(family).toMatchObject({
      registration: "registered",
      sampleIds: ["sample.scene3d-animation.direct-gpu-preview@1"],
      machineAuthority: { path: "schemas/debug.json", kind: "debug-command", id: "motion.timeline.scene3d-animation.inspect" }
    });
    expect(sample).toMatchObject({
      source: { path: "fixtures/packages/gpu-scene3d-animation-preview" },
      invocation: {
        kind: "renderer-browser-direct-api",
        packageLoader: { module: "@shellx-motion/core", export: "loadMotionPackage" },
        renderer: { module: "@shellx-motion/renderer-browser", export: "renderMotionGpuPreview" },
        atMs: 500,
        outDir: ".scratch/rendering-samples/gpu-scene3d-animation-preview"
      },
      expectedArtifact: { path: ".scratch/rendering-samples/gpu-scene3d-animation-preview/pkg_gpu_scene3d_animation_preview-gpu-500.png", mediaType: "image/png" },
      expectedReceipt: { operation: "preview.gpu.frame", location: "inline-return" }
    });
    expect(renderRenderingSampleCatalogDoc(catalog)).toContain("there is no CLI, Debug/Action preview, or installed-command equivalent");
    await expect(validateRenderingSampleCatalog(repository)).resolves.toEqual([]);
  });

  it("fails closed when the publicly advertised Scene3D animation family is omitted", async () => {
    const root = await fixture();
    const catalog = JSON.parse(await readFile(join(root, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    catalog.publicCapabilityFamilies = (catalog.publicCapabilityFamilies as Array<Record<string, unknown>>).filter((family) => family.id !== "family.scene3d-animation-gpu-preview@1");
    catalog.familySampleBindings = (catalog.familySampleBindings as Array<Record<string, unknown>>).filter((binding) => binding.familyId !== "family.scene3d-animation-gpu-preview@1");
    catalog.samples = (catalog.samples as Array<Record<string, unknown>>).filter((sample) => sample.id !== "sample.scene3d-animation.direct-gpu-preview@1");
    await synchronizeCatalog(root, catalog);

    const errors = await validateRenderingSampleCatalog(root);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("publicCapabilityFamilies must exactly equal the checked public rendering-family authority inventory");
    expect(errors[0]).toContain("family.scene3d-animation-gpu-preview@1");
  });

  it.runIf(hasImplementationExportManifest)("fails closed when the direct Scene3D preview recipe is not positively selected for public export", async () => {
    const root = await fixture();
    const manifestPath = join(root, "scripts/public-export-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { include: Array<{ path: string }> };
    manifest.include = manifest.include.filter((entry) => entry.path !== "packages");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const errors = await validateRenderingSampleCatalog(root);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("sample.scene3d-animation.direct-gpu-preview@1 direct source recipe is not positively included by scripts/public-export-manifest.json: missing packages")
    ]));
  });

  it("fails closed when the registered glTF CLI input identity drifts", async () => {
    const root = await fixture();
    const catalog = JSON.parse(await readFile(join(root, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const workflow = (catalog.familyWorkflowBindings as Array<Record<string, unknown>>).find((candidate) => candidate.familyId === "family.fixed-scene3d-and-gltf@1")!;
    (workflow.input as Record<string, unknown>).sha256 = "0".repeat(64);
    await synchronizeCatalog(root, catalog);

    const errors = await validateRenderingSampleCatalog(root);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("input fingerprint is stale for fixtures/imports/gltf-triangle/input.gltf")
    ]));
  });

  it("refuses a path-reveal registration that omits the animated reveal-window evidence", async () => {
    const root = await fixture();
    const catalog = JSON.parse(await readFile(join(root, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const binding = (catalog.familySampleBindings as Array<Record<string, unknown>>).find((candidate) => candidate.familyId === "family.path-reveals@1")!;
    const recipe = binding.capabilityRecipe as Record<string, unknown>;
    recipe.expectedJsonValues = (recipe.expectedJsonValues as Array<Record<string, unknown>>).filter((evidence) => evidence.pointer !== "/layers/0/keyframes/pathReveal.end/2/value");
    await synchronizeCatalog(root, catalog);

    const errors = await validateRenderingSampleCatalog(root);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("family.path-reveals@1: registered bindings must prove one browser-compatible shape path/freeform")
    ]));
  });

  it("fails closed when compositing registration drops its direct parity source", async () => {
    const root = await fixture();
    const catalog = JSON.parse(await readFile(join(root, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const families = catalog.publicCapabilityFamilies as Array<Record<string, unknown>>;
    const family = families.find((candidate) => candidate.id === "family.compositing-graphs@1")!;
    family.sampleIds = ["sample.compositing-graph-parity.browser-preview@1"];
    catalog.familySampleBindings = (catalog.familySampleBindings as Array<Record<string, unknown>>).filter((binding) => binding.sampleId !== "sample.compositing-direct-parity.browser-preview@1");
    catalog.releaseGate = {
      schema: "shellx-motion/rendering-sample-release-gate@1",
      state: "blocked",
      blockers: renderingSampleReleaseBlockers(catalog)
    };
    await synchronizeCatalog(root, catalog);

    const errors = await validateRenderingSampleCatalog(root);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("family.compositing-graphs@1: registered bindings must jointly pin the data-only compositing graph's source/matte/blend/output topology and its checked direct alpha-matte/screen/blur parity source.")
    ]));
  });

  it("fails closed when compositing registration stops pinning its matte port", async () => {
    const root = await fixture();
    const catalog = JSON.parse(await readFile(join(root, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const binding = (catalog.familySampleBindings as Array<Record<string, unknown>>).find((candidate) => candidate.sampleId === "sample.compositing-graph-parity.browser-preview@1")!;
    const recipe = binding.capabilityRecipe as Record<string, unknown>;
    recipe.expectedJsonValues = (recipe.expectedJsonValues as Array<Record<string, unknown>>).filter((evidence) => evidence.pointer !== "/compositing/edges/4/to/port");
    await synchronizeCatalog(root, catalog);

    const errors = await validateRenderingSampleCatalog(root);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("family.compositing-graphs@1: registered bindings must jointly pin the data-only compositing graph's source/matte/blend/output topology and its checked direct alpha-matte/screen/blur parity source.")
    ]));
  });

  it("fails closed when the keying-and-roto workflow stops referencing its public fixture", async () => {
    const root = await fixture();
    const catalog = JSON.parse(await readFile(join(root, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const workflow = (catalog.familyWorkflowBindings as Array<Record<string, unknown>>).find((candidate) => candidate.familyId === "family.keying-and-roto@1")!;
    workflow.inputPaths = ["fixtures/packages/gpu-material-admitted/assets/missing.png"];
    await synchronizeCatalog(root, catalog);

    const errors = await validateRenderingSampleCatalog(root);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("input path is missing or unsafe: fixtures/packages/gpu-material-admitted/assets/missing.png")
    ]));
  });

  it("fails closed when a sample source fingerprint or capability binding drifts", async () => {
    const root = await fixture();
    const catalogPath = join(root, "docs/public/rendering-sample-catalog.json");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as { samples: Array<{ capabilityId: string; source: { fingerprint: string } }> };
    catalog.samples[0]!.source.fingerprint = "0".repeat(64);
    catalog.samples[0]!.capabilityId = "preview.browser-png@1";
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

    const errors = await validateRenderingSampleCatalog(root);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("catalog fingerprint is stale"),
      expect.stringContaining("source fingerprint is stale"),
      expect.stringContaining("sourceCheckout must use --lane browser for preview.browser-png@1"),
      expect.stringContaining("expected exactly one truthful public sample, found 0")
    ]));
  });
});
