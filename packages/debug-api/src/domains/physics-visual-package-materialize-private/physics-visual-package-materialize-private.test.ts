import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { compilePhysicsVisualRetainedStaticPlan } from "../physics-visual-retained-private/physics-visual-retained-private.js";
import { physicsVisualFixture, retainedRecipe } from "../physics-visual-retained-private/physics-visual-retained.test-support.js";
import { createPhysicsShowcasePresentationRecipe } from "../physics-showcase-scenario-private/unadopted/physics-showcase-scenario-private.js";
import { compilePhysicsVisualPresentationStaticPlan } from "../physics-visual-presentation-private/physics-visual-presentation-private.js";
import { PHYSICS_VISUAL_PRESENTATION_SCHEMA } from "../physics-visual-presentation-private/physics-visual-presentation-types-private.js";
import {
  C7B4D_ARTIFACT_ROOT,
  C7B4D_RECEIPT_PATH,
  C7B4D_SIDECAR_PATH,
} from "./physics-visual-package-materialize-facts-private.js";
import {
  materializePhysicsVisualPackage,
  preparePhysicsVisualPackageMaterialization,
  reopenPhysicsVisualPackageMaterializationOutput,
  reopenPhysicsVisualPackagePreviewInput,
} from "./physics-visual-package-materialize-private.js";

const roots: string[] = [];
const portableExportPath = process.env.MOTION_C7B4D_PORTABLE_EXPORT_PATH?.trim();
const portableReopenPath = process.env.MOTION_C7B4D_PORTABLE_REOPEN_PATH?.trim();
const fault = vi.hoisted(() => ({ output: "", renamed: false, postInstall: false, outputManifestOpens: 0, afterCommitFaulted: false, precommitSource: "", precommitArtifactSegment: "", precommitTriggerManifest: "", beforeCommitClaimed: false, beforeCommitFaulted: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>(), path = await import("node:path");
  return {
    ...actual,
    rename: (async (...args: unknown[]) => {
      const from = typeof args[0] === "string" ? path.resolve(args[0]) : "", to = typeof args[1] === "string" ? path.resolve(args[1]) : "";
      const result = await (actual.rename as (...inner: unknown[]) => Promise<void>)(...args);
      if ((fault.precommitSource || fault.precommitArtifactSegment) && from === fault.output) fault.beforeCommitClaimed = true;
      if (fault.postInstall && path.basename(from) === "package" && to === fault.output) { fault.renamed = true; fault.outputManifestOpens = 0; }
      return result;
    }) as typeof actual.rename,
    open: (async (...args: unknown[]) => {
      const file = typeof args[0] === "string" ? path.resolve(args[0]) : "";
      if (fault.beforeCommitClaimed && file === fault.precommitTriggerManifest) {
        if (fault.precommitSource) { const motion = JSON.parse(await actual.readFile(fault.precommitSource, "utf8")); motion.name = "C7B4D source drift at beforeCommit"; await actual.writeFile(fault.precommitSource, `${JSON.stringify(motion)}\n`, "utf8"); fault.precommitSource = ""; }
        if (fault.precommitArtifactSegment) { await actual.writeFile(fault.precommitArtifactSegment, Buffer.from("C7B4D external artifact drift")); fault.precommitArtifactSegment = ""; }
        fault.beforeCommitFaulted = true;
      }
      if (fault.postInstall && fault.renamed && file === path.join(fault.output, "manifest.json") && ++fault.outputManifestOpens >= 2) { fault.postInstall = false; fault.renamed = false; fault.afterCommitFaulted = true; throw Object.assign(new Error("test-only C7B4D afterCommit reopen failure"), { code: "EIO" }); }
      return await (actual.open as (...inner: unknown[]) => Promise<any>)(...args);
    }) as typeof actual.open,
  };
});
afterEach(async () => {
  fault.output = ""; fault.renamed = false; fault.postInstall = false; fault.outputManifestOpens = 0; fault.afterCommitFaulted = false;
  fault.precommitSource = ""; fault.precommitArtifactSegment = ""; fault.precommitTriggerManifest = ""; fault.beforeCommitClaimed = false; fault.beforeCommitFaulted = false;
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux")("private C7B4D physics-visual package materializer", () => {
  it("embeds byte-identical C7B3 data plus canonical recipes and reopens after both original inputs are deleted", async () => {
    const value = await fixture();
    const sourceBefore = await snapshotPackageEditTree(value.source), artifactManifest = await readFile(join(value.physics.host.outputRoot, "manifest.json")), artifactReceipt = await readFile(join(value.physics.host.outputRoot, "receipt.json"));
    const result = await invoke(value), output = await snapshotPackageEditTree(value.output);
    expect((await snapshotPackageEditTree(value.source)).entries).toEqual(sourceBefore.entries);
    expect(await readFile(join(value.output, C7B4D_ARTIFACT_ROOT, "manifest.json"))).toEqual(artifactManifest);
    expect(await readFile(join(value.output, C7B4D_ARTIFACT_ROOT, "receipt.json"))).toEqual(artifactReceipt);
    for (const segment of await readdir(join(value.physics.host.outputRoot, "segments"))) expect(await readFile(join(value.output, C7B4D_ARTIFACT_ROOT, "segments", segment))).toEqual(await readFile(join(value.physics.host.outputRoot, "segments", segment)));
    expect([...output.entries.keys()].filter((path) => !sourceBefore.entries.has(path) && output.entries.get(path)?.startsWith("file:"))).toContain(C7B4D_SIDECAR_PATH);
    expect(result.receipt.evidence).toEqual({ rendererInvoked: false, pixels: false, providerInvoked: false, videoInvoked: false });
    const installed = await reopenPhysicsVisualPackageMaterializationOutput(outputHost(value));
    expect(installed).toMatchObject({ presentationStaticFingerprint: value.prepared.expected.plans.presentationStaticFingerprint, plans: value.prepared.expected.plans, renderer: { invoked: false, providerInvoked: false } });
    await rm(value.source, { recursive: true, force: true }); await rm(value.physics.host.outputRoot, { recursive: true, force: true });
    await expect(reopenPhysicsVisualPackageMaterializationOutput(outputHost(value))).resolves.toMatchObject({ artifact: value.prepared.expected.externalArtifact });
    await expect(reopenPhysicsVisualPackagePreviewInput(outputHost(value))).resolves.toMatchObject({ presentationStaticPlan: { fingerprint: value.prepared.expected.plans.presentationStaticFingerprint } });
  });

  it("refuses forged or reused approval, expected-base drift and an occupied output", async () => {
    const forged = await fixture(), drift = await fixture(), occupied = await fixture(), reused = await fixture();
    await expect(materializePhysicsVisualPackage(forged.host, Object.freeze({}) as never, forged.request)).rejects.toThrow(/host-minted/i);
    await expect(materializePhysicsVisualPackage(drift.host, drift.prepared.approval, { ...drift.request, expected: { ...drift.request.expected, recipeBundleFingerprint: "0".repeat(64) } })).rejects.toThrow(/source|exact/i);
    await mkdir(occupied.output, { mode: 0o700 });
    await expect(invoke(occupied)).rejects.toThrow(/absent|output/i);
    await expect(invoke(reused)).resolves.toBeTruthy();
    await expect(invoke(reused)).rejects.toThrow(/consumed|absent|output/i);
  });

  it("requires the exact compiler-minted C7B4C plan, both separate authority references, and absent fixed targets", async () => {
    const cloned = await fixture(), wrongPackage = await fixture(), wrongPhysics = await fixture(), existing = await fixture();
    await expect(preparePhysicsVisualPackageMaterialization(cloned.host, structuredClone(cloned.presentation), cloned.recipes)).rejects.toThrow(/compiler-minted|exact terminal/i);
    const replacementPackageAuthority = await createTrustedWorkspaceAnchor(wrongPackage.workspace);
    await expect(materializePhysicsVisualPackage({ ...wrongPackage.host, packageWorkspaceAuthority: replacementPackageAuthority }, wrongPackage.prepared.approval, wrongPackage.request)).rejects.toThrow(/authority|bound/i);
    const replacementPhysicsAuthority = await createTrustedWorkspaceAnchor(wrongPhysics.physics.host.workspaceRoot);
    await expect(materializePhysicsVisualPackage({ ...wrongPhysics.host, physicsWorkspaceAuthority: replacementPhysicsAuthority }, wrongPhysics.prepared.approval, wrongPhysics.request)).rejects.toThrow(/authority|bound/i);
    await mkdir(join(existing.source, "analysis", "scene-recipe"), { recursive: true, mode: 0o700 });
    await writeFile(join(existing.source, C7B4D_SIDECAR_PATH), "{}\n", "utf8");
    await expect(invoke(existing)).rejects.toThrow(/fixed|sidecar|artifact/i);
    await expect(lstat(existing.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("materializes both C7B4D route fixtures", async () => {
    const bingo = await fixture("bingo"), wall = await fixture("wall");
    await expect(invoke(bingo)).resolves.toMatchObject({ receipt: { approval: { base: { plans: { presentationStaticFingerprint: bingo.prepared.expected.plans.presentationStaticFingerprint } } } } });
    await expect(invoke(wall)).resolves.toMatchObject({ receipt: { approval: { base: { plans: { presentationStaticFingerprint: wall.prepared.expected.plans.presentationStaticFingerprint } } } } });
    await expect(reopenPhysicsVisualPackageMaterializationOutput(outputHost(wall))).resolves.toMatchObject({ plans: wall.prepared.expected.plans });
  });

  it.skipIf(!portableExportPath)("exports a Linux-produced installed output for cross-host reopen proof", async () => {
    const value = await fixture("wall");
    await invoke(value);
    const target = resolve(portableExportPath!);
    await cp(value.output, target, { recursive: true, force: false, errorOnExist: true });
    await expect(reopenPhysicsVisualPackageMaterializationOutput({
      outputPackageRoot: target,
      packageWorkspaceRoot: resolve(target, ".."),
      packageWorkspaceAuthority: await createTrustedWorkspaceAnchor(resolve(target, "..")),
    })).resolves.toMatchObject({ plans: value.prepared.expected.plans });
  });

  it("replays fixed artifact, sidecar and receipt bytes and rejects tampered installed leaves", async () => {
    const first = await fixture(), replay = await fixture(), sidecar = await fixture(), artifact = await fixture(), receipt = await fixture(), extra = await fixture(), empty = await fixture();
    await Promise.all([invoke(first), invoke(replay), invoke(sidecar), invoke(artifact), invoke(receipt), invoke(extra), invoke(empty)]);
    for (const path of [join(C7B4D_ARTIFACT_ROOT, "manifest.json"), C7B4D_SIDECAR_PATH, C7B4D_RECEIPT_PATH]) expect(await readFile(join(first.output, path))).toEqual(await readFile(join(replay.output, path)));
    await writeFile(join(sidecar.output, C7B4D_SIDECAR_PATH), "{}\n", "utf8");
    await writeFile(join(artifact.output, C7B4D_ARTIFACT_ROOT, "segments", "000000.bin"), Buffer.from("tampered"));
    const receiptJson = JSON.parse(await readFile(join(receipt.output, C7B4D_RECEIPT_PATH), "utf8")); receiptJson.fingerprint = "0".repeat(64); await json(join(receipt.output, C7B4D_RECEIPT_PATH), receiptJson);
    await writeFile(join(extra.output, "unexpected-leaf.txt"), "unexpected\n", "utf8");
    await rm(join(empty.output, "assets", "empty"), { recursive: true });
    await expect(reopenPhysicsVisualPackageMaterializationOutput(outputHost(sidecar))).rejects.toThrow(/sidecar|C7B4D|canonical/i);
    await expect(reopenPhysicsVisualPackageMaterializationOutput(outputHost(artifact))).rejects.toThrow(/segment|artifact|C7B4D/i);
    await expect(reopenPhysicsVisualPackageMaterializationOutput(outputHost(receipt))).rejects.toThrow(/receipt|C7B4D|fingerprint/i);
    await expect(reopenPhysicsVisualPackageMaterializationOutput(outputHost(extra))).rejects.toThrow(/inventory|C7B4D|copy/i);
    await expect(reopenPhysicsVisualPackageMaterializationOutput(outputHost(empty))).rejects.toThrow(/inventory|C7B4D|copy/i);
  });

  it("refuses embedded artifact hard links and symlinks", async () => {
    const hardLink = await fixture(), symbolicLink = await fixture();
    await Promise.all([invoke(hardLink), invoke(symbolicLink)]);
    const hardLinkSegment = join(hardLink.output, C7B4D_ARTIFACT_ROOT, "segments", "000000.bin");
    await rm(hardLinkSegment); await link(join(hardLink.physics.host.outputRoot, "segments", "000000.bin"), hardLinkSegment);
    const symbolicLinkSegment = join(symbolicLink.output, C7B4D_ARTIFACT_ROOT, "segments", "000000.bin");
    await rm(symbolicLinkSegment); await symlink(join(symbolicLink.source, "keep.txt"), symbolicLinkSegment);
    await expect(reopenPhysicsVisualPackageMaterializationOutput(outputHost(hardLink))).rejects.toThrow(/C7B3|C7B4D|artifact|regular|link|closed-inventory/i);
    await expect(reopenPhysicsVisualPackageMaterializationOutput(outputHost(symbolicLink))).rejects.toThrow(/C7B3|C7B4D|artifact|regular|link|closed-inventory/i);
  });

  it("refuses a source C7B3 segments-directory symlink before any output claim", async () => {
    const value = await fixture(), segments = join(value.physics.host.outputRoot, "segments"), retained = join(value.physics.host.outputRoot, "segments-retained");
    await rename(segments, retained); await symlink(retained, segments);
    await expect(invoke(value)).rejects.toThrow(/C7B3|segment|symlink|artifact|source/i);
    await expect(lstat(value.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses source and external-artifact precommit drift with no output, then retains an uncertain installed output for explicit reopen", async () => {
    const sourceDrift = await fixture(), artifactDrift = await fixture(), uncertain = await fixture();
    fault.output = resolve(sourceDrift.output); fault.precommitSource = resolve(join(sourceDrift.source, "motion.json")); fault.precommitTriggerManifest = resolve(join(sourceDrift.source, "manifest.json"));
    await expect(invoke(sourceDrift)).rejects.toThrow(/source|exact|rederive|document/i);
    expect(fault.beforeCommitFaulted).toBe(true);
    await expect(lstat(sourceDrift.output)).rejects.toMatchObject({ code: "ENOENT" });
    fault.output = resolve(artifactDrift.output); fault.precommitArtifactSegment = resolve(join(artifactDrift.physics.host.outputRoot, "segments", "000000.bin")); fault.precommitTriggerManifest = resolve(join(artifactDrift.source, "manifest.json")); fault.beforeCommitClaimed = false; fault.beforeCommitFaulted = false;
    await expect(invoke(artifactDrift)).rejects.toThrow(/source|artifact|C7B3|rederive/i);
    expect(fault.beforeCommitFaulted).toBe(true);
    await expect(lstat(artifactDrift.output)).rejects.toMatchObject({ code: "ENOENT" });
    fault.output = resolve(uncertain.output); fault.precommitSource = ""; fault.precommitArtifactSegment = ""; fault.precommitTriggerManifest = ""; fault.beforeCommitClaimed = false; fault.postInstall = true; fault.renamed = false; fault.afterCommitFaulted = false;
    const error = await invoke(uncertain).catch((reason: unknown) => reason as { readonly code?: unknown; readonly evidence?: unknown });
    expect(fault.afterCommitFaulted).toBe(true);
    expect(error).toMatchObject({ code: "publication_commit_uncertain", evidence: { publicPath: uncertain.output, kind: "directory" } });
    await expect(reopenPhysicsVisualPackageMaterializationOutput(outputHost(uncertain))).resolves.toMatchObject({ plans: uncertain.prepared.expected.plans });
  });
});

describe("private C7B4D portable installed output", () => {
  it.skipIf(!portableReopenPath)("reopens a Linux-produced package without either original input", async () => {
    const outputPackageRoot = resolve(portableReopenPath!);
    const packageWorkspaceRoot = resolve(outputPackageRoot, "..");
    const packageWorkspaceAuthority = await createTrustedWorkspaceAnchor(packageWorkspaceRoot);
    const host = { outputPackageRoot, packageWorkspaceRoot, packageWorkspaceAuthority };
    const installed = await reopenPhysicsVisualPackageMaterializationOutput(host);
    expect(installed).toMatchObject({
      schema: "shellx-motion/private-physics-visual-package-installed-output@1",
      renderer: { invoked: false, pixels: false, providerInvoked: false, videoInvoked: false },
    });
    await expect(reopenPhysicsVisualPackagePreviewInput(host)).resolves.toMatchObject({
      presentationStaticPlan: { fingerprint: installed.presentationStaticFingerprint },
      installed: { renderer: { invoked: false, pixels: false, providerInvoked: false, videoInvoked: false } },
    });
  });
});

describe("private C7B4D static boundary", () => {
  it("uses only the existing private host export and keeps mutation/reopen out of provider, renderer and public surfaces", async () => {
    const [writer, output, privateExport, publicIndex, packageJson, ...publicSurfaces] = await Promise.all([
      readFile(new URL("./physics-visual-package-materialize-private.ts", import.meta.url), "utf8"),
      readFile(new URL("./physics-visual-package-materialize-output-private.ts", import.meta.url), "utf8"),
      readFile(new URL("../../internal/physics-visual-retained-render.ts", import.meta.url), "utf8"),
      readFile(new URL("../../index.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../package.json", import.meta.url), "utf8"),
      ...["../../../../actions/src/catalog.ts", "../../../../cli/src/main.ts", "../../../../connectors/src/index.ts", "../../../../renderer-browser/src/index.ts", "../../../../renderer-ffmpeg/src/index.ts", "../../../../renderer-native/src/index.ts", "../../../../sdk/src/index.ts"].map(async (path) => await readFile(new URL(path, import.meta.url), "utf8")),
    ]);
    expect(`${writer}\n${output}`).not.toMatch(/bakePhysicsWithPinnedRapier|renderer-browser|renderer-ffmpeg|createGpu|WebGPU|encodeGpuPng|dispatchDebugCommand/u);
    expect(privateExport).toMatch(/preparePhysicsVisualPackageMaterialization/u);
    expect(publicIndex).not.toMatch(/physics-visual-package/u);
    expect(JSON.parse(packageJson).exports).not.toHaveProperty("./internal/physics-visual-package");
    expect(publicSurfaces.join("\n")).not.toMatch(/physics-visual-package|physicsVisualPackage|motion\.physics/u);
  });
});

async function fixture(kind: "bingo" | "wall" = "bingo") {
  const physics = await physicsVisualFixture(kind), root = await mkdtemp(join(tmpdir(), "shellx-motion-c7b4d-"));
  roots.push(physics.root, root);
  const workspace = join(root, "packages"), source = join(workspace, "source"), output = join(workspace, "output");
  await mkdir(join(source, "assets", "empty"), { recursive: true, mode: 0o700 }); await chmod(workspace, 0o700); await chmod(source, 0o700);
  await json(join(source, "manifest.json"), { schema: "shellx-motion/package-manifest@1", id: "c7b4d-package", name: "C7B4D package", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: [], hosts: [] } });
  await json(join(source, "motion.json"), { schema: "shellx-motion/motion@1", id: "c7b4d-motion", name: "C7B4D package", durationMs: 1000, fps: 30, width: 640, height: 360, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "placeholder", type: "shape", shape: "rect", fill: "#07111f", opacity: 1, startMs: 0, durationMs: 1000, transform: { x: 0, y: 0, width: 640, height: 360 } }] });
  await writeFile(join(source, "keep.txt"), "keep\n", "utf8");
  const retained = compilePhysicsVisualRetainedStaticPlan(physics.visualPlan, retainedRecipe(physics.visualPlan.fingerprint, kind)), presentation = compilePhysicsVisualPresentationStaticPlan(retained, physics.physicsPlan, kind === "bingo" ? createPhysicsShowcasePresentationRecipe(physics.compilation, retained.fingerprint, physics.physicsPlan) : wallPresentation(retained.fingerprint, physics.physicsPlan.fingerprint));
  const host = { sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: await createTrustedWorkspaceAnchor(workspace), physicsBakeArtifactRoot: physics.host.outputRoot, physicsWorkspaceRoot: physics.host.workspaceRoot, physicsWorkspaceAuthority: physics.host.workspaceAuthority, requireAbsentOutput: true as const };
  const recipes = { physicsBake: physics.physicsPlan.recipe, visualBinding: physics.visualPlan.recipe, retainedRender: retained.recipe, presentation: presentation.recipe };
  const prepared = await preparePhysicsVisualPackageMaterialization(host, presentation, recipes);
  return { root, physics, workspace, source, output, host, recipes, presentation, prepared, request: { schema: "shellx-motion/private-physics-visual-package-materialization-request@1", expected: prepared.expected } };
}
function invoke(value: Awaited<ReturnType<typeof fixture>>, request: unknown = value.request) { return materializePhysicsVisualPackage(value.host, value.prepared.approval, request); }
function outputHost(value: Awaited<ReturnType<typeof fixture>>) { return { outputPackageRoot: value.output, packageWorkspaceRoot: value.workspace, packageWorkspaceAuthority: value.host.packageWorkspaceAuthority }; }
function wallPresentation(retainedStaticFingerprint: string, physicsPlanFingerprint: string) { return { schema: PHYSICS_VISUAL_PRESENTATION_SCHEMA, retainedStaticFingerprint, physicsPlanFingerprint, additionalResources: { geometry: [{ id: "z-ground-visual", kind: "box", size: [20, 0.2, 8] }, { id: "z-tether-visual", kind: "box", size: [0.08, 1, 0.08] }], materials: [{ id: "z-ground-matte", kind: "basic", baseColor: "#26364a", emissive: 0 }, { id: "z-tether-steel", kind: "basic", baseColor: "#d9e2ec", emissive: 0.04 }] }, staticCollisionBindings: [{ bodyId: "ground", geometryRef: "z-ground-visual", materialRef: "z-ground-matte" }], constraintBindings: [{ constraintId: "tether", geometryRef: "z-tether-visual", materialRef: "z-tether-steel" }], presentationBindings: [] }; }
async function json(path: string, value: unknown): Promise<void> { await writeFile(path, `${canonicalJson(value)}\n`, "utf8"); }
