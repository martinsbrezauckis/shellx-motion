import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadMotionPackage } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { createCheckpointStoryboard, createTransitionRecipe } from "@shellx-motion/core/internal/checkpoint-storyboard-behavior-profile";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { C6B2_RECEIPT_PATH } from "../checkpoint-storyboard-behavior-materialize-private/checkpoint-storyboard-behavior-materialize-receipt-private.js";
import { materializeCheckpointStoryboardBehavior, prepareCheckpointStoryboardBehaviorMaterialization, reopenCheckpointStoryboardBehaviorMaterializationOutput } from "../checkpoint-storyboard-behavior-materialize-private/checkpoint-storyboard-behavior-materialize-private.js";

const TEST_PARENT = join(process.cwd(), ".c6b2-materialize-test");
const itLinux = process.platform === "linux" ? it : it.skip;

/** Test-only installed-output observation fault; callers never receive this seam. */
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
  await writeJson(join(source, "manifest.json"), { schema: "shellx-motion/package-manifest@1", id: "package-1", name: "C6B2", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: [] } });
  await writeJson(join(source, "motion.json"), {
    schema: "shellx-motion/motion@1", id: "motion-1", name: "C6B2", durationMs: 1_000, fps: 30, width: 1280, height: 720,
    layers: [{ id: "orb", type: "shape", shape: "ellipse", fill: "#4e8cff", startMs: 0, durationMs: 1_000, transform: { x: 10, y: 20 } }], assets: [], provenance: { sourceApp: "test", createdBy: "test" },
  });
  await writeFile(join(source, "assets", "nested", "leaf.txt"), "preserve me\n"); await writeFile(join(source, "receipts", "prior.json"), "{\"prior\":true}\n");
  if (options.fixedReceipt) await writeFile(join(source, C6B2_RECEIPT_PATH), "{}\n");
  const authority = await createTrustedWorkspaceAnchor(workspace);
  const recipe = createTransitionRecipe({ recipeId: "behavior", seed: 2, exactBaseRequirements: [], intent: { kind: "transform-behavior", targetObjectId: "orb", behavior: { kind: "gravity", velocityX: 30, velocityY: 10, gravityY: 20 } } });
  const storyboard = createCheckpointStoryboard({
    seed: 1, capabilityRequirements: ["renderer.gpu"], objectCatalog: [{ objectId: "orb", rootShapeKind: "ellipse", propertyMask: ["transform.x", "transform.y"] }],
    checkpoints: [
      { id: "zero", atUs: 0, objects: [{ objectId: "orb", state: "present", properties: [{ property: "transform.x", value: 10 }, { property: "transform.y", value: 20 }] }] },
      { id: "finish", atUs: 1_000_000, objects: [{ objectId: "orb", state: "present", properties: [{ property: "transform.x", value: 40 }, { property: "transform.y", value: 40 }] }] },
    ],
    edges: [{ id: "edge", fromCheckpointId: "zero", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "orb" }], recipeIds: ["behavior"] }], recipes: [recipe],
  });
  const host = { sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: authority };
  const prepared = await prepareCheckpointStoryboardBehaviorMaterialization(host, storyboard, [{ objectId: "orb", layerId: "orb" }]);
  return { root, workspace, source, output, authority, host, prepared, request: { schema: "shellx-motion/private-checkpoint-storyboard-behavior-materialization-request@1", expected: prepared.expected } };
}

describe("private C6B2 behavior exact-base COW materializer", () => {
  itLinux("installs exactly /behaviors with a fixed non-render receipt and preserves every unrelated leaf", async () => {
    const value = await fixture();
    try {
      const before = await snapshotPackageEditTree(value.source), result = await invoke(value);
      const after = await snapshotPackageEditTree(value.source), output = await snapshotPackageEditTree(value.output);
      const reopened = await withTrustedWorkspaceAnchor(value.authority, async () => await loadMotionPackage(value.output));
      expect(after.entries).toEqual(before.entries);
      expect(reopened.motion.behaviors).toEqual(value.prepared.plan.projection.store);
      expect(reopened.motion.layers[0]).not.toHaveProperty("keyframes");
      expect([...output.entries.keys()].filter((path) => !before.entries.has(path))).toEqual([C6B2_RECEIPT_PATH]);
      expect(result.receipt.renderer).toEqual({ invoked: false, pixels: false });
      expect(result.receipt.output.changed).toEqual({ paths: ["motion.json", C6B2_RECEIPT_PATH], count: 2, motionPropertyPaths: ["behaviors"], motionPropertyPathCount: 1 });
      const receipt = await readFile(join(value.output, C6B2_RECEIPT_PATH), "utf8");
      expect(receipt).toContain(result.receipt.fingerprint); expect(receipt).not.toContain(value.source); expect(receipt).not.toContain(value.output);
    } finally { await dispose(value.root); }
  });

  itLinux("reopens a committed output without any source input and returns only path-free exact facts", async () => {
    const value = await fixture();
    try {
      await invoke(value);
      const reopened = await reopenCheckpointStoryboardBehaviorMaterializationOutput(outputHost(value));
      expect(reopened).toMatchObject({
        schema: "shellx-motion/private-checkpoint-storyboard-behavior-materialization-installed-output@1",
        receipt: { fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
        package: { id: "package-1", manifest: { rawSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }, motion: { rawSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } },
        storyboard: { id: value.prepared.plan.storyboard.id }, plan: { fingerprint: value.prepared.plan.fingerprint }, profile: { fingerprint: value.prepared.plan.lowererProfile.fingerprint },
        behaviorStore: { schema: "shellx-motion/behaviors@1", sha256: value.prepared.plan.projection.storeSha256, bindings: value.prepared.plan.projection.store.bindings },
        materialization: { changedMotionRoot: "behaviors", changedLeafCount: 2, renderer: { invoked: false, pixels: false } },
      });
      expect(JSON.stringify(reopened)).not.toContain(value.source); expect(JSON.stringify(reopened)).not.toContain(value.output);
      expect(Object.isFrozen(reopened.behaviorStore.bindings)).toBe(true);
    } finally { await dispose(value.root); }
  });

  itLinux("replays deterministically and refuses stale/caller-substituted exact bases, identity drift, and competing behavior/overlay authority", async () => {
    const first = await fixture(), replay = await fixture(), stale = await fixture(), changed = await fixture(), overlay = await fixture(), asset = await fixture(), collision = await fixture({ fixedReceipt: true });
    try {
      const [one, two] = await Promise.all([invoke(first), invoke(replay)]);
      expect(two.receipt).toEqual(one.receipt); expect(two.receipt.fingerprint).toBe(one.receipt.fingerprint);
      await expect(invoke(stale, { ...stale.request, expected: { ...stale.request.expected, motionRawSha256: "a".repeat(64) } })).rejects.toThrow(/exact base/i);
      const motion = JSON.parse(await readFile(join(changed.source, "motion.json"), "utf8")); motion.behaviors = { schema: "shellx-motion/behaviors@1", bindings: [] }; await writeJson(join(changed.source, "motion.json"), motion);
      await expect(invoke(changed)).rejects.toThrow(/rederives|behavior/i);
      const overlaid = JSON.parse(await readFile(join(overlay.source, "motion.json"), "utf8")); overlaid.layers[0].keyframes = { "transform.x": [] }; await writeJson(join(overlay.source, "motion.json"), overlaid);
      await expect(invoke(overlay)).rejects.toThrow(/rederives|overlay/i);
      await writeFile(join(asset.source, "assets", "nested", "leaf.txt"), "identity drift\n");
      await expect(invoke(asset)).rejects.toThrow(/exact base|inventory/i);
      await expect(invoke(collision)).rejects.toThrow(/fixed materialization receipt/i);
    } finally { await dispose(first.root, replay.root, stale.root, changed.root, overlay.root, asset.root, collision.root); }
  });

  itLinux("refuses forged approvals, hostile request accessors, symlinks, unsafe inventory, and competing output", async () => {
    const forged = await fixture(), hostile = await fixture(), linked = await fixture(), unsafe = await fixture(), occupied = await fixture();
    try {
      await expect(materializeCheckpointStoryboardBehavior(forged.host, Object.freeze({}) as never, forged.request)).rejects.toThrow(/approval/i);
      let reads = 0; const request = { schema: hostile.request.schema };
      Object.defineProperty(request, "expected", { enumerable: true, get() { reads += 1; return hostile.request.expected; } });
      await expect(invoke(hostile, request)).rejects.toThrow(/data field/i); expect(reads).toBe(0);
      await mkdir(join(linked.workspace, "target")); await symlink(join(linked.workspace, "target"), linked.output);
      await expect(invoke(linked)).rejects.toThrow(/symbolic link/i);
      await symlink(join(unsafe.source, "assets", "nested", "leaf.txt"), join(unsafe.source, "assets", "unsafe-link"));
      await expect(invoke(unsafe)).rejects.toThrow(/inventory|symbolic link|entry/i);
      await mkdir(occupied.output); await expect(invoke(occupied)).rejects.toThrow(/absent/i);
    } finally { await dispose(forged.root, hostile.root, linked.root, unsafe.root, occupied.root); }
  });

  itLinux("rejects an intermediate-symlink source alias before COW and leaves no output", async () => {
    const value = await fixture();
    try {
      await symlink(value.workspace, join(value.workspace, "alias"));
      const aliasHost = { ...value.host, sourcePackageRoot: join(value.workspace, "alias", "source") };
      await expect(prepareCheckpointStoryboardBehaviorMaterialization(aliasHost, value.prepared.plan.storyboard, [{ objectId: "orb", layerId: "orb" }])).rejects.toMatchObject({ code: "unsafe_output" });
      await expect(lstat(value.output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await dispose(value.root); }
  });

  itLinux("rejects an absent output below an intermediate symlink before COW or external publication", async () => {
    const value = await fixture();
    try {
      const outside = join(value.root, "outside"), alias = join(value.workspace, "link"), output = join(alias, "output");
      await mkdir(outside); await symlink(outside, alias);
      const before = await snapshotPackageEditTree(value.source), aliasHost = { ...value.host, outputPackageRoot: output };
      const error = await materializeCheckpointStoryboardBehavior(aliasHost, value.prepared.approval, value.request).catch((reason: unknown) => reason);
      expect(error).toMatchObject({ code: "unsafe_output" });
      expect(String(error)).not.toContain(value.workspace); expect(String(error)).not.toContain(outside);
      expect((await snapshotPackageEditTree(value.source)).entries).toEqual(before.entries);
      await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(outside, "output"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await dispose(value.root); }
  });

  itLinux("fails source-independent output reopen on behavior, leaf, inventory, receipt, topology, and identity tampering", async () => {
    const behavior = await fixture(), leaf = await fixture(), added = await fixture(), receipt = await fixture(), linked = await fixture(), identity = await fixture();
    try {
      await Promise.all([invoke(behavior), invoke(leaf), invoke(added), invoke(receipt), invoke(linked), invoke(identity)]);
      const changed = JSON.parse(await readFile(join(behavior.output, "motion.json"), "utf8")); changed.behaviors.bindings[0].motion.velocityX = 31; await writeJson(join(behavior.output, "motion.json"), changed);
      await writeFile(join(leaf.output, "assets", "nested", "leaf.txt"), "changed leaf\n");
      await writeFile(join(added.output, "added.txt"), "unexpected\n");
      await writeFile(join(receipt.output, C6B2_RECEIPT_PATH), "{\"tampered\":true}\n");
      await rm(join(linked.output, "assets", "nested", "leaf.txt")); await symlink(join(linked.output, "motion.json"), join(linked.output, "assets", "nested", "leaf.txt"));
      const manifest = JSON.parse(await readFile(join(identity.output, "manifest.json"), "utf8")); manifest.name = "identity drift"; await writeJson(join(identity.output, "manifest.json"), manifest);
      for (const value of [behavior, leaf, added, receipt, linked, identity]) await expect(reopenCheckpointStoryboardBehaviorMaterializationOutput(outputHost(value))).rejects.toThrow(/C6B2|symbolic|inventory|receipt/i);
    } finally { await dispose(behavior.root, leaf.root, added.root, receipt.root, linked.root, identity.root); }
  });

  itLinux("retains an installed package when post-install observation is uncertain", async () => {
    const value = await fixture();
    try {
      fault.output = resolve(value.output); fault.armed = true; fault.renamed = false;
      const error = await invoke(value).catch((reason: unknown) => reason as { readonly code?: unknown; readonly evidence?: unknown });
      expect(error).toMatchObject({ code: "publication_commit_uncertain", evidence: { publicPath: value.output, kind: "directory" } });
      expect((await lstat(value.output)).isDirectory()).toBe(true);
      await expect(readFile(join(value.output, C6B2_RECEIPT_PATH), "utf8")).resolves.toContain("checkpoint-storyboard.behavior.materialize");
      expect((await readdir(value.workspace)).some((name) => name.startsWith(".out.shellx-edit-"))).toBe(true);
    } finally { fault.armed = false; fault.renamed = false; fault.output = ""; await dispose(value.root); }
  });

  it("does not adopt this private COW seam through public Core, Debug, CLI, SDK, or renderer routes", async () => {
    const files = ["../../index.ts", "../../command-registry.ts", "../../command-metadata.ts", "../../../../core/src/index.ts", "../../../../cli/src/main.ts", "../../../../sdk/src/index.ts", "../../../../renderer-native/src/index.ts"];
    const contents = await Promise.all(files.map(async (file) => await readFile(new URL(file, import.meta.url), "utf8")));
    const [debugIndex, debugRegistry, debugMetadata, publicCore, cli, sdk, renderer] = contents;
    expect([publicCore, cli, sdk, renderer].every((text) => !text!.includes("checkpoint-storyboard"))).toBe(true);
    expect([debugIndex, debugRegistry, debugMetadata].every((text) => !text!.includes("checkpoint-storyboard.behavior.materialize"))).toBe(true);
  });
});

function invoke(value: Awaited<ReturnType<typeof fixture>>, request: unknown = value.request) { return materializeCheckpointStoryboardBehavior(value.host, value.prepared.approval, request); }
function outputHost(value: Awaited<ReturnType<typeof fixture>>) { return { outputPackageRoot: value.output, packageWorkspaceRoot: value.workspace, packageWorkspaceAuthority: value.authority }; }
async function dispose(...roots: readonly string[]): Promise<void> { await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true }))); await rm(TEST_PARENT, { recursive: true, force: true }); }
async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
