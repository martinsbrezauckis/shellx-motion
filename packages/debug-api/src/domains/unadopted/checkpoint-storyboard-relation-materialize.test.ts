import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadMotionPackage } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { createCheckpointStoryboard, createTransitionRecipe } from "@shellx-motion/core/internal/checkpoint-storyboard-relation-profile";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { C6B3B_RECEIPT_PATH } from "../checkpoint-storyboard-relation-materialize-private/checkpoint-storyboard-relation-materialize-receipt-private.js";
import {
  materializeCheckpointStoryboardRelation,
  prepareCheckpointStoryboardRelationMaterialization,
  reopenCheckpointStoryboardRelationMaterializationOutput,
} from "../checkpoint-storyboard-relation-materialize-private/checkpoint-storyboard-relation-materialize-private.js";

const TEST_PARENT = join(process.cwd(), ".c6b3b-materialize-test");
const itLinux = process.platform === "linux" ? it : it.skip;

/** Test-only installed-output observation fault; no materializer caller receives this seam. */
const fault = vi.hoisted(() => ({ output: "", armed: false, renamed: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const path = await import("node:path");
  return {
    ...actual,
    rename: (async (...args: unknown[]) => {
      const result = await (actual.rename as (...inner: unknown[]) => Promise<void>)(...args);
      if (fault.armed && typeof args[0] === "string" && typeof args[1] === "string" && path.basename(args[0]) === "package" && path.resolve(args[1]) === fault.output) fault.renamed = true;
      return result;
    }) as typeof actual.rename,
    open: (async (...args: unknown[]) => {
      if (fault.armed && fault.renamed && typeof args[0] === "string" && path.resolve(args[0]) === path.join(fault.output, "manifest.json")) {
        fault.armed = false; fault.renamed = false;
        throw Object.assign(new Error("test-only installed reopen failure"), { code: "EIO" });
      }
      return await (actual.open as (...inner: unknown[]) => Promise<any>)(...args);
    }) as typeof actual.open,
  };
});

async function fixture(options: { readonly fixedReceipt?: boolean } = {}) {
  await mkdir(TEST_PARENT, { recursive: true });
  const root = await mkdtemp(join(TEST_PARENT, "run-"));
  const workspace = join(root, "workspace"), source = join(workspace, "source"), output = join(workspace, "out");
  await mkdir(join(source, "assets", "nested"), { recursive: true }); await mkdir(join(source, "receipts"), { recursive: true });
  await writeJson(join(source, "manifest.json"), { schema: "shellx-motion/package-manifest@1", id: "package-1", name: "C6B3b", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: [] } });
  await writeJson(join(source, "motion.json"), {
    schema: "shellx-motion/motion@1", id: "motion-1", name: "C6B3b", durationMs: 1_000, fps: 30, width: 1280, height: 720,
    layers: [
      { id: "guide", type: "shape", shape: "rect", fill: "#4e8cff", startMs: 0, durationMs: 1_000, transform: { x: 100, y: 50 } },
      { id: "orb", type: "shape", shape: "ellipse", fill: "#f3c547", startMs: 0, durationMs: 1_000, transform: { x: 125, y: 50 } },
    ],
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
  });
  await writeFile(join(source, "assets", "nested", "leaf.txt"), "preserve me\n"); await writeFile(join(source, "receipts", "prior.json"), "{\"prior\":true}\n");
  if (options.fixedReceipt) await writeFile(join(source, C6B3B_RECEIPT_PATH), "{}\n");
  const authority = await createTrustedWorkspaceAnchor(workspace);
  const recipe = createTransitionRecipe({
    recipeId: "follow-guide", seed: 2, exactBaseRequirements: [],
    intent: {
      kind: "relation", relationKind: "follow", sourceObjectId: "guide", targetObjectId: "orb",
      sourceAnchor: { x: 10, y: 10 }, targetAnchor: { x: 5, y: 5 },
      offset: { space: "world", x: 20, y: -5, rotationDeg: 0, scale: 1 },
    },
  });
  const storyboard = createCheckpointStoryboard({
    seed: 1, capabilityRequirements: ["renderer.gpu"],
    objectCatalog: [
      { objectId: "guide", rootShapeKind: "rect", propertyMask: ["transform.x", "transform.y"] },
      { objectId: "orb", rootShapeKind: "ellipse", propertyMask: ["transform.x", "transform.y"] },
    ],
    checkpoints: [
      { id: "start", atUs: 0, objects: [state("guide", 100, 50), state("orb", 125, 50)] },
      { id: "finish", atUs: 1_000_000, objects: [state("guide", 100, 50), state("orb", 125, 50)] },
    ],
    edges: [{ id: "follow-edge", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "guide" }, { kind: "preserve", objectId: "orb" }], recipeIds: ["follow-guide"] }],
    recipes: [recipe],
  });
  const bindings = [{ objectId: "guide", layerId: "guide" }, { objectId: "orb", layerId: "orb" }] as const;
  const host = { sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: authority };
  const prepared = await prepareCheckpointStoryboardRelationMaterialization(host, storyboard, bindings);
  return { root, workspace, source, output, authority, host, storyboard, bindings, prepared, request: { schema: "shellx-motion/private-checkpoint-storyboard-relation-materialization-request@1", expected: prepared.expected } };
}
function state(objectId: "guide" | "orb", x: number, y: number) {
  return { objectId, state: "present" as const, properties: [{ property: "transform.x" as const, value: x }, { property: "transform.y" as const, value: y }] };
}

describe("private C6B3b relation exact-base COW materializer", () => {
  itLinux("installs exactly /relations plus the fixed non-render receipt and leaves source bytes untouched", async () => {
    const value = await fixture();
    try {
      const before = await snapshotPackageEditTree(value.source), result = await invoke(value);
      const after = await snapshotPackageEditTree(value.source), output = await snapshotPackageEditTree(value.output);
      const reopened = await withTrustedWorkspaceAnchor(value.authority, async () => await loadMotionPackage(value.output));
      expect(after.entries).toEqual(before.entries);
      expect(reopened.motion.relations).toEqual(value.prepared.plan.projection.store);
      expect(reopened.motion.layers.every((layer) => !Object.hasOwn(layer, "keyframes"))).toBe(true);
      expect([...output.entries.keys()].filter((path) => !before.entries.has(path))).toEqual([C6B3B_RECEIPT_PATH]);
      expect(result.receipt.output.changed).toEqual({ paths: ["motion.json", C6B3B_RECEIPT_PATH], count: 2, motionPropertyPaths: ["relations"], motionPropertyPathCount: 1 });
      expect(result.receipt.renderer).toEqual({ invoked: false, pixels: false });
      expect(result.receipt.approval).toMatchObject({
        planFingerprint: value.prepared.plan.fingerprint,
        profileFingerprint: value.prepared.plan.lowererProfile.fingerprint,
        storeSha256: value.prepared.plan.projection.storeSha256,
        staticFingerprint: value.prepared.plan.projection.staticFingerprint,
        gpuStaticFingerprint: value.prepared.plan.projection.gpuPreviewStaticPlan.fingerprint,
        startFramePlanFingerprint: value.prepared.plan.endpointFramePlans.start.fingerprint,
        endFramePlanFingerprint: value.prepared.plan.endpointFramePlans.end.fingerprint,
      });
      const receipt = await readFile(join(value.output, C6B3B_RECEIPT_PATH), "utf8");
      expect(receipt).toContain(result.receipt.fingerprint); expect(receipt).not.toContain(value.source); expect(receipt).not.toContain(value.output);
    } finally { await dispose(value.root); }
  });

  itLinux("replays deterministically and reopens output-only path-free static and endpoint relation evidence", async () => {
    const first = await fixture(), replay = await fixture();
    try {
      const [one, two] = await Promise.all([invoke(first), invoke(replay)]);
      expect(two.receipt).toEqual(one.receipt);
      const reopened = await reopenCheckpointStoryboardRelationMaterializationOutput(outputHost(first));
      expect(reopened).toMatchObject({
        schema: "shellx-motion/private-checkpoint-storyboard-relation-materialization-installed-output@1",
        storyboard: { id: first.prepared.plan.storyboard.id }, plan: { fingerprint: first.prepared.plan.fingerprint }, profile: { fingerprint: first.prepared.plan.lowererProfile.fingerprint },
        relationStore: { schema: "shellx-motion/relations@1", sha256: first.prepared.plan.projection.storeSha256, bindings: first.prepared.plan.projection.store.bindings },
        relationStatic: { fingerprint: first.prepared.plan.projection.staticFingerprint },
        gpuRelationStatic: { fingerprint: first.prepared.plan.projection.gpuPreviewStaticPlan.fingerprint, relationStaticFingerprint: first.prepared.plan.projection.staticFingerprint },
        endpointFramePlans: { startFingerprint: first.prepared.plan.endpointFramePlans.start.fingerprint, endFingerprint: first.prepared.plan.endpointFramePlans.end.fingerprint },
        materialization: { changedMotionRoot: "relations", changedLeafCount: 2, renderer: { invoked: false, pixels: false } },
      });
      expect(JSON.stringify(reopened)).not.toContain(first.source); expect(JSON.stringify(reopened)).not.toContain(first.output);
      expect(Object.isFrozen(reopened.relationStore.bindings)).toBe(true);
    } finally { await dispose(first.root, replay.root); }
  });

  itLinux("refuses stale or substituted exact bases, source identity drift, relations, and competing topology/authority", async () => {
    const stale = await fixture(), changed = await fixture(), relations = await fixture(), authority = await fixture(), topology = await fixture();
    try {
      await expect(invoke(stale, { ...stale.request, expected: { ...stale.request.expected, staticFingerprint: "a".repeat(64) } })).rejects.toThrow(/exact base/i);
      await writeFile(join(changed.source, "assets", "nested", "leaf.txt"), "identity drift\n"); await expect(invoke(changed)).rejects.toThrow(/exact base|inventory/i);
      const relationMotion = JSON.parse(await readFile(join(relations.source, "motion.json"), "utf8")); relationMotion.relations = { schema: "shellx-motion/relations@1", bindings: [] }; await writeJson(join(relations.source, "motion.json"), relationMotion);
      await expect(invoke(relations)).rejects.toThrow(/rederives|relations/i);
      const authorityMotion = JSON.parse(await readFile(join(authority.source, "motion.json"), "utf8")); authorityMotion.layers[0].keyframes = { "transform.x": [] }; await writeJson(join(authority.source, "motion.json"), authorityMotion);
      await expect(invoke(authority)).rejects.toThrow(/rederives|authority|keyframes/i);
      const topologyMotion = JSON.parse(await readFile(join(topology.source, "motion.json"), "utf8")); topologyMotion.layers[1].childLayerIds = ["guide"]; await writeJson(join(topology.source, "motion.json"), topologyMotion);
      await expect(invoke(topology)).rejects.toThrow(/rederives|root-owned|endpoint/i);
    } finally { await dispose(stale.root, changed.root, relations.root, authority.root, topology.root); }
  });

  itLinux("rejects forged approvals, hostile request accessors, unsafe trees, occupied outputs, and aliases before output intent", async () => {
    const forged = await fixture(), hostile = await fixture(), unsafe = await fixture(), occupied = await fixture(), sourceAlias = await fixture(), outputAlias = await fixture();
    try {
      await expect(materializeCheckpointStoryboardRelation(forged.host, Object.freeze({}) as never, forged.request)).rejects.toThrow(/approval/i);
      let reads = 0; const request = { schema: hostile.request.schema };
      Object.defineProperty(request, "expected", { enumerable: true, get() { reads += 1; return hostile.request.expected; } });
      await expect(invoke(hostile, request)).rejects.toThrow(/data field/i); expect(reads).toBe(0);
      await symlink(join(unsafe.source, "assets", "nested", "leaf.txt"), join(unsafe.source, "assets", "unsafe-link")); await expect(invoke(unsafe)).rejects.toThrow(/inventory|symbolic link|entry/i);
      await mkdir(occupied.output); await expect(invoke(occupied)).rejects.toThrow(/absent/i);
      await symlink(sourceAlias.workspace, join(sourceAlias.workspace, "alias"));
      const sourceBefore = await snapshotPackageEditTree(sourceAlias.source);
      await expect(prepareCheckpointStoryboardRelationMaterialization({ ...sourceAlias.host, sourcePackageRoot: join(sourceAlias.workspace, "alias", "source") }, sourceAlias.storyboard, sourceAlias.bindings)).rejects.toMatchObject({ code: "unsafe_output" });
      expect((await snapshotPackageEditTree(sourceAlias.source)).entries).toEqual(sourceBefore.entries);
      await expect(lstat(sourceAlias.output)).rejects.toMatchObject({ code: "ENOENT" });
      const outside = join(outputAlias.root, "outside"), alias = join(outputAlias.workspace, "alias"), aliasedOutput = join(alias, "not-created");
      await mkdir(outside); await symlink(outside, alias);
      const before = await snapshotPackageEditTree(outputAlias.source);
      await expect(prepareCheckpointStoryboardRelationMaterialization({ ...outputAlias.host, outputPackageRoot: aliasedOutput }, outputAlias.storyboard, outputAlias.bindings)).rejects.toMatchObject({ code: "unsafe_output" });
      expect((await snapshotPackageEditTree(outputAlias.source)).entries).toEqual(before.entries);
      await expect(lstat(aliasedOutput)).rejects.toMatchObject({ code: "ENOENT" }); await expect(lstat(join(outside, "not-created"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await dispose(forged.root, hostile.root, unsafe.root, occupied.root, sourceAlias.root, outputAlias.root); }
  });

  itLinux("cleans normal preinstall failure but retains installed output on observation uncertainty", async () => {
    const normal = await fixture({ fixedReceipt: true }), uncertain = await fixture();
    try {
      await expect(invoke(normal)).rejects.toThrow(/fixed materialization receipt/i);
      await expect(lstat(normal.output)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(normal.workspace)).every((name) => !name.startsWith(".out.shellx-edit-"))).toBe(true);
      fault.output = resolve(uncertain.output); fault.armed = true; fault.renamed = false;
      const error = await invoke(uncertain).catch((reason: unknown) => reason as { readonly code?: unknown; readonly evidence?: unknown });
      expect(error).toMatchObject({ code: "publication_commit_uncertain", evidence: { publicPath: uncertain.output, kind: "directory" } });
      expect((await lstat(uncertain.output)).isDirectory()).toBe(true);
      await expect(readFile(join(uncertain.output, C6B3B_RECEIPT_PATH), "utf8")).resolves.toContain("checkpoint-storyboard.relation.materialize");
      expect((await readdir(uncertain.workspace)).some((name) => name.startsWith(".out.shellx-edit-"))).toBe(true);
    } finally { fault.armed = false; fault.renamed = false; fault.output = ""; await dispose(normal.root, uncertain.root); }
  });

  itLinux("fails output-only reopen on relation, leaf, inventory, receipt, topology, and package identity tampering", async () => {
    const relation = await fixture(), leaf = await fixture(), added = await fixture(), receipt = await fixture(), topology = await fixture(), identity = await fixture();
    try {
      await Promise.all([invoke(relation), invoke(leaf), invoke(added), invoke(receipt), invoke(topology), invoke(identity)]);
      const changed = JSON.parse(await readFile(join(relation.output, "motion.json"), "utf8")); changed.relations.bindings[0].enabled = false; await writeJson(join(relation.output, "motion.json"), changed);
      await writeFile(join(leaf.output, "assets", "nested", "leaf.txt"), "changed leaf\n"); await writeFile(join(added.output, "added.txt"), "unexpected\n");
      await writeFile(join(receipt.output, C6B3B_RECEIPT_PATH), "{\"tampered\":true}\n");
      const invalid = JSON.parse(await readFile(join(topology.output, "motion.json"), "utf8")); invalid.relations.bindings[0].durationUs = 999_000; await writeJson(join(topology.output, "motion.json"), invalid);
      const manifest = JSON.parse(await readFile(join(identity.output, "manifest.json"), "utf8")); manifest.name = "identity drift"; await writeJson(join(identity.output, "manifest.json"), manifest);
      for (const value of [relation, leaf, added, receipt, topology, identity]) await expect(reopenCheckpointStoryboardRelationMaterializationOutput(outputHost(value))).rejects.toThrow(/C6B3b|relation|inventory|receipt/i);
    } finally { await dispose(relation.root, leaf.root, added.root, receipt.root, topology.root, identity.root); }
  });

  it("keeps the dev handoff and private adapter out of publish, Core root, Debug registry, CLI, SDK, Actions, connectors, and renderers", async () => {
    const files = ["../../index.ts", "../../command-registry.ts", "../../command-metadata.ts", "../../../../core/src/index.ts", "../../../../cli/src/main.ts", "../../../../sdk/src/index.ts", "../../../../actions/src/catalog.ts", "../../../../connectors/src/index.ts", "../../../../renderer-browser/src/index.ts", "../../../../renderer-native/src/index.ts"];
    const contents = await Promise.all(files.map(async (file) => await readFile(new URL(file, import.meta.url), "utf8")));
    expect(contents.every((text) => !text.includes("checkpoint-storyboard.relation.materialize"))).toBe(true);
    expect(contents.slice(3).every((text) => !text.includes("checkpoint-storyboard-relation-materializer"))).toBe(true);
    const manifest = JSON.parse(await readFile(new URL("../../../../core/package.json", import.meta.url), "utf8"));
    expect(manifest.exports["./internal/checkpoint-storyboard-relation-profile"]).toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-relation-materializer.ts");
    expect(manifest.publishConfig.exports["./internal/checkpoint-storyboard-relation-profile"]).toEqual({ types: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-relation-materializer.d.ts", default: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-relation-materializer.js" });
  });
});

function invoke(value: Awaited<ReturnType<typeof fixture>>, request: unknown = value.request) { return materializeCheckpointStoryboardRelation(value.host, value.prepared.approval, request); }
function outputHost(value: Awaited<ReturnType<typeof fixture>>) { return { outputPackageRoot: value.output, packageWorkspaceRoot: value.workspace, packageWorkspaceAuthority: value.authority }; }
async function dispose(...roots: readonly string[]): Promise<void> { await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true }))); await rm(TEST_PARENT, { recursive: true, force: true }); }
async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
