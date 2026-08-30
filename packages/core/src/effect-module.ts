import { canonicalJsonSha256, compareCodeUnits } from "./canonical-json";
import type { MotionDocument, MotionLayer } from "./types";

export const MOTION_EFFECT_MODULE_REF_SCHEMA = "shellx-motion/effect-module-ref@1" as const;
export const MOTION_EFFECT_MODULE_MANIFEST_SCHEMA = "shellx-motion/effect-module-manifest@1" as const;
export const MOTION_AFTERIMAGE_STACK_INTRINSIC = "motion.afterimage-stack.v1" as const;
export const GPU_EFFECT_MODULE_RENDERER_ABI = "shellx-motion/gpu-effect-module@1" as const;
export const MOTION_AFTERIMAGE_STACK_PARAMETER_SCHEMA = "motion.afterimage-stack.parameters@1" as const;
export const GPU_EFFECT_MODULE_UNIFORM_BYTES = 160;
export const GPU_EFFECT_MODULE_MAX_TEXTURE_LOADS = 5;
export const GPU_EFFECT_MODULE_PASS_COUNT = 1;
export const GPU_EFFECT_MODULE_RETAINED_TEXTURE_COUNT = 0;
export const GPU_EFFECT_MODULE_MAX_ECHOES = 4;
export const GPU_EFFECT_MODULE_MAX_MANIFEST_BYTES = 16_384;
/**
 * Exact effect-module versions are short identifiers, not arbitrary manifest text. This matches
 * the existing module-id ceiling while leaving ample room for normal prerelease labels.
 */
export const MOTION_EFFECT_MODULE_VERSION_MAX_LENGTH = 128;
/**
 * The published JSON Schema repeats the exact bounded grammar for standard validators; Core owns
 * the executable linear parser, and `published-schema-check` dispatches this marker back to it.
 */
export const MOTION_EFFECT_MODULE_VERSION_SCHEMA_PATTERN = "^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-(?!0[0-9]+(?:\\.|$))[0-9A-Za-z-]+(?:\\.(?!0[0-9]+(?:\\.|$))[0-9A-Za-z-]+)*)?$";

export interface MotionEffectModuleEcho { dxPx: number; dyPx: number; color: string; opacityQ16: number }
export interface MotionEffectModuleReference {
  schema: typeof MOTION_EFFECT_MODULE_REF_SCHEMA;
  moduleId: string;
  version: string;
  parameters: { echoes: readonly MotionEffectModuleEcho[]; amountQ16: number };
}
export interface MotionEffectModuleManifest {
  schema: typeof MOTION_EFFECT_MODULE_MANIFEST_SCHEMA;
  moduleId: string;
  version: string;
  displayName: string;
  intrinsic: typeof MOTION_AFTERIMAGE_STACK_INTRINSIC;
  rendererAbi: typeof GPU_EFFECT_MODULE_RENDERER_ABI;
  parameterSchema: typeof MOTION_AFTERIMAGE_STACK_PARAMETER_SCHEMA;
}
export interface GpuEffectModuleRegistryEntry {
  moduleId: string;
  version: string;
  manifestSha256: string;
  manifestByteLength: number;
  registryEntrySha256: string;
  installationProvenanceSha256: string;
  installationProvenance: GpuEffectModuleInstallationProvenance;
  intrinsic: typeof MOTION_AFTERIMAGE_STACK_INTRINSIC;
  rendererAbi: typeof GPU_EFFECT_MODULE_RENDERER_ABI;
  parameterSchema: typeof MOTION_AFTERIMAGE_STACK_PARAMETER_SCHEMA;
  state: "active" | "revoked";
}
export interface GpuEffectModuleRendererIdentity { intrinsic: typeof MOTION_AFTERIMAGE_STACK_INTRINSIC; rendererAbi: typeof GPU_EFFECT_MODULE_RENDERER_ABI; parameterSchema: typeof MOTION_AFTERIMAGE_STACK_PARAMETER_SCHEMA; pipelineImplementationSha256: string }
/** Begin-use evidence is runtime-only revocation linearization, never static-plan identity. */
export interface GpuEffectModuleBeginUseEvidence { bindingFingerprint: string; registryGeneration: number; revocation: "not-revoked-at-begin-use" }
export interface GpuEffectModuleInstallationProvenance { schema: "shellx-motion/effect-module-installation-provenance@1"; moduleId: string; version: string; manifestSha256: string; manifestByteLength: number; installedAt: string; authority: "workbench-operator" }
export interface GpuEffectModuleEcho { dxPx: number; dyPx: number; rgba8: readonly [number, number, number, number]; opacityQ16: number }
export interface GpuEffectModuleStaticDescriptor {
  layerId: string;
  /** Renderer draw identity, reserved against the document and group synthetic namespace. */
  drawId: string;
  scopeGroupId: string;
  scopeGroupDrawId: string;
  moduleId: string;
  version: string;
  manifestSha256: string;
  manifestByteLength: number;
  registryEntrySha256: string;
  installationProvenanceSha256: string;
  pipelineImplementationSha256: string;
  resourceCeilingSha256: string;
  intrinsic: typeof MOTION_AFTERIMAGE_STACK_INTRINSIC;
  rendererAbi: typeof GPU_EFFECT_MODULE_RENDERER_ABI;
  parameterSchema: typeof MOTION_AFTERIMAGE_STACK_PARAMETER_SCHEMA;
  referenceFingerprint: string;
  echoes: readonly GpuEffectModuleEcho[];
  amountQ16: number;
  uniformBytes: typeof GPU_EFFECT_MODULE_UNIFORM_BYTES;
  textureLoadCount: number;
  passCount: typeof GPU_EFFECT_MODULE_PASS_COUNT;
  retainedTextureCount: typeof GPU_EFFECT_MODULE_RETAINED_TEXTURE_COUNT;
  descriptorFingerprint: string;
}
export interface GpuEffectModuleBinding extends GpuEffectModuleStaticDescriptor { bindingFingerprint: string }
export interface GpuEffectModuleDescriptorResult { ok: true; descriptors: readonly GpuEffectModuleStaticDescriptor[] }
export interface GpuEffectModuleDescriptorFailure { ok: false; message: string; layerId?: string }
export type GpuEffectModuleDescriptorResolution = GpuEffectModuleDescriptorResult | GpuEffectModuleDescriptorFailure;
type DerivedDescriptor = Omit<GpuEffectModuleStaticDescriptor, "manifestSha256" | "manifestByteLength" | "registryEntrySha256" | "installationProvenanceSha256" | "pipelineImplementationSha256" | "resourceCeilingSha256" | "descriptorFingerprint">;

/**
 * Parse the exact package/manifest SemVer subset in one bounded forward pass. Effect modules use
 * stable versions and prereleases only: leading `v`, build metadata, ranges, and `latest` never
 * name an installed immutable module.
 */
export function isCanonicalMotionEffectModuleVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MOTION_EFFECT_MODULE_VERSION_MAX_LENGTH) return false;
  let index = 0;
  const numericIdentifier = (): boolean => {
    const start = index;
    while (index < value.length && digit(value.charCodeAt(index))) index += 1;
    return index > start && !(value.charCodeAt(start) === 48 && index - start > 1);
  };
  if (!numericIdentifier() || value[index++] !== "." || !numericIdentifier() || value[index++] !== "." || !numericIdentifier()) return false;
  if (index === value.length) return true;
  if (value[index++] !== "-") return false;
  while (index < value.length) {
    const start = index;
    let numeric = true;
    while (index < value.length && value[index] !== ".") {
      const code = value.charCodeAt(index);
      if (!semverIdentifier(code)) return false;
      if (!digit(code)) numeric = false;
      index += 1;
    }
    if (index === start || (numeric && value.charCodeAt(start) === 48 && index - start > 1)) return false;
    if (index === value.length) return true;
    index += 1;
  }
  return false;
}

/** Checks the exact, executable-free package reference before any registry resolution. */
export function motionEffectModuleReferenceProblem(value: unknown): string | null {
  if (!record(value, ["schema", "moduleId", "version", "parameters"])) return "contains unknown or missing fields";
  if (value.schema !== MOTION_EFFECT_MODULE_REF_SCHEMA || !moduleId(value.moduleId) || !isCanonicalMotionEffectModuleVersion(value.version)) return "has an invalid schema, moduleId, or canonical version";
  const parameters = value.parameters;
  if (!record(parameters, ["echoes", "amountQ16"]) || !Array.isArray(parameters.echoes) || parameters.echoes.length < 1 || parameters.echoes.length > GPU_EFFECT_MODULE_MAX_ECHOES || !q16(parameters.amountQ16)) return "has invalid bounded parameters";
  for (const echo of parameters.echoes) {
    if (!record(echo, ["dxPx", "dyPx", "color", "opacityQ16"]) || !offset(echo.dxPx) || !offset(echo.dyPx) || !color(echo.color) || !q16(echo.opacityQ16)) return "has an invalid echo";
  }
  return null;
}

/** Validates the host-installed, data-only manifest without interpreting any executable payload. */
export function motionEffectModuleManifestProblem(value: unknown): string | null {
  if (!record(value, ["schema", "moduleId", "version", "displayName", "intrinsic", "rendererAbi", "parameterSchema"])) return "contains unknown or missing fields";
  return value.schema === MOTION_EFFECT_MODULE_MANIFEST_SCHEMA && moduleId(value.moduleId) && isCanonicalMotionEffectModuleVersion(value.version) && displayName(value.displayName) && value.intrinsic === MOTION_AFTERIMAGE_STACK_INTRINSIC && value.rendererAbi === GPU_EFFECT_MODULE_RENDERER_ABI && value.parameterSchema === MOTION_AFTERIMAGE_STACK_PARAMETER_SCHEMA ? null : "has an invalid closed manifest field";
}
/** Stable host helpers: no registry path, raw manifest bytes, or operator session crosses this boundary. */
export function gpuEffectModuleInstallationProvenanceFingerprint(value: GpuEffectModuleInstallationProvenance): string { return canonicalJsonSha256(value); }
export function gpuEffectModuleInstallationProvenanceProblem(value: unknown): string | null { return !record(value, ["schema", "moduleId", "version", "manifestSha256", "manifestByteLength", "installedAt", "authority"]) || value.schema !== "shellx-motion/effect-module-installation-provenance@1" || !moduleId(value.moduleId) || !isCanonicalMotionEffectModuleVersion(value.version) || !sha(value.manifestSha256) || !byteLength(value.manifestByteLength) || !isoTime(value.installedAt) || value.authority !== "workbench-operator" ? "contains invalid installation provenance" : null; }
export function gpuEffectModuleRegistryEntryFingerprint(value: Omit<GpuEffectModuleRegistryEntry, "registryEntrySha256" | "state">): string { return canonicalJsonSha256(value); }
export function gpuEffectModuleResourceCeilingFingerprint(): string { return canonicalJsonSha256({ intrinsic: MOTION_AFTERIMAGE_STACK_INTRINSIC, rendererAbi: GPU_EFFECT_MODULE_RENDERER_ABI, maxEchoes: GPU_EFFECT_MODULE_MAX_ECHOES, uniformBytes: GPU_EFFECT_MODULE_UNIFORM_BYTES, textureLoadCount: GPU_EFFECT_MODULE_MAX_TEXTURE_LOADS, passCount: GPU_EFFECT_MODULE_PASS_COUNT, retainedTextureCount: GPU_EFFECT_MODULE_RETAINED_TEXTURE_COUNT }); }
export function gpuEffectModuleRendererIdentityProblem(value: unknown): string | null { return !record(value, ["intrinsic", "rendererAbi", "parameterSchema", "pipelineImplementationSha256"]) || value.intrinsic !== MOTION_AFTERIMAGE_STACK_INTRINSIC || value.rendererAbi !== GPU_EFFECT_MODULE_RENDERER_ABI || value.parameterSchema !== MOTION_AFTERIMAGE_STACK_PARAMETER_SCHEMA || !sha(value.pipelineImplementationSha256) ? "contains invalid renderer identity" : null; }

/** Semantic package validator: a module reference is a terminal, isolated group-local adjustment. */
export function validateMotionEffectModuleLayers(layers: unknown[], errors: Array<{ path: string; message: string }>): void {
  const values = layers.map((value) => plain(value)); const owners = groupOwners(values);
  for (let index = 0; index < values.length; index += 1) {
    const layer = values[index]; if (!layer || !hasEffectModule(layer)) continue;
    const path = `/layers/${index}`; const problem = motionEffectModuleReferenceProblem(layer.effectModule);
    if (problem) errors.push({ path: `${path}/effectModule`, message: problem });
    if (layer.type !== "adjustment") errors.push({ path: `${path}/effectModule`, message: "is supported only on adjustment layers" });
    const parent = owners.get(String(layer.id));
    if (!parent || parent.count !== 1) errors.push({ path: `${path}/effectModule`, message: "requires one owning isolated group" });
    else if (parent.children[parent.children.length - 1] !== layer.id) errors.push({ path: `${path}/effectModule`, message: "must be the final direct child of its owning group" });
    else if (owners.has(parent.id)) errors.push({ path: `${path}/effectModule`, message: "cannot be scoped by a nested group" });
    for (const key of Object.keys(layer)) if (!(["id", "type", "startMs", "durationMs", "visible", "effectModule"] as const).includes(key as never)) errors.push({ path: `${path}/${key}`, message: "is not supported on module adjustment layers" });
  }
}

/** Pure host-entry resolution; entries are data supplied by the host, never paths or manifest bytes. */
export function resolveGpuEffectModuleDescriptors(motion: MotionDocument, registry: ReadonlyMap<string, GpuEffectModuleRegistryEntry> | undefined, rendererIdentity: GpuEffectModuleRendererIdentity | undefined): GpuEffectModuleDescriptorResolution {
  const topology = derive(motion); if (!topology.ok) return topology;
  if (!topology.descriptors.length) return { ok: true, descriptors: freeze([]) };
  if (!registry || !rendererIdentity || gpuEffectModuleRendererIdentityProblem(rendererIdentity)) return fail("GPU effect-module resolution requires host-derived registry and current renderer identity.");
  const descriptors: GpuEffectModuleStaticDescriptor[] = [];
  for (const value of topology.descriptors) {
    const entry = registry.get(entryKey(value.moduleId, value.version)); const problem = registryProblem(entry);
    if (problem || entry?.moduleId !== value.moduleId || entry.version !== value.version || entry.state !== "active") return fail(`GPU effect module ${value.moduleId}@${value.version} is unavailable or incompatible.`, value.layerId);
    descriptors.push(descriptor(value, entry, rendererIdentity));
  }
  return { ok: true, descriptors: freeze(descriptors) };
}

/** Re-admits a static descriptor before it is bound into a frame plan. */
export function gpuEffectModuleStaticDescriptorProblem(value: unknown): string | null {
  if (!record(value, descriptorKeys) || !id(value.layerId) || !id(value.drawId) || !id(value.scopeGroupId) || !id(value.scopeGroupDrawId) || !moduleId(value.moduleId) || !isCanonicalMotionEffectModuleVersion(value.version) || !sha(value.manifestSha256) || !byteLength(value.manifestByteLength) || !sha(value.registryEntrySha256) || !sha(value.installationProvenanceSha256) || !sha(value.pipelineImplementationSha256) || value.resourceCeilingSha256 !== gpuEffectModuleResourceCeilingFingerprint() || value.intrinsic !== MOTION_AFTERIMAGE_STACK_INTRINSIC || value.rendererAbi !== GPU_EFFECT_MODULE_RENDERER_ABI || value.parameterSchema !== MOTION_AFTERIMAGE_STACK_PARAMETER_SCHEMA || !sha(value.referenceFingerprint) || !Array.isArray(value.echoes) || value.echoes.length < 1 || value.echoes.length > GPU_EFFECT_MODULE_MAX_ECHOES || !q16(value.amountQ16) || value.uniformBytes !== GPU_EFFECT_MODULE_UNIFORM_BYTES || value.textureLoadCount !== value.echoes.length + 1 || value.passCount !== GPU_EFFECT_MODULE_PASS_COUNT || value.retainedTextureCount !== GPU_EFFECT_MODULE_RETAINED_TEXTURE_COUNT || !sha(value.descriptorFingerprint)) return "contains invalid descriptor fields";
  for (const echo of value.echoes) if (!record(echo, ["dxPx", "dyPx", "rgba8", "opacityQ16"]) || !offset(echo.dxPx) || !offset(echo.dyPx) || !rgba8(echo.rgba8) || !q16(echo.opacityQ16)) return "contains an invalid lowered echo";
  return value.descriptorFingerprint === canonicalJsonSha256(descriptorPayload(value as GpuEffectModuleStaticDescriptor)) ? null : "descriptor fingerprint is not canonical";
}

/** Validates a renderer-facing immutable binding independently of the registry host. */
export function gpuEffectModuleBindingProblem(value: unknown): string | null { return bindingProblem(value); }
export function createGpuEffectModuleBinding(descriptor: GpuEffectModuleStaticDescriptor): GpuEffectModuleBinding { const problem = gpuEffectModuleStaticDescriptorProblem(descriptor); if (problem) throw new Error(`GPU effect-module descriptor ${problem}.`); return freeze({ ...descriptor, bindingFingerprint: canonicalJsonSha256(descriptor) }); }
export function gpuEffectModuleBeginUseEvidenceProblem(value: unknown): string | null { return !record(value, ["bindingFingerprint", "registryGeneration", "revocation"]) || !sha(value.bindingFingerprint) || !Number.isSafeInteger(value.registryGeneration) || value.registryGeneration < 0 || value.revocation !== "not-revoked-at-begin-use" ? "contains invalid begin-use evidence" : null; }

/** Requires exact bindings for every declared module, then exposes at most one active one. */
export function resolveGpuEffectModuleFrameBindings(motion: MotionDocument, atUs: number, descriptors: ReadonlyMap<string, GpuEffectModuleStaticDescriptor> | undefined, bindings: ReadonlyMap<string, GpuEffectModuleBinding> | undefined): { ok: true; active: GpuEffectModuleBinding | null } | GpuEffectModuleDescriptorFailure {
  if (!Number.isSafeInteger(atUs) || atUs < 0) return fail("GPU effect-module frame binding requires a non-negative safe integer atUs.");
  const topology = derive(motion); if (!topology.ok) return topology;
  if (!topology.descriptors.length) return descriptors?.size || bindings?.size ? fail("GPU effect-module frame resources must be empty when no visible module descriptor exists.") : { ok: true, active: null };
  if (!descriptors || descriptors.size !== topology.descriptors.length || !bindings || bindings.size !== topology.descriptors.length) return fail("GPU effect-module frame descriptors and bindings must cover exactly every declared module.");
  const known = new Set(topology.descriptors.map((value) => value.layerId));
  for (const key of descriptors.keys()) if (!known.has(key)) return fail("GPU effect-module frame descriptors contain an unknown layer.");
  for (const key of bindings.keys()) if (!known.has(key)) return fail("GPU effect-module frame bindings contain an unknown layer.");
  const active = activeLayers(motion, atUs, known);
  if (active.length > 1) return fail("GPU frames allow at most one semantically active effect module.");
  for (const expected of topology.descriptors) {
    const descriptor = descriptors.get(expected.layerId), binding = bindings.get(expected.layerId); const problem = gpuEffectModuleStaticDescriptorProblem(descriptor);
    if (!descriptor || !binding || problem || !sameDescriptor(expected, descriptor) || bindingProblem(binding) || canonicalJsonSha256(withoutBinding(binding)) !== canonicalJsonSha256(descriptor)) return fail(`GPU effect-module binding for ${expected.layerId} is forged or mismatched.`, expected.layerId);
  }
  return { ok: true, active: active.length ? bindings.get(active[0])! : null };
}

function derive(motion: MotionDocument): { ok: true; descriptors: readonly DerivedDescriptor[] } | GpuEffectModuleDescriptorFailure {
  const values = motion.layers; const byId = new Map(values.map((layer) => [layer.id, layer])); const owners = groupOwners(values); const descriptors: DerivedDescriptor[] = []; const occupiedDrawIds = reservedDrawIds(values);
  for (const [layerIndex, layer] of values.entries()) {
    if (!hasEffectModule(layer)) continue;
    const reference = layer.effectModule; const problem = motionEffectModuleReferenceProblem(reference); if (problem || !reference) return fail(`GPU effect module ${layer.id} ${problem ?? "is absent"}.`, layer.id);
    const owner = owners.get(layer.id); if (!owner || owner.count !== 1 || owner.children.at(-1) !== layer.id || owners.has(owner.id)) return fail(`GPU effect module ${layer.id} must be the final direct child of one non-nested isolated group.`, layer.id);
    const group = byId.get(owner.id); if (layer.visible === false || group?.visible === false) continue;
    if (!group || group.type !== "group" || !id(`${owner.id}.group`) || layer.type !== "adjustment" || !moduleAdjustmentOnly(layer)) return fail(`GPU effect module ${layer.id} has an invalid adjustment scope.`, layer.id);
    const drawId = reserveModuleDrawId(layerIndex, occupiedDrawIds); if (!drawId) return fail(`GPU effect module ${layer.id} cannot reserve a collision-free renderer draw identity.`, layer.id);
    const echoes = reference.parameters.echoes.map((echo) => ({ dxPx: echo.dxPx, dyPx: echo.dyPx, rgba8: hex(echo.color), opacityQ16: echo.opacityQ16 }));
    descriptors.push({ layerId: layer.id, drawId, scopeGroupId: owner.id, scopeGroupDrawId: `${owner.id}.group`, moduleId: reference.moduleId, version: reference.version, intrinsic: MOTION_AFTERIMAGE_STACK_INTRINSIC, rendererAbi: GPU_EFFECT_MODULE_RENDERER_ABI, parameterSchema: MOTION_AFTERIMAGE_STACK_PARAMETER_SCHEMA, referenceFingerprint: canonicalJsonSha256(reference), echoes: freeze(echoes), amountQ16: reference.parameters.amountQ16, uniformBytes: GPU_EFFECT_MODULE_UNIFORM_BYTES, textureLoadCount: echoes.length + 1, passCount: GPU_EFFECT_MODULE_PASS_COUNT, retainedTextureCount: GPU_EFFECT_MODULE_RETAINED_TEXTURE_COUNT });
  }
  const overlap = overlapping(motion, descriptors.map((value) => value.layerId)); if (overlap) return fail("GPU effect modules overlap or have an ambiguous nested/hidden scope.", overlap);
  return { ok: true, descriptors: freeze(descriptors.sort((left, right) => compareCodeUnits(left.layerId, right.layerId))) };
}

function descriptor(value: DerivedDescriptor, entry: GpuEffectModuleRegistryEntry, rendererIdentity: GpuEffectModuleRendererIdentity): GpuEffectModuleStaticDescriptor {
  const base = { ...value, manifestSha256: entry.manifestSha256, manifestByteLength: entry.manifestByteLength, registryEntrySha256: entry.registryEntrySha256, installationProvenanceSha256: entry.installationProvenanceSha256, pipelineImplementationSha256: rendererIdentity.pipelineImplementationSha256, resourceCeilingSha256: gpuEffectModuleResourceCeilingFingerprint() }; return freeze({ ...base, descriptorFingerprint: canonicalJsonSha256(descriptorPayload(base)) });
}
function descriptorPayload(value: Omit<GpuEffectModuleStaticDescriptor, "descriptorFingerprint"> | GpuEffectModuleStaticDescriptor): Omit<GpuEffectModuleStaticDescriptor, "descriptorFingerprint"> { const { descriptorFingerprint: _descriptorFingerprint, ...payload } = value as GpuEffectModuleStaticDescriptor; return payload; }
function bindingProblem(value: unknown): string | null {
  if (!record(value, [...descriptorKeys, "bindingFingerprint"]) || !sha(value.bindingFingerprint)) return "contains unknown or missing fields";
  const descriptorProblem = gpuEffectModuleStaticDescriptorProblem(withoutBinding(value));
  return descriptorProblem ?? (value.bindingFingerprint === canonicalJsonSha256(withoutBinding(value)) ? null : "binding fingerprint is not canonical");
}
const descriptorKeys = ["layerId", "drawId", "scopeGroupId", "scopeGroupDrawId", "moduleId", "version", "manifestSha256", "manifestByteLength", "registryEntrySha256", "installationProvenanceSha256", "pipelineImplementationSha256", "resourceCeilingSha256", "intrinsic", "rendererAbi", "parameterSchema", "referenceFingerprint", "echoes", "amountQ16", "uniformBytes", "textureLoadCount", "passCount", "retainedTextureCount", "descriptorFingerprint"];
function withoutBinding(value: Record<string, unknown> | GpuEffectModuleBinding): Record<string, unknown> { const { bindingFingerprint: _bindingFingerprint, ...descriptor } = value; return descriptor; }
function sameDescriptor(expected: DerivedDescriptor, binding: Pick<GpuEffectModuleStaticDescriptor, "layerId" | "drawId" | "scopeGroupId" | "scopeGroupDrawId" | "moduleId" | "version" | "intrinsic" | "rendererAbi" | "parameterSchema" | "referenceFingerprint" | "echoes" | "amountQ16" | "uniformBytes" | "textureLoadCount" | "passCount" | "retainedTextureCount">): boolean { return binding.layerId === expected.layerId && binding.drawId === expected.drawId && binding.scopeGroupId === expected.scopeGroupId && binding.scopeGroupDrawId === expected.scopeGroupDrawId && binding.moduleId === expected.moduleId && binding.version === expected.version && binding.intrinsic === expected.intrinsic && binding.rendererAbi === expected.rendererAbi && binding.parameterSchema === expected.parameterSchema && binding.referenceFingerprint === expected.referenceFingerprint && binding.amountQ16 === expected.amountQ16 && binding.uniformBytes === expected.uniformBytes && binding.textureLoadCount === expected.textureLoadCount && binding.passCount === expected.passCount && binding.retainedTextureCount === expected.retainedTextureCount && canonicalJsonSha256(binding.echoes) === canonicalJsonSha256(expected.echoes); }
function registryProblem(value: unknown): string | null { return !record(value, ["moduleId", "version", "manifestSha256", "manifestByteLength", "registryEntrySha256", "installationProvenanceSha256", "installationProvenance", "intrinsic", "rendererAbi", "parameterSchema", "state"]) || !moduleId(value.moduleId) || !isCanonicalMotionEffectModuleVersion(value.version) || !sha(value.manifestSha256) || !byteLength(value.manifestByteLength) || !sha(value.registryEntrySha256) || !sha(value.installationProvenanceSha256) || gpuEffectModuleInstallationProvenanceProblem(value.installationProvenance) || value.installationProvenance.moduleId !== value.moduleId || value.installationProvenance.version !== value.version || value.installationProvenance.manifestSha256 !== value.manifestSha256 || value.installationProvenance.manifestByteLength !== value.manifestByteLength || value.installationProvenanceSha256 !== gpuEffectModuleInstallationProvenanceFingerprint(value.installationProvenance) || value.intrinsic !== MOTION_AFTERIMAGE_STACK_INTRINSIC || value.rendererAbi !== GPU_EFFECT_MODULE_RENDERER_ABI || value.parameterSchema !== MOTION_AFTERIMAGE_STACK_PARAMETER_SCHEMA || value.registryEntrySha256 !== gpuEffectModuleRegistryEntryFingerprint(withoutRegistryEntrySha(value as GpuEffectModuleRegistryEntry)) || (value.state !== "active" && value.state !== "revoked") ? "invalid host-derived registry entry" : null; }
function activeLayers(motion: MotionDocument, atUs: number, targets: ReadonlySet<string>): string[] {
  const byId = new Map(motion.layers.map((layer) => [layer.id, layer])); const owned = new Set(motion.layers.filter((layer) => layer.type === "group").flatMap((layer) => layer.childLayerIds ?? [])); const active: string[] = [];
  const visit = (layer: MotionLayer, parentUs: number, ancestorVisible: boolean): void => { const start = us(layer.startMs), duration = us(layer.durationMs); if (start === null || duration === null || !ancestorVisible || layer.visible === false || parentUs < start || parentUs >= start + duration) return; if (layer.type === "group") for (const child of layer.childLayerIds ?? []) { const value = byId.get(child); if (value) visit(value, parentUs - start, true); } else if (targets.has(layer.id)) active.push(layer.id); };
  for (const layer of motion.layers) if (!owned.has(layer.id)) visit(layer, atUs, true);
  return active;
}
function overlapping(motion: MotionDocument, targets: readonly string[]): string | null { const byId = new Map(motion.layers.map((layer) => [layer.id, layer])); const owned = new Set(motion.layers.filter((layer) => layer.type === "group").flatMap((layer) => layer.childLayerIds ?? [])); const intervals: Array<{ layerId: string; start: number; end: number }> = []; const visit = (layer: MotionLayer, parentStart: number, parentEnd: number, visible: boolean): void => { const start = us(layer.startMs), duration = us(layer.durationMs); if (start === null || duration === null || !visible || layer.visible === false) return; const absoluteStart = parentStart + start, absoluteEnd = Math.min(parentEnd, absoluteStart + duration); if (absoluteEnd <= absoluteStart) return; if (layer.type === "group") for (const childId of layer.childLayerIds ?? []) { const child = byId.get(childId); if (child) visit(child, absoluteStart, absoluteEnd, true); } else if (targets.includes(layer.id)) intervals.push({ layerId: layer.id, start: absoluteStart, end: absoluteEnd }); }; const documentEnd = us(motion.durationMs); if (documentEnd === null) return "timeline"; for (const layer of motion.layers) if (!owned.has(layer.id)) visit(layer, 0, documentEnd, true); const events = intervals.flatMap((interval) => [{ at: interval.start, delta: 1, layerId: interval.layerId }, { at: interval.end, delta: -1, layerId: interval.layerId }]).sort((left, right) => left.at - right.at || left.delta - right.delta || compareCodeUnits(left.layerId, right.layerId)); const active = new Set<string>(); for (const event of events) { if (event.delta < 0) active.delete(event.layerId); else { active.add(event.layerId); if (active.size > 1) return [...active].sort(compareCodeUnits)[1]; } } return null; }
function groupOwners(layers: readonly (Record<string, unknown> | MotionLayer | null)[]): Map<string, { id: string; children: string[]; count: number }> { const values = new Map<string, { id: string; children: string[]; count: number }>(); for (const layer of layers) if (layer?.type === "group" && typeof layer.id === "string" && Array.isArray(layer.childLayerIds)) for (const child of layer.childLayerIds) if (typeof child === "string") { const previous = values.get(child); values.set(child, { id: String(layer.id), children: layer.childLayerIds.filter((value): value is string => typeof value === "string"), count: (previous?.count ?? 0) + 1 }); } return values; }
function moduleAdjustmentOnly(layer: MotionLayer): boolean { return Object.keys(layer).every((key) => ["id", "type", "startMs", "durationMs", "visible", "effectModule"].includes(key)); }
function entryKey(moduleId: string, version: string): string { return `${moduleId}\u0000${version}`; }
function hasEffectModule(value: object): boolean { return Object.prototype.hasOwnProperty.call(value, "effectModule"); }
/** Keep module renderer IDs disjoint from authored IDs and all fixed group/camera markers. */
function reservedDrawIds(layers: readonly MotionLayer[]): Set<string> {
  const ids = new Set<string>();
  for (const [index, layer] of layers.entries()) {
    ids.add(layer.id);
    if (layer.type === "group") { ids.add(`${layer.id}.group`); ids.add(`${layer.id}.group.end`); }
    ids.add(`camera-plane-${index}`); ids.add(`camera-plane-${index}.end`);
  }
  return ids;
}
function reserveModuleDrawId(layerIndex: number, occupied: Set<string>): string | null {
  const base = `effect-module-draw-${layerIndex}`;
  for (let suffix = 0; suffix < 2_048; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    if (id(candidate) && !occupied.has(candidate)) { occupied.add(candidate); return candidate; }
  }
  return null;
}
function record(value: unknown, keys: readonly string[]): value is Record<string, any> { const candidate = plain(value); return candidate !== null && Object.keys(candidate).length === keys.length && keys.every((key) => key in candidate); }
function plain(value: unknown): Record<string, any> | null { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) ? value as Record<string, any> : null; }
function id(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value); }
function moduleId(value: unknown): value is string { return typeof value === "string" && value.length <= 128 && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){1,7}$/.test(value); }
function digit(code: number): boolean { return code >= 48 && code <= 57; }
function semverIdentifier(code: number): boolean { return digit(code) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45; }
function displayName(value: unknown): value is string { return typeof value === "string" && value === value.trim() && value.length >= 1 && value.length <= 96 && !/[\u0000-\u001f\u007f]/.test(value); }
function offset(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= -256 && value <= 256; }
function q16(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65_535; }
function color(value: unknown): value is string { return typeof value === "string" && /^#[0-9A-F]{8}$/.test(value); }
function rgba8(value: unknown): value is readonly [number, number, number, number] { return Array.isArray(value) && value.length === 4 && value.every((channel) => typeof channel === "number" && Number.isInteger(channel) && channel >= 0 && channel <= 255); }
function hex(value: string): readonly [number, number, number, number] { return freeze([parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16), parseInt(value.slice(7, 9), 16)] as [number, number, number, number]); }
function sha(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function byteLength(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= GPU_EFFECT_MODULE_MAX_MANIFEST_BYTES; }
function isoTime(value: unknown): value is string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false; const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString() === value; }
function withoutRegistryEntrySha(value: GpuEffectModuleRegistryEntry): Omit<GpuEffectModuleRegistryEntry, "registryEntrySha256" | "state"> { const { registryEntrySha256: _registryEntrySha256, state: _state, ...entry } = value; return entry; }
function us(value: number): number | null { const result = Math.round(value * 1_000); return Number.isSafeInteger(result) && result >= 0 ? result : null; }
function fail(message: string, layerId?: string): GpuEffectModuleDescriptorFailure { return { ok: false, message, ...(layerId ? { layerId } : {}) }; }
function freeze<T>(value: T): T { if (Array.isArray(value)) for (const entry of value) freeze(entry); else if (value && typeof value === "object") for (const entry of Object.values(value as object)) freeze(entry); return Object.freeze(value); }
