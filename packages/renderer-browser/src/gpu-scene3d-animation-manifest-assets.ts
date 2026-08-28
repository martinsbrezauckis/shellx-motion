import type { MotionPackage } from "@shellx-motion/core";
import { gltfPbrFinalPresentMarkerRefusal, type GltfPbrFinalEntrypointRefusal } from "./gltf-pbr-final-entrypoint-refusal";

/**
 * O6 is asset-free across both document authorities. This deliberately reflects the package and
 * manifest descriptors instead of evaluating either `manifest` or `manifest.assets`: an accessor,
 * inherited value, reflection failure, or anything other than an own empty data-array is hostile.
 */
export function gpuScene3dAnimationManifestAssetRefusal(pkg: MotionPackage): { code: "gpu_unsupported_feature"; message: string } | undefined {
  let manifestDescriptor: PropertyDescriptor | undefined;
  try { manifestDescriptor = Object.getOwnPropertyDescriptor(pkg, "manifest"); }
  catch { return refusal(); }
  if (!manifestDescriptor || !("value" in manifestDescriptor) || typeof manifestDescriptor.value !== "object" || manifestDescriptor.value === null || Array.isArray(manifestDescriptor.value)) {
    return refusal();
  }
  let assetsDescriptor: PropertyDescriptor | undefined;
  try { assetsDescriptor = Object.getOwnPropertyDescriptor(manifestDescriptor.value, "assets"); }
  catch { return refusal(); }
  if (!assetsDescriptor || !("value" in assetsDescriptor) || !Array.isArray(assetsDescriptor.value)) return refusal();
  let lengthDescriptor: PropertyDescriptor | undefined;
  try { lengthDescriptor = Object.getOwnPropertyDescriptor(assetsDescriptor.value, "length"); }
  catch { return refusal(); }
  if (!lengthDescriptor || !("value" in lengthDescriptor) || lengthDescriptor.value !== 0) return refusal();
  return undefined;
}

/**
 * O6 cannot send an arbitrary manifest through the legacy marker probe: that probe reads
 * `manifest.data.adapter`. Inspect its exact presence path as descriptors instead, so hostile
 * data, adapter, or marker accessors refuse before hashing, resources, runtime, or output work.
 */
export function gpuScene3dAnimationManifestPbrRefusal(
  pkg: MotionPackage,
): { code: "gpu_unsupported_feature"; message: string } | GltfPbrFinalEntrypointRefusal | undefined {
  let manifestDescriptor: PropertyDescriptor | undefined;
  try { manifestDescriptor = Object.getOwnPropertyDescriptor(pkg, "manifest"); }
  catch { return pbrDescriptorRefusal(); }
  if (!manifestDescriptor || !("value" in manifestDescriptor) || recordState(manifestDescriptor.value) !== "record") return pbrDescriptorRefusal();

  const data = ownDescriptor(manifestDescriptor.value, "data");
  if (data === null) return pbrDescriptorRefusal();
  if (!data) return undefined;
  if (!("value" in data)) return pbrDescriptorRefusal();
  const dataRecord = recordState(data.value);
  if (dataRecord === "hostile") return pbrDescriptorRefusal();
  if (dataRecord !== "record") return undefined;

  const adapter = ownDescriptor(data.value, "adapter");
  if (adapter === null) return pbrDescriptorRefusal();
  if (!adapter) return undefined;
  if (!("value" in adapter)) return pbrDescriptorRefusal();
  const adapterRecord = recordState(adapter.value);
  if (adapterRecord === "hostile") return pbrDescriptorRefusal();
  if (adapterRecord !== "record") return undefined;

  const marker = ownDescriptor(adapter.value, "scene3dGltfPbrFinal");
  if (marker === null) return pbrDescriptorRefusal();
  return marker ? gltfPbrFinalPresentMarkerRefusal("gpu-preview") : undefined;
}

function ownDescriptor(value: object, key: string): PropertyDescriptor | undefined | null {
  try { return Object.getOwnPropertyDescriptor(value, key); }
  catch { return null; }
}

function recordState(value: unknown): "record" | "not-record" | "hostile" {
  if (typeof value !== "object" || value === null) return "not-record";
  try { return !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype ? "record" : "not-record"; }
  catch { return "hostile"; }
}

function refusal(): { code: "gpu_unsupported_feature"; message: string } {
  return {
    code: "gpu_unsupported_feature",
    message: "The strict O6 GPU preview lowerer requires an own descriptor-safe empty package manifest.assets array before manifest hashing, resource preparation, runtime opening, or output work.",
  };
}

function pbrDescriptorRefusal(): { code: "gpu_unsupported_feature"; message: string } {
  return {
    code: "gpu_unsupported_feature",
    message: "The strict O6 GPU preview lowerer requires descriptor-safe package manifest.data and manifest.data.adapter marker fields before manifest hashing, resource preparation, runtime opening, or output work.",
  };
}
