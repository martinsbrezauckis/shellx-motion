/** Private V25-C1 local-effect registry vocabulary. No package or wire input carries these types. */

export const EFFECT_MODULE_MANIFEST_SCHEMA = "shellx-motion/effect-module-manifest@1" as const;
export const EFFECT_MODULE_REGISTRY_SCHEMA = "shellx-motion/effect-module-registry@1" as const;
export const EFFECT_MODULE_INTRINSIC = "motion.afterimage-stack.v1" as const;
export const EFFECT_MODULE_RENDERER_ABI = "shellx-motion/gpu-effect-module@1" as const;
export const EFFECT_MODULE_PARAMETER_SCHEMA = "motion.afterimage-stack.parameters@1" as const;

export interface EffectModuleManifest {
  schema: typeof EFFECT_MODULE_MANIFEST_SCHEMA;
  moduleId: string;
  version: string;
  displayName: string;
  intrinsic: typeof EFFECT_MODULE_INTRINSIC;
  rendererAbi: typeof EFFECT_MODULE_RENDERER_ABI;
  parameterSchema: typeof EFFECT_MODULE_PARAMETER_SCHEMA;
}

export interface EffectModuleRegistryEntry {
  moduleId: string;
  version: string;
  manifestSha256: string;
  manifestByteLength: number;
  /** Hash of the immutable stored entry facts (never a random lease token). */
  registryEntrySha256: string;
  /** Hash of the host-derived installation provenance facts, with no source path. */
  installationProvenanceSha256: string;
  installationProvenance: {
    schema: "shellx-motion/effect-module-installation-provenance@1";
    moduleId: string;
    version: string;
    manifestSha256: string;
    manifestByteLength: number;
    installedAt: string;
    authority: "workbench-operator";
  };
  displayName: string;
  intrinsic: typeof EFFECT_MODULE_INTRINSIC;
  rendererAbi: typeof EFFECT_MODULE_RENDERER_ABI;
  parameterSchema: typeof EFFECT_MODULE_PARAMETER_SCHEMA;
  installedAt: string;
  revokedAt?: string;
}

export interface EffectModuleRegistrySnapshot {
  schema: typeof EFFECT_MODULE_REGISTRY_SCHEMA;
  generation: number;
  entries: readonly EffectModuleRegistryEntry[];
}

/** Publicly safe manager projection; it intentionally omits registry and blob paths. */
export interface EffectModuleRegistrySummary extends EffectModuleRegistryEntry {}

export interface EffectModuleInstallResult {
  entry: EffectModuleRegistrySummary;
  generation: number;
  idempotent: boolean;
}

/** Opaque one-shot confirmation created only after a native Workbench picker admits a source. */
export interface EffectModulePendingInstall {
  confirmationId: string;
  moduleId: string;
  version: string;
  displayName: string;
  manifestSha256: string;
  manifestByteLength: number;
  intrinsic: typeof EFFECT_MODULE_INTRINSIC;
  rendererAbi: typeof EFFECT_MODULE_RENDERER_ABI;
  parameterSchema: typeof EFFECT_MODULE_PARAMETER_SCHEMA;
}

export interface EffectModuleUseLease {
  readonly moduleId: string;
  readonly version: string;
  readonly manifestSha256: string;
  readonly manifestByteLength: number;
  readonly registryEntrySha256: string;
  readonly installationProvenanceSha256: string;
  readonly intrinsic: typeof EFFECT_MODULE_INTRINSIC;
  readonly rendererAbi: typeof EFFECT_MODULE_RENDERER_ABI;
  readonly parameterSchema: typeof EFFECT_MODULE_PARAMETER_SCHEMA;
  readonly registryGeneration: number;
  readonly notRevokedAtBeginUse: true;
  release(): Promise<{ released: boolean }>;
}

export interface EffectModuleRegistryAuthority {
  /** This path is accepted only from the host-native Workbench picker, never a package or RPC body. */
  prepareInstallFromManifestFile(path: string): Promise<EffectModulePendingInstall>;
  /** Consumes its opaque confirmation before attempting publication; retries are therefore refused. */
  confirmInstall(confirmationId: string): Promise<EffectModuleInstallResult>;
  /** Explicitly discards a frozen pending candidate; an absent/expired id is harmlessly false. */
  cancelInstall(confirmationId: string): Promise<{ cancelled: boolean }>;
  /** Cancels all process-local pending bytes; server shutdown calls this before releasing the host. */
  close(): Promise<{ closed: boolean; cancelledPending: number }>;
  list(): Promise<readonly EffectModuleRegistrySummary[]>;
  inspect(moduleId: string, version: string): Promise<EffectModuleRegistrySummary | null>;
  revoke(moduleId: string, version: string): Promise<{ entry: EffectModuleRegistrySummary; generation: number; changed: boolean }>;
  beginUse(moduleId: string, version: string): Promise<EffectModuleUseLease>;
}

export class EffectModuleRegistryError extends Error {
  constructor(message: string, readonly code:
    | "invalid_manifest"
    | "immutable_conflict"
    | "capacity_exceeded"
    | "not_installed"
    | "revoked"
    | "pending_not_found"
    | "pending_full"
    | "closed"
    | "private_state_invalid"
    | "private_state_busy"
    | "private_state_changed") {
    super(message);
    this.name = "EffectModuleRegistryError";
    Object.setPrototypeOf(this, EffectModuleRegistryError.prototype);
  }
}
