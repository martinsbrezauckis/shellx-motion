import { createHash, createHmac } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "../index.js";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { canonicalJson, hashBuffer, type MotionPackage } from "@shellx-motion/core";
import { approveShotPlan, createCreativeAssetLedger, createCreativeBrief, createCreativeRun, createReviewDecision, createShotPlan } from "./creative-contract/creative-contract.js";
import type { BrowserFrameBatchOptions, BrowserFrameOptions, BrowserNetworkAccessOptions } from "@shellx-motion/renderer-browser";
import { createCheckpointStoryboard, createTransitionRecipe } from "@shellx-motion/core/internal/checkpoint-storyboard-scalar-spatial-materializer";
import { configureCheckpointStoryboardMaterializationAuthority } from "./checkpoint-storyboard-materialization-authority.js";
import { configureCheckpointStoryboardPreviewAuthority, setCheckpointStoryboardPreviewFaultHooksForTest } from "./checkpoint-storyboard-preview-authority.js";
import { configureCheckpointStoryboardCreativeReviewAuthority } from "./checkpoint-storyboard-creative-review-authority.js";
import { setCheckpointStoryboardCreativeReviewFaultHooksForTest } from "./checkpoint-storyboard-creative-review.js";
import { detachCheckpointStoryboardStoredRecord, materializeCheckpointStoryboardStoredRecord, setCheckpointStoryboardMaterializationFaultHooksForTest } from "./checkpoint-storyboard-materialization.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMANDS, dispatchCheckpointStoryboardRecordLifecycleCommand } from "./checkpoint-storyboard-record-lifecycle.js";
import { archiveCheckpointStoryboardStoredLineage, configureCheckpointStoryboardRecordStore, createCheckpointStoryboardStoredRecord, inspectCheckpointStoryboardStoredRecord, issueCheckpointStoryboardRecordStoreQuiescentAdmission, recoverCheckpointStoryboardRecordStoreForQuiescentHost } from "./checkpoint-storyboard-record-store.js";

const roots: string[] = [];
const itLinux = process.platform === "linux" ? it : it.skip;
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

async function fixture(capabilityRequirements: readonly string[] = ["renderer.browser"]) {
  const root = await mkdtemp(join(process.cwd(), ".c6c-b1b-test-")); roots.push(root);
  const workspace = join(root, "workspace"), source = join(workspace, "source"), output = join(workspace, "output");
  await mkdir(join(source, "assets"), { recursive: true });
  await writeFile(join(source, "manifest.json"), JSON.stringify({ schema: "shellx-motion/package-manifest@1", id: "package-b1a", name: "B1a", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["native"], hosts: [] } }));
  await writeFile(join(source, "motion.json"), JSON.stringify({ schema: "shellx-motion/motion@1", id: "motion-b1a", name: "B1a", durationMs: 1000, fps: 30, width: 1280, height: 720, layers: [{ id: "orb", type: "shape", shape: "ellipse", startMs: 0, durationMs: 1000, transform: { x: 0, y: 0, rotation: 0, scale: 1 }, opacity: 1 }], assets: [], provenance: { sourceApp: "test", createdBy: "test" } }));
  await writeFile(join(source, "assets", "retained.txt"), "retained\n");
  const store = await configureCheckpointStoryboardRecordStore({ root, integrityKey: Buffer.alloc(32, 9) });
  const anchor = await createTrustedWorkspaceAnchor(workspace);
  const materialization = await configureCheckpointStoryboardMaterializationAuthority({ recordStore: store, sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: anchor, objectLayerBindings: [{ objectId: "orb", layerId: "orb" }] });
  const scalar = createTransitionRecipe({ recipeId: "scalar", seed: 2, exactBaseRequirements: [], intent: { kind: "checkpoint-keyframe", easing: "ease-in-out", targets: [{ objectId: "orb", propertyMask: ["transform.rotation"] }] } });
  const spatial = createTransitionRecipe({ recipeId: "spatial", seed: 3, exactBaseRequirements: [], intent: { kind: "checkpoint-spatial-path", targets: [{ objectId: "orb", tangentMode: "auto" }] } });
  const storyboard = createCheckpointStoryboard({ seed: 1, capabilityRequirements, objectCatalog: [{ objectId: "orb", rootShapeKind: "ellipse", propertyMask: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] }], checkpoints: [checkpoint("start", 0, 0, 0, 0), checkpoint("finish", 1_000_000, 100, 50, 90)], edges: [{ id: "edge", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "orb" }], recipeIds: ["scalar", "spatial"] }], recipes: [scalar, spatial] });
  return { root, source, output, store, materialization, storyboard };
}
function checkpoint(id: string, atUs: number, x: number, y: number, rotation: number) {
  return { id, atUs, objects: [{ objectId: "orb", state: "present" as const, properties: [{ property: "transform.x" as const, value: x }, { property: "transform.y" as const, value: y }, { property: "transform.rotation" as const, value: rotation }, { property: "transform.scale" as const, value: 1 }, { property: "opacity" as const, value: 1 }] }] };
}
function terminalBoundaryEvidence(atMs: number, extra: Record<string, unknown> = {}) {
  return {
    schema: "shellx-motion/checkpoint-storyboard-terminal-boundary@1",
    mode: "exact-duration-static-background",
    endpoint: { requestedAtMs: atMs, durationMs: 1000, exactDuration: true },
    execution: { renderFramesCalls: 1, requestedFrames: 1, capturedFrames: 1, maxConcurrency: 1, maxFrameAttempts: 1, retries: 0, cacheHits: 0, reused: false },
    document: { width: 1280, height: 720, background: "#00000000", layersLoaded: 0, sourceLoads: 0, fontLoads: 0, assetLoads: 0, scriptLoads: 0, mediaLoads: 0, webglContexts: 0 },
    network: { policy: "deny-all", approvedOrigins: [], requestsAllowed: 0, webSocketsAllowed: 0 },
    ...extra,
  };
}
function lifecycleDescriptor(rotation = 90) {
  return {
    seed: 1,
    capabilityRequirements: ["renderer.browser"],
    objectCatalog: [{ objectId: "orb", rootShapeKind: "ellipse", propertyMask: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] }],
    checkpoints: [checkpoint("start", 0, 0, 0, 0), checkpoint("finish", 1_000_000, 100, 50, rotation)],
    edges: [{ id: "edge", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "orb" }], recipeIds: ["scalar", "spatial"] }],
    recipes: [
      { recipeId: "scalar", seed: 2, exactBaseRequirements: [], intent: { kind: "checkpoint-keyframe", easing: "ease-in-out", targets: [{ objectId: "orb", propertyMask: ["transform.rotation"] }] } },
      { recipeId: "spatial", seed: 3, exactBaseRequirements: [], intent: { kind: "checkpoint-spatial-path", targets: [{ objectId: "orb", tangentMode: "auto" }] } },
    ],
  };
}
function lifecycleIdentity(result: Awaited<ReturnType<typeof dispatchCheckpointStoryboardRecordLifecycleCommand>>) {
  expect(result).toMatchObject({ ok: true });
  if (!result?.ok) throw new Error("Expected lifecycle success.");
  return (result.result as { record: { identity: { id: string; sha256: string; revision: number } } }).record.identity;
}

describe("C6C B1a durable materialization binding", () => {
  itLinux("reuses C6B COW once, replays its binding, and detaches without deleting output even after source removal", async () => {
    const value = await fixture();
    const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
    const dispatched = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.materialize, { identity: created.record.identity }, { tier: "write_local", checkpointStoryboardRecordStore: value.store, checkpointStoryboardMaterializationAuthority: value.materialization });
    expect(dispatched).toMatchObject({ ok: true, result: { renderer: { invoked: false }, binding: { state: "bound", active: 1 } } });
    if (!dispatched.ok) throw new Error("Expected materialize dispatch success.");
    const first = dispatched.result as { binding: { bindingId: string; outputHandle: string; receiptFingerprint: string } };
    expect(JSON.stringify(first)).not.toMatch(new RegExp(value.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const replay = await materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
    expect(replay).toMatchObject({ replayed: true, binding: { bindingId: first.binding.bindingId, outputHandle: first.binding.outputHandle } });
    expect((await inspectCheckpointStoryboardStoredRecord(value.store, created.record.identity)).target.activeMaterializationBindings).toBe(0);
    const inspected = await dispatchCheckpointStoryboardRecordLifecycleCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: created.record.identity }, { checkpointStoryboardRecordStore: value.store, checkpointStoryboardMaterializationAuthority: value.materialization });
    expect(inspected).toMatchObject({ ok: true, result: { record: { target: { activeMaterializationBindings: 1 }, materializationBinding: { state: "bound", active: 1 } } } });
    await rm(value.source, { recursive: true });
    const detached = await detachCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
    expect(detached).toMatchObject({ replayed: false, binding: { state: "detached", active: 0, bindingId: first.binding.bindingId }, renderer: { invoked: false } });
    await expect(readFile(join(value.output, "receipts", "checkpoint-storyboard-scalar-spatial-materialization.v1.json"), "utf8")).resolves.toContain(first.binding.receiptFingerprint);
    await expect(materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity)).rejects.toMatchObject({ code: "materialization_detached" });
  });

  it("refuses a native-only lifecycle record before COW", async () => {
    const value = await fixture(["renderer.native"]);
    const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
    await expect(materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity)).rejects.toMatchObject({ code: "materialization_profile_refused" });
    await expect(readFile(value.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when a final record loses its required materialization state head", async () => {
    const value = await fixture();
    const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
    await rm(join(value.root, ".shellx-motion-c6c-record-store", "bindings", `${created.record.identity.id}.state.json`));
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: created.record.identity }, { tier: "read_motion", checkpointStoryboardRecordStore: value.store, checkpointStoryboardMaterializationAuthority: value.materialization })).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
    await expect(createCheckpointStoryboardStoredRecord(value.store, value.storyboard)).rejects.toMatchObject({ code: "store_integrity_failed" });
  });

  itLinux("terminally abandons an intent-only pre-COW interruption without deleting or recreating output", async () => {
    const value = await fixture();
    const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
    setCheckpointStoryboardMaterializationFaultHooksForTest(value.materialization, { "after-intent": () => { throw new Error(`${value.source}/injected-path`); } });
    await expect(materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    setCheckpointStoryboardMaterializationFaultHooksForTest(value.materialization, undefined);
    await expect(lstat(value.output)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(detachCheckpointStoryboardStoredRecord(value.materialization, created.record.identity)).rejects.toMatchObject({ code: "materialization_not_bound" });
    const inspected = await dispatchCheckpointStoryboardRecordLifecycleCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: created.record.identity }, { checkpointStoryboardRecordStore: value.store });
    expect(inspected).toMatchObject({ ok: true, result: { record: { materializationBinding: { state: "abandoned", active: 0 } } } });
    await expect(materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_conflict" });
  });

  itLinux("never starts a second COW when durable COW-start evidence is removed or output is absent", async () => {
    const value = await fixture();
    const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
    setCheckpointStoryboardMaterializationFaultHooksForTest(value.materialization, { "after-cow-start": () => { throw new Error("interrupted"); } });
    await expect(materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    setCheckpointStoryboardMaterializationFaultHooksForTest(value.materialization, undefined);
    await rm(join(value.root, ".shellx-motion-c6c-record-store", "bindings", `${created.record.identity.id}.cow-start.json`));
    await expect(materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity)).rejects.toMatchObject({ code: "store_integrity_failed" });
    await expect(lstat(value.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itLinux("recovers an exact COW committed before binding and promotes a stale preparing head only from matching evidence", async () => {
    const value = await fixture();
    const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
    setCheckpointStoryboardMaterializationFaultHooksForTest(value.materialization, { "after-c6b-commit": () => { throw new Error("post-commit uncertainty"); } });
    await expect(materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    await expect(readFile(join(value.output, "receipts", "checkpoint-storyboard-scalar-spatial-materialization.v1.json"), "utf8")).resolves.toContain("fingerprint");
    setCheckpointStoryboardMaterializationFaultHooksForTest(value.materialization, undefined);
    const recovered = await materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
    expect(recovered).toMatchObject({ replayed: true, binding: { state: "bound", active: 1 }, renderer: { invoked: false } });
  });

  itLinux("promotes a binding published before its state head and rejects live-output tampering without exposing host paths", async () => {
    const value = await fixture();
    const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
    setCheckpointStoryboardMaterializationFaultHooksForTest(value.materialization, { "after-binding": () => { throw new Error("binding head interruption"); } });
    await expect(materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    setCheckpointStoryboardMaterializationFaultHooksForTest(value.materialization, undefined);
    const recovered = await materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
    expect(recovered).toMatchObject({ replayed: true, binding: { state: "bound" } });
    await writeFile(join(value.output, "motion.json"), "{\"tampered\":true}");
    await expect(materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity)).rejects.toSatisfy((error: unknown) => {
      const errorValue = error as { code?: unknown; message?: unknown };
      return typeof errorValue.code === "string" && typeof errorValue.message === "string" && !errorValue.message.includes(value.source) && !errorValue.message.includes(value.output);
    });
  });

  it("refuses a foreign output collision and a materialization authority bound to another store", async () => {
    const value = await fixture();
    const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
    await writeFile(value.output, "foreign output");
    await expect(materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    await expect(readFile(value.output, "utf8")).resolves.toBe("foreign output");

    const otherRoot = join(value.root, "other-store");
    await mkdir(otherRoot);
    const otherStore = await configureCheckpointStoryboardRecordStore({ root: otherRoot, integrityKey: Buffer.alloc(32, 8) });
    const otherAuthority = await configureCheckpointStoryboardMaterializationAuthority({ recordStore: otherStore, sourcePackageRoot: value.source, outputPackageRoot: join(value.root, "workspace", "other-output"), packageWorkspaceRoot: join(value.root, "workspace"), packageWorkspaceAuthority: await createTrustedWorkspaceAnchor(join(value.root, "workspace")), objectLayerBindings: [{ objectId: "orb", layerId: "orb" }] });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.materialize, { identity: created.record.identity }, { tier: "write_local", checkpointStoryboardRecordStore: value.store, checkpointStoryboardMaterializationAuthority: otherAuthority })).resolves.toMatchObject({ ok: false, error: { code: "materialization_authority_refused" } });
  });

  itLinux("serializes inspect and detach behind a materialize-held lineage lock", async () => {
    const value = await fixture();
    const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
    let entered!: () => void;
    let release!: () => void;
    const enteredLock = new Promise<void>((resolve) => { entered = resolve; });
    const releaseLock = new Promise<void>((resolve) => { release = resolve; });
    setCheckpointStoryboardMaterializationFaultHooksForTest(value.materialization, { "while-lineage-lock-held": async () => { entered(); await releaseLock; } });
    const materializing = materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
    await enteredLock;
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: created.record.identity }, { tier: "read_motion", checkpointStoryboardRecordStore: value.store })).resolves.toMatchObject({ ok: false, error: { code: "store_busy" } });
    await expect(detachCheckpointStoryboardStoredRecord(value.materialization, created.record.identity)).rejects.toMatchObject({ code: "store_busy" });
    release();
    setCheckpointStoryboardMaterializationFaultHooksForTest(value.materialization, undefined);
    await expect(materializing).resolves.toMatchObject({ binding: { state: "bound" } });
  });

  itLinux("rejects a tampered C6B receipt on a bound replay without replacing the retained output", async () => {
    const value = await fixture();
    const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
    await materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
    const receipt = join(value.output, "receipts", "checkpoint-storyboard-scalar-spatial-materialization.v1.json");
    await writeFile(receipt, "{\"forged\":true}");
    await expect(materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity)).rejects.toSatisfy((error: unknown) => {
      const errorValue = error as { code?: unknown; message?: unknown };
      return typeof errorValue.code === "string" && typeof errorValue.message === "string" && !errorValue.message.includes(value.root);
    });
    await expect(readFile(receipt, "utf8")).resolves.toBe("{\"forged\":true}");
  });

  itLinux("resyncs bound and detached state heads after a post-rename durability uncertainty", async () => {
    const bound = await fixture();
    const boundRecord = await createCheckpointStoryboardStoredRecord(bound.store, bound.storyboard);
    setCheckpointStoryboardMaterializationFaultHooksForTest(bound.materialization, { "after-bound-state-head-rename": () => { throw new Error("bound state fsync interrupted"); } });
    await expect(materializeCheckpointStoryboardStoredRecord(bound.materialization, boundRecord.record.identity)).rejects.toMatchObject({ code: "record_commit_uncertain" });
    setCheckpointStoryboardMaterializationFaultHooksForTest(bound.materialization, undefined);
    await expect(materializeCheckpointStoryboardStoredRecord(bound.materialization, boundRecord.record.identity)).resolves.toMatchObject({ replayed: true, binding: { state: "bound", active: 1 } });

    const detached = await fixture();
    const detachedRecord = await createCheckpointStoryboardStoredRecord(detached.store, detached.storyboard);
    await materializeCheckpointStoryboardStoredRecord(detached.materialization, detachedRecord.record.identity);
    setCheckpointStoryboardMaterializationFaultHooksForTest(detached.materialization, { "after-detached-state-head-rename": () => { throw new Error("detached state fsync interrupted"); } });
    await expect(detachCheckpointStoryboardStoredRecord(detached.materialization, detachedRecord.record.identity)).rejects.toMatchObject({ code: "record_commit_uncertain" });
    setCheckpointStoryboardMaterializationFaultHooksForTest(detached.materialization, undefined);
    await expect(detachCheckpointStoryboardStoredRecord(detached.materialization, detachedRecord.record.identity)).resolves.toMatchObject({ replayed: true, binding: { state: "detached", active: 0 } });
  });

  itLinux("retains a foreign output that appears after B1a's precheck and before C6B commits", async () => {
    const value = await fixture();
    const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
    setCheckpointStoryboardMaterializationFaultHooksForTest(value.materialization, { "before-c6b": async () => { await mkdir(value.output); await writeFile(join(value.output, "foreign.txt"), "do-not-touch"); } });
    await expect(materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    setCheckpointStoryboardMaterializationFaultHooksForTest(value.materialization, undefined);
    await expect(readFile(join(value.output, "foreign.txt"), "utf8")).resolves.toBe("do-not-touch");
    await expect(lstat(join(value.output, "receipts", "checkpoint-storyboard-scalar-spatial-materialization.v1.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
  });

  itLinux("promotes exact detach and abandonment evidence that survived before their state-head publications", async () => {
    const detached = await fixture();
    const detachedRecord = await createCheckpointStoryboardStoredRecord(detached.store, detached.storyboard);
    await materializeCheckpointStoryboardStoredRecord(detached.materialization, detachedRecord.record.identity);
    setCheckpointStoryboardMaterializationFaultHooksForTest(detached.materialization, { "after-detach": () => { throw new Error("detach head interruption"); } });
    await expect(detachCheckpointStoryboardStoredRecord(detached.materialization, detachedRecord.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    setCheckpointStoryboardMaterializationFaultHooksForTest(detached.materialization, undefined);
    await expect(detachCheckpointStoryboardStoredRecord(detached.materialization, detachedRecord.record.identity)).resolves.toMatchObject({ replayed: true, binding: { state: "detached", active: 0 } });

    const abandoned = await fixture();
    const abandonedRecord = await createCheckpointStoryboardStoredRecord(abandoned.store, abandoned.storyboard);
    setCheckpointStoryboardMaterializationFaultHooksForTest(abandoned.materialization, {
      "before-c6b": () => { throw new Error("proven pre-install refusal"); },
      "after-abandon": () => { throw new Error("abandon head interruption"); },
    });
    await expect(materializeCheckpointStoryboardStoredRecord(abandoned.materialization, abandonedRecord.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    setCheckpointStoryboardMaterializationFaultHooksForTest(abandoned.materialization, undefined);
    const inspected = await dispatchCheckpointStoryboardRecordLifecycleCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: abandonedRecord.record.identity }, { checkpointStoryboardRecordStore: abandoned.store });
    expect(inspected).toMatchObject({ ok: true, result: { record: { materializationBinding: { state: "abandoned", active: 0 } } } });
    await expect(materializeCheckpointStoryboardStoredRecord(abandoned.materialization, abandonedRecord.record.identity)).rejects.toMatchObject({ code: "materialization_binding_conflict" });
  });

  it("keeps deterministic private fault seams out of the Debug public index", async () => {
    await expect(readFile(new URL("../index.ts", import.meta.url), "utf8")).resolves.not.toContain("setCheckpointStoryboardMaterializationFaultHooksForTest");
    await expect(readFile(new URL("../index.ts", import.meta.url), "utf8")).resolves.not.toContain("setCheckpointStoryboardPreviewFaultHooksForTest");
    await expect(readFile(new URL("../index.ts", import.meta.url), "utf8")).resolves.not.toContain("invokeCheckpointStoryboardPreviewFaultHookForTest");
  });

  itLinux("previews a source-deleted B1a output through one admitted Browser frame without exposing paths", async () => {
    const value = await fixture();
    const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
    await materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
    let sessions = 0;
    let frames = 0;
    const png = Buffer.from("not-a-real-png-but-a-private-stage-fixture", "utf8");
    const preview = configureCheckpointStoryboardPreviewAuthority({
      recordStore: value.store,
      materializationAuthority: value.materialization,
      testCreateSession: async (_pkg: MotionPackage, sessionOptions: Readonly<{ networkAccess?: BrowserNetworkAccessOptions }>) => {
        expect(sessionOptions).toEqual({ networkAccess: {} });
        return {
        browserVersion: "source-test",
        metrics: { browserLaunches: 1, framesRendered: 0, contextsCreated: 0, pagesCreated: 0, activeFrames: 0, peakConcurrentFrames: 1, frameCacheHits: 0, frameRetries: 0 },
        scriptExecution: {},
        renderFrame: async () => { throw new Error("B1b must use renderFrames."); },
        renderFrames: async (request: Array<Omit<BrowserFrameOptions, "networkAccess">>, options?: BrowserFrameBatchOptions) => {
          sessions += 1;
          expect(request).toHaveLength(1);
          expect(options).toMatchObject({ maxConcurrency: 1, maxFrameAttempts: 1 });
          expect(request[0]).toMatchObject({ atMs: 0, format: "png" });
          if (!request[0]?.outputPath) throw new Error("missing private output stage");
          await writeFile(request[0].outputPath, png);
          expect(options?.signal).toBeUndefined();
          frames += 1;
          return [{ ok: true, output: { path: value.output, sha256: hashBuffer(png), format: "png", width: 1280, height: 720, atMs: 0, browser: { name: "source-test", version: "source-test" } }, receipt: {} } as never];
        },
        close: async () => undefined,
        } as never;
      },
    });
    await rm(value.source, { recursive: true });
    const result = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "checkpoint", checkpointId: "start" } }, { tier: "render_motion", checkpointStoryboardRecordStore: value.store, checkpointStoryboardPreviewAuthority: preview });
    expect(result).toMatchObject({ ok: true, result: { resolvedAtMs: 0, output: { sha256: hashBuffer(png), width: 1280, height: 720, format: "png" }, browser: { runtimeEvidence: "source-test", network: { policy: "no-approved-origins", approvedOrigins: 0, allowPrivateNetwork: false } } } });
    expect(sessions).toBe(1); expect(frames).toBe(1);
    expect(JSON.stringify(result)).not.toContain(value.root);
    expect(JSON.stringify(result)).not.toContain(value.output);
    const previewDirectory = join(value.root, ".shellx-motion-c6c-record-store", "previews", created.record.identity.id);
    const receiptName = (await readdir(previewDirectory)).find((name) => name.endsWith(".receipt.json"));
    expect(receiptName).toBeDefined();
    await expect(readFile(join(previewDirectory, receiptName!), "utf8")).resolves.not.toContain(value.root);
    await detachCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
    await expect(archiveCheckpointStoryboardStoredLineage(value.store, created.record.identity)).resolves.toMatchObject({ replayed: false });
  });

  itLinux("rejects loose, unsafe, and out-of-range preview targets before Browser acquisition", async () => {
    const value = await fixture();
    const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
    await materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
    let sessions = 0;
    const preview = configureCheckpointStoryboardPreviewAuthority({ recordStore: value.store, materializationAuthority: value.materialization, testCreateSession: async () => { sessions += 1; throw new Error("must not acquire Browser"); } });
    const context = { tier: "render_motion" as const, checkpointStoryboardRecordStore: value.store, checkpointStoryboardPreviewAuthority: preview };
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 0.5 } }, context)).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "checkpoint", checkpointId: "start", atMs: 0 } }, context)).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 0 }, playhead: 0 }, context)).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 0, networkAccess: {} } }, context)).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 0 }, endpoint: "D" }, context)).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 0 }, workflow: {} }, context)).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 0 }, lane: "browser" }, context)).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 0 }, outputPath: value.output }, context)).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, Object.create({ identity: created.record.identity, target: { kind: "time", atMs: 0 } }), context)).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: -1 } }, context)).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: Number.MAX_SAFE_INTEGER + 1 } }, context)).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "checkpoint", checkpointId: "missing" } }, context)).resolves.toMatchObject({ ok: false, error: { code: "preview_target_invalid" } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 1001 } }, context)).resolves.toMatchObject({ ok: false, error: { code: "preview_target_invalid" } });
    const controller = new AbortController(); controller.abort();
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 0 } }, { ...context, executionSignal: controller.signal })).resolves.toMatchObject({ ok: false, error: { code: "preview_cancelled" } });
    expect(sessions).toBe(0);
    await expect(readdir(join(value.root, ".shellx-motion-c6c-record-store", "previews", created.record.identity.id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  itLinux("refuses cross-store, structural, inactive, terminal, and tampered preview authority before Browser/session or a preview journal", async () => {
    const value = await fixture();
    const other = await fixture();
    const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
    const noJournal = async () => await expect(readdir(join(value.root, ".shellx-motion-c6c-record-store", "previews", created.record.identity.id))).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => configureCheckpointStoryboardPreviewAuthority({ recordStore: value.store, materializationAuthority: other.materialization })).toThrow();
    const foreignPreview = configureCheckpointStoryboardPreviewAuthority({ recordStore: other.store, materializationAuthority: other.materialization });
    const structuralPreview = configureCheckpointStoryboardPreviewAuthority({ recordStore: value.store, materializationAuthority: value.materialization });
    const foreign = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 0 } }, { tier: "render_motion", checkpointStoryboardRecordStore: value.store, checkpointStoryboardPreviewAuthority: foreignPreview });
    const structural = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 0 } }, { tier: "render_motion", checkpointStoryboardRecordStore: value.store, checkpointStoryboardPreviewAuthority: { ...structuralPreview } as never });
    expect(foreign).toMatchObject({ ok: false, error: { code: "preview_authority_refused" } });
    expect(structural).toMatchObject({ ok: false, error: { code: "preview_authority_refused" } });
    await noJournal();

    let sessions = 0;
    const preview = configureCheckpointStoryboardPreviewAuthority({ recordStore: value.store, materializationAuthority: value.materialization, testCreateSession: async () => { sessions += 1; throw new Error("Browser must not start"); } });
    await materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
    await detachCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 0 } }, { tier: "render_motion", checkpointStoryboardRecordStore: value.store, checkpointStoryboardPreviewAuthority: preview })).resolves.toMatchObject({ ok: false, error: { code: "preview_binding_not_active" } });
    expect(sessions).toBe(0); await noJournal();

    const tombstoned = await fixture();
    const tombstoneRecord = await createCheckpointStoryboardStoredRecord(tombstoned.store, tombstoned.storyboard);
    const tombstonePreview = configureCheckpointStoryboardPreviewAuthority({ recordStore: tombstoned.store, materializationAuthority: tombstoned.materialization, testCreateSession: async () => { sessions += 1; throw new Error("Browser must not start"); } });
    await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.remove, { identity: tombstoneRecord.record.identity }, { tier: "write_local", checkpointStoryboardRecordStore: tombstoned.store });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: tombstoneRecord.record.identity, target: { kind: "time", atMs: 0 } }, { tier: "render_motion", checkpointStoryboardRecordStore: tombstoned.store, checkpointStoryboardPreviewAuthority: tombstonePreview })).resolves.toMatchObject({ ok: false, error: { code: "record_tombstoned" } });

    const archived = await fixture();
    const archiveRecord = await createCheckpointStoryboardStoredRecord(archived.store, archived.storyboard);
    const archivePreview = configureCheckpointStoryboardPreviewAuthority({ recordStore: archived.store, materializationAuthority: archived.materialization, testCreateSession: async () => { sessions += 1; throw new Error("Browser must not start"); } });
    await archiveCheckpointStoryboardStoredLineage(archived.store, archiveRecord.record.identity);
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: archiveRecord.record.identity, target: { kind: "time", atMs: 0 } }, { tier: "render_motion", checkpointStoryboardRecordStore: archived.store, checkpointStoryboardPreviewAuthority: archivePreview })).resolves.toMatchObject({ ok: false, error: { code: "lineage_archived" } });

    const tampered = await fixture();
    const tamperedRecord = await createCheckpointStoryboardStoredRecord(tampered.store, tampered.storyboard);
    const tamperedPreview = configureCheckpointStoryboardPreviewAuthority({ recordStore: tampered.store, materializationAuthority: tampered.materialization, testCreateSession: async () => { sessions += 1; throw new Error("Browser must not start"); } });
    await materializeCheckpointStoryboardStoredRecord(tampered.materialization, tamperedRecord.record.identity);
    await writeFile(join(tampered.root, ".shellx-motion-c6c-record-store", "bindings", `${tamperedRecord.record.identity.id}.binding.json`), "{}", { mode: 0o600 });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: tamperedRecord.record.identity, target: { kind: "time", atMs: 0 } }, { tier: "render_motion", checkpointStoryboardRecordStore: tampered.store, checkpointStoryboardPreviewAuthority: tamperedPreview })).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
    expect(sessions).toBe(0);
  });

  itLinux("retains interior receipt-first cancellation evidence only as a receipt-revoked signed state", async () => {
    const value = await fixture();
    const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
    await materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
    const controller = new AbortController();
    const png = Buffer.from("receipt-interior-cancellation-png", "utf8");
    const preview = configureCheckpointStoryboardPreviewAuthority({
      recordStore: value.store,
      materializationAuthority: value.materialization,
      testCreateSession: async (_pkg: MotionPackage, sessionOptions: Readonly<{ networkAccess?: BrowserNetworkAccessOptions }>) => {
        expect(sessionOptions).toEqual({ networkAccess: {} });
        return {
          browserVersion: "source-test",
          metrics: { browserLaunches: 1, framesRendered: 0, contextsCreated: 0, pagesCreated: 0, activeFrames: 0, peakConcurrentFrames: 1, frameCacheHits: 0, frameRetries: 0 },
          scriptExecution: {},
          renderFrame: async () => { throw new Error("B1b must use renderFrames."); },
          renderFrames: async (request: Array<Omit<BrowserFrameOptions, "networkAccess">>) => {
            if (!request[0]?.outputPath) throw new Error("missing private output stage");
            await writeFile(request[0].outputPath, png);
            return [{ ok: true, output: { path: value.output, sha256: hashBuffer(png), format: "png", width: 1280, height: 720, atMs: 0, browser: { name: "source-test", version: "source-test" }, network: { policy: "no-approved-origins", approvedOrigins: [], allowPrivateNetwork: false } }, receipt: {} } as never];
          },
          close: async () => undefined,
        } as never;
      },
    });
    setCheckpointStoryboardPreviewFaultHooksForTest(preview, { afterReceiptPublished: () => controller.abort() });
    try {
      await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 0 } }, { tier: "render_motion", checkpointStoryboardRecordStore: value.store, checkpointStoryboardPreviewAuthority: preview, executionSignal: controller.signal })).resolves.toMatchObject({ ok: false, error: { code: "preview_cancelled" } });
    } finally { setCheckpointStoryboardPreviewFaultHooksForTest(preview, undefined); }
    const entries = await readdir(join(value.root, ".shellx-motion-c6c-record-store", "previews", created.record.identity.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^checkpoint_storyboard_preview_[a-f0-9]{32}\.state\.json$/u);
    await expect(readFile(join(value.root, ".shellx-motion-c6c-record-store", "previews", created.record.identity.id, entries[0]!), "utf8")).resolves.toContain('"phase":"receipt-revoked"');
  });

  itLinux("retains terminal receipt-first cancellation evidence only as a receipt-revoked signed state", async () => {
    const value = await fixture();
    const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
    await materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
    const controller = new AbortController();
    const png = Buffer.from("receipt-boundary-cancellation-png", "utf8");
    const preview = configureCheckpointStoryboardPreviewAuthority({
      recordStore: value.store,
      materializationAuthority: value.materialization,
      testCreateSession: async () => ({
        browserVersion: "source-test",
        metrics: { browserLaunches: 1, framesRendered: 0, contextsCreated: 0, pagesCreated: 0, activeFrames: 0, peakConcurrentFrames: 1, frameCacheHits: 0, frameRetries: 0 },
        scriptExecution: {},
        renderFrame: async () => { throw new Error("B1b must use renderFrames."); },
        renderFrames: async (request: Array<Omit<BrowserFrameOptions, "networkAccess">>) => {
          if (!request[0]?.outputPath) throw new Error("missing private output stage");
          await writeFile(request[0].outputPath, png);
          return [{ ok: true, output: { path: value.output, sha256: hashBuffer(png), format: "png", width: 1280, height: 720, atMs: 1000, browser: { name: "source-test", version: "source-test" }, terminalBoundary: terminalBoundaryEvidence(1000) }, receipt: {} } as never];
        },
        close: async () => undefined,
      } as never),
    });
    setCheckpointStoryboardPreviewFaultHooksForTest(preview, { afterReceiptPublished: () => controller.abort() });
    try {
      await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 1000 } }, { tier: "render_motion", checkpointStoryboardRecordStore: value.store, checkpointStoryboardPreviewAuthority: preview, executionSignal: controller.signal })).resolves.toMatchObject({ ok: false, error: { code: "preview_cancelled" } });
    } finally { setCheckpointStoryboardPreviewFaultHooksForTest(preview, undefined); }
    const entries = await readdir(join(value.root, ".shellx-motion-c6c-record-store", "previews", created.record.identity.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^checkpoint_storyboard_preview_[a-f0-9]{32}\.state\.json$/u);
    await expect(readFile(join(value.root, ".shellx-motion-c6c-record-store", "previews", created.record.identity.id, entries[0]!), "utf8")).resolves.toContain('"phase":"receipt-revoked"');
  });

  itLinux("refuses a Browser frame whose resolved time or canvas identity differs from the admitted package", async () => {
    const value = await fixture();
    const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
    await materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
    const png = Buffer.from("wrong-frame-facts-png", "utf8");
    const preview = configureCheckpointStoryboardPreviewAuthority({
      recordStore: value.store,
      materializationAuthority: value.materialization,
      testCreateSession: async () => ({
        browserVersion: "source-test", metrics: { browserLaunches: 1, framesRendered: 0, contextsCreated: 0, pagesCreated: 0, activeFrames: 0, peakConcurrentFrames: 1, frameCacheHits: 0, frameRetries: 0 }, scriptExecution: {},
        renderFrame: async () => { throw new Error("B1b must use renderFrames."); },
        renderFrames: async (request: Array<Omit<BrowserFrameOptions, "networkAccess">>) => {
          if (!request[0]?.outputPath) throw new Error("missing private output stage");
          await writeFile(request[0].outputPath, png);
          return [{ ok: true, output: { path: value.output, sha256: hashBuffer(png), format: "png", width: 1280, height: 720, atMs: 1, browser: { name: "source-test", version: "source-test" } }, receipt: {} } as never];
        }, close: async () => undefined,
      } as never),
    });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 0 } }, { tier: "render_motion", checkpointStoryboardRecordStore: value.store, checkpointStoryboardPreviewAuthority: preview })).resolves.toMatchObject({ ok: false, error: { code: "preview_publication_uncertain" } });
    const entries = await readdir(join(value.root, ".shellx-motion-c6c-record-store", "previews", created.record.identity.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^checkpoint_storyboard_preview_[a-f0-9]{32}\.state\.json$/u);
    await expect(readFile(join(value.root, ".shellx-motion-c6c-record-store", "previews", created.record.identity.id, entries[0]!), "utf8")).resolves.toContain('"phase":"abandoned"');
  });

  itLinux("refuses archive when a completed private preview receipt is tampered", async () => {
    const value = await fixture();
    const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
    await materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
    const png = Buffer.from("tampered-preview-receipt-png", "utf8");
    const preview = configureCheckpointStoryboardPreviewAuthority({
      recordStore: value.store,
      materializationAuthority: value.materialization,
      testCreateSession: async () => ({
        browserVersion: "source-test", metrics: { browserLaunches: 1, framesRendered: 0, contextsCreated: 0, pagesCreated: 0, activeFrames: 0, peakConcurrentFrames: 1, frameCacheHits: 0, frameRetries: 0 }, scriptExecution: {},
        renderFrame: async () => { throw new Error("B1b must use renderFrames."); },
        renderFrames: async (request: Array<Omit<BrowserFrameOptions, "networkAccess">>) => {
          if (!request[0]?.outputPath) throw new Error("missing private output stage");
          await writeFile(request[0].outputPath, png);
          return [{ ok: true, output: { path: value.output, sha256: hashBuffer(png), format: "png", width: 1280, height: 720, atMs: 0, browser: { name: "source-test", version: "source-test" } }, receipt: {} } as never];
        }, close: async () => undefined,
      } as never),
    });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 0 } }, { tier: "render_motion", checkpointStoryboardRecordStore: value.store, checkpointStoryboardPreviewAuthority: preview })).resolves.toMatchObject({ ok: true });
    const directory = join(value.root, ".shellx-motion-c6c-record-store", "previews", created.record.identity.id);
    const receipt = (await readdir(directory)).find((name) => name.endsWith(".receipt.json"));
    await writeFile(join(directory, receipt!), "{}", { mode: 0o600 });
    await detachCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
    await expect(archiveCheckpointStoryboardStoredLineage(value.store, created.record.identity)).rejects.toMatchObject({ code: "preview_publication_uncertain" });
  });

  itLinux("preserves a post-link preparing preview for supervisor-only recovery and blocks archive until then", async () => {
    const value = await fixture();
    const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
    await materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
    const preview = configureCheckpointStoryboardPreviewAuthority({ recordStore: value.store, materializationAuthority: value.materialization });
    setCheckpointStoryboardPreviewFaultHooksForTest(preview, { afterPreparing: () => { throw new Error("deterministic post-link preparing interruption"); } });
    try {
      const interrupted = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "checkpoint", checkpointId: "start" } }, { tier: "render_motion", checkpointStoryboardRecordStore: value.store, checkpointStoryboardPreviewAuthority: preview });
      expect(interrupted).toMatchObject({ ok: false, error: { code: "preview_publication_uncertain" } });
      expect(JSON.stringify(interrupted)).not.toContain(value.root);
    } finally { setCheckpointStoryboardPreviewFaultHooksForTest(preview, undefined); }
    await detachCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
    await expect(archiveCheckpointStoryboardStoredLineage(value.store, created.record.identity)).rejects.toMatchObject({ code: "preview_publication_uncertain" });
    await expect(recoverCheckpointStoryboardRecordStoreForQuiescentHost(value.store, issueCheckpointStoryboardRecordStoreQuiescentAdmission(value.store))).resolves.toMatchObject({ removedStaleLocks: 0 });
    await expect(archiveCheckpointStoryboardStoredLineage(value.store, created.record.identity)).resolves.toMatchObject({ replayed: false });
  });

  itLinux("never rebuilds a finalized lineage roster after deletion, including a bound descendant or missing head", async () => {
    const value = await fixture();
    const services = { checkpointStoryboardRecordStore: value.store, checkpointStoryboardMaterializationAuthority: value.materialization };
    const root = lifecycleIdentity(await dispatchCheckpointStoryboardRecordLifecycleCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: lifecycleDescriptor() }, services));
    const child = lifecycleIdentity(await dispatchCheckpointStoryboardRecordLifecycleCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: root, descriptor: lifecycleDescriptor(180) }, services));
    await expect(materializeCheckpointStoryboardStoredRecord(value.materialization, child)).resolves.toMatchObject({ binding: { state: "bound" } });
    const memberDirectory = join(value.root, ".shellx-motion-c6c-record-store", "members", root.id);
    await rm(memberDirectory, { recursive: true });
    await expect(dispatchCheckpointStoryboardRecordLifecycleCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: lifecycleDescriptor() }, services)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
    await expect(dispatchCheckpointStoryboardRecordLifecycleCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.archive, { identity: root }, services)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
    await expect(dispatchCheckpointStoryboardRecordLifecycleCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: root }, services)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });

    const second = await fixture();
    const secondServices = { checkpointStoryboardRecordStore: second.store, checkpointStoryboardMaterializationAuthority: second.materialization };
    const secondRoot = lifecycleIdentity(await dispatchCheckpointStoryboardRecordLifecycleCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: lifecycleDescriptor() }, secondServices));
    await rm(join(second.root, ".shellx-motion-c6c-record-store", "members", secondRoot.id, "head.json"));
    await expect(dispatchCheckpointStoryboardRecordLifecycleCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: lifecycleDescriptor() }, secondServices)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
    await expect(dispatchCheckpointStoryboardRecordLifecycleCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.archive, { identity: secondRoot }, secondServices)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });

    const third = await fixture();
    const thirdServices = { checkpointStoryboardRecordStore: third.store, checkpointStoryboardMaterializationAuthority: third.materialization };
    const thirdRoot = lifecycleIdentity(await dispatchCheckpointStoryboardRecordLifecycleCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: lifecycleDescriptor() }, thirdServices));
    const thirdMembers = join(third.root, ".shellx-motion-c6c-record-store", "members", thirdRoot.id);
    const retainedRootHead = await readFile(join(thirdMembers, "head.json"));
    const thirdChild = lifecycleIdentity(await dispatchCheckpointStoryboardRecordLifecycleCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: thirdRoot, descriptor: lifecycleDescriptor(180) }, thirdServices));
    await materializeCheckpointStoryboardStoredRecord(third.materialization, thirdChild);
    // A valid old head plus a deleted ordinal tail must not hide this bound descendant at archive.
    await writeFile(join(thirdMembers, "head.json"), retainedRootHead);
    await rm(join(thirdMembers, "2.json"));
    await expect(dispatchCheckpointStoryboardRecordLifecycleCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.archive, { identity: thirdRoot }, thirdServices)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });

    const fourth = await fixture();
    const fourthServices = { checkpointStoryboardRecordStore: fourth.store, checkpointStoryboardMaterializationAuthority: fourth.materialization };
    const fourthRoot = lifecycleIdentity(await dispatchCheckpointStoryboardRecordLifecycleCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: lifecycleDescriptor() }, fourthServices));
    const fourthMembers = join(fourth.root, ".shellx-motion-c6c-record-store", "members", fourthRoot.id);
    const fourthOldHead = await readFile(join(fourthMembers, "head.json"));
    const fourthChild = lifecycleIdentity(await dispatchCheckpointStoryboardRecordLifecycleCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: fourthRoot, descriptor: lifecycleDescriptor(180) }, fourthServices));
    await materializeCheckpointStoryboardStoredRecord(fourth.materialization, fourthChild);
    await writeFile(join(fourthMembers, "head.json"), fourthOldHead);
    await rm(join(fourthMembers, "2.json"));
    await rm(join(fourth.root, ".shellx-motion-c6c-record-store", "records", `${fourthChild.id}.json`));
    await rm(join(fourth.root, ".shellx-motion-c6c-record-store", "targets", `${fourthChild.id}.active.json`));
    // Retained signed B1a phase journals are a separate witness: archive must not strand this
    // now-hidden active binding merely because its record, target, and member tail were deleted.
    await expect(dispatchCheckpointStoryboardRecordLifecycleCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.archive, { identity: fourthRoot }, fourthServices)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
  });
});
