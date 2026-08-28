import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson, canonicalJsonSha256, createMotionPackage, loadMotionPackage } from "@shellx-motion/core";
import { createCheckpointStoryboard } from "@shellx-motion/core/internal/checkpoint-storyboard-relation-profile";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { C6B5B_RECEIPT_PATH, readC6B5bReceipt } from "../checkpoint-storyboard-lifecycle-materialize-private/checkpoint-storyboard-lifecycle-materialize-receipt-private.js";
import { materializeCheckpointStoryboardLifecycle, prepareCheckpointStoryboardLifecycleMaterialization, reopenCheckpointStoryboardLifecycleMaterializationOutput } from "../checkpoint-storyboard-lifecycle-materialize-private/checkpoint-storyboard-lifecycle-materialize-private.js";

const TEST_PARENT = join(process.cwd(), ".c6b5b-materialize-test");
const itLinux = process.platform === "linux" ? it : it.skip;
const MASK = ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] as const;
const fault = vi.hoisted(() => ({ output: "", armed: false, renamed: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>(), path = await import("node:path");
  return { ...actual,
    rename: (async (...args: unknown[]) => { const result = await (actual.rename as (...inner: unknown[]) => Promise<void>)(...args); if (fault.armed && typeof args[0] === "string" && typeof args[1] === "string" && path.basename(args[0]) === "package" && path.resolve(args[1]) === fault.output) fault.renamed = true; return result; }) as typeof actual.rename,
    open: (async (...args: unknown[]) => { if (fault.armed && fault.renamed && typeof args[0] === "string" && path.resolve(args[0]) === path.join(fault.output, "manifest.json")) { fault.armed = false; fault.renamed = false; throw Object.assign(new Error("test-only installed reopen failure"), { code: "EIO" }); } return await (actual.open as (...inner: unknown[]) => Promise<any>)(...args); }) as typeof actual.open,
  };
});
const creation = (fill: string, width: number, height: number) => ({ schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1" as const, fill, width, height });
const absent = (objectId: string) => ({ objectId, state: "absent" as const, properties: [] });
const present = (objectId: string, x: number, y: number, rotation: number, scale: number, opacity: number) => ({ objectId, state: "present" as const, properties: [{ property: "transform.x" as const, value: x }, { property: "transform.y" as const, value: y }, { property: "transform.rotation" as const, value: rotation }, { property: "transform.scale" as const, value: scale }, { property: "opacity" as const, value: opacity }] });

function storyboard() {
  const alpha = present("alpha", 12, 24, 15, 1.25, 0.75), zeta = present("zeta", -10, 40, 0, 1, 1);
  return createCheckpointStoryboard({ seed: 1, capabilityRequirements: ["renderer.native"], objectCatalog: [{ objectId: "alpha", rootShapeKind: "ellipse", propertyMask: MASK, creation: creation("#4e8cff", 120, 80) }, { objectId: "zeta", rootShapeKind: "rect", propertyMask: MASK, creation: creation("#f3c547", 60, 40) }], checkpoints: [{ id: "start", atUs: 0, objects: [absent("alpha"), absent("zeta")] }, { id: "zeta-create", atUs: 100_000, objects: [absent("alpha"), zeta] }, { id: "alpha-create", atUs: 300_000, objects: [alpha, zeta] }, { id: "zeta-remove", atUs: 700_000, objects: [alpha, absent("zeta")] }, { id: "finish", atUs: 1_000_000, objects: [alpha, absent("zeta")] }], edges: [edge("a-zeta-create", "start", "zeta-create", ["preserve", "create"]), edge("b-alpha-create", "zeta-create", "alpha-create", ["create", "preserve"]), edge("c-zeta-remove", "alpha-create", "zeta-remove", ["preserve", "remove"]), edge("d-finish", "zeta-remove", "finish", ["preserve", "preserve"])], recipes: [] });
}
function edge(id: string, fromCheckpointId: string, toCheckpointId: string, lifecycle: readonly ("create" | "preserve" | "remove")[]) { return { id, fromCheckpointId, toCheckpointId, lifecycle: [{ kind: lifecycle[0]!, objectId: "alpha" }, { kind: lifecycle[1]!, objectId: "zeta" }], recipeIds: [] }; }

async function fixture(options: { readonly receipt?: boolean } = {}) {
  await mkdir(TEST_PARENT, { recursive: true }); const root = await mkdtemp(join(TEST_PARENT, "run-")), workspace = join(root, "workspace"), source = join(workspace, "source"), output = join(workspace, "out");
  await mkdir(join(source, "assets", "nested"), { recursive: true }); await mkdir(join(source, "receipts"), { recursive: true });
  await writeJson(join(source, "manifest.json"), { schema: "shellx-motion/package-manifest@1", id: "package-1", name: "C6B5b", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["native"], hosts: [] } });
  await writeJson(join(source, "motion.json"), { schema: "shellx-motion/motion@1", id: "motion-1", name: "C6B5b", durationMs: 1_000, fps: 30, width: 1280, height: 720, layers: [{ id: "title", type: "text", text: "prefix", startMs: 0, durationMs: 1_000 }], assets: [], provenance: { sourceApp: "test", createdBy: "test" } });
  await writeFile(join(source, "assets", "nested", "leaf.txt"), "preserve me\n"); await writeFile(join(source, "receipts", "prior.json"), "{\"prior\":true}\n"); if (options.receipt) await writeFile(join(source, C6B5B_RECEIPT_PATH), "{}\n");
  const authority = await createTrustedWorkspaceAnchor(workspace), host = { sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: authority }, sealed = storyboard(), prepared = await prepareCheckpointStoryboardLifecycleMaterialization(host, sealed);
  return { root, workspace, source, output, authority, host, storyboard: sealed, prepared, request: { schema: "shellx-motion/private-checkpoint-storyboard-lifecycle-materialization-request@1", expected: prepared.expected } };
}
async function freshEmptyAssetsFixture(options: { readonly preexistingEmptyReceipts?: boolean } = {}) {
  await mkdir(TEST_PARENT, { recursive: true });
  const root = await mkdtemp(join(TEST_PARENT, "fresh-empty-assets-"));
  const workspace = join(root, "workspace"), source = join(workspace, "source"), output = join(workspace, "out"), sourceAssets = join(source, "assets");
  await mkdir(workspace, { recursive: true });
  const authority = await createTrustedWorkspaceAnchor(workspace);
  await withTrustedWorkspaceAnchor(authority, async () => await createMotionPackage({ packageRoot: source, name: "C6B5b empty assets", durationMs: 1_000, empty: true }));
  if (options.preexistingEmptyReceipts) await mkdir(join(source, "receipts"), { mode: 0o700 });
  const host = { sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: authority }, sealed = storyboard(), prepared = await prepareCheckpointStoryboardLifecycleMaterialization(host, sealed);
  return { root, workspace, source, output, sourceAssets, authority, host, storyboard: sealed, prepared, request: { schema: "shellx-motion/private-checkpoint-storyboard-lifecycle-materialization-request@1", expected: prepared.expected } };
}
function invoke(value: Awaited<ReturnType<typeof fixture>>, request: unknown = value.request) { return materializeCheckpointStoryboardLifecycle(value.host, value.prepared.approval, request); }
function outputHost(value: Awaited<ReturnType<typeof fixture>>) { return { outputPackageRoot: value.output, packageWorkspaceRoot: value.workspace, packageWorkspaceAuthority: value.authority }; }

describe("source-only C6B5b lifecycle exact-base COW materializer", () => {
  itLinux("appends only catalog-order ordinary roots, preserves every source leaf, and reopens without source authority", async () => {
    const value = await fixture(); try {
      const before = await snapshotPackageEditTree(value.source), result = await invoke(value), after = await snapshotPackageEditTree(value.source), output = await withTrustedWorkspaceAnchor(value.authority, async () => await loadMotionPackage(value.output));
      expect(after.entries).toEqual(before.entries); expect(output.motion.layers.map((layer) => layer.id)).toEqual(["title", "alpha", "zeta"]); expect(output.motion.layers.slice(1)).toEqual(value.prepared.plan.layers); expect([...output.motion.layers.slice(1)].map((layer) => ({ fill: layer.fill, opacity: layer.opacity, transform: layer.transform }))).toEqual([{ fill: "#4e8cff", opacity: 0.75, transform: { x: 12, y: 24, rotation: 15, scale: 1.25, width: 120, height: 80, originX: 60, originY: 40 } }, { fill: "#f3c547", opacity: 1, transform: { x: -10, y: 40, rotation: 0, scale: 1, width: 60, height: 40, originX: 30, originY: 20 } }]);
      expect(result.receipt.output.changed).toEqual({ paths: ["motion.json", C6B5B_RECEIPT_PATH], count: 2, motionPropertyPaths: ["layers"], motionPropertyPathCount: 1 }); expect(result.receipt.transaction.workspaceCleanup).toBe("not-attested"); expect(result.receipt.renderer).toEqual({ invoked: false, pixels: false });
      const reopened = await reopenCheckpointStoryboardLifecycleMaterializationOutput(outputHost(value)); expect(reopened.layers).toMatchObject({ sourcePrefix: { count: 1 }, ids: ["alpha", "zeta"] }); expect(JSON.stringify(reopened)).not.toContain(value.source); expect(JSON.stringify(reopened)).not.toContain(value.output); expect((await readFile(join(value.output, C6B5B_RECEIPT_PATH), "utf8")).includes(value.source)).toBe(false);
    } finally { await dispose(value.root); }
  });

  itLinux("round-trips a freshly created package with empty assets and rejects output empty-assets tampering", async () => {
    const value = await freshEmptyAssetsFixture(); try {
      const result = await invoke(value);
      expect(result.packageRoot).toBe(value.output);
      expect(await readdir(value.sourceAssets)).toEqual([]);
      expect(await readdir(join(value.output, "assets"))).toEqual([]);
      const reopened = await reopenCheckpointStoryboardLifecycleMaterializationOutput(outputHost(value));
      expect(reopened.package.currentInventory).toMatchObject({ entryCount: 4, leafCount: 3 });
      expect(reopened.package.nonReceiptInventory).toMatchObject({ entryCount: 4, leafCount: 2 });

      await writeFile(join(value.output, "assets", "late.txt"), "late\n", "utf8");
      await expect(reopenCheckpointStoryboardLifecycleMaterializationOutput(outputHost(value))).rejects.toThrow(/inventory|C6B5b/i);
    } finally { await dispose(value.root); }
  });

  itLinux("round-trips a fresh package that already has an empty receipts directory", async () => {
    const value = await freshEmptyAssetsFixture({ preexistingEmptyReceipts: true }); try {
      await invoke(value);
      const reopened = await reopenCheckpointStoryboardLifecycleMaterializationOutput(outputHost(value));
      expect(reopened.package.currentInventory).toMatchObject({ entryCount: 4, leafCount: 3 });
      expect(reopened.package.nonReceiptInventory).toMatchObject({ entryCount: 4, leafCount: 2 });
    } finally { await dispose(value.root); }
  });

  itLinux("refuses forged or descriptor-hostile requests before workspace entry, stale facts, collisions, fixed receipt, and occupied output", async () => {
    const hostile = await fixture(), stale = await fixture(), leaf = await fixture(), collision = await fixture(), receipt = await fixture({ receipt: true }), occupied = await fixture(); try {
      let reads = 0; const request = { schema: hostile.request.schema }; Object.defineProperty(request, "expected", { enumerable: true, get() { reads += 1; return hostile.request.expected; } }); await expect(materializeCheckpointStoryboardLifecycle({ ...hostile.host, outputPackageRoot: hostile.root }, hostile.prepared.approval, request)).rejects.toThrow(/data field/i); expect(reads).toBe(0);
      const nested = structuredClone(hostile.request.expected), ids = [...nested.generatedLayerIds]; Object.defineProperty(nested, "inventory", { enumerable: true, get() { reads += 1; return hostile.request.expected.inventory; } }); await expect(invoke(hostile, { schema: hostile.request.schema, expected: nested })).rejects.toThrow(/unsupported fields|invalid/i); expect(reads).toBe(0);
      const arrayNested = structuredClone(hostile.request.expected) as unknown as { generatedLayerIds: string[] }; Object.defineProperty(ids, "0", { enumerable: true, get() { reads += 1; return hostile.request.expected.generatedLayerIds[0]; } }); arrayNested.generatedLayerIds = ids; await expect(invoke(hostile, { schema: hostile.request.schema, expected: arrayNested })).rejects.toThrow(/invalid/i); expect(reads).toBe(0);
      let approvalReads = 0; const forgedApproval = {}, approvalSymbol = Object.getOwnPropertySymbols(stale.prepared.approval)[0]!; Object.defineProperty(forgedApproval, approvalSymbol, { enumerable: true, get() { approvalReads += 1; return "c6b5b-approved"; } }); await expect(materializeCheckpointStoryboardLifecycle(stale.host, forgedApproval as never, stale.request)).rejects.toThrow(/host-minted/i); expect(approvalReads).toBe(0);
      await expect(invoke(stale, { ...stale.request, expected: { ...stale.request.expected, generatedLayersSha256: "a".repeat(64) } })).rejects.toThrow(/exact base/i);
      await writeFile(join(leaf.source, "assets", "nested", "leaf.txt"), "changed\n"); await expect(invoke(leaf)).rejects.toThrow(/inventory|exact base/i);
      const motion = JSON.parse(await readFile(join(collision.source, "motion.json"), "utf8")); motion.layers[0].id = "alpha"; await writeJson(join(collision.source, "motion.json"), motion); await expect(invoke(collision)).rejects.toThrow(/collision|rederives/i);
      await expect(invoke(receipt)).rejects.toThrow(/receipt/i); await mkdir(occupied.output); await expect(invoke(occupied)).rejects.toThrow(/absent|output/i);
    } finally { await dispose(hostile.root, stale.root, leaf.root, collision.root, receipt.root, occupied.root); }
  });

  itLinux("fails root, intermediate, and nested source/output symlink aliases before COW", async () => {
    const sourceAlias = await fixture(), nested = await fixture(), outputAlias = await fixture(); try {
      await symlink(sourceAlias.workspace, join(sourceAlias.workspace, "alias")); await expect(prepareCheckpointStoryboardLifecycleMaterialization({ ...sourceAlias.host, sourcePackageRoot: join(sourceAlias.workspace, "alias", "source") }, sourceAlias.storyboard)).rejects.toMatchObject({ code: "unsafe_output" });
      const leaf = join(nested.source, "assets", "nested", "leaf.txt"), outsideLeaf = join(nested.root, "outside-leaf"); await writeFile(outsideLeaf, "outside\n"); await rm(leaf); await symlink(outsideLeaf, leaf); await expect(invoke(nested)).rejects.toMatchObject({ code: "unsupported_source_entry" });
      const outside = join(outputAlias.root, "outside"), alias = join(outputAlias.workspace, "alias"); await mkdir(outside); await symlink(outside, alias); await expect(materializeCheckpointStoryboardLifecycle({ ...outputAlias.host, outputPackageRoot: join(alias, "out") }, outputAlias.prepared.approval, outputAlias.request)).rejects.toMatchObject({ code: "unsafe_output" }); await expect(lstat(join(outside, "out"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await dispose(sourceAlias.root, nested.root, outputAlias.root); }
  });

  itLinux("refuses source compositing drift and invalid complete Motion authority before COW", async () => {
    const compositing = await fixture(), authority = await fixture(); try {
      const sourceMotion = JSON.parse(await readFile(join(compositing.source, "motion.json"), "utf8")); sourceMotion.compositing = { schema: "shellx-motion/compositing-graph@1", id: "c", nodes: [{ id: "source", type: "source", layerId: "title" }, { id: "output", type: "output" }], edges: [{ id: "out", from: { nodeId: "source", port: "output" }, to: { nodeId: "output", port: "input" } }] }; await writeJson(join(compositing.source, "motion.json"), sourceMotion);
      await expect(invoke(compositing)).rejects.toThrow(/compositing.*not idempotent|rederives/i);
      const invalidMotion = JSON.parse(await readFile(join(authority.source, "motion.json"), "utf8")); invalidMotion.relationActions = { schema: "shellx-motion/relation-actions@1", actions: [{ id: "broken" }] }; await writeJson(join(authority.source, "motion.json"), invalidMotion);
      await expect(invoke(authority)).rejects.toThrow(/authority graph|rederives/i);
    } finally { await dispose(compositing.root, authority.root); }
  });

  itLinux("cleans known pre-install failures but retains an output on uncertain post-install observation", async () => {
    const known = await fixture({ receipt: true }), uncertain = await freshEmptyAssetsFixture(); try {
      await expect(invoke(known)).rejects.toThrow(/receipt/i); await expect(lstat(known.output)).rejects.toMatchObject({ code: "ENOENT" });
      fault.output = resolve(uncertain.output); fault.armed = true; fault.renamed = false;
      const error = await invoke(uncertain).catch((reason: unknown) => reason as { readonly code?: unknown; readonly evidence?: unknown });
      const sentinel = createHash("sha256").update("shellx-motion:complete-tree-reopen-required@1\n").digest("hex");
      expect(error).toMatchObject({ code: "publication_commit_uncertain", message: expect.stringContaining("domain-specific output-only reopen"), evidence: { publicPath: uncertain.output, kind: "directory", expected: { sha256: sentinel, entryCount: 0, entries: [] } } }); expect((error as { evidence: { expected: object } }).evidence.expected).not.toHaveProperty("inventory"); expect((await lstat(uncertain.output)).isDirectory()).toBe(true); expect((await withTrustedWorkspaceAnchor(uncertain.authority, async () => await readC6B5bReceipt(uncertain.output))).transaction.workspaceCleanup).toBe("not-attested");
      await expect(reopenCheckpointStoryboardLifecycleMaterializationOutput(outputHost(uncertain))).resolves.toMatchObject({ package: { currentInventory: { entryCount: 4, leafCount: 3 } } });
      await rm(join(uncertain.output, "assets"), { recursive: true });
      await expect(reopenCheckpointStoryboardLifecycleMaterializationOutput(outputHost(uncertain))).rejects.toThrow(/inventory|C6B5b/i);
    } finally { fault.armed = false; fault.renamed = false; fault.output = ""; await dispose(known.root, uncertain.root); }
  });

  itLinux("makes output-only reopen reject suffix, prefix, preserved-leaf, inventory, and self-consistent receipt tampering", async () => {
    const suffix = await fixture(), prefix = await fixture(), leaf = await fixture(), added = await fixture(), receipt = await fixture(), manifest = await fixture(), projection = await fixture(), plan = await fixture(), approval = await fixture(); try {
      await Promise.all([invoke(suffix), invoke(prefix), invoke(leaf), invoke(added), invoke(receipt), invoke(manifest), invoke(projection), invoke(plan), invoke(approval)]);
      const suffixMotion = JSON.parse(await readFile(join(suffix.output, "motion.json"), "utf8")); suffixMotion.layers[1].fill = "#ffffff"; await writeJson(join(suffix.output, "motion.json"), suffixMotion);
      const prefixMotion = JSON.parse(await readFile(join(prefix.output, "motion.json"), "utf8")); prefixMotion.layers.reverse(); await writeJson(join(prefix.output, "motion.json"), prefixMotion);
      await writeFile(join(leaf.output, "assets", "nested", "leaf.txt"), "changed\n"); await writeFile(join(added.output, "extra.txt"), "extra\n"); await writeFile(join(receipt.output, C6B5B_RECEIPT_PATH), "{}\n");
      const outputManifest = JSON.parse(await readFile(join(manifest.output, "manifest.json"), "utf8")), reorderedManifest = Object.fromEntries([...Object.entries(outputManifest)].reverse()), manifestBytes = `${JSON.stringify(reorderedManifest, null, 4)}\n`; await writeFile(join(manifest.output, "manifest.json"), manifestBytes); const manifestReceipt = JSON.parse(await readFile(join(manifest.output, C6B5B_RECEIPT_PATH), "utf8")); manifestReceipt.output.manifestRawSha256 = createHash("sha256").update(manifestBytes, "utf8").digest("hex"); resealReceipt(manifestReceipt); await writeFile(join(manifest.output, C6B5B_RECEIPT_PATH), `${canonicalJson(manifestReceipt)}\n`);
      const projectionReceipt = JSON.parse(await readFile(join(projection.output, C6B5B_RECEIPT_PATH), "utf8")); projectionReceipt.base.expected.generatedLayerIdsSha256 = "b".repeat(64); projectionReceipt.base.reopened.generatedLayerIdsSha256 = "b".repeat(64); projectionReceipt.approval.projection.generatedLayerIdsSha256 = "b".repeat(64); resealReceipt(projectionReceipt); await writeFile(join(projection.output, C6B5B_RECEIPT_PATH), `${canonicalJson(projectionReceipt)}\n`);
      const planReceipt = JSON.parse(await readFile(join(plan.output, C6B5B_RECEIPT_PATH), "utf8")); planReceipt.approval.plan.schema = "shellx-motion/private-checkpoint-storyboard-lifecycle-profile-plan@999"; resealPlan(planReceipt.approval.plan); resealReceipt(planReceipt); await writeFile(join(plan.output, C6B5B_RECEIPT_PATH), `${canonicalJson(planReceipt)}\n`);
      const approvalReceipt = JSON.parse(await readFile(join(approval.output, C6B5B_RECEIPT_PATH), "utf8")); approvalReceipt.approval.storyboard.id = "other-storyboard"; approvalReceipt.approval.storyboard.sha256 = "c".repeat(64); approvalReceipt.approval.storyboard.revision += 1; resealReceipt(approvalReceipt); await writeFile(join(approval.output, C6B5B_RECEIPT_PATH), `${canonicalJson(approvalReceipt)}\n`);
      for (const value of [suffix, prefix, leaf, added, receipt, manifest, projection, plan, approval]) await expect(reopenCheckpointStoryboardLifecycleMaterializationOutput(outputHost(value))).rejects.toThrow(/C6B5b|receipt|output|inventory/i);
    } finally { await dispose(suffix.root, prefix.root, leaf.root, added.root, receipt.root, manifest.root, projection.root, plan.root, approval.root); }
  });

  it("keeps raw B5b unreachable from Debug, package, command, CLI, SDK, actions, renderers, and public docs", async () => {
    const files = ["../../index.ts", "../../command-registry.ts", "../../command-metadata.ts", "../../../package.json", "../../../../core/src/index.ts", "../../../../core/package.json", "../../../../cli/src/main.ts", "../../../../sdk/src/index.ts", "../../../../actions/src/catalog.ts", "../../../../connectors/src/index.ts", "../../../../renderer-browser/src/index.ts", "../../../../renderer-native/src/index.ts", "../../../../../README.md", "../../../../../docs/public/DEBUG_API.md", "../../../../../docs/public/DEBUG_API_COMMANDS.md", "../../../../../schemas/debug-contracts.schema.json"];
    const contents = await Promise.all(files.map(async (file) => await readFile(new URL(file, import.meta.url), "utf8")));
    expect(contents.filter((_text, index) => index !== 5).every((text) => !text.includes("checkpoint-storyboard.lifecycle.materialize") && !text.includes("checkpoint-storyboard-lifecycle-materialize"))).toBe(true);
    const coreManifest = JSON.parse(contents[5]!) as { exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } };
    expect(coreManifest.exports["./internal/checkpoint-storyboard-lifecycle-profile"]).toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-lifecycle-materializer.ts");
    expect(coreManifest.publishConfig.exports["./internal/checkpoint-storyboard-lifecycle-profile"]).toEqual({ types: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-lifecycle-materializer.d.ts", default: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-lifecycle-materializer.js" });
    const privateModules = await Promise.all([
      readFile(new URL("../checkpoint-storyboard-lifecycle-materialize-private/checkpoint-storyboard-lifecycle-materialize-private.ts", import.meta.url), "utf8"),
      readFile(new URL("../checkpoint-storyboard-lifecycle-materialize-private/checkpoint-storyboard-lifecycle-materialize-output-private.ts", import.meta.url), "utf8"),
    ]);
    expect(privateModules.every((text) => text.includes("@shellx-motion/core/internal/checkpoint-storyboard-lifecycle-profile"))).toBe(true);
    expect(privateModules.join("\n")).not.toMatch(/vite-ignore|core\/src\/unadopted|import\s*\(/);
  });
});

async function dispose(...roots: readonly string[]): Promise<void> { await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true }))); await rm(TEST_PARENT, { recursive: true, force: true }); }
async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
function resealPlan(plan: Record<string, unknown>): void { const { fingerprint: _fingerprint, ...payload } = plan; plan.fingerprint = canonicalJsonSha256(payload); }
function resealReceipt(receipt: Record<string, unknown>): void { const { fingerprint: _fingerprint, ...payload } = receipt; receipt.fingerprint = canonicalJsonSha256(payload); }
