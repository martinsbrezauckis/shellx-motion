import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonSha256, crc32 } from "@shellx-motion/core";
import { createCheckpointStoryboard, createTransitionRecipe } from "@shellx-motion/core/internal/checkpoint-storyboard-scalar-spatial-materializer";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { resolveRendererPrivateOutputPublication } from "@shellx-motion/renderer-browser/internal/private-output-publication";
import { debugCommandContract, dispatchDebugCommand } from "../index.js";
import { DEBUG_COMMANDS, debugCommandDefinition } from "../command-registry.js";
import { configureCheckpointStoryboardRetainedTracePreviewAuthority, withCheckpointStoryboardRetainedTracePreviewAuthority, type CheckpointStoryboardRetainedTracePreviewRenderer } from "./checkpoint-storyboard-retained-trace-preview-authority.js";
import { reopenCheckpointStoryboardRetainedTraceMaterializationOutput, reopenCheckpointStoryboardRetainedTracePreviewInput } from "./checkpoint-storyboard-retained-trace-materialize-private/checkpoint-storyboard-retained-trace-materialize-output-private.js";
import { configureCheckpointStoryboardRetainedTraceResolutionAuthority } from "./checkpoint-storyboard-retained-trace-resolution-authority.js";
import { detachCheckpointStoryboardRetainedTraceStoredRecord, resolveCheckpointStoryboardRetainedTraceStoredRecord, withCheckpointStoryboardRetainedTraceActivePreviewInput } from "./checkpoint-storyboard-retained-trace-resolution.js";
import { checkedAuthority, configureCheckpointStoryboardRecordStore } from "./checkpoint-storyboard-record-store-authority.js";
import { lineageRetainedTracePreviewsDirectory } from "./checkpoint-storyboard-retained-trace-preview-store.js";
import { createCheckpointStoryboardStoredRecord, tombstoneCheckpointStoryboardStoredRecord } from "./checkpoint-storyboard-record-store.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMANDS } from "./checkpoint-storyboard-record-lifecycle.js";

const roots: string[] = [];
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

afterEach(async () => await Promise.all(roots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true }))));

function trace() {
  return {
    schema: "shellx-motion/private-parametric-trace@1",
    clip: { durationUs: 4_000, sampleIntervalUs: 1_000 },
    drawers: [{
      id: "line",
      driver: { kind: "parametric-graph", graph: { nodes: [{ id: "time", kind: "time-us" }, { id: "scale", kind: "constant", value: 0.001 }, { id: "x", kind: "multiply", left: "time", right: "scale" }, { id: "zero", kind: "constant", value: 0 }], output: { x: "x", y: "zero", z: "zero" } } },
      retention: { kind: "full-clip", maxSamples: 5 },
      output: { mode: "line", width: { source: "constant", from: 2, to: 2 }, colour: { source: "constant", from: 0.5, to: 0.5 }, opacity: { source: "constant", from: 0.75, to: 0.75 }, speedLimit: 100 },
    }],
    caps: { perDrawer: { maxSamples: 64, maxVertices: 64, maxWorkUnits: 16_384, maxBytes: 128 * 1024 }, aggregate: { maxSamples: 64, maxVertices: 64, maxWorkUnits: 16_384, maxBytes: 128 * 1024 } },
  };
}

function storyboard(seed = 1) {
  const recipe = createTransitionRecipe({ recipeId: "retained-line", seed: seed + 1, exactBaseRequirements: [], intent: { kind: "parametric-trace", outputObjectId: "trace-anchor", trace: trace() } });
  return createCheckpointStoryboard({
    seed,
    capabilityRequirements: ["renderer.gpu"],
    objectCatalog: [{ objectId: "trace-anchor", rootShapeKind: "rect", propertyMask: ["opacity"] }],
    checkpoints: [{ id: "start", atUs: 0, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] }, { id: "finish", atUs: 4_000, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] }],
    edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "trace-anchor" }], recipeIds: ["retained-line"] }],
    recipes: [recipe],
  });
}

function pngFrame(width = 1280, height = 720): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(scanlines)), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0); chunk.write(type, 4, 4, "ascii"); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return chunk;
}

function injectedRenderer(calls: number[], afterStage?: () => void, frame = pngFrame()): CheckpointStoryboardRetainedTracePreviewRenderer {
  const renderer: CheckpointStoryboardRetainedTracePreviewRenderer = async (_pkg, options) => {
    const publication = resolveRendererPrivateOutputPublication(options);
    if (!publication) throw new Error("test renderer requires the Debug-bound Core private publication");
    const output = await publication.writePrivateFile(frame, {
      label: "Checkpoint storyboard retained-trace staged preview PNG",
      maxBytes: 64 * 1024 * 1024,
    });
    calls.push(options.atUs);
    afterStage?.();
    const sampleCount = Math.floor(options.atUs / 1_000) + 1;
    const rasterVertexInvocations = sampleCount === 1 ? 6 : (sampleCount - 1) * 6;
    const cleanupPayload = { closed: true as const, traceBuffers: { sampleBufferDestroyed: true as const, rasterControlBufferDestroyed: true as const, targetDestroyed: true as const, readbackBufferDestroyed: true as const }, runtimeResources: null };
    const cleanup = { ...cleanupPayload, fingerprint: canonicalJsonSha256(cleanupPayload) };
    const planFingerprint = (options.retainedTracePlan as { readonly fingerprint: string }).fingerprint;
    const evidencePayload = { schema: "shellx-motion/checkpoint-storyboard-retained-trace-preview-evidence@1" as const, retainedTracePlanFingerprint: planFingerprint, staticWrapperFingerprint: "1".repeat(64), frameWrapperFingerprint: "2".repeat(64), atUs: options.atUs, vertexAbi: "shellx-motion/gpu-parametric-trace-vertices@2" as const, sampleTopology: "line-strip/sequential-sample@1" as const, rasterPrimitive: "triangle-list" as const, rasterMapping: "motion-top-left-pixel-xy-to-ndc@1" as const, rasterTessellation: "square-cap-or-endpoint-width-segment-quad@1" as const, sampleCount, rasterVertexInvocations, maxRasterVertexInvocations: 378 as const, uploadBytes: sampleCount * 20, uploadSha256: "3".repeat(64), staticRasterizationFingerprint: "4".repeat(64), frameRasterizationFingerprint: "5".repeat(64), outputSha256: output.sha256, outputByteLength: output.byteLength, background: "transparent-rgba@1" as const, cleanupFingerprint: cleanup.fingerprint };
    return {
      ok: true,
      output: { sha256: output.sha256, byteLength: output.byteLength, width: 1280, height: 720, atUs: options.atUs, background: "transparent-rgba@1" },
      gpu: { adapterFingerprint: "a".repeat(64) },
      resources: {},
      cleanup,
      evidence: { ...evidencePayload, fingerprint: canonicalJsonSha256(evidencePayload) },
    } as never;
  };
  return renderer;
}

async function fixture(testRender: CheckpointStoryboardRetainedTracePreviewRenderer) {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-c6c-b7-preview-"));
  roots.push(root);
  const workspace = join(root, "workspace"), source = join(workspace, "source"), output = join(workspace, "output"), storeRoot = join(root, "store");
  await mkdir(join(source, "empty"), { recursive: true, mode: 0o700 });
  await mkdir(storeRoot, { mode: 0o700 });
  await writeJson(join(source, "manifest.json"), { schema: "shellx-motion/package-manifest@1", id: "trace-package", name: "Trace", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: [] } });
  await writeJson(join(source, "motion.json"), { schema: "shellx-motion/motion@1", id: "trace-motion", name: "Trace", durationMs: 4, fps: 30, width: 1280, height: 720, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "trace-anchor", type: "shape", shape: "rect", fill: "#4e8cff", opacity: 0.75, startMs: 0, durationMs: 4, transform: { x: 0, y: 0, width: 100, height: 100 } }] });
  const anchor = await createTrustedWorkspaceAnchor(workspace);
  const store = await configureCheckpointStoryboardRecordStore({ root: storeRoot, integrityKey: Buffer.alloc(32, 7) });
  const created = await createCheckpointStoryboardStoredRecord(store, storyboard());
  const resolution = await configureCheckpointStoryboardRetainedTraceResolutionAuthority({ recordStore: store, sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: anchor });
  const preview = configureCheckpointStoryboardRetainedTracePreviewAuthority({ recordStore: store, retainedTraceResolutionAuthority: resolution, testRender });
  return { root, workspace, source, output, anchor, store, created, resolution, preview };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function context(value: Awaited<ReturnType<typeof fixture>>, executionSignal?: AbortSignal) {
  return {
    tier: "render_motion" as const,
    checkpointStoryboardRecordStore: value.store,
    checkpointStoryboardRetainedTracePreviewAuthority: value.preview,
    ...(executionSignal ? { executionSignal } : {}),
  };
}

async function previewStates(value: Awaited<ReturnType<typeof fixture>>) {
  const directory = await lineageRetainedTracePreviewsDirectory(checkedAuthority(value.store), value.created.record.lineage.root.id);
  const names = await readdir(directory.path);
  const states = await Promise.all(names.filter((name) => name.endsWith(".state.json")).map(async (name) => {
    const signed = JSON.parse(await readFile(join(directory.path, name), "utf8")) as { payload: Record<string, unknown> };
    return signed.payload;
  }));
  return { directory: directory.path, names, states };
}

describe.skipIf(process.platform !== "linux")("C6C B7 Debug/MCP retained-trace previews (Linux closed-inventory COW)", () => {
  it("revalidates a fresh installed binding through preview authority after source loss", async () => {
    const value = await fixture(injectedRenderer([]));
    await resolveCheckpointStoryboardRetainedTraceStoredRecord(value.resolution, value.created.record.identity);
    await rm(value.source, { recursive: true, force: true });

    await withCheckpointStoryboardRetainedTracePreviewAuthority(value.preview, async (preview) =>
      await withCheckpointStoryboardRetainedTraceActivePreviewInput(preview.resolution, value.created.record.identity, async (active) => {
        await active.revalidate();
      }));
  });

  it("reopens one installed preview input repeatedly after source loss", async () => {
    const value = await fixture(injectedRenderer([]));
    await resolveCheckpointStoryboardRetainedTraceStoredRecord(value.resolution, value.created.record.identity);
    await rm(value.source, { recursive: true, force: true });
    const host = { outputPackageRoot: value.output, packageWorkspaceRoot: value.workspace, packageWorkspaceAuthority: value.anchor };

    const firstInstalled = await reopenCheckpointStoryboardRetainedTraceMaterializationOutput(host);
    const firstInput = await reopenCheckpointStoryboardRetainedTracePreviewInput(host);
    const secondInstalled = await reopenCheckpointStoryboardRetainedTraceMaterializationOutput(host);
    const secondInput = await reopenCheckpointStoryboardRetainedTracePreviewInput(host);

    expect(secondInstalled).toEqual(firstInstalled);
    expect(secondInput).toEqual(firstInput);
    await withCheckpointStoryboardRetainedTraceActivePreviewInput(value.resolution, value.created.record.identity, async (active) => {
      await active.revalidate();
      await active.revalidate();
    });
  });

  it("renders one active resolved source-loss binding at exact 0, interior, and D schedule points with complete private pairs", async () => {
    const calls: number[] = [];
    const value = await fixture(injectedRenderer(calls));
    const identity = value.created.record.identity;
    await resolveCheckpointStoryboardRetainedTraceStoredRecord(value.resolution, identity);
    await rm(value.source, { recursive: true, force: true });

    for (const atUs of [0, 2_000, 4_000]) {
      const result = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTracePreview, { identity, atUs }, context(value));
      if (!result.ok) throw new Error(JSON.stringify({ error: result.error, calls }));
      expect(result).toMatchObject({ ok: true, result: { identity, atUs, output: { width: 1280, height: 720, format: "png", background: "transparent-rgba@1" }, gpu: { runtimeEvidence: "source-test" }, previewHandle: expect.stringMatching(/^checkpoint_storyboard_retained_trace_preview_[a-f0-9]{32}$/u), receiptHandle: expect.stringMatching(/^checkpoint_storyboard_retained_trace_preview_receipt_[a-f0-9]{32}$/u) } });
      expect(JSON.stringify(result)).not.toContain(value.root);
      expect(JSON.stringify(result)).not.toContain(value.workspace);
      expect(JSON.stringify(result)).not.toContain(value.output);
    }
    expect(calls).toEqual([0, 2_000, 4_000]);

    const retained = await previewStates(value);
    expect(retained.names).toHaveLength(9);
    expect(retained.states).toHaveLength(3);
    for (const state of retained.states) {
      expect(state).toMatchObject({ phase: "complete", runtimeEvidence: "source-test", receipt: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/u), byteLength: expect.any(Number) }, png: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/u), byteLength: expect.any(Number), width: 1280, height: 720 } });
    }
  });

  it("rejects unscheduled and non-strict preview requests before an injected renderer runs", async () => {
    const calls: number[] = [];
    const value = await fixture(injectedRenderer(calls));
    const identity = value.created.record.identity;
    await resolveCheckpointStoryboardRetainedTraceStoredRecord(value.resolution, identity);

    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTracePreview, { identity, atUs: 999 }, context(value))).resolves.toMatchObject({ ok: false, error: { code: "preview_target_invalid" } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTracePreview, { identity, atUs: 0.5 }, context(value))).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTracePreview, { identity, atUs: 0, outputPath: value.output }, context(value))).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTracePreview, { identity, atUs: 0 }, { tier: "render_motion", checkpointStoryboardRecordStore: value.store })).resolves.toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    expect(calls).toEqual([]);
  });

  it("refuses malformed staged PNG bytes and forged renderer evidence before publishing a complete pair", async () => {
    const malformedCalls: number[] = [];
    const malformed = await fixture(injectedRenderer(malformedCalls, undefined, Buffer.from("not-a-png")));
    await resolveCheckpointStoryboardRetainedTraceStoredRecord(malformed.resolution, malformed.created.record.identity);
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTracePreview, { identity: malformed.created.record.identity, atUs: 0 }, context(malformed))).resolves.toMatchObject({ ok: false, error: { code: "preview_publication_uncertain" } });
    expect((await previewStates(malformed)).states).toEqual([expect.objectContaining({ phase: "abandoned" })]);

    const forgedCalls: number[] = [];
    const validForged = injectedRenderer(forgedCalls);
    const forgedRenderer: CheckpointStoryboardRetainedTracePreviewRenderer = async (pkg, options) => {
      const result = await validForged(pkg, options);
      return result.ok ? { ...result, evidence: { ...result.evidence, atUs: options.atUs + 1 } } : result;
    };
    const forged = await fixture(forgedRenderer);
    await resolveCheckpointStoryboardRetainedTraceStoredRecord(forged.resolution, forged.created.record.identity);
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTracePreview, { identity: forged.created.record.identity, atUs: 0 }, context(forged))).resolves.toMatchObject({ ok: false, error: { code: "preview_publication_uncertain" } });
    expect((await previewStates(forged)).states).toEqual([expect.objectContaining({ phase: "abandoned" })]);
  });

  it("refuses inactive, unbound, detached, cross-store, and copied authority requests before rendering", async () => {
    const inactiveCalls: number[] = [], unboundCalls: number[] = [], detachedCalls: number[] = [], firstCalls: number[] = [], secondCalls: number[] = [];
    const inactive = await fixture(injectedRenderer(inactiveCalls));
    await tombstoneCheckpointStoryboardStoredRecord(inactive.store, inactive.created.record.identity);
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTracePreview, { identity: inactive.created.record.identity, atUs: 0 }, context(inactive))).resolves.toMatchObject({ ok: false, error: { code: "record_tombstoned" } });

    const unbound = await fixture(injectedRenderer(unboundCalls));
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTracePreview, { identity: unbound.created.record.identity, atUs: 0 }, context(unbound))).resolves.toMatchObject({ ok: false, error: { code: "preview_binding_not_active" } });

    const detached = await fixture(injectedRenderer(detachedCalls));
    await resolveCheckpointStoryboardRetainedTraceStoredRecord(detached.resolution, detached.created.record.identity);
    await detachCheckpointStoryboardRetainedTraceStoredRecord(detached.resolution, detached.created.record.identity);
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTracePreview, { identity: detached.created.record.identity, atUs: 0 }, context(detached))).resolves.toMatchObject({ ok: false, error: { code: "preview_binding_not_active" } });

    const first = await fixture(injectedRenderer(firstCalls)), second = await fixture(injectedRenderer(secondCalls));
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTracePreview, { identity: second.created.record.identity, atUs: 0 }, { tier: "render_motion", checkpointStoryboardRecordStore: second.store, checkpointStoryboardRetainedTracePreviewAuthority: first.preview })).resolves.toMatchObject({ ok: false, error: { code: "preview_authority_refused" } });
    const copiedPreview = Object.create(first.preview) as typeof first.preview;
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTracePreview, { identity: first.created.record.identity, atUs: 0 }, { tier: "render_motion", checkpointStoryboardRecordStore: first.store, checkpointStoryboardRetainedTracePreviewAuthority: copiedPreview })).resolves.toMatchObject({ ok: false, error: { code: "preview_authority_refused" } });
    expect([...inactiveCalls, ...unboundCalls, ...detachedCalls, ...firstCalls, ...secondCalls]).toEqual([]);
  });

  it("keeps a pre-receipt cancellation abandoned without a PNG/receipt pair", async () => {
    const calls: number[] = [], controller = new AbortController();
    const value = await fixture(injectedRenderer(calls, () => controller.abort()));
    const identity = value.created.record.identity;
    await resolveCheckpointStoryboardRetainedTraceStoredRecord(value.resolution, identity);

    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTracePreview, { identity, atUs: 0 }, context(value, controller.signal))).resolves.toMatchObject({ ok: false, error: { code: "preview_cancelled" } });
    expect(calls).toEqual([0]);
    const retained = await previewStates(value);
    expect(retained.names).toHaveLength(1);
    expect(retained.names[0]).toMatch(/^checkpoint_storyboard_retained_trace_preview_[a-f0-9]{32}\.state\.json$/u);
    expect(retained.states).toEqual([expect.objectContaining({ phase: "abandoned" })]);
    expect(retained.states[0]).not.toHaveProperty("receipt");
    expect(retained.states[0]).not.toHaveProperty("png");
  });

  it("revokes a receipt-first publication when cancellation arrives before PNG publication", async () => {
    const calls: number[] = [];
    const value = await fixture(injectedRenderer(calls));
    const identity = value.created.record.identity;
    await resolveCheckpointStoryboardRetainedTraceStoredRecord(value.resolution, identity);
    let reads = 0;
    const signal = {
      get aborted() { reads += 1; return reads === 4; },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;

    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTracePreview, { identity, atUs: 0 }, context(value, signal))).resolves.toMatchObject({ ok: false, error: { code: "preview_cancelled" } });
    expect(calls).toEqual([0]);
    const retained = await previewStates(value);
    expect(retained.names).toHaveLength(1);
    expect(retained.states).toEqual([expect.objectContaining({
      phase: "receipt-revoked",
      receipt: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/u), byteLength: expect.any(Number) },
    })]);
    expect(retained.states[0]).not.toHaveProperty("png");
  });

  it("holds the retained-trace lineage lock while GPU work is active", async () => {
    const calls: number[] = [];
    let releaseRenderer!: () => void;
    let rendererEntered!: () => void;
    const release = new Promise<void>((resolve) => { releaseRenderer = resolve; });
    const entered = new Promise<void>((resolve) => { rendererEntered = resolve; });
    const base = injectedRenderer(calls);
    const blocked: CheckpointStoryboardRetainedTracePreviewRenderer = async (pkg, options) => {
      rendererEntered();
      await release;
      return await base(pkg, options);
    };
    const value = await fixture(blocked);
    const identity = value.created.record.identity;
    await resolveCheckpointStoryboardRetainedTraceStoredRecord(value.resolution, identity);

    const rendering = dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTracePreview, { identity, atUs: 2_000 }, context(value));
    await entered;
    await expect(detachCheckpointStoryboardRetainedTraceStoredRecord(value.resolution, identity)).rejects.toMatchObject({ code: "store_busy" });
    releaseRenderer();
    await expect(rendering).resolves.toMatchObject({ ok: true, result: { atUs: 2_000 } });
    expect(calls).toEqual([2_000]);
  });
});

describe("C6C B7 retained-trace preview command contract", () => {
  it("projects the closed command as render-only Debug/MCP metadata and a named CLI no-route", async () => {
    const command = CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTracePreview;
    expect(DEBUG_COMMANDS).toContain(command);
    expect(debugCommandDefinition(command)).toMatchObject({ permission: "render_motion", mutates: true });
    expect(debugCommandContract(command)?.argsSchema).toMatchObject({ type: "object", additionalProperties: false, required: ["identity", "atUs"], properties: { identity: expect.any(Object), atUs: { type: "number", minimum: 0, maximum: 3_600_000_000, multipleOf: 1 } } });
    const cli = await readFile(new URL("../../../cli/src/debug-subcommands.ts", import.meta.url), "utf8");
    const named = cli.slice(cli.indexOf("export const CLI_NAMED_DEBUG_NO_ROUTE"));
    expect(named).toContain(command);
    expect(cli.slice(0, cli.indexOf("export const CLI_NAMED_DEBUG_NO_ROUTE"))).not.toContain("checkpoint-storyboard.retained-trace.preview");
  });
});
