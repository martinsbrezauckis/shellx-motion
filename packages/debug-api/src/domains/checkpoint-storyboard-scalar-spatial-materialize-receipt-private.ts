/** Private C6B1b receipt representation and exclusive staged publication. */

import { join } from "node:path";
import {
  canonicalJson,
  canonicalJsonSha256,
  compareCodeUnits,
  readBoundedStableFile,
  writeVerifiedBoundedFile,
} from "@shellx-motion/core";
import {
  CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_MATERIALIZER_PROFILE,
  type CheckpointStoryboardScalarSpatialMaterializationProjection,
} from "@shellx-motion/core/internal/checkpoint-storyboard-scalar-spatial-materializer";
import { PackageEditTransactionError } from "./package-edit-transaction.js";

export const C6B1B_RECEIPT_PATH = "receipts/checkpoint-storyboard-scalar-spatial-materialization.v1.json";
const MAX_RECEIPT_BYTES = 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;

export interface C6B1bInventory {
  readonly sha256: string;
  readonly entryCount: number;
  readonly leafCount: number;
}

export interface C6B1bExactBase {
  readonly packageId: string;
  readonly manifestRawSha256: string;
  readonly motionRawSha256: string;
  readonly manifestCanonicalSha256: string;
  readonly motionCanonicalSha256: string;
  readonly inventory: C6B1bInventory;
  readonly c6aPlanFingerprint: string;
  readonly c6b1bProfileFingerprint: string;
  readonly c6b1bProjectionFingerprint: string;
}

export interface CheckpointStoryboardScalarSpatialMaterializationReceipt {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-scalar-spatial-materialization-receipt@1";
  readonly operation: "checkpoint-storyboard.scalar-spatial.materialize";
  readonly status: "passed";
  readonly approval: { readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number }; readonly c6aPlanFingerprint: string; readonly c6aLowererProfileFingerprint: string; readonly c6b1bProfileFingerprint: string; readonly c6b1bProjectionFingerprint: string };
  readonly base: { readonly expected: C6B1bExactBase; readonly reopened: C6B1bExactBase };
  readonly output: { readonly packageId: string; readonly manifestRawSha256: string; readonly motionRawSha256: string; readonly canonicalMotionSha256: string; readonly nonReceiptInventory: C6B1bInventory; readonly preservedLeaves: { readonly sha256: string; readonly count: number }; readonly changed: { readonly paths: readonly string[]; readonly count: 2; readonly motionPropertyPaths: readonly string[]; readonly motionPropertyPathCount: number } };
  readonly transaction: { readonly cow: "closed-inventory-finalize-after-edit"; readonly installed: true; readonly exclusiveReceipt: true; readonly workspaceCleanup: "completed" };
  readonly renderer: { readonly invoked: false };
  readonly fingerprint: string;
}

export function approvedC6B1bBase(base: C6B1bExactBase, plan: any, projection: CheckpointStoryboardScalarSpatialMaterializationProjection): C6B1bExactBase {
  return Object.freeze({ ...base, c6aPlanFingerprint: plan.fingerprint, c6b1bProfileFingerprint: CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_MATERIALIZER_PROFILE.fingerprint, c6b1bProjectionFingerprint: projection.fingerprint });
}

export function createC6B1bReceipt(plan: any, projection: CheckpointStoryboardScalarSpatialMaterializationProjection, source: C6B1bExactBase, output: C6B1bExactBase, motionPath: string, nonReceiptInventory: C6B1bInventory, preserved: { sha256: string; count: number }): CheckpointStoryboardScalarSpatialMaterializationReceipt {
  const approvedSource = approvedC6B1bBase(source, plan, projection), approvedOutput = approvedC6B1bBase(output, plan, projection);
  const changedPaths = Object.freeze([motionPath, C6B1B_RECEIPT_PATH].sort(compareCodeUnits));
  const motionPropertyPaths = projectionPropertyPaths(projection);
  const payload: Omit<CheckpointStoryboardScalarSpatialMaterializationReceipt, "fingerprint"> = {
    schema: "shellx-motion/private-checkpoint-storyboard-scalar-spatial-materialization-receipt@1", operation: "checkpoint-storyboard.scalar-spatial.materialize", status: "passed",
    approval: { storyboard: { id: plan.storyboard.id, sha256: plan.storyboard.sha256, revision: plan.storyboard.revision }, c6aPlanFingerprint: plan.fingerprint, c6aLowererProfileFingerprint: plan.lowererProfile.fingerprint, c6b1bProfileFingerprint: projection.materializerProfile.fingerprint, c6b1bProjectionFingerprint: projection.fingerprint },
    base: { expected: approvedSource, reopened: approvedSource },
    output: { packageId: approvedOutput.packageId, manifestRawSha256: approvedOutput.manifestRawSha256, motionRawSha256: approvedOutput.motionRawSha256, canonicalMotionSha256: approvedOutput.motionCanonicalSha256, nonReceiptInventory, preservedLeaves: preserved, changed: { paths: changedPaths, count: 2, motionPropertyPaths, motionPropertyPathCount: motionPropertyPaths.length } },
    transaction: { cow: "closed-inventory-finalize-after-edit", installed: true, exclusiveReceipt: true, workspaceCleanup: "completed" }, renderer: { invoked: false },
  };
  return Object.freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

export async function writeC6B1bReceipt(root: string, receipt: CheckpointStoryboardScalarSpatialMaterializationReceipt, message: (error: unknown) => string): Promise<void> {
  const bytes = Buffer.from(`${canonicalJson(receipt)}\n`, "utf8");
  if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new PackageEditTransactionError("package_limit_exceeded", "C6B1b receipt exceeds 1 MiB.");
  try { await writeVerifiedBoundedFile(join(root, C6B1B_RECEIPT_PATH), bytes, { label: "C6B1b materialization receipt", maxBytes: MAX_RECEIPT_BYTES, withinRoot: root }); }
  catch (error) { throw new PackageEditTransactionError("copy_mismatch", `C6B1b receipt could not be exclusively published: ${message(error)}`); }
  if (canonicalJsonSha256(await readC6B1bReceipt(root)) !== canonicalJsonSha256(receipt)) throw new PackageEditTransactionError("copy_mismatch", "C6B1b receipt differs after staged publication.");
}

export async function readC6B1bReceipt(root: string): Promise<CheckpointStoryboardScalarSpatialMaterializationReceipt> {
  const file = await readBoundedStableFile(join(root, C6B1B_RECEIPT_PATH), { label: "C6B1b materialization receipt", maxBytes: MAX_RECEIPT_BYTES, withinRoot: root, requireSingleLink: true });
  let parsed: unknown; try { parsed = JSON.parse(file.bytes.toString("utf8")); } catch { throw new PackageEditTransactionError("copy_mismatch", "C6B1b receipt is not JSON."); }
  const receipt = plainObject(parsed, "C6B1b receipt") as Record<string, unknown>;
  exactKeys(receipt, ["schema", "operation", "status", "approval", "base", "output", "transaction", "renderer", "fingerprint"], "C6B1b receipt");
  assertReceiptShape(receipt);
  const fingerprint = field(receipt, "fingerprint", "C6B1b receipt"); const { fingerprint: _ignored, ...payload } = receipt;
  if (typeof fingerprint !== "string" || !HASH.test(fingerprint) || canonicalJsonSha256(payload) !== fingerprint || file.bytes.toString("utf8") !== `${canonicalJson(receipt)}\n`) throw new PackageEditTransactionError("copy_mismatch", "C6B1b receipt integrity is invalid.");
  return Object.freeze(receipt) as unknown as CheckpointStoryboardScalarSpatialMaterializationReceipt;
}

function plainObject(value: unknown, label: string): object { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object.`); return value; }
function field(value: object, key: string, label: string): unknown { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}.${key} must be an enumerable data field.`); return descriptor.value; }
function exactKeys(value: object, expected: readonly string[], label: string): void { const keys = Reflect.ownKeys(value); if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key)) || expected.some((key) => !keys.includes(key))) throw new Error(`${label} has unsupported fields.`); }

/** Verify every receipt field before its fingerprint can serve later private evidence. */
function assertReceiptShape(root: Record<string, unknown>): void {
  if (field(root, "schema", "C6B1b receipt") !== "shellx-motion/private-checkpoint-storyboard-scalar-spatial-materialization-receipt@1" || field(root, "operation", "C6B1b receipt") !== "checkpoint-storyboard.scalar-spatial.materialize" || field(root, "status", "C6B1b receipt") !== "passed") throw new PackageEditTransactionError("copy_mismatch", "C6B1b receipt identity is invalid.");
  const approval = record(field(root, "approval", "C6B1b receipt"), ["storyboard", "c6aPlanFingerprint", "c6aLowererProfileFingerprint", "c6b1bProfileFingerprint", "c6b1bProjectionFingerprint"], "C6B1b receipt approval");
  const storyboard = record(field(approval, "storyboard", "C6B1b receipt approval"), ["id", "sha256", "revision"], "C6B1b receipt storyboard");
  identifier(field(storyboard, "id", "C6B1b receipt storyboard"), "C6B1b receipt storyboard id"); sha(field(storyboard, "sha256", "C6B1b receipt storyboard"), "C6B1b receipt storyboard sha256"); positive(field(storyboard, "revision", "C6B1b receipt storyboard"), "C6B1b receipt storyboard revision", Number.MAX_SAFE_INTEGER);
  for (const key of ["c6aPlanFingerprint", "c6aLowererProfileFingerprint", "c6b1bProfileFingerprint", "c6b1bProjectionFingerprint"] as const) sha(field(approval, key, "C6B1b receipt approval"), `C6B1b receipt approval ${key}`);
  const base = record(field(root, "base", "C6B1b receipt"), ["expected", "reopened"], "C6B1b receipt base");
  assertBase(field(base, "expected", "C6B1b receipt base"), "C6B1b receipt expected base"); assertBase(field(base, "reopened", "C6B1b receipt base"), "C6B1b receipt reopened base");
  const output = record(field(root, "output", "C6B1b receipt"), ["packageId", "manifestRawSha256", "motionRawSha256", "canonicalMotionSha256", "nonReceiptInventory", "preservedLeaves", "changed"], "C6B1b receipt output");
  identifier(field(output, "packageId", "C6B1b receipt output"), "C6B1b receipt output package id");
  for (const key of ["manifestRawSha256", "motionRawSha256", "canonicalMotionSha256"] as const) sha(field(output, key, "C6B1b receipt output"), `C6B1b receipt output ${key}`);
  assertInventory(field(output, "nonReceiptInventory", "C6B1b receipt output"), "C6B1b receipt output inventory");
  const preserved = record(field(output, "preservedLeaves", "C6B1b receipt output"), ["sha256", "count"], "C6B1b receipt preserved leaves"); sha(field(preserved, "sha256", "C6B1b receipt preserved leaves"), "C6B1b receipt preserved leaves sha256"); positive(field(preserved, "count", "C6B1b receipt preserved leaves"), "C6B1b receipt preserved leaves count", 1_024);
  assertChanged(field(output, "changed", "C6B1b receipt output"));
  const transaction = record(field(root, "transaction", "C6B1b receipt"), ["cow", "installed", "exclusiveReceipt", "workspaceCleanup"], "C6B1b receipt transaction");
  if (field(transaction, "cow", "C6B1b receipt transaction") !== "closed-inventory-finalize-after-edit" || field(transaction, "installed", "C6B1b receipt transaction") !== true || field(transaction, "exclusiveReceipt", "C6B1b receipt transaction") !== true || field(transaction, "workspaceCleanup", "C6B1b receipt transaction") !== "completed") throw new PackageEditTransactionError("copy_mismatch", "C6B1b receipt transaction is invalid.");
  const renderer = record(field(root, "renderer", "C6B1b receipt"), ["invoked"], "C6B1b receipt renderer");
  if (field(renderer, "invoked", "C6B1b receipt renderer") !== false) throw new PackageEditTransactionError("copy_mismatch", "C6B1b receipt renderer claim is invalid.");
}
function assertBase(value: unknown, label: string): void {
  const base = record(value, ["packageId", "manifestRawSha256", "motionRawSha256", "manifestCanonicalSha256", "motionCanonicalSha256", "inventory", "c6aPlanFingerprint", "c6b1bProfileFingerprint", "c6b1bProjectionFingerprint"], label);
  identifier(field(base, "packageId", label), `${label} package id`);
  for (const key of ["manifestRawSha256", "motionRawSha256", "manifestCanonicalSha256", "motionCanonicalSha256", "c6aPlanFingerprint", "c6b1bProfileFingerprint", "c6b1bProjectionFingerprint"] as const) sha(field(base, key, label), `${label} ${key}`);
  assertInventory(field(base, "inventory", label), `${label} inventory`);
}
function assertInventory(value: unknown, label: string): void { const inventory = record(value, ["sha256", "entryCount", "leafCount"], label); sha(field(inventory, "sha256", label), `${label} sha256`); positive(field(inventory, "entryCount", label), `${label} entry count`, 2_048); positive(field(inventory, "leafCount", label), `${label} leaf count`, 1_024); }
function assertChanged(value: unknown): void {
  const changed = record(value, ["paths", "count", "motionPropertyPaths", "motionPropertyPathCount"], "C6B1b receipt changed");
  const paths = stringList(field(changed, "paths", "C6B1b receipt changed"), "C6B1b receipt changed paths", 2);
  if (paths.length !== 2 || !paths.includes(C6B1B_RECEIPT_PATH) || !paths.some((path) => path !== C6B1B_RECEIPT_PATH && safePackagePath(path)) || field(changed, "count", "C6B1b receipt changed") !== 2) throw new PackageEditTransactionError("copy_mismatch", "C6B1b receipt changed leaves are invalid.");
  const properties = stringList(field(changed, "motionPropertyPaths", "C6B1b receipt changed"), "C6B1b receipt property paths", 320);
  if (properties.length < 1 || properties.some((path) => !/^layers\/[0-9]+\/keyframes\/(?:transform\.(?:x|y|rotation|scale)|opacity)$/.test(path)) || field(changed, "motionPropertyPathCount", "C6B1b receipt changed") !== properties.length) throw new PackageEditTransactionError("copy_mismatch", "C6B1b receipt ordinary Motion paths are invalid.");
}
function projectionPropertyPaths(projection: CheckpointStoryboardScalarSpatialMaterializationProjection): readonly string[] {
  const paths = [
    ...projection.scalar.map((entry) => `layers/${entry.layerIndex}/keyframes/${entry.property}`),
    ...projection.spatial.flatMap((entry) => [`layers/${entry.layerIndex}/keyframes/transform.x`, `layers/${entry.layerIndex}/keyframes/transform.y`]),
  ].sort(compareCodeUnits);
  if (paths.length < 1 || paths.length > 320 || new Set(paths).size !== paths.length) throw new PackageEditTransactionError("copy_mismatch", "C6B1b projection changed-property paths are invalid.");
  return Object.freeze(paths);
}
function stringList(value: unknown, label: string, maximum: number): readonly string[] { if (!Array.isArray(value) || value.length < 1 || value.length > maximum || value.some((item) => typeof item !== "string") || value.some((item, index) => index > 0 && compareCodeUnits(value[index - 1] as string, item) >= 0)) throw new PackageEditTransactionError("copy_mismatch", `${label} is invalid.`); return value; }
function safePackagePath(value: string): boolean { return !!value && !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."); }
function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> { const result = plainObject(value, label) as Record<string, unknown>; exactKeys(result, keys, label); return result; }
function sha(value: unknown, label: string): void { if (typeof value !== "string" || !HASH.test(value)) throw new PackageEditTransactionError("copy_mismatch", `${label} is invalid.`); }
function identifier(value: unknown, label: string): void { if (typeof value !== "string" || value.length < 1 || value.length > 128) throw new PackageEditTransactionError("copy_mismatch", `${label} is invalid.`); }
function positive(value: unknown, label: string, maximum: number): void { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new PackageEditTransactionError("copy_mismatch", `${label} is invalid.`); }
