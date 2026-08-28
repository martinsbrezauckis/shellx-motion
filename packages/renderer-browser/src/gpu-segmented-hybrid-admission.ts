import { createHash } from "node:crypto";
import {
  compileGpuSceneStaticPlan,
  createGpuHybridTextureSourceSnapshot,
  deriveGpuHybridTextureStaticDescriptor,
  readVerifiedPackageAsset,
  resolvePackageAsset,
  validateRestrictedFragmentShader,
  type GpuHybridTextureStaticDescriptor,
  type MotionLayer,
  type MotionPackage,
} from "@shellx-motion/core";
import { createBrowserPackageFulfillment } from "./browser-package-fulfillment";
import { admitGpuSegmentedHybridSelfContainedDocument } from "./gpu-browser-hybrid-html-policy";
import { gpuSegmentedHybridCaptureContractSha256 } from "./gpu-segmented-hybrid-admission-identity";
import {
  GpuSegmentedHybridPreparation,
  type GpuSegmentedHybridPreparationIdentity,
  type GpuSegmentedHybridAdmissionInput,
} from "./gpu-segmented-hybrid-types";

interface SegmentedHybridPrivateState {
  readonly packageTemplate: MotionPackage;
  readonly layer: MotionLayer;
  readonly sourceBytes: Buffer;
  readonly sourceFileName: "source.html" | "source.glsl";
}

const admissionState = new WeakMap<object, SegmentedHybridPrivateState>();

/**
 * Pre-store admission for exactly one frozen browser-produced texture.  The
 * returned opaque handle retains source bytes, never a live package root.
 */
export async function prepareGpuSegmentedHybridAdmission(
  input: GpuSegmentedHybridAdmissionInput
): Promise<GpuSegmentedHybridPreparation> {
  assertBrowserIdentity(input.browser);
  const recomputed = compileGpuSceneStaticPlan(input.pkg.motion);
  if (!recomputed.ok) throw new Error(`GPU segmented hybrid admission Core static planning failed: ${recomputed.failure.message}`);
  if (input.staticPlan.fingerprint !== recomputed.plan.fingerprint) {
    throw new Error("GPU segmented hybrid admission refuses a stale or forged Core static plan fingerprint.");
  }
  const descriptors = recomputed.plan.hybridTextures ?? [];
  if (descriptors.length !== 1) throw new Error("GPU segmented hybrid admission requires exactly one strict HTML/web/canvas or restricted GLSL static descriptor.");
  const descriptor = descriptors[0];
  const layer = input.pkg.motion.layers.find((candidate) => candidate.id === descriptor.layerId && candidate.visible !== false);
  const rederived = layer ? deriveGpuHybridTextureStaticDescriptor(input.pkg.motion, layer) : null;
  if (!layer || !rederived || rederived.descriptorFingerprint !== descriptor.descriptorFingerprint) {
    throw new Error("GPU segmented hybrid admission static descriptor no longer binds one visible Core layer.");
  }
  assertStaticPlanDescriptor(input.staticPlan.fingerprint, input.staticPlan.hybridTextures ?? [], descriptor);
  const source = await freezeSegmentedHybridSource(input, layer, descriptor);
  const policy = Object.freeze({ scripts: "data-only-none" as const, network: "no-egress" as const, htmlClosure: descriptor.producer === "strict-data-only-html" ? "primary-self-contained" as const : "not-applicable-restricted-glsl" as const, capture: "one-borrowed-browser-context-per-bootstrap-or-range" as const });
  const captureContractSha256 = gpuSegmentedHybridCaptureContractSha256({ staticPlanFingerprint: input.staticPlan.fingerprint, descriptor, sourceSnapshotSha256: source.sha256, sourceByteLength: source.bytes.byteLength, browser: input.browser, policy });
  const sourceSnapshot = createGpuHybridTextureSourceSnapshot({
    descriptor,
    sourceSnapshotSha256: source.sha256,
    sourceByteLength: source.bytes.byteLength,
    captureContractSha256
  });
  const bytes = descriptor.width * descriptor.height * 4;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 256 * 1024 * 1024) {
    throw new Error("GPU segmented hybrid admission texture exceeds the fixed dynamic-image budget.");
  }
  const textureId = `hybrid-${createHash("sha256").update(descriptor.descriptorFingerprint).digest("hex").slice(0, 24)}`;
  const dynamicTexture = Object.freeze({ id: textureId, width: descriptor.width, height: descriptor.height, sourceSha256: captureContractSha256 });
  const identity: GpuSegmentedHybridPreparationIdentity = Object.freeze({
    schema: "shellx-motion/gpu-segmented-hybrid-preparation@1",
    staticPlanFingerprint: input.staticPlan.fingerprint,
    descriptor: Object.freeze({ ...descriptor, ...(descriptor.restrictedShader ? { restrictedShader: Object.freeze({ ...descriptor.restrictedShader, uniformNames: Object.freeze([...descriptor.restrictedShader.uniformNames]) }) } : {}) }),
    sourceSnapshot,
    captureContractSha256,
    browser: Object.freeze({ ...input.browser }),
    dynamicTexture: Object.freeze({ ...dynamicTexture, bytes }),
    policy
  });
  const preparation = new GpuSegmentedHybridPreparation(identity, dynamicTexture);
  admissionState.set(preparation, Object.freeze({
    packageTemplate: structuredClone(input.pkg),
    layer: structuredClone(layer), sourceBytes: Buffer.from(source.bytes), sourceFileName: descriptor.producer === "strict-data-only-html" ? "source.html" : "source.glsl"
  } satisfies SegmentedHybridPrivateState));
  return preparation;
}

export function gpuSegmentedHybridPrivateState(admission: object): SegmentedHybridPrivateState {
  const state = admissionState.get(admission);
  if (!state || !Buffer.isBuffer(state.sourceBytes)) {
    throw new Error("GPU segmented hybrid admission lost its browser-owned source state.");
  }
  return state;
}

/** Internal transfer only: the finalized opaque admission retains these frozen bytes. */
export function bindGpuSegmentedHybridPrivateState(target: object, source: object): void {
  const state = gpuSegmentedHybridPrivateState(source);
  admissionState.set(target, state);
}

async function freezeSegmentedHybridSource(
  input: GpuSegmentedHybridAdmissionInput,
  layer: MotionLayer,
  descriptor: GpuHybridTextureStaticDescriptor
): Promise<{ bytes: Buffer; sha256: string }> {
  if (descriptor.producer === "strict-data-only-html") {
    const fulfillment = await createBrowserPackageFulfillment(input.pkg.root);
    const source = await admitGpuSegmentedHybridSelfContainedDocument({
      source: descriptor.assetRef,
      sourcePath: resolvePackageAsset(input.pkg, descriptor.assetRef),
      fulfillment
    });
    if (source.source !== descriptor.assetRef || source.sourceSha256 !== createHash("sha256").update(source.bytes).digest("hex")) {
      throw new Error("GPU segmented hybrid HTML admission lost its exact frozen primary source identity.");
    }
    return { bytes: Buffer.from(source.bytes), sha256: source.sourceSha256 };
  }
  const source = await readVerifiedPackageAsset(input.pkg, descriptor.assetRef, {
    label: `GPU segmented restricted shader ${layer.id}`,
    maxBytes: 16 * 1024
  });
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
  } catch {
    throw new Error("GPU segmented restricted shader admission requires canonical UTF-8 source bytes.");
  }
  const validation = validateRestrictedFragmentShader(text, [...(descriptor.restrictedShader?.uniformNames ?? [])]);
  if (!validation.ok) throw new Error(`GPU segmented restricted shader source was refused: ${validation.errors.join("; ")}`);
  return { bytes: Buffer.from(source.bytes), sha256: source.sha256 };
}

function assertStaticPlanDescriptor(
  fingerprint: unknown,
  descriptors: readonly GpuHybridTextureStaticDescriptor[],
  expected: GpuHybridTextureStaticDescriptor
): void {
  if (!isSha256(fingerprint) || !Array.isArray(descriptors) || descriptors.length !== 1) {
    throw new Error("GPU segmented hybrid admission requires one Core static-plan hybrid texture descriptor before store opening.");
  }
  const actual = descriptors[0];
  if (!actual || actual.descriptorFingerprint !== expected.descriptorFingerprint || actual.layerId !== expected.layerId || actual.producer !== expected.producer || actual.assetRef !== expected.assetRef || actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error("GPU segmented hybrid admission static plan does not bind the exact Core hybrid descriptor.");
  }
}

function assertBrowserIdentity(value: unknown): asserts value is GpuSegmentedHybridAdmissionInput["browser"] {
  if (!value || typeof value !== "object") throw new Error("GPU segmented hybrid admission requires a host-attested Chromium identity.");
  const identity = value as Record<string, unknown>;
  if (identity.name !== "chromium" || !isSha256(identity.executableSha256) || identity.runtimePolicy !== "borrowed-precontained-chromium-data-only-no-network") {
    throw new Error("GPU segmented hybrid admission browser identity is incomplete or not host-attested.");
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
