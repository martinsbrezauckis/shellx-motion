import { lstat, mkdir, mkdtemp, readFile, readdir, rmdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalJsonSha256,
  hashPackageFile,
  loadMotionPackage,
} from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { captureTrustedWorkspaceCompleteDirectoryInventory } from "@shellx-motion/core/internal/closed-directory-inventory";
import {
  CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_MATERIALIZER_PROFILE,
  approveCheckpointStoryboardScalarSpatialMaterialization,
  compileCheckpointStoryboardScalarSpatialPlan,
  createCheckpointStoryboard,
  createTransitionRecipe,
  readApprovedCheckpointStoryboardScalarSpatialMaterialization,
  CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_REQUEST_SCHEMA,
} from "@shellx-motion/core/internal/checkpoint-storyboard-scalar-spatial-materializer";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { materializeCheckpointStoryboardScalarSpatial } from "../checkpoint-storyboard-scalar-spatial-materialize-private.js";

const HASH = "a".repeat(64);
const TEST_PARENT = join(process.cwd(), ".c6b1b-test");
const itLinux = process.platform === "linux" ? it : it.skip;

/** Test-only fs fault seam: no stage route is ever provided to the materializer caller. */
const fsFault = vi.hoisted(() => ({
  stageSource: "", stageArmed: false,
  sourceRaceSource: "", sourceRaceArmed: false,
  outputRaceOutput: "", outputRaceArmed: false,
  postRenameOutput: "", postRenameArmed: false,
  afterCommitOutput: "", afterCommitArmed: false,
  renameObserved: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const path = await import("node:path");
  return {
    ...actual,
    cp: (async (...args: any[]) => {
      const result = await (actual.cp as any)(...args);
      if (fsFault.stageArmed && typeof args[0] === "string" && typeof args[1] === "string" && path.resolve(args[0]) === fsFault.stageSource) {
        fsFault.stageArmed = false;
        await actual.writeFile(path.join(args[1], "assets", "nested", "leaf.txt"), "stage-raced\\n");
      }
      if (fsFault.sourceRaceArmed && typeof args[0] === "string" && path.resolve(args[0]) === fsFault.sourceRaceSource) {
        fsFault.sourceRaceArmed = false;
        await actual.writeFile(path.join(args[0], "assets", "nested", "leaf.txt"), "source-raced\\n");
      }
      return result;
    }) as typeof actual.cp,
    rename: (async (...args: any[]) => {
      const result = await (actual.rename as any)(...args);
      if (fsFault.outputRaceArmed && typeof args[0] === "string" && typeof args[1] === "string" && path.resolve(args[0]) === fsFault.outputRaceOutput && path.basename(args[1]) === "previous-output") {
        fsFault.outputRaceArmed = false;
        await actual.mkdir(args[0]); await actual.writeFile(path.join(args[0], "intruder"), "output-raced\\n");
      }
      if ((fsFault.postRenameArmed || fsFault.afterCommitArmed) && typeof args[0] === "string" && typeof args[1] === "string" && path.basename(args[0]) === "package" && path.resolve(args[1]) === (fsFault.postRenameArmed ? fsFault.postRenameOutput : fsFault.afterCommitOutput)) fsFault.renameObserved = true;
      return result;
    }) as typeof actual.rename,
    lstat: (async (...args: any[]) => {
      if (fsFault.postRenameArmed && fsFault.renameObserved && typeof args[0] === "string" && path.resolve(args[0]) === fsFault.postRenameOutput) {
        fsFault.postRenameArmed = false; fsFault.renameObserved = false;
        throw Object.assign(new Error("test-only post-rename observation failure"), { code: "EIO" });
      }
      return await (actual.lstat as any)(...args);
    }) as typeof actual.lstat,
    open: (async (...args: any[]) => {
      if (fsFault.afterCommitArmed && fsFault.renameObserved && typeof args[0] === "string" && path.resolve(args[0]) === path.join(fsFault.afterCommitOutput, "manifest.json")) {
        fsFault.afterCommitArmed = false; fsFault.renameObserved = false;
        throw Object.assign(new Error("test-only post-install reopen failure"), { code: "EIO" });
      }
      return await (actual.open as any)(...args);
    }) as typeof actual.open,
  };
});

function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as object)) deepFreeze(child); Object.freeze(value); } return value; }

async function fixture(options: { fixedReceipt?: boolean; source?: "uncompiled-compositing" } = {}) {
  await mkdir(TEST_PARENT, { recursive: true });
  const root = await mkdtemp(join(TEST_PARENT, "run-"));
  const workspace = join(root, "workspace"), source = join(workspace, "source"), output = join(workspace, "out");
  await mkdir(join(source, "assets", "nested"), { recursive: true });
  await mkdir(join(source, "receipts"), { recursive: true });
  const manifest = { schema: "shellx-motion/package-manifest@1", id: "package-1", name: "C6B1b", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["native"], hosts: [] } };
  const motion = { schema: "shellx-motion/motion@1", id: "motion-1", name: "C6B1b", durationMs: 1_000, fps: 30, width: 1280, height: 720, layers: [{ id: "orb", type: "shape", shape: "ellipse", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, rotation: 0, scale: 1 }, opacity: 1 }], assets: [], provenance: { sourceApp: "test", createdBy: "test" } };
  if (options.source === "uncompiled-compositing") Object.assign(motion, { compositing: { schema: "shellx-motion/compositing-graph@1", id: "c", nodes: [{ id: "source", type: "source", layerId: "orb" }, { id: "output", type: "output" }], edges: [{ id: "out", from: { nodeId: "source", port: "output" }, to: { nodeId: "output", port: "input" } }] } });
  await writeJson(join(source, "manifest.json"), manifest); await writeJson(join(source, "motion.json"), motion);
  await writeFile(join(source, "assets", "nested", "leaf.txt"), "preserve me\n"); await writeFile(join(source, "receipts", "prior.json"), "{\"prior\":true}\n");
  if (options.fixedReceipt) await writeFile(join(source, "receipts", "checkpoint-storyboard-scalar-spatial-materialization.v1.json"), "{}\n");
  const authority = await createTrustedWorkspaceAnchor(workspace);
  const { pkg, raw } = await withTrustedWorkspaceAnchor(authority, async () => ({ pkg: await loadMotionPackage(source), raw: { manifest: await hashPackageFile(join(source, "manifest.json")), motion: await hashPackageFile(join(source, "motion.json")) } }));
  const scalar = createTransitionRecipe({ recipeId: "scalar", seed: 2, exactBaseRequirements: [], intent: { kind: "checkpoint-keyframe", easing: "ease-in-out", targets: [{ objectId: "orb", propertyMask: ["transform.rotation"] }] } });
  const spatial = createTransitionRecipe({ recipeId: "spatial", seed: 3, exactBaseRequirements: [], intent: { kind: "checkpoint-spatial-path", targets: [{ objectId: "orb", tangentMode: "auto" }] } });
  const storyboard = createCheckpointStoryboard({ seed: 1, capabilityRequirements: ["renderer.native"], objectCatalog: [{ objectId: "orb", rootShapeKind: "ellipse", propertyMask: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] }], checkpoints: [
    { id: "zero", atUs: 0, objects: [{ objectId: "orb", state: "present", properties: [{ property: "transform.x", value: 0 }, { property: "transform.y", value: 0 }, { property: "transform.rotation", value: 0 }, { property: "transform.scale", value: 1 }, { property: "opacity", value: 1 }] }] },
    { id: "finish", atUs: 1_000_000, objects: [{ objectId: "orb", state: "present", properties: [{ property: "transform.x", value: 100 }, { property: "transform.y", value: 50 }, { property: "transform.rotation", value: 90 }, { property: "transform.scale", value: 1 }, { property: "opacity", value: 1 }] }] },
  ], edges: [{ id: "edge", fromCheckpointId: "zero", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "orb" }], recipeIds: ["scalar", "spatial"] }], recipes: [scalar, spatial] });
  const request = deepFreeze({ schema: CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_REQUEST_SCHEMA, storyboard, base: { packageId: pkg.manifest.id, manifest: pkg.manifest, motion: pkg.motion, persistedMotionSha256: raw.motion }, objectLayerBindings: [{ objectId: "orb", layerId: "orb" }] });
  const plan = compileCheckpointStoryboardScalarSpatialPlan(request);
  const approval = approveCheckpointStoryboardScalarSpatialMaterialization(Object.freeze({ request, plan }));
  const projection = readApprovedCheckpointStoryboardScalarSpatialMaterialization(approval).projection;
  const inventory = await inventoryFor(source, workspace, authority);
  const expected = { packageId: pkg.manifest.id, manifestRawSha256: raw.manifest, motionRawSha256: raw.motion, manifestCanonicalSha256: canonicalJsonSha256(pkg.manifest), motionCanonicalSha256: canonicalJsonSha256(pkg.motion), inventory, c6aPlanFingerprint: plan.fingerprint, c6b1bProfileFingerprint: CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_MATERIALIZER_PROFILE.fingerprint, c6b1bProjectionFingerprint: projection.fingerprint };
  return { root, workspace, source, output, approval, request: { schema: "shellx-motion/private-checkpoint-storyboard-scalar-spatial-materialization-request@1", expected }, authority };
}

describe("private C6B1b scalar/spatial COW materializer", () => {
  itLinux("reopens the approved exact base when the host output is absent", async () => {
    const value = await fixture();
    try {
      const result = await invoke(value);
      expect(result.packageRoot).toBe(value.output);
      expect(JSON.parse(await readFile(join(value.output, "motion.json"), "utf8")).layers[0].keyframes).toHaveProperty("transform.rotation");
      await expect(readFile(join(value.output, "receipts", "checkpoint-storyboard-scalar-spatial-materialization.v1.json"), "utf8")).resolves.toContain(result.receipt.fingerprint);
    } finally { await dispose(value.root); }
  });

  itLinux("reopens the approved exact base, permits an empty output, and preserves every unrelated leaf", async () => {
    const value = await fixture();
    try {
      await mkdir(value.output);
      const before = await snapshotPackageEditTree(value.source);
      const result = await materializeCheckpointStoryboardScalarSpatial({ sourcePackageRoot: value.source, outputPackageRoot: value.output, packageWorkspaceRoot: value.workspace, packageWorkspaceAuthority: value.authority }, value.approval, value.request);
      const after = await snapshotPackageEditTree(value.source), output = await snapshotPackageEditTree(value.output), reopened = await withTrustedWorkspaceAnchor(value.authority, async () => await loadMotionPackage(value.output));
      expect(after.entries).toEqual(before.entries);
      expect([...output.entries.keys()].filter((path) => !before.entries.has(path))).toEqual(["receipts/checkpoint-storyboard-scalar-spatial-materialization.v1.json"]);
      expect(reopened.motion.layers[0]!.keyframes).toMatchObject({
        "transform.rotation": [{ atMs: 0, value: 0, easing: "ease-in-out" }, { atMs: 1_000, value: 90 }],
        "transform.x": [{ atMs: 0, value: 0, easing: "linear", spatial: { mode: "auto" } }, { atMs: 1_000, value: 100, spatial: { mode: "auto" } }],
        "transform.y": [{ atMs: 0, value: 0, easing: "linear" }, { atMs: 1_000, value: 50 }],
      });
      expect(result.receipt.renderer).toEqual({ invoked: false });
      expect(result.receipt.output.changed).toEqual({
        paths: ["motion.json", "receipts/checkpoint-storyboard-scalar-spatial-materialization.v1.json"], count: 2,
        motionPropertyPaths: ["layers/0/keyframes/transform.rotation", "layers/0/keyframes/transform.x", "layers/0/keyframes/transform.y"], motionPropertyPathCount: 3,
      });
      const receiptText = await readFile(join(value.output, "receipts", "checkpoint-storyboard-scalar-spatial-materialization.v1.json"), "utf8");
      expect(receiptText).toContain(result.receipt.fingerprint); expect(receiptText).not.toContain(value.source); expect(receiptText).not.toContain(value.output);
      await expect(inventoryFor(value.output, value.workspace, value.authority)).resolves.toMatchObject({ entryCount: 5 });
    } finally { await dispose(value.root); }
  });

  itLinux("refuses a stale requested exact base and a fixed receipt collision before publication", async () => {
    const stale = await fixture(); const collision = await fixture({ fixedReceipt: true });
    try {
      await expect(materializeCheckpointStoryboardScalarSpatial({ sourcePackageRoot: stale.source, outputPackageRoot: stale.output, packageWorkspaceRoot: stale.workspace, packageWorkspaceAuthority: stale.authority }, stale.approval, { ...stale.request, expected: { ...stale.request.expected, motionRawSha256: HASH } })).rejects.toThrow(/exact base/i);
      await expect(materializeCheckpointStoryboardScalarSpatial({ sourcePackageRoot: collision.source, outputPackageRoot: collision.output, packageWorkspaceRoot: collision.workspace, packageWorkspaceAuthority: collision.authority }, collision.approval, collision.request)).rejects.toThrow(/fixed materialization receipt/i);
    } finally { await dispose(stale.root, collision.root); }
  });

  itLinux("rejects stale raw, canonical, inventory, plan/profile, asset, id, and binding facts", async () => {
    const value = await fixture();
    try {
      const variants = ["manifestRawSha256", "motionRawSha256", "manifestCanonicalSha256", "motionCanonicalSha256", "c6aPlanFingerprint", "c6b1bProfileFingerprint", "c6b1bProjectionFingerprint"] as const;
      for (const key of variants) await expect(invoke(value, { ...value.request, expected: { ...value.request.expected, [key]: HASH } })).rejects.toThrow(/exact base|profile|identity/i);
      await expect(invoke(value, { ...value.request, expected: { ...value.request.expected, inventory: { ...value.request.expected.inventory, sha256: HASH } } })).rejects.toThrow(/exact base|inventory/i);
      await writeFile(join(value.source, "assets", "nested", "leaf.txt"), "stale-asset\n");
      await expect(invoke(value)).rejects.toThrow(/exact base|rederives/i);
    } finally { await dispose(value.root); }

    const id = await fixture(), binding = await fixture();
    try {
      const manifest = JSON.parse(await readFile(join(id.source, "manifest.json"), "utf8")); manifest.id = "other-package"; await writeJson(join(id.source, "manifest.json"), manifest);
      const motion = JSON.parse(await readFile(join(binding.source, "motion.json"), "utf8")); motion.layers[0].id = "other-orb"; await writeJson(join(binding.source, "motion.json"), motion);
      await expect(invoke(id)).rejects.toThrow(/exact base|rederives/i);
      await expect(invoke(binding)).rejects.toThrow(/exact base|rederives|binding/i);
    } finally { await dispose(id.root, binding.root); }
  });

  itLinux("rejects forged approval and hostile tiny request accessors without evaluating them", async () => {
    const value = await fixture();
    try {
      await expect(materializeCheckpointStoryboardScalarSpatial(host(value), Object.freeze({}) as any, value.request)).rejects.toThrow(/approval/i);
      let reads = 0; const hostile = { schema: value.request.schema };
      Object.defineProperty(hostile, "expected", { enumerable: true, get() { reads += 1; return value.request.expected; } });
      await expect(invoke(value, hostile)).rejects.toThrow(/data field/i); expect(reads).toBe(0);
    } finally { await dispose(value.root); }
  });

  itLinux("requires exact workspace authority", async () => {
    const authority = await fixture();
    try {
      const wrongRoot = join(authority.workspace, "other"); await mkdir(wrongRoot);
      const wrongAuthority = await createTrustedWorkspaceAnchor(wrongRoot);
      await expect(materializeCheckpointStoryboardScalarSpatial({ ...host(authority), packageWorkspaceAuthority: wrongAuthority }, authority.approval, authority.request)).rejects.toThrow(/workspace authority/i);
    } finally { await dispose(authority.root); }
  });

  itLinux("refuses stage drift through a test-only fs mock and invalid source authority/compositing", async () => {
    const stage = await fixture(), compositing = await fixture({ source: "uncompiled-compositing" }), invalid = await fixture();
    try {
      fsFault.stageSource = resolve(stage.source); fsFault.stageArmed = true;
      await expect(invoke(stage)).rejects.toThrow(/staged package bytes|exact base|source.*changed/i);
      await expect(invoke(compositing)).rejects.toThrow(/compositing.*not idempotent/i);
      const invalidMotion = JSON.parse(await readFile(join(invalid.source, "motion.json"), "utf8"));
      invalidMotion.relationships = { schema: "shellx-motion/procedural-relationships@1", relationships: [{ id: "bad", enabled: false, target: { layerId: "orb", property: "transform.x" }, nodes: [], outputNodeId: "none" }] };
      await writeJson(join(invalid.source, "motion.json"), invalidMotion);
      await expect(invoke(invalid)).rejects.toThrow(/existing relationships authority/i);
    } finally {
      fsFault.stageArmed = false; fsFault.stageSource = "";
      await dispose(stage.root, compositing.root, invalid.root);
    }
  });

  itLinux("passes through post-rename publication uncertainty without rollback", async () => {
    const value = await fixture();
    try {
      fsFault.postRenameOutput = resolve(value.output); fsFault.renameObserved = false; fsFault.postRenameArmed = true;
      const error = await invoke(value).catch((reason: unknown) => reason as { code?: unknown });
      expect(error).toMatchObject({ code: "publication_commit_uncertain" });
      expect((await lstat(value.output)).isDirectory()).toBe(true);
      expect(JSON.parse(await readFile(join(value.output, "motion.json"), "utf8")).layers[0].keyframes).toHaveProperty("transform.rotation");
      await expect(readFile(join(value.output, "receipts", "checkpoint-storyboard-scalar-spatial-materialization.v1.json"), "utf8")).resolves.toContain("checkpoint-storyboard.scalar-spatial.materialize");
      expect((await readdir(value.workspace)).some((name) => name.startsWith(".out.shellx-edit-"))).toBe(true);
    } finally { fsFault.postRenameArmed = false; fsFault.renameObserved = false; fsFault.postRenameOutput = ""; await dispose(value.root); }
  });

  itLinux("retains the installed package when candidate afterCommit reopening cannot be observed", async () => {
    const value = await fixture();
    try {
      fsFault.afterCommitOutput = resolve(value.output); fsFault.renameObserved = false; fsFault.afterCommitArmed = true;
      const error = await invoke(value).catch((reason: unknown) => reason as { code?: unknown; evidence?: unknown });
      expect(error).toMatchObject({ code: "publication_commit_uncertain", evidence: { publicPath: value.output, kind: "directory" } });
      expect(JSON.parse(await readFile(join(value.output, "motion.json"), "utf8")).layers[0].keyframes).toHaveProperty("transform.rotation");
      await expect(readFile(join(value.output, "receipts", "checkpoint-storyboard-scalar-spatial-materialization.v1.json"), "utf8")).resolves.toContain("checkpoint-storyboard.scalar-spatial.materialize");
      expect((await readdir(value.workspace)).some((name) => name.startsWith(".out.shellx-edit-"))).toBe(true);
    } finally { fsFault.afterCommitArmed = false; fsFault.afterCommitOutput = ""; fsFault.renameObserved = false; await dispose(value.root); }
  });

  itLinux("refuses source and output races at the final commit checkpoint", async () => {
    const sourceRace = await fixture(); const outputRace = await fixture();
    try {
      fsFault.sourceRaceSource = resolve(sourceRace.source); fsFault.sourceRaceArmed = true;
      await expect(invoke(sourceRace)).rejects.toThrow(/source.*changed|exact base/i);
      fsFault.outputRaceOutput = resolve(outputRace.output); fsFault.outputRaceArmed = true;
      await expect(invoke(outputRace)).rejects.toThrow(/output.*changed|output must/i);
    } finally {
      fsFault.sourceRaceArmed = false; fsFault.sourceRaceSource = ""; fsFault.outputRaceArmed = false; fsFault.outputRaceOutput = "";
      await dispose(sourceRace.root, outputRace.root);
    }
  });

  itLinux("refuses nonempty, overlapping, and symlinked host outputs", async () => {
    const nonempty = await fixture(), overlap = await fixture(), linked = await fixture();
    try {
      await mkdir(nonempty.output); await writeFile(join(nonempty.output, "occupied"), "no\n");
      await expect(materializeCheckpointStoryboardScalarSpatial({ sourcePackageRoot: nonempty.source, outputPackageRoot: nonempty.output, packageWorkspaceRoot: nonempty.workspace, packageWorkspaceAuthority: nonempty.authority }, nonempty.approval, nonempty.request)).rejects.toThrow(/empty/i);
      await expect(materializeCheckpointStoryboardScalarSpatial({ sourcePackageRoot: overlap.source, outputPackageRoot: overlap.source, packageWorkspaceRoot: overlap.workspace, packageWorkspaceAuthority: overlap.authority }, overlap.approval, overlap.request)).rejects.toThrow(/outside source|output/i);
      await mkdir(join(linked.workspace, "target")); await symlink(join(linked.workspace, "target"), linked.output);
      await expect(materializeCheckpointStoryboardScalarSpatial({ sourcePackageRoot: linked.source, outputPackageRoot: linked.output, packageWorkspaceRoot: linked.workspace, packageWorkspaceAuthority: linked.authority }, linked.approval, linked.request)).rejects.toThrow(/symbolic link/i);
    } finally { await dispose(nonempty.root, overlap.root, linked.root); }
  });

  it("does not adopt the private vertical through public Core, Debug, CLI, SDK, or renderer entrances", async () => {
    const files = ["../../index.ts", "../../command-registry.ts", "../../command-registry-timeline-extensions.ts", "../../command-metadata.ts", "../../../../core/src/index.ts", "../../../../cli/src/main.ts", "../../../../sdk/src/index.ts", "../../../../renderer-native/src/index.ts"];
    const contents = await Promise.all(files.map(async (file) => await readFile(new URL(file, import.meta.url), "utf8")));
    const [debugIndex, debugRegistry, debugTimelineExtensions, debugMetadata, publicCore, cli, sdk, renderer] = contents;
    expect([publicCore, cli, sdk, renderer].every((text) => !text!.includes("checkpoint-storyboard"))).toBe(true);
    expect([debugIndex, debugRegistry, debugTimelineExtensions, debugMetadata].every((text) => !text!.includes("checkpoint-storyboard.scalar-spatial.materialize"))).toBe(true);
    expect(debugRegistry).toContain("command-registry-timeline-extensions");
    expect(debugTimelineExtensions).toContain("command-registry-checkpoint-storyboard");
    expect(materializeCheckpointStoryboardScalarSpatial.length).toBe(3);
  });
});

function host(value: Awaited<ReturnType<typeof fixture>>) { return { sourcePackageRoot: value.source, outputPackageRoot: value.output, packageWorkspaceRoot: value.workspace, packageWorkspaceAuthority: value.authority }; }
function invoke(value: Awaited<ReturnType<typeof fixture>>, request: unknown = value.request) { return materializeCheckpointStoryboardScalarSpatial(host(value), value.approval, request); }
async function dispose(...roots: readonly string[]): Promise<void> { await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true }))); await rmdir(TEST_PARENT).catch(() => undefined); }
async function inventoryFor(root: string, workspace: string, authority: Awaited<ReturnType<typeof createTrustedWorkspaceAnchor>>) { const entry = await lstat(root, { bigint: true }); const snapshot = await captureTrustedWorkspaceCompleteDirectoryInventory({ workspaceRoot: workspace, workspaceAuthority: authority, directory: root, identity: { dev: Number(entry.dev), ino: Number(entry.ino) }, label: "C6B1b test inventory" }); return { sha256: snapshot.evidence.sha256, entryCount: snapshot.evidence.entryCount, leafCount: snapshot.evidence.entryCount }; }
async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
