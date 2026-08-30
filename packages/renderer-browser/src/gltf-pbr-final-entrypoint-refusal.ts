import type { MotionPackage } from "@shellx-motion/core";

export type GltfPbrFinalUnsupportedEntrypoint = "browser-preview" | "gpu-preview";

export interface GltfPbrFinalEntrypointRefusal {
  readonly code: "gltf_pbr_final_direct_final_only";
  readonly message: string;
}

/**
 * Marker presence is enough to exclude generic rendering. Its records are untrusted until the
 * direct-final resolver reopens and cross-binds them, so no generic resource may be prepared.
 */
export function gltfPbrFinalEntrypointRefusal(
  pkg: MotionPackage,
  entrypoint: GltfPbrFinalUnsupportedEntrypoint,
): GltfPbrFinalEntrypointRefusal | undefined {
  const marker = descriptorSafeMarkerPresence(pkg);
  if (marker === "absent") return undefined;
  return marker === "present"
    ? gltfPbrFinalPresentMarkerRefusal(entrypoint)
    : gltfPbrFinalUnsafeMarkerRefusal(entrypoint);
}

/** Creates the one generic-entrypoint refusal after a caller has safely established marker presence. */
export function gltfPbrFinalPresentMarkerRefusal(
  entrypoint: GltfPbrFinalUnsupportedEntrypoint,
): GltfPbrFinalEntrypointRefusal {
  return Object.freeze({
    code: "gltf_pbr_final_direct_final_only",
    message: `The marked glTF PBR package refuses ${entrypoint}; only the authenticated 1280x720 static GPU direct-final lane is admitted.`,
  });
}

/**
 * Generic routes cannot establish the direct-final marker by evaluating package metadata. An
 * accessor, inherited field, or failed reflection is therefore a closed refusal, not a reason to
 * continue into Motion, resource, or output work.
 */
function gltfPbrFinalUnsafeMarkerRefusal(entrypoint: GltfPbrFinalUnsupportedEntrypoint): GltfPbrFinalEntrypointRefusal {
  return Object.freeze({
    code: "gltf_pbr_final_direct_final_only",
    message: `The ${entrypoint} generic route refuses a descriptor-unsafe glTF PBR marker path; only the authenticated 1280x720 static GPU direct-final lane may establish it.`,
  });
}

/**
 * Inspect the marker path without invoking package, manifest, data, adapter, or marker getters.
 * A marker accessor counts as present: its value is untrusted either way, and generic rendering
 * has no route that may continue past that authority.
 */
function descriptorSafeMarkerPresence(pkg: MotionPackage): "absent" | "present" | "unsafe" {
  const manifest = ownDataRecord(pkg, "manifest");
  if (manifest.kind !== "record") return "unsafe";
  const data = ownDataRecord(manifest.value, "data", true);
  if (data.kind === "absent") return "absent";
  if (data.kind !== "record") return data.kind === "non-record" ? "absent" : "unsafe";
  const adapter = ownDataRecord(data.value, "adapter", true);
  if (adapter.kind === "absent") return "absent";
  if (adapter.kind !== "record") return adapter.kind === "non-record" ? "absent" : "unsafe";
  const marker = ownDescriptor(adapter.value, "scene3dGltfPbrFinal");
  return marker === undefined ? "absent" : marker === null ? "unsafe" : "present";
}

type OwnDataRecordResult =
  | { kind: "absent" }
  | { kind: "record"; value: Record<string, unknown> }
  | { kind: "non-record" }
  | { kind: "unsafe" };

function ownDataRecord(value: object, key: string, optional = false): OwnDataRecordResult {
  const descriptor = ownDescriptor(value, key);
  if (descriptor === null) return { kind: "unsafe" };
  if (descriptor === undefined) return optional ? { kind: "absent" } : { kind: "unsafe" };
  if (!("value" in descriptor)) return { kind: "unsafe" };
  const record = plainRecord(descriptor.value);
  return record === undefined ? { kind: "unsafe" } : record === false ? { kind: "non-record" } : { kind: "record", value: record };
}

function ownDescriptor(value: object, key: string): PropertyDescriptor | undefined | null {
  try { return Object.getOwnPropertyDescriptor(value, key); }
  catch { return null; }
}

function plainRecord(value: unknown): Record<string, unknown> | false | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    return Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : false;
  } catch {
    return undefined;
  }
}

export class GltfPbrFinalEntrypointError extends Error {
  readonly code = "gltf_pbr_final_direct_final_only" as const;

  constructor(refusal: GltfPbrFinalEntrypointRefusal) {
    super(refusal.message);
    this.name = "GltfPbrFinalEntrypointError";
  }
}
