import { canonicalJsonSha256 } from "./canonical-json";
import type { ArtifactReceiptAttestation } from "./artifact-handle";
import type { AttestedRenderReuseDescriptor, AttestedRenderReuseInputs, AttestedRenderReusePlan } from "./attested-render-reuse";
import { isAbsolute, win32 } from "node:path";

const SCHEMA = "shellx-motion/attested-render-reuse@2";
const SHA256 = /^[a-f0-9]{64}$/;

export function validateAttestedRenderReuseDescriptor(value: unknown): asserts value is AttestedRenderReuseDescriptor {
  const descriptor = record(value, "attested-reuse descriptor");
  if (descriptor.schema !== SCHEMA) throw new Error("unsupported attested-reuse descriptor schema");
  stringHash(descriptor.cacheKey, "attested-reuse descriptor cacheKey");
  if (typeof descriptor.id !== "string" || !/^render-reuse-[a-f0-9]{24}$/.test(descriptor.id)) throw new Error("attested-reuse descriptor id is invalid");
  validateAttestedRenderReusePlan(descriptor.plan);
  validateAttestedRenderReuseInputs(descriptor.inputs);
  if (!descriptor.artifact || typeof descriptor.artifact !== "object") throw new Error("attested-reuse descriptor artifact is invalid");
  validateAttestedRenderReuseReceipt(descriptor.sourceReceipt);
  if (!Number.isFinite(Date.parse(String(descriptor.createdAt)))) throw new Error("attested-reuse descriptor createdAt is invalid");
  const expectedKey = canonicalJsonSha256({ schema: SCHEMA, plan: descriptor.plan, inputs: descriptor.inputs });
  if (descriptor.cacheKey !== expectedKey) throw new Error("attested-reuse descriptor cacheKey is invalid");
  if (descriptor.id !== attestedRenderReuseDescriptorId({
    schema: descriptor.schema,
    cacheKey: descriptor.cacheKey,
    plan: descriptor.plan,
    inputs: descriptor.inputs,
    artifact: descriptor.artifact,
    sourceReceipt: descriptor.sourceReceipt,
    createdAt: descriptor.createdAt,
  })) {
    throw new Error("attested-reuse descriptor id does not bind its contents");
  }
}

export function validateAttestedRenderReusePlan(value: unknown): asserts value is AttestedRenderReusePlan {
  const plan = record(value, "attested-reuse plan");
  const allowed = new Set(["schema", "outputRootRelativePath", "preset", "frameLane", "engineVersion", "atMs", "minUniqueFrameHashes", "workflow", "qualityManifest"]);
  if (Object.keys(plan).some((key) => !allowed.has(key))) throw new Error("attested-reuse plan contains unsupported fields");
  if (plan.schema !== "shellx-motion/attested-render-plan@2") throw new Error("unsupported attested-reuse plan schema");
  canonicalRelativePath(plan.outputRootRelativePath, "attested-reuse plan output path");
  if (typeof plan.preset !== "string" || !plan.preset) throw new Error("attested-reuse plan preset is invalid");
  if (plan.frameLane !== "browser" && plan.frameLane !== "native") throw new Error("attested-reuse plan frameLane is invalid");
  if (typeof plan.engineVersion !== "string" || !plan.engineVersion) throw new Error("attested-reuse plan engineVersion is invalid");
  if (plan.atMs !== undefined && (!Number.isFinite(plan.atMs) || plan.atMs < 0)) throw new Error("attested-reuse plan atMs is invalid");
  if (plan.minUniqueFrameHashes !== undefined && (!Number.isSafeInteger(plan.minUniqueFrameHashes) || plan.minUniqueFrameHashes < 1)) throw new Error("attested-reuse plan minUniqueFrameHashes is invalid");
  if (plan.workflow !== "none" && plan.workflow !== "inline" && plan.workflow !== "path") throw new Error("attested-reuse plan workflow is invalid");
  if (typeof plan.qualityManifest !== "boolean") throw new Error("attested-reuse plan qualityManifest is invalid");
}

export function validateAttestedRenderReuseInputs(value: unknown): asserts value is AttestedRenderReuseInputs {
  const inputs = record(value, "attested-reuse inputs");
  const allowed = new Set(["schema", "packageSha256", "workflowSha256", "workflowPathSha256", "qualityManifestSha256", "qualityBaselinesSha256"]);
  if (Object.keys(inputs).some((key) => !allowed.has(key))) throw new Error("attested-reuse inputs contain unsupported fields");
  if (inputs.schema !== "shellx-motion/attested-render-inputs@2") throw new Error("unsupported attested-reuse inputs schema");
  stringHash(inputs.packageSha256, "attested-reuse packageSha256");
  if (inputs.workflowSha256 !== undefined) stringHash(inputs.workflowSha256, "attested-reuse workflowSha256");
  if (inputs.workflowPathSha256 !== undefined) stringHash(inputs.workflowPathSha256, "attested-reuse workflowPathSha256");
  if (inputs.qualityManifestSha256 !== undefined) stringHash(inputs.qualityManifestSha256, "attested-reuse qualityManifestSha256");
  if (inputs.qualityBaselinesSha256 !== undefined) stringHash(inputs.qualityBaselinesSha256, "attested-reuse qualityBaselinesSha256");
  if ((inputs.qualityManifestSha256 === undefined) !== (inputs.qualityBaselinesSha256 === undefined)) throw new Error("attested-reuse quality manifest and baseline inputs must be bound together");
}

export function attestedRenderReuseDescriptorId(value: Omit<AttestedRenderReuseDescriptor, "id">): string {
  return `render-reuse-${canonicalJsonSha256(value).slice(0, 24)}`;
}

export function validateAttestedRenderReuseReceipt(value: unknown): asserts value is ArtifactReceiptAttestation {
  const receipt = record(value, "attested-reuse source receipt");
  const allowed = new Set(["role", "id", "operation", "status", "rootRelativePath", "sha256"]);
  if (Object.keys(receipt).some((key) => !allowed.has(key))) throw new Error("attested-reuse source receipt contains unsupported fields");
  if (receipt.role !== "render" || typeof receipt.id !== "string" || !receipt.id || typeof receipt.operation !== "string" || !receipt.operation
    || (receipt.status !== "passed" && receipt.status !== "warning")) throw new Error("attested-reuse source receipt is invalid");
  canonicalRelativePath(receipt.rootRelativePath, "attested-reuse source receipt path");
  stringHash(receipt.sha256, "attested-reuse source receipt sha256");
}

function canonicalRelativePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value || isAbsolute(value) || win32.isAbsolute(value) || value.includes("\\")
    || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`${label} must be canonical and root-relative`);
}

function stringHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
}

function record(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, any>;
}
