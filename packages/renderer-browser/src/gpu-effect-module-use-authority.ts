/**
 * Renderer-owned read/use boundary for local effect modules. This deliberately
 * is not the Workbench registry manager: source paths, manifest bytes and all
 * install/list/inspect/revoke controls remain behind the internal export.
 */
import {
  compileGpuSceneBehaviorStaticPlan,
  compileGpuSceneGeometryKeyframesStaticPlan,
  compileGpuSceneRelationsStaticPlan,
  compileGpuSceneStaticPlan,
  compileGpuFramePlan,
  createGpuEffectModuleBinding,
  canonicalJsonSha256,
  gpuEffectModuleBindingProblem,
  type GpuEffectModuleBinding,
  type GpuEffectModuleRegistryEntry,
  type GpuEffectModuleStaticDescriptor,
  type GpuScene2dFailure,
  type GpuScene2dCompileResources,
  type GpuSceneBehaviorStaticPlan,
  type GpuSceneGeometryKeyframesStaticPlan,
  type GpuSceneRelationsStaticPlan,
  type GpuSceneStaticPlan,
  motionRelationStorePresent,
  motionScene3DAnimationStorePresent,
  type MotionDocument
} from "@shellx-motion/core";
import { compileGpuScene3DAnimationStaticPlan, type GpuScene3DAnimationStaticPlan } from "@shellx-motion/core/internal/scene3d-animation-gpu-preview";
import { GPU_PAGE_AFTERIMAGE_STACK_RENDERER_IDENTITY } from "./gpu-page-afterimage-stack-contract.js";
import type { EffectModuleRegistryAuthority, EffectModuleRegistrySummary, EffectModuleUseLease } from "./effect-module-registry-types.js";

declare const authorityBrand: unique symbol;
declare const resolutionBrand: unique symbol;
declare const leaseBrand: unique symbol;

/** Safe host-injection token. Only the internal registry adapter can mint one. */
export interface GpuEffectModuleUseAuthority {
  readonly [authorityBrand]: "shellx-motion/gpu-effect-module-use-authority@1";
  resolveForMotion(motion: MotionDocument): Promise<GpuEffectModuleUseResolution>;
  beginUse(resolution: GpuEffectModuleUseResolution): Promise<GpuEffectModuleBeginUseLease>;
}

/** Opaque result: current registry entries remain in a private WeakMap. */
export interface GpuEffectModuleUseResolution {
  readonly [resolutionBrand]: "shellx-motion/gpu-effect-module-use-resolution@1";
}

/** Opaque use lease. The only public operation is one idempotent release. */
export interface GpuEffectModuleBeginUseLease {
  readonly [leaseBrand]: "shellx-motion/gpu-effect-module-begin-use-lease@1";
  release(): Promise<{ released: boolean }>;
}

/** Sanitized, immutable begin-use evidence. It intentionally contains no registry handle, path, or manifest bytes. */
export interface GpuEffectModuleBeginUseSummary {
  schema: "shellx-motion/gpu-effect-module-begin-use@1";
  staticPlanFingerprint: string;
  canonicalFrameCount: number;
  modules: readonly GpuEffectModuleBeginUseModuleEvidence[];
}
export interface GpuEffectModuleBeginUseModuleEvidence {
  layerId: string; drawId: string; scopeGroupId: string; scopeGroupDrawId: string; moduleId: string; version: string;
  manifestSha256: string; manifestByteLength: number; registryEntrySha256: string; installationProvenanceSha256: string;
  intrinsic: "motion.afterimage-stack.v1"; rendererAbi: "shellx-motion/gpu-effect-module@1"; parameterSchema: "motion.afterimage-stack.parameters@1";
  pipelineImplementationSha256: string; resourceCeilingSha256: string; descriptorFingerprint: string; bindingFingerprint: string;
  amountQ16: number; echoes: readonly { dxPx: number; dyPx: number; rgba8: readonly [number, number, number, number]; opacityQ16: number }[];
  parameterValuesSha256: string; registryGeneration: number; revocation: "not-revoked-at-begin-use";
}
export interface GpuEffectModuleApplicationLedgerEntry { index: number; atUs: number; framePlanFingerprint: string; layerId: string; }
export interface GpuEffectModuleApplicationLedger {
  schema: "shellx-motion/gpu-effect-module-application-ledger@1";
  beginUse: GpuEffectModuleBeginUseSummary;
  applications: readonly (GpuEffectModuleApplicationLedgerEntry & { atMs: number; drawId: string; scopeGroupId: string; scopeGroupDrawId: string; moduleId: string; version: string; descriptorFingerprint: string; bindingFingerprint: string; registryGeneration: number; revocation: "not-revoked-at-begin-use" })[];
  applicationSequenceSha256: string;
  release: "pending";
}
type GpuEffectModuleReleasedApplication = GpuEffectModuleApplicationLedger["applications"][number] & { release: "released" };
export interface GpuEffectModuleFinalReceiptEvidence {
  schema: "shellx-motion/gpu-effect-module-final-use@1";
  beginUse: GpuEffectModuleBeginUseSummary;
  applications: readonly GpuEffectModuleReleasedApplication[];
  applicationSequenceSha256: string;
  release: "released";
}
export interface GpuPreviewEffectModuleReceiptEvidence {
  schema: "shellx-motion/gpu-effect-module-preview-use@1";
  beginUse: GpuEffectModuleBeginUseSummary;
  applications: readonly (GpuEffectModuleReleasedApplication & GpuEffectModuleBeginUseModuleEvidence)[];
  applicationSequenceSha256: string;
  release: "released";
}

type RegistryReadUseSource = Pick<EffectModuleRegistryAuthority, "list" | "beginUse">;
type ResolutionState = { authority: GpuEffectModuleUseAuthority; registry: ReadonlyMap<string, GpuEffectModuleRegistryEntry>; descriptors?: readonly GpuEffectModuleStaticDescriptor[]; staticPlanFingerprint?: string; canonicalFrameCount?: number };
type LeaseState = {
  readonly resources: Pick<GpuScene2dCompileResources, "effectModuleDescriptors" | "effectModuleBindings">;
  readonly raw: readonly EffectModuleUseLease[];
  readonly begun: ReadonlyMap<string, EffectModuleUseLease>;
  readonly summary: GpuEffectModuleBeginUseSummary;
  readonly recordedApplications: Set<string>;
  releasePromise?: Promise<{ released: boolean }>;
  released?: true;
};

const authorityStates = new WeakMap<object, RegistryReadUseSource>();
const resolutions = new WeakMap<object, ResolutionState>();
const leases = new WeakMap<object, LeaseState>();
const ledgers = new WeakMap<object, GpuEffectModuleBeginUseLease>();

/** Internal-only minting used by the Workbench registry adapter, never re-exported from main. */
export function mintGpuEffectModuleUseAuthority(source: RegistryReadUseSource): GpuEffectModuleUseAuthority {
  const authority = Object.freeze({
    async resolveForMotion(_motion: MotionDocument): Promise<GpuEffectModuleUseResolution> {
      const state = authorityStates.get(authority);
      if (!state) throw new Error("GPU effect-module use authority is not trusted.");
      const registry = new Map<string, GpuEffectModuleRegistryEntry>();
      for (const summary of await state.list()) registry.set(key(summary.moduleId, summary.version), coreEntry(summary));
      const resolution = Object.freeze({}) as GpuEffectModuleUseResolution;
      resolutions.set(resolution, { authority, registry });
      return resolution;
    },
    async beginUse(resolution: GpuEffectModuleUseResolution): Promise<GpuEffectModuleBeginUseLease> {
      const state = authorityStates.get(authority);
      const resolved = resolutions.get(resolution);
      if (!state) throw new Error("GPU effect-module use authority is not trusted.");
      if (!resolved || resolved.authority !== authority || !resolved.descriptors || !resolved.staticPlanFingerprint || !resolved.canonicalFrameCount) throw new Error("GPU effect-module use resolution is not trusted.");
      const raw: EffectModuleUseLease[] = [];
      try {
        const byModule = new Map<string, EffectModuleUseLease>();
        for (const descriptor of resolved.descriptors) {
          const entryKey = key(descriptor.moduleId, descriptor.version);
          if (!byModule.has(entryKey)) byModule.set(entryKey, await state.beginUse(descriptor.moduleId, descriptor.version));
        }
        raw.push(...byModule.values());
        for (const descriptor of resolved.descriptors) {
          const candidate = byModule.get(key(descriptor.moduleId, descriptor.version));
          if (!candidate || !leaseMatchesDescriptor(candidate, descriptor)) throw new Error("GPU effect-module begin-use lease does not match the resolved static descriptor.");
        }
        const descriptors = new Map(resolved.descriptors.map((descriptor) => [descriptor.layerId, descriptor]));
        const bindings = new Map(resolved.descriptors.map((descriptor) => [descriptor.layerId, createGpuEffectModuleBinding(descriptor)]));
        const lease = Object.freeze({ release: async () => await releaseLease(lease) }) as GpuEffectModuleBeginUseLease;
        const summary = beginUseSummary(resolved.staticPlanFingerprint, resolved.canonicalFrameCount, resolved.descriptors, bindings, byModule);
        leases.set(lease, { raw: Object.freeze(raw), begun: byModule, summary, recordedApplications: new Set(), resources: { effectModuleDescriptors: descriptors, effectModuleBindings: bindings } });
        return lease;
      } catch (error) {
        await Promise.allSettled(raw.map(async (lease) => await lease.release()));
        throw error;
      }
    }
  }) as GpuEffectModuleUseAuthority;
  authorityStates.set(authority, source);
  return authority;
}

/** Pure host preflight; the returned resolution is opaque and must later be passed back to this authority's beginUse. */
export async function resolveGpuEffectModuleStaticPlanForUse(motion: MotionDocument, authority: GpuEffectModuleUseAuthority | undefined): Promise<
  | { ok: true; plan: GpuSceneStaticPlan; behaviorPlan?: GpuSceneBehaviorStaticPlan; geometryKeyframesPlan?: GpuSceneGeometryKeyframesStaticPlan; relationsPlan?: GpuSceneRelationsStaticPlan; scene3dAnimationPlan?: GpuScene3DAnimationStaticPlan; resolution?: GpuEffectModuleUseResolution }
  | { ok: false; failure: GpuScene2dFailure }
> {
  if (motionScene3DAnimationStorePresent(motion)) {
    const scene3dAnimation = compileGpuScene3DAnimationStaticPlan(motion);
    return scene3dAnimation.ok
      ? { ok: true, plan: scene3dAnimation.plan.basePlan, scene3dAnimationPlan: scene3dAnimation.plan }
      : scene3dAnimation;
  }
  // Relations keep their generic lane refusal. This is the one selected Browser GPU-preview
  // resolver that may receive a Core-issued relation wrapper, before resources or runtime open.
  if (motionRelationStorePresent(motion)) {
    const relations = compileGpuSceneRelationsStaticPlan(motion);
    return relations.ok
      ? { ok: true, plan: relations.plan.basePlan, relationsPlan: relations.plan }
      : relations;
  }
  // This exact Core-issued wrapper is the only GPU Browser producer path for persisted shape
  // geometry keyframes. It completes before resources, Chromium, or output publication; DOM and
  // Native keep their own capability refusals.
  if (motion.layers.some((layer) => layer.visible !== false && layer.geometryKeyframes !== undefined)) {
    const geometry = compileGpuSceneGeometryKeyframesStaticPlan(motion);
    return geometry.ok
      ? { ok: true, plan: geometry.plan.basePlan, geometryKeyframesPlan: geometry.plan }
      : geometry;
  }
  // Behaviors are composed by Core before the legacy scene plan enters this
  // renderer boundary.  Effect-module resources remain deliberately out of
  // this first join: Core's composition preflight refuses them without a
  // registry rather than lending an unbound module map to a behavior frame.
  if (motion.behaviors !== undefined) {
    const behavior = compileGpuSceneBehaviorStaticPlan(motion);
    return behavior.ok
      ? { ok: true, plan: behavior.plan.basePlan, behaviorPlan: behavior.plan }
      : behavior;
  }
  // The Core preflight has the exact visibility/topology semantics. A hidden
  // module must remain byte-for-byte on the no-module path and never wake the
  // authority; only its specific "needs host registry" refusal enters C2.
  const baseline = compileGpuSceneStaticPlan(motion);
  if (baseline.ok || !baseline.failure.message.includes("requires host-derived registry")) return baseline;
  if (!authority || !authorityStates.has(authority)) return { ok: false, failure: { code: "gpu_resource_refused", message: "GPU effect modules require a trusted host preview authority before resources or runtime can open." } };
  try {
    const resolution = await authority.resolveForMotion(motion);
    const resolved = resolutions.get(resolution);
    if (!resolved || resolved.authority !== authority) throw new Error("GPU effect-module preview authority returned an untrusted resolution.");
    const compiled = compileGpuSceneStaticPlan(motion, { effectModuleRegistry: resolved.registry, effectModuleRendererIdentity: GPU_PAGE_AFTERIMAGE_STACK_RENDERER_IDENTITY });
    if (!compiled.ok) return compiled;
    resolutions.set(resolution, { ...resolved, descriptors: Object.freeze(compiled.plan.effectModules ? [...compiled.plan.effectModules] : []), staticPlanFingerprint: compiled.plan.fingerprint, canonicalFrameCount: compiled.plan.canonicalFrameCount });
    return { ok: true, plan: compiled.plan, resolution };
  } catch (error) {
    return { ok: false, failure: { code: "gpu_resource_refused", message: error instanceof Error ? error.message : "GPU effect-module preview authority could not resolve current installed entries." } };
  }
}

/** Internal bridge into Core frame compilation; the maps never cross the injected authority API. */
export function gpuEffectModuleBeginUseFrameResources(lease: GpuEffectModuleBeginUseLease): Pick<GpuScene2dCompileResources, "effectModuleDescriptors" | "effectModuleBindings"> {
  return liveLease(lease).resources;
}

/** Internal-only evidence: live use only, with no registry map, source path, or release claim. */
export function gpuEffectModuleBeginUseSummary(lease: GpuEffectModuleBeginUseLease): GpuEffectModuleBeginUseSummary {
  return liveLease(lease).summary;
}

/** Records one successfully rendered canonical Core frame before it may enter a ledger. */
export function recordGpuEffectModuleApplication(lease: GpuEffectModuleBeginUseLease, entry: GpuEffectModuleApplicationLedgerEntry, frame: unknown): void {
  const state = liveLease(lease), fingerprint = canonicalFrameFingerprint(frame);
  if (!validApplicationEntry(entry, state.summary.canonicalFrameCount) || entry.framePlanFingerprint !== fingerprint) throw new Error("GPU effect-module application record does not match its canonical frame fingerprint.");
  const active = (frame as { draws?: unknown[] }).draws?.find((draw) => typeof draw === "object" && draw !== null && (draw as { kind?: unknown }).kind === "effectModule");
  if (!active || (active as { layerId?: unknown }).layerId !== entry.layerId || verifyGpuEffectModuleBeginUseLease(lease, active) !== null) throw new Error("GPU effect-module application record does not match its exact begin-use binding.");
  const record = canonicalJsonSha256(entry);
  if (state.recordedApplications.has(record)) throw new Error("GPU effect-module application record is duplicated.");
  state.recordedApplications.add(record);
}

/** Internal-only bounded exact application ledger for a currently live use lease. */
export function gpuEffectModuleApplicationLedger(lease: GpuEffectModuleBeginUseLease, entries: readonly GpuEffectModuleApplicationLedgerEntry[]): GpuEffectModuleApplicationLedger {
  const state = liveLease(lease);
  if (!Array.isArray(entries) || entries.length > state.summary.canonicalFrameCount) throw new Error("GPU effect-module application ledger exceeds its static frame ceiling.");
  for (let index = 0; index < entries.length; index += 1) if (!Object.hasOwn(entries, index)) throw new Error("GPU effect-module application ledger must be dense.");
  let previous: GpuEffectModuleApplicationLedgerEntry | undefined;
  const applications = entries.map((entry) => {
    if (!validApplicationEntry(entry, state.summary.canonicalFrameCount) || !state.recordedApplications.has(canonicalJsonSha256(entry))) throw new Error("GPU effect-module application ledger entry is invalid or was not rendered.");
    if (previous && (entry.index <= previous.index || entry.atUs <= previous.atUs)) throw new Error("GPU effect-module application ledger index/time is not strictly monotonic.");
    previous = entry;
    const module = state.summary.modules.find((candidate) => candidate.layerId === entry.layerId);
    if (!module || !state.resources.effectModuleDescriptors?.has(entry.layerId) || !state.resources.effectModuleBindings?.has(entry.layerId)) throw new Error("GPU effect-module application ledger does not match its exact begin-use binding.");
    return Object.freeze({ ...entry, atMs: entry.atUs / 1_000, drawId: module.drawId, scopeGroupId: module.scopeGroupId, scopeGroupDrawId: module.scopeGroupDrawId, moduleId: module.moduleId, version: module.version, descriptorFingerprint: module.descriptorFingerprint, bindingFingerprint: module.bindingFingerprint, registryGeneration: module.registryGeneration, revocation: "not-revoked-at-begin-use" as const });
  });
  const ledger = Object.freeze({ schema: "shellx-motion/gpu-effect-module-application-ledger@1" as const, beginUse: state.summary, applications: Object.freeze(applications), applicationSequenceSha256: canonicalJsonSha256({ schema: "shellx-motion/gpu-effect-module-application-ledger@1", applications }), release: "pending" as const });
  ledgers.set(ledger, lease);
  return ledger;
}

/** Preview receipts only materialize a ledger after the exact lease completed release. */
export function gpuPreviewEffectModuleReceiptEvidence(lease: GpuEffectModuleBeginUseLease, ledger: GpuEffectModuleApplicationLedger): GpuPreviewEffectModuleReceiptEvidence {
  const released = releasedLedgerEvidence(lease, ledger);
  const applications = ledger.applications.map((application) => {
    const module = ledger.beginUse.modules.find((candidate) => candidate.layerId === application.layerId);
    if (!module) throw new Error("GPU effect-module preview application evidence is incomplete or forged.");
    return Object.freeze({ ...application, ...module, release: "released" as const });
  });
  return Object.freeze({ schema: "shellx-motion/gpu-effect-module-preview-use@1" as const, ...released, applications: Object.freeze(applications) });
}

/** Public, path-free final receipt evidence after the outer host has released the trusted lease. */
export function gpuEffectModuleFinalReceiptEvidence(lease: GpuEffectModuleBeginUseLease, ledger: GpuEffectModuleApplicationLedger): GpuEffectModuleFinalReceiptEvidence {
  return Object.freeze({ schema: "shellx-motion/gpu-effect-module-final-use@1" as const, ...releasedLedgerEvidence(lease, ledger) });
}

/** Runtime-only verifier: a public canonical frame plan is inert without this current opaque lease. */
export function verifyGpuEffectModuleBeginUseLease(lease: unknown, value: unknown): string | null {
  if (!lease || typeof lease !== "object") return "GPU effect-module frame lacks a trusted begin-use lease.";
  const state = leases.get(lease);
  if (!state || state.releasePromise) return "GPU effect-module begin-use lease is unknown or already released.";
  if (!value || typeof value !== "object" || Array.isArray(value)) return "GPU effect-module frame binding is invalid.";
  const raw = value as Record<string, unknown>;
  const { kind, id, blendMode, effects, mask: _mask, ...binding } = raw;
  if (kind !== "effectModule" || typeof id !== "string" || blendMode !== "normal" || effects !== null || gpuEffectModuleBindingProblem(binding) !== null) {
    return "GPU effect-module frame binding is invalid.";
  }
  const candidate = state.resources.effectModuleBindings?.get(String(binding.layerId));
  if (!candidate || candidate.bindingFingerprint !== binding.bindingFingerprint || candidate.drawId !== id) return "GPU effect-module frame binding does not match its begin-use lease.";
  return null;
}

function liveLease(lease: GpuEffectModuleBeginUseLease): LeaseState {
  const state = leases.get(lease);
  if (!state || state.releasePromise) throw new Error("GPU effect-module begin-use lease is unknown or already released.");
  return state;
}

function releasedLedgerEvidence(lease: GpuEffectModuleBeginUseLease, ledger: GpuEffectModuleApplicationLedger): Omit<GpuEffectModuleFinalReceiptEvidence, "schema"> {
  const state = leases.get(lease);
  if (!state || state.released !== true || ledgers.get(ledger) !== lease) throw new Error("GPU effect-module lease has not completed a trusted successful release.");
  return Object.freeze({ beginUse: ledger.beginUse, applications: Object.freeze(ledger.applications.map((application) => Object.freeze({ ...application, release: "released" as const }))), applicationSequenceSha256: ledger.applicationSequenceSha256, release: "released" as const });
}

function beginUseSummary(staticPlanFingerprint: string, canonicalFrameCount: number, descriptors: readonly GpuEffectModuleStaticDescriptor[], bindings: ReadonlyMap<string, GpuEffectModuleBinding>, begun: ReadonlyMap<string, EffectModuleUseLease>): GpuEffectModuleBeginUseSummary {
  const modules = descriptors.map((descriptor) => {
    const binding = bindings.get(descriptor.layerId), lease = begun.get(key(descriptor.moduleId, descriptor.version));
    if (!binding || !lease) throw new Error("GPU effect-module begin-use summary cannot bind its static descriptor.");
    return Object.freeze({ layerId: descriptor.layerId, drawId: descriptor.drawId, scopeGroupId: descriptor.scopeGroupId, scopeGroupDrawId: descriptor.scopeGroupDrawId, moduleId: descriptor.moduleId, version: descriptor.version, manifestSha256: descriptor.manifestSha256, manifestByteLength: descriptor.manifestByteLength, registryEntrySha256: descriptor.registryEntrySha256, installationProvenanceSha256: descriptor.installationProvenanceSha256, intrinsic: descriptor.intrinsic, rendererAbi: descriptor.rendererAbi, parameterSchema: descriptor.parameterSchema, pipelineImplementationSha256: descriptor.pipelineImplementationSha256, resourceCeilingSha256: descriptor.resourceCeilingSha256, descriptorFingerprint: descriptor.descriptorFingerprint, bindingFingerprint: binding.bindingFingerprint, amountQ16: descriptor.amountQ16, echoes: Object.freeze(descriptor.echoes.map((echo) => Object.freeze({ ...echo, rgba8: Object.freeze([...echo.rgba8]) as readonly [number, number, number, number] }))), parameterValuesSha256: canonicalJsonSha256({ schema: descriptor.parameterSchema, amountQ16: descriptor.amountQ16, echoes: descriptor.echoes }), registryGeneration: lease.registryGeneration, revocation: "not-revoked-at-begin-use" as const });
  });
  return Object.freeze({ schema: "shellx-motion/gpu-effect-module-begin-use@1" as const, staticPlanFingerprint, canonicalFrameCount, modules: Object.freeze(modules) });
}

function validApplicationEntry(entry: GpuEffectModuleApplicationLedgerEntry, canonicalFrameCount: number): boolean {
  return !!entry && Number.isSafeInteger(entry.index) && entry.index >= 0 && entry.index < canonicalFrameCount && Number.isSafeInteger(entry.atUs) && entry.atUs >= 0 && sha256(entry.framePlanFingerprint) && typeof entry.layerId === "string";
}

function canonicalFrameFingerprint(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GPU effect-module application record lacks a canonical Core frame.");
  const { fingerprint, budget: _budget, ...intent } = value as Record<string, unknown>;
  if (!sha256(fingerprint) || compileGpuFramePlan(intent).fingerprint !== fingerprint) throw new Error("GPU effect-module application record has a forged canonical frame fingerprint.");
  return fingerprint;
}

function sha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }

function coreEntry(summary: EffectModuleRegistrySummary): GpuEffectModuleRegistryEntry {
  return Object.freeze({ moduleId: summary.moduleId, version: summary.version, manifestSha256: summary.manifestSha256,
    manifestByteLength: summary.manifestByteLength, registryEntrySha256: summary.registryEntrySha256,
    installationProvenanceSha256: summary.installationProvenanceSha256, installationProvenance: summary.installationProvenance,
    intrinsic: summary.intrinsic, rendererAbi: summary.rendererAbi, parameterSchema: summary.parameterSchema,
    state: summary.revokedAt ? "revoked" : "active" });
}

function key(moduleId: string, version: string): string { return `${moduleId}\u0000${version}`; }

function leaseMatchesDescriptor(lease: EffectModuleUseLease, descriptor: GpuEffectModuleStaticDescriptor): boolean {
  return lease.moduleId === descriptor.moduleId && lease.version === descriptor.version && lease.manifestSha256 === descriptor.manifestSha256
    && lease.manifestByteLength === descriptor.manifestByteLength && lease.registryEntrySha256 === descriptor.registryEntrySha256
    && lease.installationProvenanceSha256 === descriptor.installationProvenanceSha256 && lease.intrinsic === descriptor.intrinsic
    && lease.rendererAbi === descriptor.rendererAbi && lease.parameterSchema === descriptor.parameterSchema && lease.notRevokedAtBeginUse === true;
}

async function releaseLease(lease: GpuEffectModuleBeginUseLease): Promise<{ released: boolean }> {
  const state = leases.get(lease);
  if (!state) throw new Error("GPU effect-module preview lease is not trusted.");
  if (state.releasePromise) { await state.releasePromise; return { released: false }; }
  state.releasePromise = (async () => {
    const released = await Promise.allSettled(state.raw.map(async (raw) => await raw.release()));
    if (released.some((result) => result.status !== "fulfilled" || result.value.released !== true)) {
      throw new Error("GPU effect-module preview lease could not release every raw registry lease.");
    }
    state.released = true;
    return { released: true };
  })();
  return await state.releasePromise;
}
