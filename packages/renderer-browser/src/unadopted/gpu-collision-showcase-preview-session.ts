import {
  COLLISION_SHOWCASE_FRAME_COUNT,
  COLLISION_SHOWCASE_RENDER_FRAME_COUNT,
  COLLISION_SHOWCASE_RENDER_FRAME_RATE,
  compileCollisionShowcaseRecipe,
  lowerCollisionShowcasePlan,
  renderFrameAtUs,
  type CollisionShowcaseKind,
  type CollisionShowcasePlan,
  type CollisionShowcaseRecipe,
} from "@shellx-motion/core/internal/collision-showcase";
import assert from "node:assert/strict";
import { canonicalJsonSha256 } from "@shellx-motion/core";
import { isAbsolute, resolve } from "node:path";
import { createGpuCollisionShowcasePreviewSessionBase } from "../gpu-points-preview";
import type {
  GpuPreviewFrameOptions,
  GpuPreviewResult,
  GpuPreviewSessionCleanupEvidence,
  GpuPreviewSessionOptions,
} from "../gpu-preview-session-types";

export const GPU_COLLISION_SHOWCASE_PREVIEW_SESSION_SCHEMA = "shellx-motion/private-gpu-collision-showcase-preview-session@2" as const;

export interface GpuCollisionShowcasePreviewSessionIdentity {
  schema: typeof GPU_COLLISION_SHOWCASE_PREVIEW_SESSION_SCHEMA;
  kind: CollisionShowcaseKind;
  planFingerprint: string;
  loweringFingerprint: string;
  motionSha256: string;
  strictPreviewStaticFingerprint: string;
  bakeFrameCount: typeof COLLISION_SHOWCASE_FRAME_COUNT;
  frameCount: typeof COLLISION_SHOWCASE_RENDER_FRAME_COUNT;
  frameRate: typeof COLLISION_SHOWCASE_RENDER_FRAME_RATE;
}

export interface GpuCollisionShowcasePreviewCleanup {
  schema: "shellx-motion/private-gpu-collision-showcase-preview-cleanup@2";
  closed: true;
  kind: CollisionShowcaseKind;
  completedFrames: number;
  expectedFrames: typeof COLLISION_SHOWCASE_RENDER_FRAME_COUNT;
  scheduleComplete: boolean;
  gpu: GpuPreviewSessionCleanupEvidence;
}

export type GpuCollisionShowcasePreviewFrameOptions = Omit<GpuPreviewFrameOptions, "atMs" | "jobId">;

export type GpuCollisionShowcasePreviewResult = GpuPreviewResult & {
  schedule: Readonly<{
    frameIndex: number;
    atUs: number;
    phase: string;
    stateSha256: string;
    bakeFrameBeforeIndex: number;
    bakeFrameAfterIndex: number;
    final: boolean;
    cleanup?: GpuCollisionShowcasePreviewCleanup;
  }>;
};

export interface GpuCollisionShowcasePreviewSession {
  identity: GpuCollisionShowcasePreviewSessionIdentity;
  renderNext(options: GpuCollisionShowcasePreviewFrameOptions): Promise<GpuCollisionShowcasePreviewResult>;
  close(): Promise<GpuCollisionShowcasePreviewCleanup>;
}

/**
 * Opens the only retained scene3dAnimation session: one exact C6G recipe, one static wrapper,
 * one runtime, and the fixed 151-frame 30 fps sequence. Callers cannot select timestamps or frame order.
 */
export function createGpuCollisionShowcasePreviewSession(
  recipe: CollisionShowcaseRecipe,
  options: { packageRoot: string; sessionOptions?: GpuPreviewSessionOptions },
): GpuCollisionShowcasePreviewSession {
  assert(isAbsolute(options.packageRoot) && resolve(options.packageRoot) === options.packageRoot, "C6G retained preview requires a canonical absolute package root.");
  const plan = compileCollisionShowcaseRecipe(recipe), lowering = lowerCollisionShowcasePlan(plan);
  assert.equal(plan.frames.length, COLLISION_SHOWCASE_FRAME_COUNT, "C6G retained preview requires the exact 61-frame author bake.");
  const jobSlug = plan.kind === "bingo-sphere-3d@1" ? "bingo" : "wrecking";
  const manifest = Object.freeze({
    schema: "shellx-motion/package-manifest@1" as const,
    id: lowering.motion.id,
    name: lowering.motion.name,
    motion: "motion.json",
    assets: [] as string[],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["gpu"], hosts: ["motion"] },
  });
  const pkg = Object.freeze({ root: options.packageRoot, manifest, motion: lowering.motion });
  const base = createGpuCollisionShowcasePreviewSessionBase(pkg, options.sessionOptions);
  const identity = Object.freeze({
    schema: GPU_COLLISION_SHOWCASE_PREVIEW_SESSION_SCHEMA,
    kind: plan.kind,
    planFingerprint: plan.fingerprint,
    loweringFingerprint: lowering.fingerprint,
    motionSha256: lowering.motionSha256,
    strictPreviewStaticFingerprint: lowering.strictPreviewStaticFingerprint,
    bakeFrameCount: COLLISION_SHOWCASE_FRAME_COUNT,
    frameCount: COLLISION_SHOWCASE_RENDER_FRAME_COUNT,
    frameRate: COLLISION_SHOWCASE_RENDER_FRAME_RATE,
  });
  let completedFrames = 0, rendering = false, cleanupPromise: Promise<GpuCollisionShowcasePreviewCleanup> | undefined;
  const finish = (): Promise<GpuCollisionShowcasePreviewCleanup> => cleanupPromise ??= (async () => {
    const gpu = await base.close();
    const staticCompilations = gpu.scene3dAnimation?.staticWrapperCompilations;
    if (typeof staticCompilations !== "number" || staticCompilations > 1 || (completedFrames > 0 && staticCompilations !== 1)) throw new Error("C6G retained preview did not retain at most one Core static wrapper.");
    if (completedFrames === COLLISION_SHOWCASE_RENDER_FRAME_COUNT && gpu.scene3dAnimation?.framePlanCompilations !== COLLISION_SHOWCASE_RENDER_FRAME_COUNT) throw new Error("C6G retained preview frame-plan lifecycle does not match its completed schedule.");
    return Object.freeze({
      schema: "shellx-motion/private-gpu-collision-showcase-preview-cleanup@2" as const,
      closed: true as const,
      kind: plan.kind,
      completedFrames,
      expectedFrames: COLLISION_SHOWCASE_RENDER_FRAME_COUNT,
      scheduleComplete: completedFrames === COLLISION_SHOWCASE_RENDER_FRAME_COUNT,
      gpu,
    });
  })();
  const close = (): Promise<GpuCollisionShowcasePreviewCleanup> => rendering ? Promise.reject(new Error("C6G retained preview cannot close while a frame is in flight.")) : finish();
  const renderNext = async (frameOptions: GpuCollisionShowcasePreviewFrameOptions): Promise<GpuCollisionShowcasePreviewResult> => {
    if (rendering) {
      const frame = presentationFrame(plan, Math.min(completedFrames, COLLISION_SHOWCASE_RENDER_FRAME_COUNT - 1));
      return { ok: false, error: { code: "gpu_collision_preview_busy", message: "C6G retained preview accepts one frame operation at a time." }, schedule: schedule(frame, false) };
    }
    if (cleanupPromise || completedFrames >= COLLISION_SHOWCASE_RENDER_FRAME_COUNT) {
      const frame = presentationFrame(plan, Math.min(completedFrames, COLLISION_SHOWCASE_RENDER_FRAME_COUNT - 1));
      return { ok: false, error: { code: "gpu_collision_preview_closed", message: "C6G retained preview schedule is closed." }, schedule: schedule(frame, completedFrames >= COLLISION_SHOWCASE_RENDER_FRAME_COUNT) };
    }
    const frame = presentationFrame(plan, completedFrames);
    rendering = true;
    try {
      const result = await base.renderFrame({ ...frameOptions, atMs: frame.atUs / 1_000, jobId: `c6g-retained:${jobSlug}:${frame.frameIndex}` });
      if (!result.ok) {
        await finish();
        return { ...result, schedule: schedule(frame, false) };
      }
      completedFrames += 1;
      const final = completedFrames === COLLISION_SHOWCASE_RENDER_FRAME_COUNT;
      const cleanup = final ? await finish() : undefined;
      return { ...result, schedule: Object.freeze({ ...schedule(frame, final), ...(cleanup ? { cleanup } : {}) }) };
    } finally {
      rendering = false;
    }
  };
  return Object.freeze({ identity, renderNext, close });
}

function presentationFrame(plan: CollisionShowcasePlan, frameIndex: number) {
  const atUs = renderFrameAtUs(frameIndex);
  let beforeIndex = 0;
  for (let index = 1; index < plan.frames.length && plan.frames[index]!.atUs <= atUs; index += 1) beforeIndex = index;
  const before = plan.frames[beforeIndex]!;
  const afterIndex = before.atUs === atUs ? beforeIndex : Math.min(COLLISION_SHOWCASE_FRAME_COUNT - 1, beforeIndex + 1);
  const after = plan.frames[afterIndex]!;
  return Object.freeze({
    frameIndex,
    atUs,
    phase: before.phase,
    stateSha256: canonicalJsonSha256({ schema: "shellx-motion/collision-showcase-presentation-state@1", atUs, before: { frameIndex: beforeIndex, stateSha256: before.stateSha256 }, after: { frameIndex: afterIndex, stateSha256: after.stateSha256 } }),
    bakeFrameBeforeIndex: beforeIndex,
    bakeFrameAfterIndex: afterIndex,
  });
}

function schedule(frame: ReturnType<typeof presentationFrame>, final: boolean) {
  return Object.freeze({ ...frame, final });
}
