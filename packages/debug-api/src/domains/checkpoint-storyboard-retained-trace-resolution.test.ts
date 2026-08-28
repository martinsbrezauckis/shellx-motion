import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "@shellx-motion/core";
import { createCheckpointStoryboard, createTransitionRecipe } from "@shellx-motion/core/internal/checkpoint-storyboard-scalar-spatial-materializer";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { dispatchDebugCommand } from "../index.js";
import { configureCheckpointStoryboardRetainedTraceResolutionAuthority } from "./checkpoint-storyboard-retained-trace-resolution-authority.js";
import { checkedAuthority, configureCheckpointStoryboardRecordStore } from "./checkpoint-storyboard-record-store-authority.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMANDS } from "./checkpoint-storyboard-record-lifecycle.js";
import { archiveCheckpointStoryboardStoredLineage, createCheckpointStoryboardStoredRecord, tombstoneCheckpointStoryboardStoredRecord } from "./checkpoint-storyboard-record-store.js";
import { initializeGeometryMorphStateHead } from "./checkpoint-storyboard-geometry-morph-resolution-journal.js";
import { detachCheckpointStoryboardRetainedTraceStoredRecord, resolveCheckpointStoryboardRetainedTraceStoredRecord, setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest } from "./checkpoint-storyboard-retained-trace-resolution.js";
import { C6B7B_RECEIPT_PATH, C6B7B_SIDECAR_PATH } from "./checkpoint-storyboard-retained-trace-materialize-private/checkpoint-storyboard-retained-trace-materialize-facts-private.js";
import { readC6B7bReceipt } from "./checkpoint-storyboard-retained-trace-materialize-private/checkpoint-storyboard-retained-trace-materialize-receipt-private.js";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true }))));
function trace() { return { schema: "shellx-motion/private-parametric-trace@1", clip: { durationUs: 4_000, sampleIntervalUs: 1_000 }, drawers: [{ id: "line", driver: { kind: "parametric-graph", graph: { nodes: [{ id: "time", kind: "time-us" }, { id: "scale", kind: "constant", value: 0.001 }, { id: "x", kind: "multiply", left: "time", right: "scale" }, { id: "zero", kind: "constant", value: 0 }], output: { x: "x", y: "zero", z: "zero" } } }, retention: { kind: "full-clip", maxSamples: 5 }, output: { mode: "line", width: { source: "constant", from: 2, to: 2 }, colour: { source: "constant", from: 0.5, to: 0.5 }, opacity: { source: "constant", from: 0.75, to: 0.75 }, speedLimit: 100 } }], caps: { perDrawer: { maxSamples: 64, maxVertices: 64, maxWorkUnits: 16_384, maxBytes: 128 * 1024 }, aggregate: { maxSamples: 64, maxVertices: 64, maxWorkUnits: 16_384, maxBytes: 128 * 1024 } } }; }
function storyboard(seed = 1) { const recipe = createTransitionRecipe({ recipeId: "retained-line", seed: seed + 1, exactBaseRequirements: [], intent: { kind: "parametric-trace", outputObjectId: "trace-anchor", trace: trace() } }); return createCheckpointStoryboard({ seed, capabilityRequirements: ["renderer.gpu"], objectCatalog: [{ objectId: "trace-anchor", rootShapeKind: "rect", propertyMask: ["opacity"] }], checkpoints: [{ id: "start", atUs: 0, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] }, { id: "finish", atUs: 4_000, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] }], edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "trace-anchor" }], recipeIds: ["retained-line"] }], recipes: [recipe] }); }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-c6c-b7-resolution-")); roots.push(root);
  const workspace = join(root, "workspace"), source = join(workspace, "source"), output = join(workspace, "output"), storeRoot = join(root, "store");
  await mkdir(join(source, "empty"), { recursive: true });
  await mkdir(storeRoot, { mode: 0o700 });
  await writeJson(join(source, "manifest.json"), { schema: "shellx-motion/package-manifest@1", id: "trace-package", name: "Trace", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: [] } });
  await writeJson(join(source, "motion.json"), { schema: "shellx-motion/motion@1", id: "trace-motion", name: "Trace", durationMs: 4, fps: 30, width: 1280, height: 720, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "trace-anchor", type: "shape", shape: "rect", fill: "#4e8cff", opacity: 0.75, startMs: 0, durationMs: 4, transform: { x: 0, y: 0, width: 100, height: 100 } }] });
  const anchor = await createTrustedWorkspaceAnchor(workspace), store = await configureCheckpointStoryboardRecordStore({ root: storeRoot, integrityKey: Buffer.alloc(32, 7) });
  const created = await createCheckpointStoryboardStoredRecord(store, storyboard());
  const authority = await configureCheckpointStoryboardRetainedTraceResolutionAuthority({ recordStore: store, sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: anchor });
  return { root, workspace, source, output, anchor, store, created, authority };
}
async function writeJson(path: string, value: unknown) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

describe.skipIf(process.platform !== "linux")("C6C B7 retained-trace resolver (Linux closed-inventory COW)", () => {
  it("installs only fixed artifacts, replays after source loss, and detaches without deletion", async () => {
    const value = await fixture(), identity = value.created.record.identity;
    expect(value.created.record.admission).toEqual({ staticProfileAdmitted: true, profile: "c6b7-retained-trace@1" });
    const [manifest, motion] = await Promise.all([readFile(join(value.source, "manifest.json")), readFile(join(value.source, "motion.json"))]);
    let cows = 0; setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(value.authority, { "before-c6b7b": () => { cows += 1; } });
    const bound = await resolveCheckpointStoryboardRetainedTraceStoredRecord(value.authority, identity);
    const receipt = await readC6B7bReceipt(value.output);
    expect(bound).toMatchObject({ replayed: false, binding: { state: "bound", receiptFingerprint: receipt.fingerprint }, renderer: { invoked: false, pixels: false, gpuAbi: "none", upload: "none" } });
    expect(receipt.output.package).toMatchObject({ manifestRawSha256: receipt.approval.base.source.manifestRawSha256, manifestCanonicalSha256: receipt.approval.base.source.manifestCanonicalSha256, motionRawSha256: receipt.approval.base.source.motionRawSha256, motionCanonicalSha256: receipt.approval.base.source.motionCanonicalSha256 });
    expect(await readFile(join(value.output, "manifest.json"))).toEqual(manifest); expect(await readFile(join(value.output, "motion.json"))).toEqual(motion);
    expect(await readFile(join(value.output, C6B7B_SIDECAR_PATH), "utf8")).toBe(`${canonicalJson(receipt.approval.plan)}\n`);
    expect(receipt.output.changed).toEqual({ paths: [C6B7B_SIDECAR_PATH, C6B7B_RECEIPT_PATH], count: 2, motionAndManifest: "unchanged" });
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(value.authority, identity)).resolves.toMatchObject({ replayed: true }); expect(cows).toBe(1);
    await rm(value.source, { recursive: true, force: true });
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(value.authority, identity)).resolves.toMatchObject({ replayed: true, binding: { state: "bound" } });
    await expect(detachCheckpointStoryboardRetainedTraceStoredRecord(value.authority, identity)).resolves.toMatchObject({ binding: { state: "detached", active: 0 } });
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(value.authority, identity)).rejects.toMatchObject({ code: "materialization_detached" });
    await expect(lstat(value.output)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });
  it("refuses sidecar, receipt, and full-inventory tamper and B6 foreign residue", async () => {
    const sidecar = await fixture(), receipt = await fixture(), inventory = await fixture(), foreign = await fixture();
    await Promise.all([resolveCheckpointStoryboardRetainedTraceStoredRecord(sidecar.authority, sidecar.created.record.identity), resolveCheckpointStoryboardRetainedTraceStoredRecord(receipt.authority, receipt.created.record.identity), resolveCheckpointStoryboardRetainedTraceStoredRecord(inventory.authority, inventory.created.record.identity)]);
    await writeFile(join(sidecar.output, C6B7B_SIDECAR_PATH), "{}\n", "utf8");
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(sidecar.authority, sidecar.created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_conflict" });
    await writeFile(join(receipt.output, C6B7B_RECEIPT_PATH), "{}\n", "utf8");
    await expect(detachCheckpointStoryboardRetainedTraceStoredRecord(receipt.authority, receipt.created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_conflict" });
    await writeFile(join(inventory.output, "added-leaf.txt"), "drift\n", "utf8");
    await expect(detachCheckpointStoryboardRetainedTraceStoredRecord(inventory.authority, inventory.created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_conflict" });
    await initializeGeometryMorphStateHead(checkedAuthority(foreign.store), foreign.created.record.identity, foreign.created.record.lineage.root);
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(foreign.authority, foreign.created.record.identity)).rejects.toMatchObject({ code: "store_integrity_failed" });
  });
  it("has identity-only Debug/MCP parity and a process-local output claim", async () => {
    const value = await fixture(), identity = value.created.record.identity;
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTraceResolve, { identity }, { tier: "write_local", checkpointStoryboardRecordStore: value.store })).resolves.toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    const resolved = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTraceResolve, { identity }, { tier: "write_local", checkpointStoryboardRecordStore: value.store, checkpointStoryboardRetainedTraceResolutionAuthority: value.authority });
    expect(resolved).toMatchObject({ ok: true, result: { binding: { outputHandle: expect.stringMatching(/^checkpoint_storyboard_retained_trace_output_/u), receiptFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) }, renderer: { gpuAbi: "none", upload: "none" } } }); expect(JSON.stringify(resolved)).not.toContain(value.workspace);
    const other = await createCheckpointStoryboardStoredRecord(value.store, storyboard(9)); expect(other.record.identity).not.toEqual(identity);
    await expect(configureCheckpointStoryboardRetainedTraceResolutionAuthority({ recordStore: value.store, sourcePackageRoot: value.source, outputPackageRoot: value.output, packageWorkspaceRoot: value.workspace, packageWorkspaceAuthority: value.anchor })).rejects.toThrow(/claim/i);
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTraceDetach, { identity, output: value.output }, { tier: "write_local", checkpointStoryboardRecordStore: value.store, checkpointStoryboardRetainedTraceResolutionAuthority: value.authority })).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    const cli = await readFile(new URL("../../../cli/src/debug-subcommands.ts", import.meta.url), "utf8"), named = cli.slice(cli.indexOf("export const CLI_NAMED_DEBUG_NO_ROUTE"));
    expect(named).toContain(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTraceResolve); expect(named).toContain(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTraceDetach); expect(cli.slice(0, cli.indexOf("export const CLI_NAMED_DEBUG_NO_ROUTE"))).not.toContain("checkpoint-storyboard.retained-trace");
  });

  it("never repeats after durable start, recovers every legal publication lag, and settles no-install intent-only cases", async () => {
    const started = await fixture(), startHead = await fixture(), committed = await fixture(), intent = await fixture(), binding = await fixture(), head = await fixture(), abandon = await fixture(), preCow = await fixture(); let starts = 0, commits = 0;
    setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(started.authority, { "after-cow-start": () => { throw new Error("durable start"); }, "before-c6b7b": () => { starts += 1; } });
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(started.authority, started.created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(started.authority, { "before-c6b7b": () => { starts += 1; } });
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(started.authority, started.created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" }); expect(starts).toBe(0);
    setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(startHead.authority, { "after-cow-start-before-state-head": () => { throw new Error("start head lag"); } });
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(startHead.authority, startHead.created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(startHead.authority, { "before-c6b7b": () => { starts += 1; } });
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(startHead.authority, startHead.created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" }); expect(starts).toBe(0); await expect(lstat(startHead.output)).rejects.toMatchObject({ code: "ENOENT" });
    setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(committed.authority, { "before-c6b7b": () => { commits += 1; }, "after-c6b7b-commit": () => { throw new Error("post-install"); } });
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(committed.authority, committed.created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" }); await expect(lstat(committed.output)).resolves.toBeTruthy();
    setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(committed.authority, undefined); await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(committed.authority, committed.created.record.identity)).resolves.toMatchObject({ replayed: true, binding: { state: "bound" } }); expect(commits).toBe(1);
    setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(intent.authority, { "after-intent-before-state-head": () => { throw new Error("intent lag"); } });
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(intent.authority, intent.created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" }); setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(intent.authority, undefined);
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(intent.authority, intent.created.record.identity)).resolves.toMatchObject({ binding: { state: "bound" } });
    setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(binding.authority, { "after-binding": () => { throw new Error("binding lag"); } });
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(binding.authority, binding.created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" }); setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(binding.authority, undefined);
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(binding.authority, binding.created.record.identity)).resolves.toMatchObject({ replayed: true, binding: { state: "bound" } });
    setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(binding.authority, { "after-detach": () => { throw new Error("detach lag"); } });
    await expect(detachCheckpointStoryboardRetainedTraceStoredRecord(binding.authority, binding.created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" }); setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(binding.authority, undefined);
    await expect(detachCheckpointStoryboardRetainedTraceStoredRecord(binding.authority, binding.created.record.identity)).resolves.toMatchObject({ replayed: true, binding: { state: "detached" } });
    setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(head.authority, { "after-bound-state-head-rename": () => { throw new Error("bound head lag"); } });
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(head.authority, head.created.record.identity)).rejects.toMatchObject({ code: "record_commit_uncertain" }); setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(head.authority, undefined);
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(head.authority, head.created.record.identity)).resolves.toMatchObject({ replayed: true, binding: { state: "bound" } });
    setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(head.authority, { "after-detached-state-head-rename": () => { throw new Error("detached head lag"); } });
    await expect(detachCheckpointStoryboardRetainedTraceStoredRecord(head.authority, head.created.record.identity)).rejects.toMatchObject({ code: "record_commit_uncertain" }); setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(head.authority, undefined);
    await expect(detachCheckpointStoryboardRetainedTraceStoredRecord(head.authority, head.created.record.identity)).resolves.toMatchObject({ replayed: true, binding: { state: "detached" } });
    setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(abandon.authority, { "before-c6b7b": () => { throw new Error("proved no install"); }, "after-abandon": () => { throw new Error("abandon lag"); } });
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(abandon.authority, abandon.created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" }); await expect(lstat(abandon.output)).rejects.toMatchObject({ code: "ENOENT" }); setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(abandon.authority, undefined);
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(abandon.authority, abandon.created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_conflict" });
    setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(preCow.authority, { "after-intent": () => { throw new Error("intent only"); } }); await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(preCow.authority, preCow.created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" }); setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(preCow.authority, undefined);
    await expect(detachCheckpointStoryboardRetainedTraceStoredRecord(preCow.authority, preCow.created.record.identity)).rejects.toMatchObject({ code: "materialization_not_bound" }); await expect(tombstoneCheckpointStoryboardStoredRecord(preCow.store, preCow.created.record.identity)).resolves.toMatchObject({ record: { target: { state: "tombstoned" } } });
  }, 45_000);

  it("blocks remove/archive while active, rejects every foreign partition, and serializes duplicate resolves", async () => {
    const active = await fixture(), identity = active.created.record.identity;
    await resolveCheckpointStoryboardRetainedTraceStoredRecord(active.authority, identity);
    await expect(tombstoneCheckpointStoryboardStoredRecord(active.store, identity)).rejects.toMatchObject({ code: "materialization_binding_conflict" }); await expect(archiveCheckpointStoryboardStoredLineage(active.store, identity)).rejects.toMatchObject({ code: "materialization_binding_conflict" });
    await detachCheckpointStoryboardRetainedTraceStoredRecord(active.authority, identity); await expect(tombstoneCheckpointStoryboardStoredRecord(active.store, identity)).resolves.toBeTruthy();
    const residue = await fixture(), residueFacts = checkedAuthority(residue.store); for (const directory of [residueFacts.bindings.path, residueFacts.behaviorResolutions.path, residueFacts.relationResolutions.path, residueFacts.relationActionResolutions.path, residueFacts.lifecycleResolutions.path, residueFacts.geometryMorphResolutions.path]) { const file = join(directory, `${residue.created.record.identity.id}.state.json`); await writeFile(file, "{}\\n", "utf8"); await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(residue.authority, residue.created.record.identity)).rejects.toMatchObject({ code: "store_integrity_failed" }); await rm(file); }
    const serial = await fixture(), serialIdentity = serial.created.record.identity; let entered!: () => void, release!: () => void, cows = 0; const held = new Promise<void>((done) => { entered = done; }), unlock = new Promise<void>((done) => { release = done; });
    setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(serial.authority, { "while-lineage-lock-held": async () => { entered(); await unlock; }, "before-c6b7b": () => { cows += 1; } }); const first = resolveCheckpointStoryboardRetainedTraceStoredRecord(serial.authority, serialIdentity); await held;
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(serial.authority, serialIdentity)).rejects.toMatchObject({ code: "store_busy" }); release(); await expect(first).resolves.toMatchObject({ binding: { state: "bound" } }); expect(cows).toBe(1);
  }, 45_000);

  it("refuses resolution while another process owns the exact lineage lock", async () => {
    const value = await fixture(), identity = value.created.record.identity;
    const lockPath = join(checkedAuthority(value.store).locks.path, `${identity.id}.lock`);
    const child = spawn(process.execPath, ["-e", `
      const { mkdirSync, rmdirSync } = require("node:fs");
      const path = process.argv[1];
      mkdirSync(path, { mode: 0o700 });
      process.stdout.write("locked\\n");
      process.stdin.once("data", () => { rmdirSync(path); process.exit(0); });
    `, lockPath], { stdio: ["pipe", "pipe", "inherit"] });
    await once(child.stdout!, "data");
    try {
      await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(value.authority, identity)).rejects.toMatchObject({ code: "store_busy" });
    } finally {
      child.stdin!.end("release\n");
      await once(child, "exit");
    }
    await expect(resolveCheckpointStoryboardRetainedTraceStoredRecord(value.authority, identity)).resolves.toMatchObject({ binding: { state: "bound" } });
  }, 45_000);
});
