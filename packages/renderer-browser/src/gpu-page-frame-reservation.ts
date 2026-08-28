import type { InternalGpuFramePlan } from "./gpu-runtime-types";
import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export interface GpuPageFrameReservation {
  readonly fingerprint: string;
  readonly environmentDrawCount: number;
  readonly arena: {
    readonly width: number;
    readonly height: number;
    readonly bytesPerRow: number;
    readonly root: { readonly source: boolean; readonly target: boolean; readonly scratch: boolean };
    readonly keyCleanup: boolean;
    readonly groupDepth: number;
    readonly needsDepth: boolean;
  };
}

export type GpuPageFrameReservationOutput = { ok: true } | { ok: false; failure: GpuRuntimeFailure };
export type GpuPageEnvironmentEnvelopeOutput = { ok: true } | { ok: false; failure: GpuRuntimeFailure };

export interface GpuPageEnvironmentEnvelope {
  readonly width: number;
  readonly height: number;
  readonly groupDepth: number;
  readonly keyCleanup: boolean;
  readonly needsDepth: boolean;
}

/** Derives all retained attachments before the page receives the frame transport. */
export function createGpuPageFrameReservation(plan: InternalGpuFramePlan): GpuPageFrameReservation {
  const hasChromaMatteCleanup = (draw: InternalGpuFramePlan["draws"][number]): boolean => draw.kind === "image" && draw.chromaKey !== undefined && (draw.chromaKey.matte.denoiseRadiusPx !== 0 || draw.chromaKey.matte.growShrinkPx !== 0 || draw.chromaKey.matte.chokePx !== 0 || draw.chromaKey.matte.featherPx !== 0 || draw.chromaKey.matte.blackClip !== 0 || draw.chromaKey.matte.whiteClip !== 1);
  const hasLayerComposite = plan.draws.some((draw) => draw.kind !== "adjustment" && draw.kind !== "motionBlurEnd" && draw.kind !== "groupEnd" && (draw.kind === "environment" || draw.kind === "material" || draw.kind === "motionBlurStart" || draw.kind === "groupStart" || hasChromaMatteCleanup(draw) || draw.blendMode !== "normal" || draw.effects !== null || draw.mask !== undefined));
  const hasBlur = plan.draws.some((draw) => draw.kind !== "adjustment" && draw.kind !== "motionBlurEnd" && draw.kind !== "groupEnd" && ((draw.effects?.blur ?? 0) > 0 || (draw.effects?.glow?.radius ?? 0) > 0));
  const hasMask = plan.draws.some((draw) => draw.kind !== "adjustment" && draw.kind !== "motionBlurEnd" && draw.kind !== "groupEnd" && draw.mask !== undefined);
  const needsChromaMatteCleanup = plan.draws.some(hasChromaMatteCleanup);
  const root = {
    source: plan.budget.groupCount > 0 || hasLayerComposite,
    target: plan.budget.groupCount > 0 || hasLayerComposite || plan.budget.adjustmentCount > 0,
    scratch: plan.budget.groupCount > 0 || hasBlur || hasMask
  };
  return Object.freeze({
    fingerprint: plan.fingerprint,
    environmentDrawCount: plan.budget.environmentCount,
    arena: Object.freeze({
      width: plan.width,
      height: plan.height,
      bytesPerRow: Math.ceil((plan.width * 4) / 256) * 256,
      root: Object.freeze(root),
      keyCleanup: needsChromaMatteCleanup,
      groupDepth: plan.budget.groupMaxDepth,
      needsDepth: plan.budget.scene3dCount > 0
    })
  });
}

/** Page-side half of the pre-delivery reservation. It accepts only the host-derived fixed shape. */
export async function reserveWebGpuPageSessionFrameResources(value: unknown): Promise<GpuPageFrameReservationOutput> {
  type Arena = { width: number; height: number; bytesPerRow: number; root: { source: boolean; target: boolean; scratch: boolean }; keyCleanup: boolean; groupDepth: number; needsDepth: boolean };
  type Reservation = { fingerprint: string; environmentDrawCount: number; arena: Arena };
  const fail = (message: string): GpuPageFrameReservationOutput => ({ ok: false, failure: { code: "gpu_render_failed", message } });
  const browserGlobal = globalThis as unknown as { __shellxMotionGpuSessionV1?: { resources?: { reserveFrameArena(input: { fingerprint: string; arena: Arena }): void; reserveEnvironmentUniforms(): void } } };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("The GPU frame reservation is malformed.");
  const input = value as Partial<Reservation>;
  const arena = input.arena;
  const environmentDrawCount = input.environmentDrawCount;
  if (typeof input.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.fingerprint) || typeof environmentDrawCount !== "number" || !Number.isSafeInteger(environmentDrawCount) || environmentDrawCount < 0 || environmentDrawCount > 32 || !arena || typeof arena !== "object" || !arena.root || typeof arena.root !== "object" || !Number.isSafeInteger(arena.width) || !Number.isSafeInteger(arena.height) || !Number.isSafeInteger(arena.bytesPerRow) || arena.width < 1 || arena.height < 1 || arena.bytesPerRow < arena.width * 4 || typeof arena.root.source !== "boolean" || typeof arena.root.target !== "boolean" || typeof arena.root.scratch !== "boolean" || typeof arena.keyCleanup !== "boolean" || !Number.isInteger(arena.groupDepth) || arena.groupDepth < 0 || arena.groupDepth > 5 || typeof arena.needsDepth !== "boolean") return fail("The GPU frame reservation is outside fixed bounds.");
  const admittedEnvironmentDrawCount = environmentDrawCount as number;
  const admittedArena = arena as Arena;
  const admittedFingerprint = input.fingerprint as string;
  if (admittedEnvironmentDrawCount > 0 && (!admittedArena.root.source || !admittedArena.root.target)) return fail("Environment frame reservations require retained source and target attachments.");
  const resources = browserGlobal.__shellxMotionGpuSessionV1?.resources;
  if (!resources) return fail("The persistent GPU page session cannot reserve frame resources.");
  try {
    resources.reserveFrameArena({ fingerprint: admittedFingerprint, arena: admittedArena });
    if (admittedEnvironmentDrawCount > 0) resources.reserveEnvironmentUniforms();
    return { ok: true };
  } catch {
    return fail("The persistent GPU page session could not reserve its fixed frame resources.");
  }
}

/** Reserves the environment-only retained topology before the first frame can be delivered. */
export async function reserveWebGpuPageSessionEnvironmentEnvelope(value: unknown): Promise<GpuPageEnvironmentEnvelopeOutput> {
  type Arena = { width: number; height: number; bytesPerRow: number; root: { source: boolean; target: boolean; scratch: boolean }; keyCleanup: boolean; groupDepth: number; needsDepth: boolean };
  const fail = (message: string): GpuPageEnvironmentEnvelopeOutput => ({ ok: false, failure: { code: "gpu_render_failed", message } });
  const browserGlobal = globalThis as unknown as { __shellxMotionGpuSessionV1?: { resources?: { reserveEnvironmentEnvelope(input: Arena): void } } };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("The GPU environment envelope is malformed.");
  const input = value as Partial<GpuPageEnvironmentEnvelope>;
  if (typeof input.width !== "number" || typeof input.height !== "number" || typeof input.groupDepth !== "number" || !Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || !Number.isInteger(input.groupDepth) || input.width < 1 || input.height < 1 || input.groupDepth < 0 || input.groupDepth > 5 || typeof input.keyCleanup !== "boolean" || typeof input.needsDepth !== "boolean") return fail("The GPU environment envelope is outside fixed bounds.");
  const admitted = input as GpuPageEnvironmentEnvelope;
  const resources = browserGlobal.__shellxMotionGpuSessionV1?.resources;
  if (!resources) return fail("The persistent GPU page session cannot reserve its environment envelope.");
  try {
    resources.reserveEnvironmentEnvelope({ width: admitted.width, height: admitted.height, bytesPerRow: Math.ceil((admitted.width * 4) / 256) * 256, root: { source: true, target: true, scratch: true }, keyCleanup: admitted.keyCleanup, groupDepth: admitted.groupDepth, needsDepth: admitted.needsDepth });
    return { ok: true };
  } catch {
    return fail("The persistent GPU page session could not reserve its environment envelope.");
  }
}
