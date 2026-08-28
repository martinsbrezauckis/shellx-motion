/** Fixed private receipt for C6B3b relations@1 COW installation; no Debug route imports it. */
import { canonicalJson, canonicalJsonSha256, compareCodeUnits, readBoundedStableFile, writeVerifiedBoundedFile } from "@shellx-motion/core";
import type { CheckpointStoryboardRelationProfilePlan } from "@shellx-motion/core/internal/checkpoint-storyboard-relation-profile";
import { join } from "node:path";
import { PackageEditTransactionError } from "../package-edit-transaction.js";

export const C6B3B_RECEIPT_PATH = "receipts/checkpoint-storyboard-relation-materialization.v1.json";
const HASH = /^[a-f0-9]{64}$/;
const MAX_RECEIPT_BYTES = 1024 * 1024;

export interface C6B3bInventory { readonly sha256: string; readonly entryCount: number; readonly leafCount: number; }
export interface C6B3bExactBase {
  readonly packageId: string;
  readonly manifestRawSha256: string;
  readonly motionRawSha256: string;
  readonly manifestCanonicalSha256: string;
  readonly motionCanonicalSha256: string;
  readonly inventory: C6B3bInventory;
  readonly planFingerprint: string;
  readonly profileFingerprint: string;
  readonly storeSha256: string;
  readonly staticFingerprint: string;
  readonly gpuStaticFingerprint: string;
  readonly startFramePlanFingerprint: string;
  readonly endFramePlanFingerprint: string;
}
export interface CheckpointStoryboardRelationMaterializationReceipt {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-relation-materialization-receipt@1";
  readonly operation: "checkpoint-storyboard.relation.materialize";
  readonly status: "passed";
  readonly approval: {
    readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number };
    readonly planFingerprint: string;
    readonly profileFingerprint: string;
    readonly storeSha256: string;
    readonly staticFingerprint: string;
    readonly gpuStaticFingerprint: string;
    readonly startFramePlanFingerprint: string;
    readonly endFramePlanFingerprint: string;
  };
  readonly base: { readonly expected: C6B3bExactBase; readonly reopened: C6B3bExactBase };
  readonly output: {
    readonly packageId: string;
    readonly manifestRawSha256: string;
    readonly motionRawSha256: string;
    readonly canonicalMotionSha256: string;
    readonly nonReceiptInventory: C6B3bInventory;
    readonly preservedLeaves: { readonly sha256: string; readonly count: number };
    readonly changed: { readonly paths: readonly string[]; readonly count: 2; readonly motionPropertyPaths: readonly ["relations"]; readonly motionPropertyPathCount: 1 };
  };
  readonly transaction: { readonly cow: "closed-inventory-finalize-after-edit"; readonly installed: true; readonly exclusiveReceipt: true; readonly workspaceCleanup: "completed" };
  readonly renderer: { readonly invoked: false; readonly pixels: false };
  readonly fingerprint: string;
}

export function bindC6B3bExactBase(
  base: Omit<C6B3bExactBase, "planFingerprint" | "profileFingerprint" | "storeSha256" | "staticFingerprint" | "gpuStaticFingerprint" | "startFramePlanFingerprint" | "endFramePlanFingerprint">,
  plan: CheckpointStoryboardRelationProfilePlan,
): C6B3bExactBase {
  return Object.freeze({
    ...base,
    planFingerprint: plan.fingerprint,
    profileFingerprint: plan.lowererProfile.fingerprint,
    storeSha256: plan.projection.storeSha256,
    staticFingerprint: plan.projection.staticFingerprint,
    gpuStaticFingerprint: plan.projection.gpuPreviewStaticPlan.fingerprint,
    startFramePlanFingerprint: plan.endpointFramePlans.start.fingerprint,
    endFramePlanFingerprint: plan.endpointFramePlans.end.fingerprint,
  });
}

export function createC6B3bReceipt(
  plan: CheckpointStoryboardRelationProfilePlan,
  source: C6B3bExactBase,
  output: C6B3bExactBase,
  motionPath: string,
  nonReceiptInventory: C6B3bInventory,
  preservedLeaves: { sha256: string; count: number },
): CheckpointStoryboardRelationMaterializationReceipt {
  const approval = {
    storyboard: { id: plan.storyboard.id, sha256: plan.storyboard.sha256, revision: plan.storyboard.revision },
    planFingerprint: plan.fingerprint,
    profileFingerprint: plan.lowererProfile.fingerprint,
    storeSha256: plan.projection.storeSha256,
    staticFingerprint: plan.projection.staticFingerprint,
    gpuStaticFingerprint: plan.projection.gpuPreviewStaticPlan.fingerprint,
    startFramePlanFingerprint: plan.endpointFramePlans.start.fingerprint,
    endFramePlanFingerprint: plan.endpointFramePlans.end.fingerprint,
  };
  const payload: Omit<CheckpointStoryboardRelationMaterializationReceipt, "fingerprint"> = {
    schema: "shellx-motion/private-checkpoint-storyboard-relation-materialization-receipt@1",
    operation: "checkpoint-storyboard.relation.materialize",
    status: "passed",
    approval,
    base: { expected: source, reopened: source },
    output: {
      packageId: output.packageId,
      manifestRawSha256: output.manifestRawSha256,
      motionRawSha256: output.motionRawSha256,
      canonicalMotionSha256: output.motionCanonicalSha256,
      nonReceiptInventory,
      preservedLeaves,
      changed: { paths: Object.freeze([motionPath, C6B3B_RECEIPT_PATH].sort(compareCodeUnits)), count: 2, motionPropertyPaths: ["relations"], motionPropertyPathCount: 1 },
    },
    transaction: { cow: "closed-inventory-finalize-after-edit", installed: true, exclusiveReceipt: true, workspaceCleanup: "completed" },
    renderer: { invoked: false, pixels: false },
  };
  return Object.freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

export async function writeC6B3bReceipt(root: string, receipt: CheckpointStoryboardRelationMaterializationReceipt): Promise<void> {
  const bytes = Buffer.from(`${canonicalJson(receipt)}\n`, "utf8");
  if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new PackageEditTransactionError("package_limit_exceeded", "C6B3b receipt exceeds 1 MiB.");
  try {
    await writeVerifiedBoundedFile(join(root, C6B3B_RECEIPT_PATH), bytes, { label: "C6B3b relation materialization receipt", maxBytes: MAX_RECEIPT_BYTES, withinRoot: root });
  } catch {
    throw new PackageEditTransactionError("copy_mismatch", "C6B3b receipt could not be exclusively published.");
  }
  if (canonicalJsonSha256(await readC6B3bReceipt(root)) !== canonicalJsonSha256(receipt)) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B3b receipt differs after staged publication.");
  }
}

export async function readC6B3bReceipt(root: string): Promise<CheckpointStoryboardRelationMaterializationReceipt> {
  const file = await readBoundedStableFile(join(root, C6B3B_RECEIPT_PATH), { label: "C6B3b relation materialization receipt", maxBytes: MAX_RECEIPT_BYTES, withinRoot: root, requireSingleLink: true });
  let parsed: unknown;
  try { parsed = JSON.parse(file.bytes.toString("utf8")); } catch { throw new PackageEditTransactionError("copy_mismatch", "C6B3b receipt is not JSON."); }
  const receipt = record(parsed, ["schema", "operation", "status", "approval", "base", "output", "transaction", "renderer", "fingerprint"], "C6B3b receipt");
  if (field(receipt, "schema", "C6B3b receipt") !== "shellx-motion/private-checkpoint-storyboard-relation-materialization-receipt@1"
    || field(receipt, "operation", "C6B3b receipt") !== "checkpoint-storyboard.relation.materialize"
    || field(receipt, "status", "C6B3b receipt") !== "passed") throw new PackageEditTransactionError("copy_mismatch", "C6B3b receipt identity is invalid.");
  const approval = record(field(receipt, "approval", "C6B3b receipt"), ["storyboard", "planFingerprint", "profileFingerprint", "storeSha256", "staticFingerprint", "gpuStaticFingerprint", "startFramePlanFingerprint", "endFramePlanFingerprint"], "C6B3b receipt approval");
  const storyboard = record(field(approval, "storyboard", "C6B3b receipt approval"), ["id", "sha256", "revision"], "C6B3b receipt storyboard");
  identifier(field(storyboard, "id", "C6B3b receipt storyboard")); hash(field(storyboard, "sha256", "C6B3b receipt storyboard")); positive(field(storyboard, "revision", "C6B3b receipt storyboard"), 1_000_000);
  for (const key of ["planFingerprint", "profileFingerprint", "storeSha256", "staticFingerprint", "gpuStaticFingerprint", "startFramePlanFingerprint", "endFramePlanFingerprint"] as const) hash(field(approval, key, "C6B3b receipt approval"));
  const base = record(field(receipt, "base", "C6B3b receipt"), ["expected", "reopened"], "C6B3b receipt base");
  const expected = assertBase(field(base, "expected", "C6B3b receipt base")), reopened = assertBase(field(base, "reopened", "C6B3b receipt base"));
  if (canonicalJsonSha256(expected) !== canonicalJsonSha256(reopened)) throw new PackageEditTransactionError("copy_mismatch", "C6B3b receipt base reopen identity is inconsistent.");
  const output = record(field(receipt, "output", "C6B3b receipt"), ["packageId", "manifestRawSha256", "motionRawSha256", "canonicalMotionSha256", "nonReceiptInventory", "preservedLeaves", "changed"], "C6B3b receipt output");
  identifier(field(output, "packageId", "C6B3b receipt output"));
  for (const key of ["manifestRawSha256", "motionRawSha256", "canonicalMotionSha256"] as const) hash(field(output, key, "C6B3b receipt output"));
  assertInventory(field(output, "nonReceiptInventory", "C6B3b receipt output"));
  const preserved = record(field(output, "preservedLeaves", "C6B3b receipt output"), ["sha256", "count"], "C6B3b receipt preserved leaves");
  hash(field(preserved, "sha256", "C6B3b receipt preserved leaves")); positive(field(preserved, "count", "C6B3b receipt preserved leaves"), 1_024);
  const changed = record(field(output, "changed", "C6B3b receipt output"), ["paths", "count", "motionPropertyPaths", "motionPropertyPathCount"], "C6B3b receipt changed");
  const paths = strings(field(changed, "paths", "C6B3b receipt changed"), 2), properties = strings(field(changed, "motionPropertyPaths", "C6B3b receipt changed"), 1);
  if (paths.length !== 2 || !paths.includes(C6B3B_RECEIPT_PATH) || !paths.some((path) => path !== C6B3B_RECEIPT_PATH && packagePath(path))
    || field(changed, "count", "C6B3b receipt changed") !== 2 || properties.length !== 1 || properties[0] !== "relations"
    || field(changed, "motionPropertyPathCount", "C6B3b receipt changed") !== 1) throw new PackageEditTransactionError("copy_mismatch", "C6B3b receipt changed-leaf evidence is invalid.");
  const transaction = record(field(receipt, "transaction", "C6B3b receipt"), ["cow", "installed", "exclusiveReceipt", "workspaceCleanup"], "C6B3b receipt transaction");
  if (field(transaction, "cow", "C6B3b receipt transaction") !== "closed-inventory-finalize-after-edit" || field(transaction, "installed", "C6B3b receipt transaction") !== true || field(transaction, "exclusiveReceipt", "C6B3b receipt transaction") !== true || field(transaction, "workspaceCleanup", "C6B3b receipt transaction") !== "completed") throw new PackageEditTransactionError("copy_mismatch", "C6B3b receipt transaction is invalid.");
  const renderer = record(field(receipt, "renderer", "C6B3b receipt"), ["invoked", "pixels"], "C6B3b receipt renderer");
  if (field(renderer, "invoked", "C6B3b receipt renderer") !== false || field(renderer, "pixels", "C6B3b receipt renderer") !== false) throw new PackageEditTransactionError("copy_mismatch", "C6B3b receipt renderer evidence is invalid.");
  const fingerprint = field(receipt, "fingerprint", "C6B3b receipt"), { fingerprint: _ignored, ...payload } = receipt;
  if (typeof fingerprint !== "string" || !HASH.test(fingerprint) || canonicalJsonSha256(payload) !== fingerprint || file.bytes.toString("utf8") !== `${canonicalJson(receipt)}\n`) throw new PackageEditTransactionError("copy_mismatch", "C6B3b receipt integrity is invalid.");
  return Object.freeze(receipt) as unknown as CheckpointStoryboardRelationMaterializationReceipt;
}

function assertBase(value: unknown): C6B3bExactBase {
  const base = record(value, ["packageId", "manifestRawSha256", "motionRawSha256", "manifestCanonicalSha256", "motionCanonicalSha256", "inventory", "planFingerprint", "profileFingerprint", "storeSha256", "staticFingerprint", "gpuStaticFingerprint", "startFramePlanFingerprint", "endFramePlanFingerprint"], "C6B3b receipt base");
  identifier(field(base, "packageId", "C6B3b receipt base"));
  for (const key of ["manifestRawSha256", "motionRawSha256", "manifestCanonicalSha256", "motionCanonicalSha256", "planFingerprint", "profileFingerprint", "storeSha256", "staticFingerprint", "gpuStaticFingerprint", "startFramePlanFingerprint", "endFramePlanFingerprint"] as const) hash(field(base, key, "C6B3b receipt base"));
  assertInventory(field(base, "inventory", "C6B3b receipt base"));
  return base as unknown as C6B3bExactBase;
}
function assertInventory(value: unknown): void { const inventory = record(value, ["sha256", "entryCount", "leafCount"], "C6B3b receipt inventory"); hash(field(inventory, "sha256", "C6B3b receipt inventory")); positive(field(inventory, "entryCount", "C6B3b receipt inventory"), 2_048); positive(field(inventory, "leafCount", "C6B3b receipt inventory"), 1_024); }
function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> { const result = object(value, label); const actual = Reflect.ownKeys(result); if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key)) || keys.some((key) => !actual.includes(key))) throw new PackageEditTransactionError("copy_mismatch", `${label} has unsupported fields.`); return result as Record<string, unknown>; }
function object(value: unknown, label: string): object { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new PackageEditTransactionError("copy_mismatch", `${label} is invalid.`); return value; }
function field(value: object, key: string, label: string): unknown { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new PackageEditTransactionError("copy_mismatch", `${label}.${key} is invalid.`); return descriptor.value; }
function hash(value: unknown, label = "C6B3b receipt"): void { if (typeof value !== "string" || !HASH.test(value)) throw new PackageEditTransactionError("copy_mismatch", `${label} hash is invalid.`); }
function identifier(value: unknown): void { if (typeof value !== "string" || value.length < 1 || value.length > 128) throw new PackageEditTransactionError("copy_mismatch", "C6B3b receipt identifier is invalid."); }
function positive(value: unknown, maximum: number): void { if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) throw new PackageEditTransactionError("copy_mismatch", "C6B3b receipt count is invalid."); }
function strings(value: unknown, maximum: number): readonly string[] { if (!Array.isArray(value) || value.length < 1 || value.length > maximum || value.some((item) => typeof item !== "string") || value.some((item, index) => index > 0 && compareCodeUnits(value[index - 1] as string, item) >= 0)) throw new PackageEditTransactionError("copy_mismatch", "C6B3b receipt paths are invalid."); return value; }
function packagePath(value: string): boolean { return !!value && !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."); }
