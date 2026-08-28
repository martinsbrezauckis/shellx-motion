import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { canonicalJson, hashBuffer, type MotionPackage } from "@shellx-motion/core";
import type { BrowserFrameBatchOptions, BrowserFrameOptions, BrowserNetworkAccessOptions } from "@shellx-motion/renderer-browser";
import { createCheckpointStoryboard, createTransitionRecipe } from "@shellx-motion/core/internal/checkpoint-storyboard-scalar-spatial-materializer";
import { dispatchDebugCommand } from "../index.js";
import { configureCheckpointStoryboardMaterializationAuthority } from "./checkpoint-storyboard-materialization-authority.js";
import { configureCheckpointStoryboardPreviewAuthority } from "./checkpoint-storyboard-preview-authority.js";
import { detachCheckpointStoryboardStoredRecord, materializeCheckpointStoryboardStoredRecord } from "./checkpoint-storyboard-materialization.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMANDS } from "./checkpoint-storyboard-record-lifecycle.js";
import { archiveCheckpointStoryboardStoredLineage, configureCheckpointStoryboardRecordStore, createCheckpointStoryboardStoredRecord } from "./checkpoint-storyboard-record-store.js";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-c6c-b1d-")); roots.push(root);
  const workspace = join(root, "workspace"), source = join(workspace, "source"), output = join(workspace, "output");
  await mkdir(join(source, "assets"), { recursive: true });
  await writeFile(join(source, "manifest.json"), JSON.stringify({ schema: "shellx-motion/package-manifest@1", id: "package-b1d", name: "B1d", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["native"], hosts: [] } }));
  await writeFile(join(source, "motion.json"), JSON.stringify({ schema: "shellx-motion/motion@1", id: "motion-b1d", name: "B1d", durationMs: 1000, fps: 30, width: 1280, height: 720, layers: [{ id: "orb", type: "shape", shape: "ellipse", startMs: 0, durationMs: 1000, transform: { x: 0, y: 0, rotation: 0, scale: 1 }, opacity: 1 }], assets: [], provenance: { sourceApp: "test", createdBy: "test" } }));
  await writeFile(join(source, "assets", "retained.txt"), "retained\n");
  const store = await configureCheckpointStoryboardRecordStore({ root, integrityKey: Buffer.alloc(32, 9) });
  const anchor = await createTrustedWorkspaceAnchor(workspace);
  const materialization = await configureCheckpointStoryboardMaterializationAuthority({ recordStore: store, sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: anchor, objectLayerBindings: [{ objectId: "orb", layerId: "orb" }] });
  const recipe = createTransitionRecipe({ recipeId: "scalar", seed: 2, exactBaseRequirements: [], intent: { kind: "checkpoint-keyframe", easing: "ease-in-out", targets: [{ objectId: "orb", propertyMask: ["transform.rotation"] }] } });
  const spatial = createTransitionRecipe({ recipeId: "spatial", seed: 3, exactBaseRequirements: [], intent: { kind: "checkpoint-spatial-path", targets: [{ objectId: "orb", tangentMode: "auto" }] } });
  const checkpoint = (id: string, atUs: number, x: number, y: number, rotation: number) => ({ id, atUs, objects: [{ objectId: "orb", state: "present" as const, properties: [{ property: "transform.x" as const, value: x }, { property: "transform.y" as const, value: y }, { property: "transform.rotation" as const, value: rotation }, { property: "transform.scale" as const, value: 1 }, { property: "opacity" as const, value: 1 }] }] });
  const storyboard = createCheckpointStoryboard({ seed: 1, capabilityRequirements: ["renderer.browser"], objectCatalog: [{ objectId: "orb", rootShapeKind: "ellipse", propertyMask: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] }], checkpoints: [checkpoint("start", 0, 0, 0, 0), checkpoint("finish", 1_000_000, 100, 50, 90)], edges: [{ id: "edge", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "orb" }], recipeIds: ["scalar", "spatial"] }], recipes: [recipe, spatial] });
  return { root, output, store, materialization, storyboard };
}

function terminalBoundaryEvidence(atMs: number, extra: Record<string, unknown> = {}) {
  return { schema: "shellx-motion/checkpoint-storyboard-terminal-boundary@1", mode: "exact-duration-static-background", endpoint: { requestedAtMs: atMs, durationMs: 1000, exactDuration: true }, execution: { renderFramesCalls: 1, requestedFrames: 1, capturedFrames: 1, maxConcurrency: 1, maxFrameAttempts: 1, retries: 0, cacheHits: 0, reused: false }, document: { width: 1280, height: 720, background: "#00000000", layersLoaded: 0, sourceLoads: 0, fontLoads: 0, assetLoads: 0, scriptLoads: 0, mediaLoads: 0, webglContexts: 0 }, network: { policy: "deny-all", approvedOrigins: [], requestsAllowed: 0, webSocketsAllowed: 0 }, ...extra };
}

describe.skipIf(process.platform !== "linux")("C6C B1d Debug terminal storyboard previews", () => {
  it("uses the renderer-minted terminal boundary at D for final checkpoint and time targets, preserving their identity", async () => {
    const value = await fixture(); const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard); await materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
    let sessions = 0;
    const preview = configureCheckpointStoryboardPreviewAuthority({ recordStore: value.store, materializationAuthority: value.materialization, testCreateSession: async (_pkg: MotionPackage, sessionOptions: Readonly<{ networkAccess?: BrowserNetworkAccessOptions }>) => {
      sessions += 1; expect(Object.keys(sessionOptions)).toEqual([]);
      const png = Buffer.from(`terminal-boundary-${sessions}`, "utf8");
      return { browserVersion: "source-test", metrics: { browserLaunches: 1, framesRendered: 0, contextsCreated: 0, pagesCreated: 0, activeFrames: 0, peakConcurrentFrames: 1, frameCacheHits: 0, frameRetries: 0 }, scriptExecution: {}, renderFrame: async () => { throw new Error("B1d must use renderFrames."); }, renderFrames: async (request: Array<Omit<BrowserFrameOptions, "networkAccess">>, options?: BrowserFrameBatchOptions) => {
        expect(request).toHaveLength(1); expect(request[0]).toMatchObject({ atMs: 1000, format: "png" }); expect(options).toMatchObject({ maxConcurrency: 1, maxFrameAttempts: 1 });
        if (!request[0]?.outputPath) throw new Error("missing private output stage"); await writeFile(request[0].outputPath, png);
        return [{ ok: true, output: { path: value.output, sha256: hashBuffer(png), format: "png", width: 1280, height: 720, atMs: 1000, browser: { name: "source-test", version: "source-test" }, terminalBoundary: terminalBoundaryEvidence(1000) }, receipt: {} } as never];
      }, close: async () => undefined } as never;
    } });
    const context = { tier: "render_motion" as const, checkpointStoryboardRecordStore: value.store, checkpointStoryboardPreviewAuthority: preview };
    const byCheckpoint = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "checkpoint", checkpointId: "finish" } }, context);
    const byTime = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 1000 } }, context);
    expect(byCheckpoint).toMatchObject({ ok: true, result: { target: { kind: "checkpoint", checkpointId: "finish", resolvedAtMs: 1000 }, sampling: { mode: "terminal-boundary", renderedAtMs: 1000, documentDurationMs: 1000, interval: "[0,D)", layerContent: "excluded-no-hold" } } });
    expect(byTime).toMatchObject({ ok: true, result: { target: { kind: "time", atMs: 1000, resolvedAtMs: 1000 }, sampling: { mode: "terminal-boundary", renderedAtMs: 1000, documentDurationMs: 1000, interval: "[0,D)", layerContent: "excluded-no-hold" } } }); expect(sessions).toBe(2);
    const directory = join(value.root, ".shellx-motion-c6c-record-store", "previews", created.record.identity.id); const receiptName = (await readdir(directory)).find((name) => name.endsWith(".receipt.json")); const receiptRaw = await readFile(join(directory, receiptName!), "utf8");
    expect(receiptRaw).toBe(canonicalJson(JSON.parse(receiptRaw))); expect(JSON.parse(receiptRaw)).toMatchObject({ schema: "shellx-motion/private-checkpoint-storyboard-preview-receipt@2", sampling: { mode: "terminal-boundary", layerContent: "excluded-no-hold" }, terminalBoundary: { schema: "shellx-motion/checkpoint-storyboard-terminal-boundary@1", endpoint: { exactDuration: true }, document: { background: "#00000000", layersLoaded: 0, sourceLoads: 0, fontLoads: 0, assetLoads: 0, scriptLoads: 0, mediaLoads: 0, webglContexts: 0 }, network: { policy: "deny-all", requestsAllowed: 0, webSocketsAllowed: 0 } } });
    await detachCheckpointStoryboardStoredRecord(value.materialization, created.record.identity); await expect(archiveCheckpointStoryboardStoredLineage(value.store, created.record.identity)).resolves.toMatchObject({ replayed: false });
  });

  it("revalidates retained terminal evidence instead of trusting a receipt sampling label", async () => {
    const value = await fixture(); const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard); await materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity); const png = Buffer.from("terminal-retained-evidence", "utf8");
    const preview = configureCheckpointStoryboardPreviewAuthority({ recordStore: value.store, materializationAuthority: value.materialization, testCreateSession: async () => ({ browserVersion: "source-test", metrics: { browserLaunches: 1, framesRendered: 0, contextsCreated: 0, pagesCreated: 0, activeFrames: 0, peakConcurrentFrames: 1, frameCacheHits: 0, frameRetries: 0 }, scriptExecution: {}, renderFrame: async () => { throw new Error("B1d must use renderFrames."); }, renderFrames: async (request: Array<Omit<BrowserFrameOptions, "networkAccess">>) => {
      if (!request[0]?.outputPath) throw new Error("missing private output stage"); await writeFile(request[0].outputPath, png);
      return [{ ok: true, output: { path: value.output, sha256: hashBuffer(png), format: "png", width: 1280, height: 720, atMs: 1000, browser: { name: "source-test", version: "source-test" }, terminalBoundary: terminalBoundaryEvidence(1000) }, receipt: {} } as never];
    }, close: async () => undefined } as never) });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 1000 } }, { tier: "render_motion", checkpointStoryboardRecordStore: value.store, checkpointStoryboardPreviewAuthority: preview })).resolves.toMatchObject({ ok: true });
    const directory = join(value.root, ".shellx-motion-c6c-record-store", "previews", created.record.identity.id); const names = await readdir(directory); const receiptName = names.find((name) => name.endsWith(".receipt.json"))!; const stateName = names.find((name) => name.endsWith(".state.json"))!;
    const receipt = JSON.parse(await readFile(join(directory, receiptName), "utf8")) as { terminalBoundary: { network: { requestsAllowed: number } } }; receipt.terminalBoundary.network.requestsAllowed = 1; const receiptBytes = Buffer.from(canonicalJson(receipt), "utf8"); await writeFile(join(directory, receiptName), receiptBytes, { mode: 0o600 });
    const signedState = JSON.parse(await readFile(join(directory, stateName), "utf8")) as { payload: { receipt: { sha256: string; byteLength: number } }; integrity: string }; signedState.payload.receipt = { sha256: hashBuffer(receiptBytes), byteLength: receiptBytes.byteLength }; const storeStat = await lstat(join(value.root, ".shellx-motion-c6c-record-store")); signedState.integrity = createHmac("sha256", Buffer.alloc(32, 9)).update(`${resolve(value.root)}\0${storeStat.dev}:${storeStat.ino}`).update("\0").update(canonicalJson(signedState.payload)).digest("hex"); await writeFile(join(directory, stateName), `${canonicalJson(signedState)}\n`, { mode: 0o600 });
    await detachCheckpointStoryboardStoredRecord(value.materialization, created.record.identity); await expect(archiveCheckpointStoryboardStoredLineage(value.store, created.record.identity)).rejects.toMatchObject({ code: "preview_publication_uncertain" });
  });

  it("keeps D-1 on the ordinary interior Browser path", async () => {
    const value = await fixture(); const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard); await materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity); const png = Buffer.from("interior-d-minus-one", "utf8");
    const preview = configureCheckpointStoryboardPreviewAuthority({ recordStore: value.store, materializationAuthority: value.materialization, testCreateSession: async (_pkg: MotionPackage, sessionOptions: Readonly<{ networkAccess?: BrowserNetworkAccessOptions }>) => {
      expect(sessionOptions).toEqual({ networkAccess: {} });
      return { browserVersion: "source-test", metrics: { browserLaunches: 1, framesRendered: 0, contextsCreated: 0, pagesCreated: 0, activeFrames: 0, peakConcurrentFrames: 1, frameCacheHits: 0, frameRetries: 0 }, scriptExecution: {}, renderFrame: async () => { throw new Error("B1b must use renderFrames."); }, renderFrames: async (request: Array<Omit<BrowserFrameOptions, "networkAccess">>, options?: BrowserFrameBatchOptions) => {
        expect(request).toHaveLength(1); expect(request[0]).toMatchObject({ atMs: 999, format: "png" }); expect(options).toMatchObject({ maxConcurrency: 1, maxFrameAttempts: 1 }); if (!request[0]?.outputPath) throw new Error("missing private output stage"); await writeFile(request[0].outputPath, png);
        return [{ ok: true, output: { path: value.output, sha256: hashBuffer(png), format: "png", width: 1280, height: 720, atMs: 999, browser: { name: "source-test", version: "source-test" } }, receipt: {} } as never];
      }, close: async () => undefined } as never;
    } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 999 } }, { tier: "render_motion", checkpointStoryboardRecordStore: value.store, checkpointStoryboardPreviewAuthority: preview })).resolves.toMatchObject({ ok: true, result: { target: { kind: "time", atMs: 999, resolvedAtMs: 999 }, sampling: { mode: "interior", renderedAtMs: 999, documentDurationMs: 1000, interval: "[0,D)", layerContent: "included" } } });
  });

  it("refuses missing, forged, or mismatched terminal evidence before receipt-first publication", async () => {
    const wrongBackground = terminalBoundaryEvidence(1000); wrongBackground.document.background = "#ffffff";
    for (const [name, evidence] of [["missing", undefined], ["wrong endpoint", terminalBoundaryEvidence(999)], ["wrong background", wrongBackground], ["forged shape", terminalBoundaryEvidence(1000, { forged: true })]] as const) {
      const value = await fixture(); const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard); await materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity); const png = Buffer.from(`terminal-${name}`, "utf8");
      const preview = configureCheckpointStoryboardPreviewAuthority({ recordStore: value.store, materializationAuthority: value.materialization, testCreateSession: async (_pkg: MotionPackage, sessionOptions: Readonly<{ networkAccess?: BrowserNetworkAccessOptions }>) => {
        expect(Object.keys(sessionOptions)).toEqual([]);
        return { browserVersion: "source-test", metrics: { browserLaunches: 1, framesRendered: 0, contextsCreated: 0, pagesCreated: 0, activeFrames: 0, peakConcurrentFrames: 1, frameCacheHits: 0, frameRetries: 0 }, scriptExecution: {}, renderFrame: async () => { throw new Error("B1d must use renderFrames."); }, renderFrames: async (request: Array<Omit<BrowserFrameOptions, "networkAccess">>) => {
          if (!request[0]?.outputPath) throw new Error("missing private output stage"); await writeFile(request[0].outputPath, png);
          return [{ ok: true, output: { path: value.output, sha256: hashBuffer(png), format: "png", width: 1280, height: 720, atMs: 1000, browser: { name: "source-test", version: "source-test" }, ...(evidence ? { terminalBoundary: evidence } : { network: { policy: "no-approved-origins", approvedOrigins: [], allowPrivateNetwork: false } }) }, receipt: {} } as never];
        }, close: async () => undefined } as never;
      } });
      await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 1000 } }, { tier: "render_motion", checkpointStoryboardRecordStore: value.store, checkpointStoryboardPreviewAuthority: preview })).resolves.toMatchObject({ ok: false, error: { code: "preview_publication_uncertain" } });
      const entries = await readdir(join(value.root, ".shellx-motion-c6c-record-store", "previews", created.record.identity.id)); expect(entries).toHaveLength(1); expect(entries[0]).toMatch(/^checkpoint_storyboard_preview_[a-f0-9]{32}\.state\.json$/u);
      await expect(readFile(join(value.root, ".shellx-motion-c6c-record-store", "previews", created.record.identity.id, entries[0]!), "utf8")).resolves.toContain('"phase":"abandoned"');
    }
  });

  it("abandons a terminal attempt when its B1a output mutates after capture and before receipt publication", async () => {
    const value = await fixture(); const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard); await materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity); const png = Buffer.from("terminal-post-render-mutation", "utf8");
    const preview = configureCheckpointStoryboardPreviewAuthority({ recordStore: value.store, materializationAuthority: value.materialization, testCreateSession: async () => ({ browserVersion: "source-test", metrics: { browserLaunches: 1, framesRendered: 0, contextsCreated: 0, pagesCreated: 0, activeFrames: 0, peakConcurrentFrames: 1, frameCacheHits: 0, frameRetries: 0 }, scriptExecution: {}, renderFrame: async () => { throw new Error("B1d must use renderFrames."); }, renderFrames: async (request: Array<Omit<BrowserFrameOptions, "networkAccess">>) => {
      if (!request[0]?.outputPath) throw new Error("missing private output stage"); await writeFile(request[0].outputPath, png); await writeFile(join(value.output, "motion.json"), "{}", "utf8");
      return [{ ok: true, output: { path: value.output, sha256: hashBuffer(png), format: "png", width: 1280, height: 720, atMs: 1000, browser: { name: "source-test", version: "source-test" }, terminalBoundary: terminalBoundaryEvidence(1000) }, receipt: {} } as never];
    }, close: async () => undefined } as never) });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: 1000 } }, { tier: "render_motion", checkpointStoryboardRecordStore: value.store, checkpointStoryboardPreviewAuthority: preview })).resolves.toMatchObject({ ok: false });
    const entries = await readdir(join(value.root, ".shellx-motion-c6c-record-store", "previews", created.record.identity.id)); expect(entries).toHaveLength(1); expect(entries[0]).toMatch(/^checkpoint_storyboard_preview_[a-f0-9]{32}\.state\.json$/u);
    await expect(readFile(join(value.root, ".shellx-motion-c6c-record-store", "previews", created.record.identity.id, entries[0]!), "utf8")).resolves.toContain('"phase":"abandoned"');
  });
});
