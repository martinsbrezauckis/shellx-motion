import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson, canonicalJsonSha256 } from "@shellx-motion/core";
import { createCheckpointStoryboard, createTransitionRecipe } from "@shellx-motion/core/internal/checkpoint-storyboard-scalar-spatial-materializer";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { C6B7B_RECEIPT_PATH, C6B7B_SIDECAR_PATH } from "./checkpoint-storyboard-retained-trace-materialize-facts-private.js";
import { materializeCheckpointStoryboardRetainedTrace, prepareCheckpointStoryboardRetainedTraceMaterialization, reopenCheckpointStoryboardRetainedTraceMaterializationOutput } from "./checkpoint-storyboard-retained-trace-materialize-private.js";

const TEST_PARENT = join(process.cwd(), `.c6b7b-retained-trace-materialize-test-${process.pid}`);
const fault = vi.hoisted(() => ({ output: "", renamed: false, postInstall: false, outputManifestOpens: 0, afterCommitFaulted: false, precommitSource: "", beforeCommitClaimed: false, beforeCommitFaulted: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>(), path = await import("node:path");
  return { ...actual,
    rename: (async (...args: unknown[]) => { const from = typeof args[0] === "string" ? path.resolve(args[0]) : "", to = typeof args[1] === "string" ? path.resolve(args[1]) : ""; const result = await (actual.rename as (...inner: unknown[]) => Promise<void>)(...args); if (fault.precommitSource && from === fault.output) fault.beforeCommitClaimed = true; if (fault.postInstall && path.basename(from) === "package" && to === fault.output) { fault.renamed = true; fault.outputManifestOpens = 0; } return result; }) as typeof actual.rename,
    open: (async (...args: unknown[]) => { const file = typeof args[0] === "string" ? path.resolve(args[0]) : ""; if (fault.precommitSource && fault.beforeCommitClaimed && file === path.join(path.dirname(fault.precommitSource), "manifest.json")) { const motion = JSON.parse(await actual.readFile(fault.precommitSource, "utf8")); motion.name = "source drifted at C6B7b beforeCommit"; await actual.writeFile(fault.precommitSource, `${JSON.stringify(motion, null, 2)}\n`, "utf8"); fault.precommitSource = ""; fault.beforeCommitFaulted = true; } if (fault.postInstall && fault.renamed && file === path.join(fault.output, "manifest.json") && ++fault.outputManifestOpens >= 2) { fault.postInstall = false; fault.renamed = false; fault.afterCommitFaulted = true; throw Object.assign(new Error("test-only C6B7b afterCommit reopen failure"), { code: "EIO" }); } return await (actual.open as (...inner: unknown[]) => Promise<any>)(...args); }) as typeof actual.open,
  };
});
function trace() { return { schema: "shellx-motion/private-parametric-trace@1", clip: { durationUs: 4_000, sampleIntervalUs: 1_000 }, drawers: [{ id: "line", driver: { kind: "parametric-graph", graph: { nodes: [{ id: "time", kind: "time-us" }, { id: "scale", kind: "constant", value: 0.001 }, { id: "x", kind: "multiply", left: "time", right: "scale" }, { id: "zero", kind: "constant", value: 0 }], output: { x: "x", y: "zero", z: "zero" } } }, retention: { kind: "full-clip", maxSamples: 5 }, output: { mode: "line", width: { source: "constant", from: 2, to: 2 }, colour: { source: "constant", from: 0.5, to: 0.5 }, opacity: { source: "constant", from: 0.75, to: 0.75 }, speedLimit: 100 } }], caps: { perDrawer: { maxSamples: 64, maxVertices: 64, maxWorkUnits: 16_384, maxBytes: 128 * 1024 }, aggregate: { maxSamples: 64, maxVertices: 64, maxWorkUnits: 16_384, maxBytes: 128 * 1024 } } }; }
function storyboard() { const recipe = createTransitionRecipe({ recipeId: "retained-line", seed: 2, exactBaseRequirements: [], intent: { kind: "parametric-trace", outputObjectId: "trace-anchor", trace: trace() } }); return createCheckpointStoryboard({ seed: 1, capabilityRequirements: ["renderer.gpu"], objectCatalog: [{ objectId: "trace-anchor", rootShapeKind: "rect", propertyMask: ["opacity"] }], checkpoints: [{ id: "start", atUs: 0, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] }, { id: "finish", atUs: 4_000, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] }], edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "trace-anchor" }], recipeIds: ["retained-line"] }], recipes: [recipe] }); }
async function fixture({ receipts = false }: { readonly receipts?: boolean } = {}) {
  await mkdir(TEST_PARENT, { recursive: true }); const root = await mkdtemp(join(TEST_PARENT, "run-")), workspace = join(root, "workspace"), source = join(workspace, "source"), output = join(workspace, "output");
  await mkdir(join(source, "assets", "empty"), { recursive: true }); if (receipts) await mkdir(join(source, "receipts"), { recursive: true });
  await json(join(source, "manifest.json"), { schema: "shellx-motion/package-manifest@1", id: "package-1", name: "C6B7b trace", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: [] } });
  await json(join(source, "motion.json"), { schema: "shellx-motion/motion@1", id: "motion-1", name: "C6B7b trace", durationMs: 4, fps: 30, width: 1280, height: 720, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "trace-anchor", type: "shape", shape: "rect", fill: "#4e8cff", opacity: 0.75, startMs: 0, durationMs: 4, transform: { x: 0, y: 0, width: 100, height: 100 } }] });
  await writeFile(join(source, "asset.txt"), "preserve\n", "utf8"); const authority = await createTrustedWorkspaceAnchor(workspace), host = { sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: authority }, sealed = storyboard(), prepared = await prepareCheckpointStoryboardRetainedTraceMaterialization(host, sealed);
  return { root, workspace, source, output, authority, host, prepared, request: { schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-materialization-request@1", expected: prepared.expected } };
}
function invoke(value: Awaited<ReturnType<typeof fixture>>, request: unknown = value.request) { return materializeCheckpointStoryboardRetainedTrace(value.host, value.prepared.approval, request); }
function outputHost(value: Awaited<ReturnType<typeof fixture>>) { return { outputPackageRoot: value.output, packageWorkspaceRoot: value.workspace, packageWorkspaceAuthority: value.authority }; }

describe.skipIf(process.platform !== "linux")("private C6B7b retained-trace sidecar materializer (Linux closed-inventory COW)", () => {
  it("COW-installs only canonical C6B7a plan/receipt bytes, preserves documents/leaves/empty dirs, and reopens after source deletion", async () => {
    const value = await fixture(); try {
      const before = await snapshotPackageEditTree(value.source), manifest = await readFile(join(value.source, "manifest.json")), motion = await readFile(join(value.source, "motion.json")); const result = await invoke(value), output = await snapshotPackageEditTree(value.output);
      expect(await readFile(join(value.source, "manifest.json"))).toEqual(manifest); expect(await readFile(join(value.source, "motion.json"))).toEqual(motion); expect((await snapshotPackageEditTree(value.source)).entries).toEqual(before.entries);
      expect(await readFile(join(value.output, C6B7B_SIDECAR_PATH), "utf8")).toBe(`${canonicalJson(value.prepared.plan)}\n`);
      expect([...output.entries.keys()].filter((path) => !before.entries.has(path) && output.entries.get(path)?.startsWith("file:"))).toEqual([C6B7B_SIDECAR_PATH, C6B7B_RECEIPT_PATH]);
      expect(result.receipt.output.changed).toEqual({ paths: [C6B7B_SIDECAR_PATH, C6B7B_RECEIPT_PATH], count: 2, motionAndManifest: "unchanged" }); expect(result.receipt.renderer).toEqual({ invoked: false, pixels: false, gpuAbi: "none", upload: "none" });
      await expect(reopenCheckpointStoryboardRetainedTraceMaterializationOutput(outputHost(value))).resolves.toMatchObject({ planFingerprint: value.prepared.expected.planFingerprint, renderer: { invoked: false, gpuAbi: "none" } }); await rm(value.source, { recursive: true, force: true }); await expect(reopenCheckpointStoryboardRetainedTraceMaterializationOutput(outputHost(value))).resolves.toMatchObject({ tracePlanFingerprint: value.prepared.expected.tracePlanFingerprint });
    } finally { await dispose(value.root); }
  });
  it("accounts for an existing empty receipts directory and rejects forged approvals, exact-base drift, source drift, and occupied output", async () => {
    const clean = await fixture({ receipts: true }), forged = await fixture(), drift = await fixture(), occupied = await fixture(); try {
      await expect(invoke(clean)).resolves.toBeTruthy(); expect((await snapshotPackageEditTree(clean.output)).entries.get("receipts")).toBe("dir");
      await expect(materializeCheckpointStoryboardRetainedTrace(forged.host, Object.freeze({}) as never, forged.request)).rejects.toThrow(/host-minted/i);
      await expect(invoke(forged, { ...forged.request, expected: { ...forged.request.expected, scheduleSha256: "a".repeat(64) } })).rejects.toThrow(/exact|source/i);
      const changed = JSON.parse(await readFile(join(drift.source, "motion.json"), "utf8")); changed.layers[0].opacity = 0.5; await json(join(drift.source, "motion.json"), changed); await expect(invoke(drift)).rejects.toThrow(/rederive|source/i);
      await mkdir(occupied.output); await expect(invoke(occupied)).rejects.toThrow(/absent|output/i);
    } finally { await dispose(clean.root, forged.root, drift.root, occupied.root); }
  });
  it("replays deterministically and refuses hostile storyboard accessors or pre-existing fixed artifacts", async () => {
    const first = await fixture(), replay = await fixture(), hostile = await fixture(), existing = await fixture(), existingReceipt = await fixture(); try {
      const [one, two] = await Promise.all([invoke(first), invoke(replay)]); expect(two.receipt).toEqual(one.receipt); expect(await readFile(join(first.output, C6B7B_SIDECAR_PATH))).toEqual(await readFile(join(replay.output, C6B7B_SIDECAR_PATH)));
      let calls = 0; const trap: Record<string, unknown> = {}; Object.defineProperty(trap, "schema", { enumerable: true, get() { calls += 1; return "shellx-motion/checkpoint-storyboard@1"; } });
      await expect(prepareCheckpointStoryboardRetainedTraceMaterialization(hostile.host, trap)).rejects.toThrow(); expect(calls).toBe(0);
      await mkdir(join(existing.source, "analysis", "checkpoint-storyboard"), { recursive: true }); await writeFile(join(existing.source, C6B7B_SIDECAR_PATH), "{}\n", "utf8"); await expect(prepareCheckpointStoryboardRetainedTraceMaterialization(existing.host, storyboard())).rejects.toThrow(/sidecar|receipt/i);
      await mkdir(join(existingReceipt.source, "receipts"), { recursive: true }); await writeFile(join(existingReceipt.source, C6B7B_RECEIPT_PATH), "{}\n", "utf8"); await expect(prepareCheckpointStoryboardRetainedTraceMaterialization(existingReceipt.host, storyboard())).rejects.toThrow(/sidecar|receipt/i);
    } finally { await dispose(first.root, replay.root, hostile.root, existing.root, existingReceipt.root); }
  });
  it("refuses precommit source drift and retains a post-rename uncertain output for explicit reopen", async () => {
    const drift = await fixture(), uncertain = await fixture(); try {
      fault.output = resolve(drift.output); fault.precommitSource = resolve(join(drift.source, "motion.json")); fault.beforeCommitClaimed = false; fault.beforeCommitFaulted = false; await expect(invoke(drift)).rejects.toThrow(/source|exact|rederive/i); expect(fault.beforeCommitFaulted).toBe(true); await expect(lstat(drift.output)).rejects.toMatchObject({ code: "ENOENT" });
      fault.output = resolve(uncertain.output); fault.postInstall = true; fault.renamed = false; fault.afterCommitFaulted = false; const error = await invoke(uncertain).catch((reason: unknown) => reason as { readonly code?: unknown; readonly evidence?: unknown }); expect(fault.afterCommitFaulted).toBe(true); expect(error).toMatchObject({ code: "publication_commit_uncertain", evidence: { publicPath: uncertain.output, kind: "directory" } }); await expect(reopenCheckpointStoryboardRetainedTraceMaterializationOutput(outputHost(uncertain))).resolves.toMatchObject({ planFingerprint: uncertain.prepared.expected.planFingerprint });
    } finally { fault.output = ""; fault.postInstall = false; fault.renamed = false; fault.outputManifestOpens = 0; fault.afterCommitFaulted = false; fault.precommitSource = ""; fault.beforeCommitClaimed = false; fault.beforeCommitFaulted = false; await dispose(drift.root, uncertain.root); }
  });
  it("output-only reopen rejects sidecar, receipt, manifest, Motion, exact-base inventory, extra/missing leaves, and empty-directory inventory tamper", async () => {
    const values = await Promise.all([fixture(), fixture(), fixture(), fixture(), fixture(), fixture(), fixture(), fixture(), fixture()]);
    try {
      await Promise.all(values.map(async (value) => await invoke(value))); const [sidecar, receipt, manifest, motion, baseInventory, extra, missing, empty, inventory] = values;
      await writeFile(join(sidecar!.output, C6B7B_SIDECAR_PATH), "{}\n", "utf8");
      const receiptJson = JSON.parse(await readFile(join(receipt!.output, C6B7B_RECEIPT_PATH), "utf8")); receiptJson.fingerprint = "0".repeat(64); await writeFile(join(receipt!.output, C6B7B_RECEIPT_PATH), `${canonicalJson(receiptJson)}\n`, "utf8");
      const manifestJson = JSON.parse(await readFile(join(manifest!.output, "manifest.json"), "utf8")); manifestJson.name = "tampered"; await json(join(manifest!.output, "manifest.json"), manifestJson);
      const motionJson = JSON.parse(await readFile(join(motion!.output, "motion.json"), "utf8")); motionJson.layers[0].fill = "#ffffff"; await json(join(motion!.output, "motion.json"), motionJson);
      const baseInventoryJson = JSON.parse(await readFile(join(baseInventory!.output, C6B7B_RECEIPT_PATH), "utf8")); baseInventoryJson.approval.base.source.inventory.sha256 = "1".repeat(64); const { fingerprint: _oldFingerprint, ...baseInventoryPayload } = baseInventoryJson; baseInventoryJson.fingerprint = canonicalJsonSha256(baseInventoryPayload); await writeFile(join(baseInventory!.output, C6B7B_RECEIPT_PATH), `${canonicalJson(baseInventoryJson)}\n`, "utf8");
      await writeFile(join(extra!.output, "extra.txt"), "unexpected\n", "utf8"); await rm(join(missing!.output, "asset.txt")); await rm(join(empty!.output, "assets", "empty"), { recursive: true }); await rm(join(inventory!.output, "analysis", "checkpoint-storyboard"), { recursive: true });
      for (const value of values) await expect(reopenCheckpointStoryboardRetainedTraceMaterializationOutput(outputHost(value!))).rejects.toThrow(/C6B7b|inventory|sidecar|receipt|identity/i);
    } finally { await dispose(...values.map((value) => value.root)); }
  });
});

describe("private C6B7b retained-trace materializer static contract", () => {
  it("has no renderer/GPU wrapper while its adopted compiler is a private installed Core route", async () => {
    const [writer, output, manifest] = await Promise.all([readFile(new URL("./checkpoint-storyboard-retained-trace-materialize-private.ts", import.meta.url), "utf8"), readFile(new URL("./checkpoint-storyboard-retained-trace-materialize-output-private.ts", import.meta.url), "utf8"), readFile(new URL("../../../../core/package.json", import.meta.url), "utf8")]);
    expect(`${writer}\n${output}`).not.toMatch(/gpu-parametric-trace-preview|renderGpu|vertexAbi/i); const parsed = JSON.parse(manifest) as { publishConfig: { exports: Record<string, unknown> } }; expect(parsed.publishConfig.exports).toHaveProperty("./internal/checkpoint-storyboard-retained-trace-profile");
  });
});
async function json(path: string, value: unknown) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
async function dispose(...paths: string[]) { await Promise.all(paths.filter(Boolean).map(async (path) => await rm(path, { recursive: true, force: true }))); }
