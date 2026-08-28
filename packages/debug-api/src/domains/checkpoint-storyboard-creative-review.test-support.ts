/** Isolated C6C B1c host fixture; raw creative records never cross the command boundary. */
import { createHash, createHmac } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, encodeRgbaPng, hashBuffer } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { createCheckpointStoryboard, createTransitionRecipe } from "@shellx-motion/core/internal/checkpoint-storyboard-scalar-spatial-materializer";
import type { BrowserFrameOptions } from "@shellx-motion/renderer-browser";
import { dispatchDebugCommand } from "../index.js";
import { approveShotPlan, createCreativeAssetLedger, createCreativeBrief, createCreativeRun, createReviewDecision, createShotPlan } from "./creative-contract/creative-contract.js";
import { configureCheckpointStoryboardCreativeReviewAuthority } from "./checkpoint-storyboard-creative-review-authority.js";
import { configureCheckpointStoryboardMaterializationAuthority } from "./checkpoint-storyboard-materialization-authority.js";
import { configureCheckpointStoryboardPreviewAuthority } from "./checkpoint-storyboard-preview-authority.js";
import { materializeCheckpointStoryboardStoredRecord } from "./checkpoint-storyboard-materialization.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMANDS } from "./checkpoint-storyboard-record-lifecycle.js";
import { configureCheckpointStoryboardRecordStore, createCheckpointStoryboardStoredRecord } from "./checkpoint-storyboard-record-store.js";

const roots: string[] = [];
export async function cleanupCreativeReviewFixtures(): Promise<void> {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
}

export function opaqueCreativeReviewHandle(label: string): string {
  return `checkpoint_storyboard_creative_review_handle_${createHash("sha256").update(label).digest("hex").slice(0, 32)}`;
}

export function hostCreativeAuthentication(actor: { kind: "human" | "policy" | "ai"; id: string }, label: string) {
  const sha256 = createHash("sha256").update(canonicalJson({ actor, label })).digest("hex");
  return { actor, id: `host_creative_authentication_${sha256.slice(0, 32)}`, sha256 };
}

export async function preparedCreativeReview(options: {
  readonly shotPlanApprover?: { kind: "human" | "policy" | "ai"; id: string };
  readonly reviewDecisionReviewer?: { kind: "human" | "policy" | "ai"; id: string };
  readonly allowPolicyActors?: boolean;
  readonly previewAtMs?: number;
  readonly shotDurationUs?: number;
  readonly validPng?: boolean;
  readonly outcome?: "accepted" | "changes_requested" | "rejected";
} = {}) {
  const value = await fixture();
  const created = await createCheckpointStoryboardStoredRecord(value.store, value.storyboard);
  await materializeCheckpointStoryboardStoredRecord(value.materialization, created.record.identity);
  const png = options.validPng ? encodeRgbaPng(1280, 720, Buffer.alloc(1280 * 720 * 4, 255)) : Buffer.from("creative-review-roster-png", "utf8");
  const previewAuthority = configureCheckpointStoryboardPreviewAuthority({
    recordStore: value.store, materializationAuthority: value.materialization,
    testCreateSession: async () => ({
      browserVersion: "source-test", metrics: { browserLaunches: 1, framesRendered: 0, contextsCreated: 0, pagesCreated: 0, activeFrames: 0, peakConcurrentFrames: 1, frameCacheHits: 0, frameRetries: 0 }, scriptExecution: {},
      renderFrame: async () => { throw new Error("B1b must use renderFrames."); },
      renderFrames: async (request: Array<Omit<BrowserFrameOptions, "networkAccess">>) => {
        if (!request[0]?.outputPath) throw new Error("missing private output stage");
        await writeFile(request[0].outputPath, png);
        const atMs = request[0].atMs;
        return [{ ok: true, output: { path: value.output, sha256: hashBuffer(png), format: "png", width: 1280, height: 720, atMs, browser: { name: "source-test", version: "source-test" }, ...(atMs === 1000 ? { terminalBoundary: terminalBoundaryEvidence(atMs) } : {}) }, receipt: {} } as never];
      }, close: async () => undefined,
    } as never),
  });
  const preview = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: created.record.identity, target: { kind: "time", atMs: options.previewAtMs ?? 0 } }, { tier: "render_motion", checkpointStoryboardRecordStore: value.store, checkpointStoryboardPreviewAuthority: previewAuthority });
  if (!preview.ok) throw new Error(JSON.stringify(preview));
  const handles = preview.result as { previewHandle: string; receiptHandle: string };
  const brief = createCreativeBrief({ createdAt: "2026-08-22T10:00:00.000Z", author: { kind: "ai", id: "planner" }, prompt: "unretained private prompt", goals: ["clarity"], constraints: [] });
  const proposed = createShotPlan({ brief, createdAt: "2026-08-22T10:00:00.000Z", capabilityIds: [], budget: { actionLimit: 1, revisionLimit: 1 }, shots: [{ id: "opening", startUs: 0, durationUs: options.shotDurationUs ?? 1_000_000, purpose: "opening", actionIds: [], assetSlots: [] }] });
  const shotPlan = approveShotPlan(proposed, { decidedBy: options.shotPlanApprover ?? { kind: "human", id: "reviewer" }, decidedAt: "2026-08-22T10:01:00.000Z", reason: "approved" });
  const assetLedger = createCreativeAssetLedger({ brief, createdAt: "2026-08-22T10:00:00.000Z", assets: [] });
  const run = createCreativeRun({ brief, shotPlan, assetLedger, createdAt: "2026-08-22T10:02:00.000Z", assetBindings: [] });
  const outcome = options.outcome ?? "accepted";
  const decision = createReviewDecision({ run, shotPlan, createdAt: "2026-08-22T10:03:00.000Z", reviewer: options.reviewDecisionReviewer ?? { kind: "human", id: "critic" }, outcome, findings: outcome === "accepted" ? [] : [{ id: "finding", severity: "warning", code: "contrast", message: "Improve contrast.", shotId: "opening", atUs: 0, region: { x: 0, y: 0, width: 1, height: 1 } }] });
  const alternateDecision = createReviewDecision({ run, shotPlan, createdAt: "2026-08-22T10:04:00.000Z", reviewer: { kind: "human", id: "alternate-critic" }, outcome: "accepted", findings: [] });
  const creativeReviewHandle = opaqueCreativeReviewHandle(`${created.record.identity.sha256}:primary`);
  const alternateCreativeReviewHandle = opaqueCreativeReviewHandle(`${created.record.identity.sha256}:alternate`);
  const registry = new Map([
    [creativeReviewHandle, hostCreativeReviewRegistration(created, handles, { brief, shotPlan, assetLedger, run, reviewDecision: decision, shotId: "opening" })],
    [alternateCreativeReviewHandle, hostCreativeReviewRegistration(created, handles, { brief, shotPlan, assetLedger, run, reviewDecision: alternateDecision, shotId: "opening" })],
  ]);
  const authority = configureCheckpointStoryboardCreativeReviewAuthority({ recordStore: value.store, materializationAuthority: value.materialization, previewAuthority, creativeReviewRegistry: registry as never, ...(options.allowPolicyActors ? { allowPolicyActors: true } : {}) });
  const args = { identity: created.record.identity, preview: { previewHandle: handles.previewHandle, receiptHandle: handles.receiptHandle }, creativeReviewHandle };
  return { value, created, args, alternateArgs: { ...args, creativeReviewHandle: alternateCreativeReviewHandle }, context: { tier: "write_local" as const, checkpointStoryboardRecordStore: value.store, checkpointStoryboardCreativeReviewAuthority: authority }, handles, registry, previewAuthority, creativeReviewAuthority: authority };
}

function terminalBoundaryEvidence(atMs: number) {
  return { schema: "shellx-motion/checkpoint-storyboard-terminal-boundary@1", mode: "exact-duration-static-background", endpoint: { requestedAtMs: atMs, durationMs: 1000, exactDuration: true }, execution: { renderFramesCalls: 1, requestedFrames: 1, capturedFrames: 1, maxConcurrency: 1, maxFrameAttempts: 1, retries: 0, cacheHits: 0, reused: false }, document: { width: 1280, height: 720, background: "#00000000", layersLoaded: 0, sourceLoads: 0, fontLoads: 0, assetLoads: 0, scriptLoads: 0, mediaLoads: 0, webglContexts: 0 }, network: { policy: "deny-all", approvedOrigins: [], requestsAllowed: 0, webSocketsAllowed: 0 } };
}

export async function seedCreativeReviewCapacity(root: string, directory: string, sample: Record<string, unknown>): Promise<void> {
  const { id: _id, sha256: _sha256, ...sampleBinding } = sample;
  const rootIdentity = (sampleBinding as { root: unknown }).root;
  let previous: { id: string; sha256: string } | undefined;
  for (let ordinal = 1; ordinal <= 128; ordinal += 1) {
    const sha256 = createHash("sha256").update(`creative-review-capacity-${ordinal}`).digest("hex");
    const identity = { id: `checkpoint_storyboard_${sha256.slice(0, 32)}`, sha256, revision: ordinal + 1 };
    const binding = withIdentity({ ...sampleBinding, identity, c6: { fingerprint: identity.sha256 } }, "checkpoint_storyboard_creative_review_");
    const reference = { id: binding.id, sha256: binding.sha256 };
    const intent = withIdentity({ schema: "shellx-motion/private-checkpoint-storyboard-creative-review-intent@1", root: rootIdentity, identity, binding: reference }, "checkpoint_storyboard_creative_review_intent_");
    const member = withIdentity({ schema: "shellx-motion/private-checkpoint-storyboard-creative-review-member@1", root: rootIdentity, identity, ordinal, binding: reference, ...(previous ? { previous } : {}) }, "checkpoint_storyboard_creative_review_member_");
    const completion = withIdentity({ schema: "shellx-motion/private-checkpoint-storyboard-creative-review-complete@1", root: rootIdentity, identity, binding: reference, member: { id: member.id, sha256: member.sha256 } }, "checkpoint_storyboard_creative_review_complete_");
    await Promise.all([writeSignedCreativeReviewTestFile(root, join(directory, `${identity.id}.creative-review.json`), binding), writeSignedCreativeReviewTestFile(root, join(directory, `${identity.id}.creative-review.intent.json`), intent), writeSignedCreativeReviewTestFile(root, join(directory, `${identity.id}.creative-review.complete.json`), completion), writeSignedCreativeReviewTestFile(root, join(directory, `${ordinal}.json`), member)]);
    previous = { id: member.id, sha256: member.sha256 };
  }
  if (!previous) throw new Error("Expected a creative-review roster tail.");
  await writeSignedCreativeReviewTestFile(root, join(directory, "head.json"), { schema: "shellx-motion/private-checkpoint-storyboard-creative-review-member-head@1", root: rootIdentity, ordinal: 128, member: previous, phase: "complete" });
}

export async function snapshotDirectory(path: string): Promise<string> {
  const names = (await readdir(path)).sort();
  return await Promise.all(names.map(async (name) => `${name}\0${await readFile(join(path, name), "utf8")}`)).then((entries) => entries.join("\n"));
}

function hostCreativeReviewRegistration(created: { record: { identity: { id: string; sha256: string; revision: number } } }, handles: { previewHandle: string; receiptHandle: string }, creative: { brief: unknown; shotPlan: unknown; assetLedger: unknown; run: unknown; reviewDecision: unknown; shotId: string }) {
  const shotPlan = creative.shotPlan as { approval: { decidedBy: { kind: "human" | "policy" | "ai"; id: string } } };
  const decision = creative.reviewDecision as { reviewer: { kind: "human" | "policy" | "ai"; id: string } };
  return { record: { identity: created.record.identity, root: created.record.identity }, preview: { previewHandle: handles.previewHandle, receiptHandle: handles.receiptHandle }, creative, authentication: { shotPlanApprover: hostCreativeAuthentication(shotPlan.approval.decidedBy, `plan:${shotPlan.approval.decidedBy.id}`), reviewDecisionReviewer: hostCreativeAuthentication(decision.reviewer, `review:${decision.reviewer.id}`) } };
}

function withIdentity<T extends object>(payload: T, prefix: string) {
  const sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return { ...payload, id: `${prefix}${sha256.slice(0, 32)}`, sha256 };
}

async function writeSignedCreativeReviewTestFile(root: string, path: string, payload: object) {
  const store = await lstat(join(root, ".shellx-motion-c6c-record-store"));
  const integrity = createHmac("sha256", Buffer.alloc(32, 9)).update(`${resolve(root)}\0${store.dev}:${store.ino}`).update("\0").update(canonicalJson(payload)).digest("hex");
  await writeFile(path, `${canonicalJson({ payload, integrity })}\n`, { mode: 0o600 });
}

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), ".c6c-b1c-test-")); roots.push(root);
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
  const checkpoint = (id: string, atUs: number, x: number, y: number, rotation: number) => ({ id, atUs, objects: [{ objectId: "orb", state: "present" as const, properties: [{ property: "transform.x" as const, value: x }, { property: "transform.y" as const, value: y }, { property: "transform.rotation" as const, value: rotation }, { property: "transform.scale" as const, value: 1 }, { property: "opacity" as const, value: 1 }] }] });
  const storyboard = createCheckpointStoryboard({ seed: 1, capabilityRequirements: ["renderer.browser"], objectCatalog: [{ objectId: "orb", rootShapeKind: "ellipse", propertyMask: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] }], checkpoints: [checkpoint("start", 0, 0, 0, 0), checkpoint("finish", 1_000_000, 100, 50, 90)], edges: [{ id: "edge", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "orb" }], recipeIds: ["scalar", "spatial"] }], recipes: [scalar, spatial] });
  return { root, source, output, store, materialization, storyboard };
}
