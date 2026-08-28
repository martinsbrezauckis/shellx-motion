import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { canonicalJson, canonicalJsonSha256, crc32 } from "@shellx-motion/core";
import { createCheckpointStoryboard, createTransitionRecipe } from "@shellx-motion/core/internal/checkpoint-storyboard-scalar-spatial-materializer";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { resolveRendererPrivateOutputPublication } from "@shellx-motion/renderer-browser/internal/private-output-publication";
import { configureCheckpointStoryboardRetainedTracePreviewAuthority, type CheckpointStoryboardRetainedTracePreviewRenderer } from "./checkpoint-storyboard-retained-trace-preview-authority.js";
import { previewCheckpointStoryboardRetainedTraceStoredRecord } from "./checkpoint-storyboard-retained-trace-preview.js";
import { configureCheckpointStoryboardRetainedTraceResolutionAuthority } from "./checkpoint-storyboard-retained-trace-resolution-authority.js";
import { configureCheckpointStoryboardRetainedTraceReviewAuthority } from "./checkpoint-storyboard-retained-trace-review-authority.js";
import type { HostRetainedTraceReviewRegistration, RetainedTraceReviewActor } from "./checkpoint-storyboard-retained-trace-review-host-registry.js";
import { configureCheckpointStoryboardRecordStore } from "./checkpoint-storyboard-record-store-authority.js";
import { createCheckpointStoryboardStoredRecord } from "./checkpoint-storyboard-record-store.js";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
export const reviewTestRoots: string[] = [];
export async function cleanupReviewTestRoots(): Promise<void> { await Promise.all(reviewTestRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true }))); }

function trace() { return { schema: "shellx-motion/private-parametric-trace@1", clip: { durationUs: 4_000, sampleIntervalUs: 1_000 }, drawers: [{ id: "line", driver: { kind: "parametric-graph", graph: { nodes: [{ id: "time", kind: "time-us" }, { id: "scale", kind: "constant", value: 0.001 }, { id: "x", kind: "multiply", left: "time", right: "scale" }, { id: "zero", kind: "constant", value: 0 }], output: { x: "x", y: "zero", z: "zero" } } }, retention: { kind: "full-clip", maxSamples: 5 }, output: { mode: "line", width: { source: "constant", from: 2, to: 2 }, colour: { source: "constant", from: 0.5, to: 0.5 }, opacity: { source: "constant", from: 0.75, to: 0.75 }, speedLimit: 100 } }], caps: { perDrawer: { maxSamples: 64, maxVertices: 64, maxWorkUnits: 16_384, maxBytes: 128 * 1024 }, aggregate: { maxSamples: 64, maxVertices: 64, maxWorkUnits: 16_384, maxBytes: 128 * 1024 } } }; }
function storyboard() { const recipe = createTransitionRecipe({ recipeId: "retained-line", seed: 2, exactBaseRequirements: [], intent: { kind: "parametric-trace", outputObjectId: "trace-anchor", trace: trace() } }); return createCheckpointStoryboard({ seed: 1, capabilityRequirements: ["renderer.gpu"], objectCatalog: [{ objectId: "trace-anchor", rootShapeKind: "rect", propertyMask: ["opacity"] }], checkpoints: [{ id: "start", atUs: 0, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] }, { id: "finish", atUs: 4_000, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] }], edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "trace-anchor" }], recipeIds: ["retained-line"] }], recipes: [recipe] }); }
function pngFrame(width = 1280, height = 720): Buffer { const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6; const scanlines = Buffer.alloc((width * 4 + 1) * height); return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(scanlines)), pngChunk("IEND", Buffer.alloc(0))]); }
function pngChunk(type: string, data: Buffer): Buffer { const chunk = Buffer.alloc(12 + data.byteLength); chunk.writeUInt32BE(data.byteLength, 0); chunk.write(type, 4, 4, "ascii"); data.copy(chunk, 8); chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.byteLength)), 8 + data.byteLength); return chunk; }

export function reviewTestRenderer(calls: number[] = []): CheckpointStoryboardRetainedTracePreviewRenderer {
  return async (_pkg, options) => {
    const publication = resolveRendererPrivateOutputPublication(options); if (!publication) throw new Error("missing private publication");
    const output = await publication.writePrivateFile(pngFrame(), { label: "B7 review test PNG", maxBytes: 64 * 1024 * 1024 }); calls.push(options.atUs);
    const sampleCount = Math.floor(options.atUs / 1_000) + 1, rasterVertexInvocations = sampleCount === 1 ? 6 : (sampleCount - 1) * 6;
    const cleanupPayload = { closed: true as const, traceBuffers: { sampleBufferDestroyed: true as const, rasterControlBufferDestroyed: true as const, targetDestroyed: true as const, readbackBufferDestroyed: true as const }, runtimeResources: null };
    const cleanup = { ...cleanupPayload, fingerprint: canonicalJsonSha256(cleanupPayload) }, planFingerprint = (options.retainedTracePlan as { fingerprint: string }).fingerprint;
    const evidencePayload = { schema: "shellx-motion/checkpoint-storyboard-retained-trace-preview-evidence@1" as const, retainedTracePlanFingerprint: planFingerprint, staticWrapperFingerprint: "1".repeat(64), frameWrapperFingerprint: "2".repeat(64), atUs: options.atUs, vertexAbi: "shellx-motion/gpu-parametric-trace-vertices@2" as const, sampleTopology: "line-strip/sequential-sample@1" as const, rasterPrimitive: "triangle-list" as const, rasterMapping: "motion-top-left-pixel-xy-to-ndc@1" as const, rasterTessellation: "square-cap-or-endpoint-width-segment-quad@1" as const, sampleCount, rasterVertexInvocations, maxRasterVertexInvocations: 378 as const, uploadBytes: sampleCount * 20, uploadSha256: "3".repeat(64), staticRasterizationFingerprint: "4".repeat(64), frameRasterizationFingerprint: "5".repeat(64), outputSha256: output.sha256, outputByteLength: output.byteLength, background: "transparent-rgba@1" as const, cleanupFingerprint: cleanup.fingerprint };
    return { ok: true, output: { sha256: output.sha256, byteLength: output.byteLength, width: 1280, height: 720, atUs: options.atUs, background: "transparent-rgba@1" }, gpu: { adapterFingerprint: "a".repeat(64) }, resources: {}, cleanup, evidence: { ...evidencePayload, fingerprint: canonicalJsonSha256(evidencePayload) } } as never;
  };
}

export async function retainedTraceReviewFixture(renderer = reviewTestRenderer()) {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-c6c-b7-review-")); reviewTestRoots.push(root);
  const workspace = join(root, "workspace"), source = join(workspace, "source"), output = join(workspace, "output"), storeRoot = join(root, "store");
  await mkdir(join(source, "empty"), { recursive: true, mode: 0o700 }); await mkdir(storeRoot, { mode: 0o700 });
  await writeJson(join(source, "manifest.json"), { schema: "shellx-motion/package-manifest@1", id: "trace-package", name: "Trace", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: [] } });
  await writeJson(join(source, "motion.json"), { schema: "shellx-motion/motion@1", id: "trace-motion", name: "Trace", durationMs: 4, fps: 30, width: 1280, height: 720, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "trace-anchor", type: "shape", shape: "rect", fill: "#4e8cff", opacity: 0.75, startMs: 0, durationMs: 4, transform: { x: 0, y: 0, width: 100, height: 100 } }] });
  const anchor = await createTrustedWorkspaceAnchor(workspace), store = await configureCheckpointStoryboardRecordStore({ root: storeRoot, integrityKey: Buffer.alloc(32, 7) }), created = await createCheckpointStoryboardStoredRecord(store, storyboard());
  const resolution = await configureCheckpointStoryboardRetainedTraceResolutionAuthority({ recordStore: store, sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: anchor });
  const preview = configureCheckpointStoryboardRetainedTracePreviewAuthority({ recordStore: store, retainedTraceResolutionAuthority: resolution, testRender: renderer });
  return { root, workspace, source, output, storeRoot, store, created, resolution, preview };
}
export async function makeReviewPreview(fixture: Awaited<ReturnType<typeof retainedTraceReviewFixture>>, atUs: number) { return await previewCheckpointStoryboardRetainedTraceStoredRecord(fixture.preview, fixture.created.record.identity, atUs); }

export function reviewRegistration(fixture: Awaited<ReturnType<typeof retainedTraceReviewFixture>>, preview: Awaited<ReturnType<typeof makeReviewPreview>>, outcome: "accepted" | "changes_requested" | "rejected" = "accepted", actor: RetainedTraceReviewActor = { kind: "human", id: "reviewer-1" }): HostRetainedTraceReviewRegistration {
  const payload = { schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-review-decision@1", outcome, reviewer: actor }, sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return Object.freeze({ record: { identity: fixture.created.record.identity, root: fixture.created.record.lineage.root }, preview: { previewHandle: preview.previewHandle, receiptHandle: preview.receiptHandle }, decision: { ...payload, id: `checkpoint_storyboard_retained_trace_review_decision_${sha256.slice(0, 32)}`, sha256 }, authentication: { reviewer: { actor, id: `host_retained_trace_review_authentication_${"9".repeat(32)}`, sha256: "9".repeat(64) } } });
}
export function makeReviewAuthority(fixture: Awaited<ReturnType<typeof retainedTraceReviewFixture>>, entries: readonly { handle: string; registration: HostRetainedTraceReviewRegistration }[], allowPolicyActors = false) { return configureCheckpointStoryboardRetainedTraceReviewAuthority({ recordStore: fixture.store, retainedTraceResolutionAuthority: fixture.resolution, retainedTracePreviewAuthority: fixture.preview, reviewRegistry: new Map(entries.map((entry) => [entry.handle, entry.registration])), allowPolicyActors }); }
async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
