import type { GpuRuntimeFailure } from "./gpu-runtime-types";
import type { GpuPageMutableResourceMetrics, GpuPageSessionResourceMetrics } from "./gpu-page-session-resource-metrics";

export type { GpuPageSessionResourceMetrics } from "./gpu-page-session-resource-metrics";
export { readWebGpuPageSessionResourceMetrics } from "./gpu-page-session-resource-metrics";

export type GpuPageSessionResourceInstallOutput =
  | { ok: true }
  | { ok: false; failure: GpuRuntimeFailure };

/**
 * Installs page-local pools after the device exists. This function is passed to
 * Playwright by source text, so all helpers deliberately stay inside its
 * closure rather than importing host code into the renderer page.
 */
export async function installWebGpuPageSessionResources(): Promise<GpuPageSessionResourceInstallOutput> {
  type BufferFacade = { destroy?(): void; getMappedRange(): ArrayBuffer; mapAsync(mode: number): Promise<void>; unmap(): void };
  type TextureFacade = { createView(): unknown; destroy?(): void };
  type Device = {
    createBuffer(value: unknown): BufferFacade;
    createTexture(value: unknown): TextureFacade;
  };
  type Surface = { current: TextureFacade; source: TextureFacade | null; target: TextureFacade | null; scratch: TextureFacade | null };
  type FrameArena = { width: number; height: number; bytesPerRow: number; readback: BufferFacade; root: Surface; keyCleanup: Surface | null; groups: Surface[]; depth: TextureFacade | null; environmentAccumulator: TextureFacade | null };
  type DynamicSlot = { buffer: BufferFacade; capacityBytes: number };
  type DynamicPools = Map<string, DynamicSlot[]>;
  type ArenaInput = { width: number; height: number; bytesPerRow: number; root: { source: boolean; target: boolean; scratch: boolean }; keyCleanup: boolean; groupDepth: number; needsDepth: boolean };
  type Reservation = { fingerprint: string; arena: ArenaInput };
  type Lifecycle = {
    ensureFrameArena(input: ArenaInput): FrameArena;
    reserveFrameArena(input: Reservation): void;
    takeReservedFrameArena(fingerprint: string): FrameArena;
    reserveEnvironmentEnvelope(input: ArenaInput): void;
    beginFrame(): void;
    acquireBuffer(role: "vertex" | "index" | "uniform", bytes: number, usage: number): BufferFacade;
    reserveEnvironmentUniforms(): void;
    environmentUniformBuffer(): BufferFacade;
    environmentAccumulator(): TextureFacade;
    completeFrame(environmentDraws: number): void;
    destroy(): void;
    snapshot(images: number, textSurfaces: number): GpuPageSessionResourceMetrics;
  };
  const fail = (message: string): GpuPageSessionResourceInstallOutput => ({ ok: false, failure: { code: "gpu_render_failed", message } });
  const MAX_DYNAMIC_POOL_BYTES = 128 * 1024 * 1024;
  const MAX_DYNAMIC_POOL_SLOTS = 24_576;
  const MAX_FRAME_ARENA_BYTES = 512 * 1024 * 1024;
  const browserGlobal = globalThis as unknown as {
    GPUBufferUsage?: Record<string, number>;
    GPUTextureUsage?: Record<string, number>;
    __shellxMotionGpuSessionV1?: unknown;
  };
  const bufferUsage = browserGlobal.GPUBufferUsage;
  const textureUsage = browserGlobal.GPUTextureUsage;
  const state = browserGlobal.__shellxMotionGpuSessionV1 as {
    device?: Device;
    resources?: Lifecycle;
  } | undefined;
  if (!state?.device || !bufferUsage || !textureUsage) return fail("The persistent GPU page session cannot install resource pools.");
  if (state.resources) return { ok: true };
  if (![bufferUsage.COPY_DST, bufferUsage.MAP_READ, textureUsage.RENDER_ATTACHMENT, textureUsage.COPY_SRC, textureUsage.TEXTURE_BINDING].every((value) => typeof value === "number")) {
    return fail("The persistent GPU page session does not expose required resource usage flags.");
  }

  let arena: FrameArena | undefined;
  let reservation: Reservation | undefined;
  let environmentEnvelope: ArenaInput | undefined;
  let environmentUniformBuffer: BufferFacade | undefined;
  const ENVIRONMENT_UNIFORM_SLOTS = 36, ENVIRONMENT_UNIFORM_SLOT_BYTES = 256;
  const pools: DynamicPools = new Map<string, DynamicSlot[]>();
  const cursors = new Map<string, number>();
  const metrics: GpuPageMutableResourceMetrics = {
    framesRendered: 0,
    frameArenaReconfigurations: 0,
    frameTextureSlots: 0,
    frameTextureBytes: 0,
    depthTextureBytes: 0,
    readbackBytes: 0,
    frameArenaBytes: 0,
    frameTextureHighWaterSlots: 0,
    frameTextureHighWaterBytes: 0,
    frameArenaHighWaterBytes: 0,
    dynamicBufferSlots: 0,
    dynamicBufferBytes: 0,
    dynamicBufferHighWaterSlots: 0,
    dynamicBufferHighWaterBytes: 0,
    frameArenaReservations: 0,
    frameArenaLateAllocationRefusals: 0,
    environmentUniformCapacitySlots: 0,
    environmentUniformBytes: 0,
    environmentUniformHighWaterSlots: 0,
    environmentUniformHighWaterBytes: 0,
    environmentUniformLateAllocationRefusals: 0,
    environmentDrawsRendered: 0,
    environmentEnvelopeReservations: 0
  };
  const fixedNonPooledMetrics = Object.freeze({
    pointRaster: "gpu-native-instanced" as const, pointPositionEvaluation: "core-cpu-exact-time" as const, pointComputeField: "not-used" as const,
    immutablePointBufferSlots: 0, immutablePointBufferBytes: 0, immutablePointMirrorBytes: 0, immutablePointBufferHighWaterSlots: 0, immutablePointBufferHighWaterBytes: 0, adapterPointInstanceLimit: 0,
    computeParticleBufferSlots: 0, computeParticleBufferBytes: 0, computeParticleBufferHighWaterSlots: 0, computeParticleBufferHighWaterBytes: 0, adapterComputeParticleInstanceLimit: 0,
    computeParticleDispatches: 0, computeParticleAbi: "not-used" as const, computeParticleInstanceBytes: 0, computeParticleRetainedBufferCount: 0, computeParticleUniformBytes: 0,
    computeParticleRasterCalls: 0, computeParticleHeadRasterCalls: 0, computeParticleTrailRasterCalls: 0, computeParticleCapacityReconfigurations: 0, computeParticleLateAllocationRefusals: 0
  });
  const safeProduct = (left: number, right: number): number => {
    const value = left * right;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("GPU frame arena byte accounting overflowed.");
    return value;
  };
  const safeSum = (...values: number[]): number => {
    const value = values.reduce((total, entry) => total + entry, 0);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("GPU frame arena byte accounting overflowed.");
    return value;
  };
  const textureSlots = (surface: Surface): number => 1 + Number(surface.source !== null) + Number(surface.target !== null) + Number(surface.scratch !== null);
  const destroySurface = (surface: Surface): void => {
    const textures = new Set<TextureFacade>([surface.current, surface.source, surface.target, surface.scratch].filter((value): value is TextureFacade => value !== null));
    for (const texture of textures) texture.destroy?.();
  };
  const destroyArena = (): void => {
    if (!arena) return;
    destroySurface(arena.root);
    if (arena.keyCleanup) destroySurface(arena.keyCleanup);
    for (const group of arena.groups) destroySurface(group);
    arena.depth?.destroy?.();
    arena.environmentAccumulator?.destroy?.();
    arena.readback.destroy?.();
    arena = undefined;
    metrics.frameTextureSlots = 0;
    metrics.frameTextureBytes = 0;
    metrics.depthTextureBytes = 0;
    metrics.readbackBytes = 0;
    metrics.frameArenaBytes = 0;
    reservation = undefined;
    environmentEnvelope = undefined;
  };
  const recomputeArenaMetrics = (): void => {
    if (!arena) return;
    const colorSlots = textureSlots(arena.root) + (arena.keyCleanup ? textureSlots(arena.keyCleanup) : 0) + arena.groups.reduce((total, surface) => total + textureSlots(surface), 0);
    const pixels = safeProduct(arena.width, arena.height);
    const colorTextureBytes = safeProduct(colorSlots, safeProduct(pixels, 4)), environmentAccumulatorBytes = arena.environmentAccumulator ? safeProduct(pixels, 8) : 0;
    metrics.depthTextureBytes = arena.depth ? safeProduct(pixels, 4) : 0;
    metrics.frameTextureSlots = colorSlots + Number(arena.depth !== null) + Number(arena.environmentAccumulator !== null);
    metrics.frameTextureBytes = safeSum(colorTextureBytes, metrics.depthTextureBytes, environmentAccumulatorBytes);
    metrics.readbackBytes = safeProduct(arena.bytesPerRow, arena.height);
    metrics.frameArenaBytes = safeSum(metrics.frameTextureBytes, metrics.readbackBytes);
    metrics.frameTextureHighWaterSlots = Math.max(metrics.frameTextureHighWaterSlots, metrics.frameTextureSlots);
    metrics.frameTextureHighWaterBytes = Math.max(metrics.frameTextureHighWaterBytes, metrics.frameTextureBytes);
    metrics.frameArenaHighWaterBytes = Math.max(metrics.frameArenaHighWaterBytes, metrics.frameArenaBytes);
  };
  const makeColorTexture = (width: number, height: number): TextureFacade => state.device!.createTexture({ size: { width, height, depthOrArrayLayers: 1 }, format: "rgba8unorm", usage: textureUsage.RENDER_ATTACHMENT | textureUsage.COPY_SRC | textureUsage.TEXTURE_BINDING });
  const makeEnvironmentAccumulator = (width: number, height: number): TextureFacade => state.device!.createTexture({ size: { width, height, depthOrArrayLayers: 1 }, format: "rgba16float", usage: textureUsage.RENDER_ATTACHMENT | textureUsage.TEXTURE_BINDING });
  const makeSurface = (width: number, height: number, requested: { source: boolean; target: boolean; scratch: boolean }): Surface => ({
    current: makeColorTexture(width, height),
    source: requested.source ? makeColorTexture(width, height) : null,
    target: requested.target ? makeColorTexture(width, height) : null,
    scratch: requested.scratch ? makeColorTexture(width, height) : null
  });
  const ensureSurface = (surface: Surface, width: number, height: number, requested: { source: boolean; target: boolean; scratch: boolean }): void => {
    if (requested.source && !surface.source) surface.source = makeColorTexture(width, height);
    if (requested.target && !surface.target) surface.target = makeColorTexture(width, height);
    if (requested.scratch && !surface.scratch) surface.scratch = makeColorTexture(width, height);
  };
  const ensureFrameArena = (input: ArenaInput, reserveEnvironmentAccumulator = false): FrameArena => {
    if (!input || typeof input !== "object" || !input.root || typeof input.root.source !== "boolean" || typeof input.root.target !== "boolean" || typeof input.root.scratch !== "boolean" || typeof input.keyCleanup !== "boolean" || typeof input.needsDepth !== "boolean" || !Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || !Number.isSafeInteger(input.bytesPerRow) || input.width < 1 || input.height < 1 || !Number.isInteger(input.groupDepth) || input.groupDepth < 0 || input.groupDepth > 5) throw new Error("GPU frame arena configuration is outside fixed bounds.");
    const minimumRowBytes = safeProduct(input.width, 4);
    if (input.bytesPerRow < minimumRowBytes) throw new Error("GPU frame arena configuration is outside fixed bounds.");
    if (environmentEnvelope && (
      environmentEnvelope.width !== input.width
      || environmentEnvelope.height !== input.height
      || environmentEnvelope.bytesPerRow !== input.bytesPerRow
      || (input.root.source && !environmentEnvelope.root.source)
      || (input.root.target && !environmentEnvelope.root.target)
      || (input.root.scratch && !environmentEnvelope.root.scratch)
      || (input.keyCleanup && !environmentEnvelope.keyCleanup)
      || input.groupDepth > environmentEnvelope.groupDepth
      || (input.needsDepth && !environmentEnvelope.needsDepth)
    )) {
      metrics.frameArenaLateAllocationRefusals += 1;
      throw new Error("GPU environment arena envelope refuses a late attachment allocation.");
    }
    const retainEnvironmentAccumulator = reserveEnvironmentAccumulator || environmentEnvelope !== undefined, pixels = safeProduct(input.width, input.height);
    const rootColorSlots = 1 + Number(input.root.source) + Number(input.root.target) + Number(input.root.scratch);
    const colorTextureBytes = safeProduct(rootColorSlots + Number(input.keyCleanup) * 3 + safeProduct(input.groupDepth, 4), safeProduct(pixels, 4));
    const depthTextureBytes = input.needsDepth ? safeProduct(pixels, 4) : 0;
    const readbackBytes = safeProduct(input.bytesPerRow, input.height);
    const requestedArenaBytes = safeSum(colorTextureBytes, depthTextureBytes, readbackBytes, retainEnvironmentAccumulator ? safeProduct(pixels, 8) : 0);
    if (requestedArenaBytes > MAX_FRAME_ARENA_BYTES) throw new Error("GPU frame arena exceeds its fixed 512 MiB session budget.");
    if (!arena || arena.width !== input.width || arena.height !== input.height || arena.bytesPerRow !== input.bytesPerRow) {
      destroyArena();
      arena = {
        width: input.width,
        height: input.height,
        bytesPerRow: input.bytesPerRow,
        readback: state.device!.createBuffer({ size: input.bytesPerRow * input.height, usage: bufferUsage.COPY_DST | bufferUsage.MAP_READ }),
        root: makeSurface(input.width, input.height, input.root),
        keyCleanup: null,
        groups: [],
        depth: null,
        environmentAccumulator: retainEnvironmentAccumulator ? makeEnvironmentAccumulator(input.width, input.height) : null
      };
      metrics.frameArenaReconfigurations += 1;
    }
    ensureSurface(arena.root, input.width, input.height, input.root);
    if (input.keyCleanup && !arena.keyCleanup) arena.keyCleanup = makeSurface(input.width, input.height, { source: true, target: true, scratch: false });
    while (arena.groups.length < input.groupDepth) arena.groups.push(makeSurface(input.width, input.height, { source: true, target: true, scratch: true }));
    if (input.needsDepth && !arena.depth) {
      arena.depth = state.device!.createTexture({ size: { width: input.width, height: input.height, depthOrArrayLayers: 1 }, format: "depth24plus", usage: textureUsage.RENDER_ATTACHMENT });
    }
    if (retainEnvironmentAccumulator && !arena.environmentAccumulator) arena.environmentAccumulator = makeEnvironmentAccumulator(input.width, input.height);
    recomputeArenaMetrics();
    return arena;
  };
  const reserveFrameArena = (input: Reservation): void => {
    if (!input || typeof input !== "object" || typeof input.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.fingerprint) || !input.arena || typeof input.arena !== "object") throw new Error("GPU frame arena reservation is malformed.");
    ensureFrameArena(input.arena);
    reservation = {
      fingerprint: input.fingerprint,
      arena: {
        width: input.arena.width,
        height: input.arena.height,
        bytesPerRow: input.arena.bytesPerRow,
        root: { ...input.arena.root },
        keyCleanup: input.arena.keyCleanup,
        groupDepth: input.arena.groupDepth,
        needsDepth: input.arena.needsDepth
      }
    };
    metrics.frameArenaReservations += 1;
  };
  const takeReservedFrameArena = (fingerprint: string): FrameArena => {
    if (!reservation || reservation.fingerprint !== fingerprint || !arena) {
      metrics.frameArenaLateAllocationRefusals += 1;
      throw new Error("GPU frame arena was not reserved before delivery.");
    }
    reservation = undefined;
    return arena;
  };
  const beginFrame = (): void => cursors.clear();
  const acquireBuffer = (role: "vertex" | "index" | "uniform", bytes: number, usage: number): BufferFacade => {
    if (!Number.isSafeInteger(bytes) || bytes < 4 || bytes % 4 !== 0) throw new Error("GPU dynamic buffer request is not 4-byte aligned.");
    const pool = pools.get(role) ?? [];
    if (!pools.has(role)) pools.set(role, pool);
    const index = cursors.get(role) ?? 0;
    cursors.set(role, index + 1);
    if (index >= MAX_DYNAMIC_POOL_SLOTS) throw new Error("GPU dynamic buffer pool exceeded its fixed slot budget.");
    const existing = pool[index];
    if (existing && existing.capacityBytes >= bytes) return existing.buffer;
    if (existing) {
      existing.buffer.destroy?.();
      metrics.dynamicBufferBytes -= existing.capacityBytes;
    }
    const nextTotalBytes = metrics.dynamicBufferBytes + bytes;
    if (nextTotalBytes > MAX_DYNAMIC_POOL_BYTES) throw new Error("GPU dynamic buffer pool exceeded its 128 MiB session budget.");
    const buffer = state.device!.createBuffer({ size: bytes, usage });
    pool[index] = { buffer, capacityBytes: bytes };
    if (!existing) metrics.dynamicBufferSlots += 1;
    metrics.dynamicBufferBytes = nextTotalBytes;
    metrics.dynamicBufferHighWaterSlots = Math.max(metrics.dynamicBufferHighWaterSlots, metrics.dynamicBufferSlots);
    metrics.dynamicBufferHighWaterBytes = Math.max(metrics.dynamicBufferHighWaterBytes, metrics.dynamicBufferBytes);
    return buffer;
  };
  const completeFrame = (environmentDraws: number): void => {
    if (!Number.isSafeInteger(environmentDraws) || environmentDraws < 0 || environmentDraws > 32) throw new Error("GPU environment draw accounting is outside its fixed capacity.");
    metrics.framesRendered += 1;
    metrics.environmentDrawsRendered += environmentDraws;
  };
  const reserveEnvironmentUniforms = (): void => {
    if (environmentUniformBuffer) return;
    if (typeof bufferUsage.UNIFORM !== "number") {
      metrics.environmentUniformLateAllocationRefusals += 1;
      throw new Error("GPU environment uniform reservation requires uniform-buffer support.");
    }
    const bytes = ENVIRONMENT_UNIFORM_SLOTS * ENVIRONMENT_UNIFORM_SLOT_BYTES;
    environmentUniformBuffer = state.device!.createBuffer({ size: bytes, usage: bufferUsage.COPY_DST | bufferUsage.UNIFORM });
    metrics.environmentUniformCapacitySlots = ENVIRONMENT_UNIFORM_SLOTS;
    metrics.environmentUniformBytes = bytes;
    metrics.environmentUniformHighWaterSlots = ENVIRONMENT_UNIFORM_SLOTS;
    metrics.environmentUniformHighWaterBytes = bytes;
  };
  const environmentUniformBufferForFrame = (): BufferFacade => {
    if (environmentUniformBuffer) return environmentUniformBuffer;
    metrics.environmentUniformLateAllocationRefusals += 1;
    throw new Error("GPU environment uniforms were not reserved before delivery.");
  };
  const environmentAccumulatorForFrame = (): TextureFacade => { if (arena?.environmentAccumulator) return arena.environmentAccumulator; metrics.frameArenaLateAllocationRefusals += 1; throw new Error("GPU temporal environment accumulator was not reserved before delivery."); };
  const reserveEnvironmentEnvelope = (input: ArenaInput): void => {
    if (environmentEnvelope) {
      metrics.frameArenaLateAllocationRefusals += 1;
      throw new Error("GPU environment arena envelope is already reserved.");
    }
    ensureFrameArena(input, true);
    environmentEnvelope = {
      width: input.width,
      height: input.height,
      bytesPerRow: input.bytesPerRow,
      root: { ...input.root },
      keyCleanup: input.keyCleanup,
      groupDepth: input.groupDepth,
      needsDepth: input.needsDepth
    };
    reserveEnvironmentUniforms();
    metrics.environmentEnvelopeReservations += 1;
  };
  const destroy = (): void => {
    destroyArena();
    environmentUniformBuffer?.destroy?.();
    environmentUniformBuffer = undefined;
    for (const pool of pools.values()) for (const slot of pool) slot.buffer.destroy?.();
    pools.clear();
    cursors.clear();
    metrics.dynamicBufferSlots = 0;
    metrics.dynamicBufferBytes = 0;
    metrics.environmentUniformCapacitySlots = 0;
    metrics.environmentUniformBytes = 0;
  };
  const snapshot = (images: number, textSurfaces: number): GpuPageSessionResourceMetrics => Object.freeze({
    schema: "shellx-motion/gpu-page-session-resources@1",
    framesRendered: metrics.framesRendered,
    frameArenaReconfigurations: metrics.frameArenaReconfigurations,
    frameTextureSlots: metrics.frameTextureSlots,
    frameTextureBytes: metrics.frameTextureBytes,
    depthTextureBytes: metrics.depthTextureBytes,
    readbackBytes: metrics.readbackBytes,
    frameArenaBytes: metrics.frameArenaBytes,
    frameTextureHighWaterSlots: metrics.frameTextureHighWaterSlots,
    frameTextureHighWaterBytes: metrics.frameTextureHighWaterBytes,
    frameArenaHighWaterBytes: metrics.frameArenaHighWaterBytes,
    frameArenaReservations: metrics.frameArenaReservations,
    frameArenaLateAllocationRefusals: metrics.frameArenaLateAllocationRefusals,
    dynamicBufferSlots: metrics.dynamicBufferSlots,
    dynamicBufferBytes: metrics.dynamicBufferBytes,
    dynamicBufferHighWaterSlots: metrics.dynamicBufferHighWaterSlots,
    dynamicBufferHighWaterBytes: metrics.dynamicBufferHighWaterBytes,
    environmentUniformCapacitySlots: metrics.environmentUniformCapacitySlots,
    environmentUniformBytes: metrics.environmentUniformBytes,
    environmentUniformHighWaterSlots: metrics.environmentUniformHighWaterSlots,
    environmentUniformHighWaterBytes: metrics.environmentUniformHighWaterBytes,
    environmentUniformLateAllocationRefusals: metrics.environmentUniformLateAllocationRefusals,
    environmentDrawsRendered: metrics.environmentDrawsRendered,
    environmentEnvelopeReservations: metrics.environmentEnvelopeReservations,
    immutableImageTextures: images,
    retainedTextSurfaces: textSurfaces,
    ...fixedNonPooledMetrics
  });
  state.resources = { ensureFrameArena, reserveFrameArena, takeReservedFrameArena, reserveEnvironmentEnvelope, beginFrame, acquireBuffer, reserveEnvironmentUniforms, environmentUniformBuffer: environmentUniformBufferForFrame, environmentAccumulator: environmentAccumulatorForFrame, completeFrame, destroy, snapshot };
  return { ok: true };
}
