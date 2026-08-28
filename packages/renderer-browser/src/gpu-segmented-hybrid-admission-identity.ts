import { createHash } from "node:crypto";
import { canonicalJsonSha256, gpuHybridTextureSourceSnapshotProblem, gpuHybridTextureStaticDescriptorProblem } from "@shellx-motion/core";
import type { GpuSegmentedHybridAdmissionIdentity, GpuSegmentedHybridBrowserPreparation } from "./gpu-segmented-hybrid-types";

export const GPU_SEGMENTED_HYBRID_CAPTURE_CONTRACT_SCHEMA = "shellx-motion/gpu-segmented-hybrid-capture-contract@1" as const;

export function gpuSegmentedHybridCaptureContractSha256(input: {
  readonly staticPlanFingerprint: string;
  readonly descriptor: GpuSegmentedHybridAdmissionIdentity["descriptor"];
  readonly sourceSnapshotSha256: string;
  readonly sourceByteLength: number;
  readonly browser: GpuSegmentedHybridBrowserPreparation;
  readonly policy: GpuSegmentedHybridAdmissionIdentity["policy"];
}): string {
  return canonicalJsonSha256({
    schema: GPU_SEGMENTED_HYBRID_CAPTURE_CONTRACT_SCHEMA,
    staticPlanFingerprint: input.staticPlanFingerprint,
    descriptorFingerprint: input.descriptor.descriptorFingerprint,
    sourceSnapshotSha256: input.sourceSnapshotSha256,
    sourceByteLength: input.sourceByteLength,
    browser: input.browser,
    policy: input.policy,
  });
}

/** Browser-owned durable identity validation; FFmpeg may only add store cross-relations. */
export function gpuSegmentedHybridAdmissionIdentityProblem(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "is not an object";
  const identity = value as GpuSegmentedHybridAdmissionIdentity;
  if (identity.schema !== "shellx-motion/gpu-segmented-hybrid-admission@1" || !sha(identity.staticPlanFingerprint)) return "has an invalid schema or static plan fingerprint";
  if (gpuHybridTextureStaticDescriptorProblem(identity.descriptor)) return "has an invalid Core static descriptor";
  if (!identity.browser || identity.browser.name !== "chromium" || !sha(identity.browser.executableSha256) || !nonEmpty(identity.browser.version) || identity.browser.runtimePolicy !== "borrowed-precontained-chromium-data-only-no-network") return "has an invalid browser identity";
  const policy = identity.policy;
  if (!policy || policy.scripts !== "data-only-none" || policy.network !== "no-egress" || policy.capture !== "one-borrowed-browser-context-per-bootstrap-or-range" || (identity.descriptor.producer === "strict-data-only-html" ? policy.htmlClosure !== "primary-self-contained" : policy.htmlClosure !== "not-applicable-restricted-glsl")) return "has an invalid strict capture policy";
  if (gpuHybridTextureSourceSnapshotProblem(identity.sourceSnapshot)) return "has an invalid Core source snapshot";
  if (identity.sourceSnapshot.layerId !== identity.descriptor.layerId || identity.sourceSnapshot.producer !== identity.descriptor.producer || identity.sourceSnapshot.assetRef !== identity.descriptor.assetRef || identity.sourceSnapshot.width !== identity.descriptor.width || identity.sourceSnapshot.height !== identity.descriptor.height || identity.sourceSnapshot.staticDescriptorFingerprint !== identity.descriptor.descriptorFingerprint || identity.sourceSnapshot.captureContractSha256 !== identity.captureContractSha256) return "source snapshot does not bind the descriptor and capture contract";
  const browser: GpuSegmentedHybridBrowserPreparation = { name: identity.browser.name, executableSha256: identity.browser.executableSha256, runtimePolicy: identity.browser.runtimePolicy };
  if (!sha(identity.captureContractSha256) || identity.captureContractSha256 !== gpuSegmentedHybridCaptureContractSha256({ staticPlanFingerprint: identity.staticPlanFingerprint, descriptor: identity.descriptor, sourceSnapshotSha256: identity.sourceSnapshot.sourceSnapshotSha256, sourceByteLength: identity.sourceSnapshot.sourceByteLength, browser, policy })) return "capture contract hash is not canonical";
  const dynamic = identity.dynamicTexture;
  const expectedId = `hybrid-${createHash("sha256").update(identity.descriptor.descriptorFingerprint).digest("hex").slice(0, 24)}`;
  const bytes = identity.descriptor.width * identity.descriptor.height * 4;
  if (!dynamic || dynamic.id !== expectedId || dynamic.width !== identity.descriptor.width || dynamic.height !== identity.descriptor.height || dynamic.bytes !== bytes || dynamic.sourceSha256 !== identity.captureContractSha256 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 256 * 1024 * 1024) return "dynamic texture reservation is not exact and bounded";
  const bootstrap = identity.bootstrap;
  if (!bootstrap || !Number.isSafeInteger(bootstrap.index) || bootstrap.index < 0 || !Number.isFinite(bootstrap.atMs) || !Number.isSafeInteger(bootstrap.atUs) || Math.round(bootstrap.atMs * 1_000) !== bootstrap.atUs || !sha(bootstrap.requestFingerprint) || bootstrap.resourceId !== dynamic.id || bootstrap.width !== dynamic.width || bootstrap.height !== dynamic.height || !sha(bootstrap.pngSha256) || !sha(bootstrap.decodedRgbaSha256) || !bootstrap.cleanup || bootstrap.cleanup.captureContext !== "closed" || bootstrap.cleanup.scratch !== "released" || bootstrap.cleanup.dynamicTexture.id !== dynamic.id || bootstrap.cleanup.dynamicTexture.width !== dynamic.width || bootstrap.cleanup.dynamicTexture.height !== dynamic.height || bootstrap.cleanup.dynamicTexture.sourceSha256 !== dynamic.sourceSha256) return "bootstrap record is incomplete or does not bind the reserved texture cleanup";
  return null;
}

function sha(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256; }
