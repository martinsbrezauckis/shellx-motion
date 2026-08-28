/** Fixed private receipt for C6B4b relation-action COW installation; no Debug route imports it. */
import { canonicalJson, canonicalJsonSha256, compareCodeUnits, readBoundedStableFile, writeVerifiedBoundedFile } from "@shellx-motion/core";
import type { MotionRelationStore } from "@shellx-motion/core";
import { join } from "node:path";
import { PackageEditTransactionError } from "../package-edit-transaction.js";

export const C6B4B_RECEIPT_PATH = "receipts/checkpoint-storyboard-relation-action-materialization.v1.json";
const HASH = /^[a-f0-9]{64}$/;
const MAX_RECEIPT_BYTES = 1024 * 1024;

export interface C6B4bInventory { readonly sha256: string; readonly entryCount: number; readonly leafCount: number; }

export interface C6B4bExactBase {
  readonly packageId: string;
  readonly manifestRawSha256: string;
  readonly motionRawSha256: string;
  readonly manifestCanonicalSha256: string;
  readonly motionCanonicalSha256: string;
  readonly inventory: C6B4bInventory;
  readonly planFingerprint: string;
  readonly profileFingerprint: string;
  readonly actionStoreSchema: "shellx-motion/relation-actions@2";
  readonly actionStoreSha256: string;
  readonly actionDefinitionId: string;
  readonly actionDefinitionSha256: string;
  readonly actionRequestInstanceId: string;
  readonly actionRequestSha256: string;
  readonly actionApplyPlanFingerprint: string;
  readonly actionObjects: 0;
  readonly actionRelations: 1;
  readonly actionKeyframeWrites: 0;
  readonly actionChangedPath: string;
  readonly actionOutputCanonicalMotionSha256: string;
  readonly relationId: string;
  readonly storeSha256: string;
  readonly staticFingerprint: string;
  readonly gpuStaticFingerprint: string;
  readonly startFramePlanFingerprint: string;
  readonly endFramePlanFingerprint: string;
}

/** The C6B4a facts B4b consumes through its private Core internal handoff. */
export interface C6B4bPlanEvidence {
  readonly fingerprint: string;
  readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number };
  readonly base: {
    readonly package: { readonly id: string };
    readonly manifest: { readonly sha256: string };
    readonly canonicalMotion: { readonly sha256: string };
    readonly persistedMotion: { readonly sha256: string };
  };
  readonly lowererProfile: { readonly fingerprint: string };
  readonly projection: {
    readonly action: {
      readonly store: { readonly schema: "shellx-motion/relation-actions@2"; readonly sha256: string };
      readonly definition: { readonly id: string; readonly sha256: string };
      readonly request: { readonly instanceId: string; readonly sha256: string };
      readonly applyPlan: { readonly fingerprint: string; readonly counts: { readonly objects: number; readonly relations: number; readonly keyframeWrites: number } };
      readonly outputCanonicalMotionSha256: string;
      readonly changedPaths: readonly string[];
      readonly relationIds: readonly [string];
    };
    readonly store: MotionRelationStore;
    readonly storeSha256: string;
    readonly staticFingerprint: string;
    readonly gpuPreviewStaticPlan: { readonly fingerprint: string };
  };
  readonly endpointFramePlans: { readonly start: { readonly fingerprint: string }; readonly end: { readonly fingerprint: string } };
}

export interface CheckpointStoryboardRelationActionMaterializationReceipt {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-relation-action-materialization-receipt@1";
  readonly operation: "checkpoint-storyboard.relation-action.materialize";
  readonly status: "passed";
  readonly approval: {
    readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number };
    readonly planFingerprint: string;
    readonly profileFingerprint: string;
    readonly action: {
      readonly store: { readonly schema: "shellx-motion/relation-actions@2"; readonly sha256: string };
      readonly definition: { readonly id: string; readonly sha256: string };
      readonly request: { readonly instanceId: string; readonly sha256: string };
      readonly applyPlanFingerprint: string;
      readonly counts: { readonly objects: 0; readonly relations: 1; readonly keyframeWrites: 0 };
      readonly changedPath: string;
      readonly outputCanonicalMotionSha256: string;
      readonly relationId: string;
    };
    readonly relation: {
      readonly storeSha256: string;
      readonly staticFingerprint: string;
      readonly gpuStaticFingerprint: string;
      readonly startFramePlanFingerprint: string;
      readonly endFramePlanFingerprint: string;
    };
  };
  readonly base: { readonly expected: C6B4bExactBase; readonly reopened: C6B4bExactBase };
  readonly output: {
    readonly packageId: string;
    readonly manifestRawSha256: string;
    readonly motionRawSha256: string;
    readonly canonicalMotionSha256: string;
    readonly nonReceiptInventory: C6B4bInventory;
    readonly preservedLeaves: { readonly sha256: string; readonly count: number };
    readonly changed: { readonly paths: readonly string[]; readonly count: 2; readonly motionPropertyPaths: readonly ["relations"]; readonly motionPropertyPathCount: 1 };
  };
  readonly transaction: { readonly cow: "closed-inventory-finalize-after-edit"; readonly installed: true; readonly exclusiveReceipt: true; readonly workspaceCleanup: "not-attested" };
  readonly renderer: { readonly invoked: false; readonly pixels: false };
  readonly fingerprint: string;
}

export function bindC6B4bExactBase(
  base: Omit<C6B4bExactBase, "planFingerprint" | "profileFingerprint" | "actionStoreSchema" | "actionStoreSha256" | "actionDefinitionId" | "actionDefinitionSha256" | "actionRequestInstanceId" | "actionRequestSha256" | "actionApplyPlanFingerprint" | "actionObjects" | "actionRelations" | "actionKeyframeWrites" | "actionChangedPath" | "actionOutputCanonicalMotionSha256" | "relationId" | "storeSha256" | "staticFingerprint" | "gpuStaticFingerprint" | "startFramePlanFingerprint" | "endFramePlanFingerprint">,
  plan: C6B4bPlanEvidence,
): C6B4bExactBase {
  assertPlanEvidence(plan);
  return Object.freeze({
    ...base,
    planFingerprint: plan.fingerprint,
    profileFingerprint: plan.lowererProfile.fingerprint,
    actionStoreSchema: plan.projection.action.store.schema,
    actionStoreSha256: plan.projection.action.store.sha256,
    actionDefinitionId: plan.projection.action.definition.id,
    actionDefinitionSha256: plan.projection.action.definition.sha256,
    actionRequestInstanceId: plan.projection.action.request.instanceId,
    actionRequestSha256: plan.projection.action.request.sha256,
    actionApplyPlanFingerprint: plan.projection.action.applyPlan.fingerprint,
    actionObjects: plan.projection.action.applyPlan.counts.objects as 0,
    actionRelations: plan.projection.action.applyPlan.counts.relations as 1,
    actionKeyframeWrites: plan.projection.action.applyPlan.counts.keyframeWrites as 0,
    actionChangedPath: plan.projection.action.changedPaths[0],
    actionOutputCanonicalMotionSha256: plan.projection.action.outputCanonicalMotionSha256,
    relationId: plan.projection.action.relationIds[0],
    storeSha256: plan.projection.storeSha256,
    staticFingerprint: plan.projection.staticFingerprint,
    gpuStaticFingerprint: plan.projection.gpuPreviewStaticPlan.fingerprint,
    startFramePlanFingerprint: plan.endpointFramePlans.start.fingerprint,
    endFramePlanFingerprint: plan.endpointFramePlans.end.fingerprint,
  });
}

export function createC6B4bReceipt(
  plan: C6B4bPlanEvidence,
  source: C6B4bExactBase,
  output: C6B4bExactBase,
  motionPath: string,
  nonReceiptInventory: C6B4bInventory,
  preservedLeaves: { sha256: string; count: number },
): CheckpointStoryboardRelationActionMaterializationReceipt {
  assertPlanEvidence(plan);
  const payload: Omit<CheckpointStoryboardRelationActionMaterializationReceipt, "fingerprint"> = {
    schema: "shellx-motion/private-checkpoint-storyboard-relation-action-materialization-receipt@1",
    operation: "checkpoint-storyboard.relation-action.materialize",
    status: "passed",
    approval: {
      storyboard: { id: plan.storyboard.id, sha256: plan.storyboard.sha256, revision: plan.storyboard.revision },
      planFingerprint: plan.fingerprint,
      profileFingerprint: plan.lowererProfile.fingerprint,
      action: {
        store: { schema: plan.projection.action.store.schema, sha256: plan.projection.action.store.sha256 },
        definition: { id: plan.projection.action.definition.id, sha256: plan.projection.action.definition.sha256 },
        request: { instanceId: plan.projection.action.request.instanceId, sha256: plan.projection.action.request.sha256 },
        applyPlanFingerprint: plan.projection.action.applyPlan.fingerprint,
        counts: { objects: 0, relations: 1, keyframeWrites: 0 },
        changedPath: plan.projection.action.changedPaths[0],
        outputCanonicalMotionSha256: plan.projection.action.outputCanonicalMotionSha256,
        relationId: plan.projection.action.relationIds[0],
      },
      relation: {
        storeSha256: plan.projection.storeSha256,
        staticFingerprint: plan.projection.staticFingerprint,
        gpuStaticFingerprint: plan.projection.gpuPreviewStaticPlan.fingerprint,
        startFramePlanFingerprint: plan.endpointFramePlans.start.fingerprint,
        endFramePlanFingerprint: plan.endpointFramePlans.end.fingerprint,
      },
    },
    base: { expected: source, reopened: source },
    output: {
      packageId: output.packageId,
      manifestRawSha256: output.manifestRawSha256,
      motionRawSha256: output.motionRawSha256,
      canonicalMotionSha256: output.motionCanonicalSha256,
      nonReceiptInventory,
      preservedLeaves,
      changed: { paths: Object.freeze([motionPath, C6B4B_RECEIPT_PATH].sort(compareCodeUnits)), count: 2, motionPropertyPaths: ["relations"], motionPropertyPathCount: 1 },
    },
    transaction: { cow: "closed-inventory-finalize-after-edit", installed: true, exclusiveReceipt: true, workspaceCleanup: "not-attested" },
    renderer: { invoked: false, pixels: false },
  };
  return Object.freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

export async function writeC6B4bReceipt(root: string, receipt: CheckpointStoryboardRelationActionMaterializationReceipt): Promise<void> {
  const bytes = Buffer.from(`${canonicalJson(receipt)}\n`, "utf8");
  if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new PackageEditTransactionError("package_limit_exceeded", "C6B4b receipt exceeds 1 MiB.");
  try {
    await writeVerifiedBoundedFile(join(root, C6B4B_RECEIPT_PATH), bytes, { label: "C6B4b relation-action materialization receipt", maxBytes: MAX_RECEIPT_BYTES, withinRoot: root });
  } catch {
    throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt could not be exclusively published.");
  }
  if (canonicalJsonSha256(await readC6B4bReceipt(root)) !== canonicalJsonSha256(receipt)) {
    throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt differs after staged publication.");
  }
}

export async function readC6B4bReceipt(root: string): Promise<CheckpointStoryboardRelationActionMaterializationReceipt> {
  const file = await readBoundedStableFile(join(root, C6B4B_RECEIPT_PATH), { label: "C6B4b relation-action materialization receipt", maxBytes: MAX_RECEIPT_BYTES, withinRoot: root, requireSingleLink: true });
  let parsed: unknown;
  try { parsed = JSON.parse(file.bytes.toString("utf8")); }
  catch { throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt is not JSON."); }
  const receipt = record(parsed, ["schema", "operation", "status", "approval", "base", "output", "transaction", "renderer", "fingerprint"], "C6B4b receipt");
  if (field(receipt, "schema", "C6B4b receipt") !== "shellx-motion/private-checkpoint-storyboard-relation-action-materialization-receipt@1"
    || field(receipt, "operation", "C6B4b receipt") !== "checkpoint-storyboard.relation-action.materialize"
    || field(receipt, "status", "C6B4b receipt") !== "passed") throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt identity is invalid.");
  const approval = assertApproval(field(receipt, "approval", "C6B4b receipt"));
  const base = record(field(receipt, "base", "C6B4b receipt"), ["expected", "reopened"], "C6B4b receipt base");
  const expected = readC6B4bExactBase(field(base, "expected", "C6B4b receipt base")), reopened = readC6B4bExactBase(field(base, "reopened", "C6B4b receipt base"));
  if (canonicalJsonSha256(expected) !== canonicalJsonSha256(reopened)) throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt base reopen identity is inconsistent.");
  const output = assertOutput(field(receipt, "output", "C6B4b receipt"));
  const transaction = record(field(receipt, "transaction", "C6B4b receipt"), ["cow", "installed", "exclusiveReceipt", "workspaceCleanup"], "C6B4b receipt transaction");
  if (field(transaction, "cow", "C6B4b receipt transaction") !== "closed-inventory-finalize-after-edit" || field(transaction, "installed", "C6B4b receipt transaction") !== true || field(transaction, "exclusiveReceipt", "C6B4b receipt transaction") !== true || field(transaction, "workspaceCleanup", "C6B4b receipt transaction") !== "not-attested") throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt transaction is invalid.");
  const renderer = record(field(receipt, "renderer", "C6B4b receipt"), ["invoked", "pixels"], "C6B4b receipt renderer");
  if (field(renderer, "invoked", "C6B4b receipt renderer") !== false || field(renderer, "pixels", "C6B4b receipt renderer") !== false) throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt renderer evidence is invalid.");
  const fingerprint = field(receipt, "fingerprint", "C6B4b receipt"), { fingerprint: _ignored, ...payload } = receipt;
  if (typeof fingerprint !== "string" || !HASH.test(fingerprint) || canonicalJsonSha256(payload) !== fingerprint || file.bytes.toString("utf8") !== `${canonicalJson(receipt)}\n`) throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt integrity is invalid.");
  return Object.freeze({ ...receipt, approval, base: { expected, reopened }, output }) as unknown as CheckpointStoryboardRelationActionMaterializationReceipt;
}

function assertPlanEvidence(plan: C6B4bPlanEvidence): void {
  const action = plan?.projection?.action;
  if (!plan || !HASH.test(plan.fingerprint) || !HASH.test(plan.lowererProfile?.fingerprint)
    || action?.store?.schema !== "shellx-motion/relation-actions@2" || !HASH.test(action.store.sha256) || !identifier(action?.definition?.id) || !HASH.test(action?.definition?.sha256)
    || !identifier(action?.request?.instanceId) || !HASH.test(action?.request?.sha256) || !HASH.test(action?.applyPlan?.fingerprint)
    || action.applyPlan.counts.objects !== 0 || action.applyPlan.counts.relations !== 1 || action.applyPlan.counts.keyframeWrites !== 0
    || !HASH.test(action.outputCanonicalMotionSha256) || !Array.isArray(action.changedPaths) || action.changedPaths.length !== 1 || action.changedPaths[0] !== `/relations/bindings/${action.relationIds?.[0]}`
    || !Array.isArray(action.relationIds) || action.relationIds.length !== 1 || !identifier(action.relationIds[0])
    || !HASH.test(plan.projection.storeSha256) || !HASH.test(plan.projection.staticFingerprint) || !HASH.test(plan.projection.gpuPreviewStaticPlan?.fingerprint)
    || !HASH.test(plan.endpointFramePlans?.start?.fingerprint) || !HASH.test(plan.endpointFramePlans?.end?.fingerprint)) {
    throw new PackageEditTransactionError("source_changed", "C6B4b received incomplete C6B4a relation-action plan evidence.");
  }
}

function assertApproval(value: unknown): CheckpointStoryboardRelationActionMaterializationReceipt["approval"] {
  const approval = record(value, ["storyboard", "planFingerprint", "profileFingerprint", "action", "relation"], "C6B4b receipt approval");
  const storyboard = record(field(approval, "storyboard", "C6B4b receipt approval"), ["id", "sha256", "revision"], "C6B4b receipt storyboard");
  identifier(field(storyboard, "id", "C6B4b receipt storyboard")); hash(field(storyboard, "sha256", "C6B4b receipt storyboard")); positive(field(storyboard, "revision", "C6B4b receipt storyboard"), 1_000_000);
  hash(field(approval, "planFingerprint", "C6B4b receipt approval")); hash(field(approval, "profileFingerprint", "C6B4b receipt approval"));
  const action = record(field(approval, "action", "C6B4b receipt approval"), ["store", "definition", "request", "applyPlanFingerprint", "counts", "changedPath", "outputCanonicalMotionSha256", "relationId"], "C6B4b receipt action");
  const store = record(field(action, "store", "C6B4b receipt action"), ["schema", "sha256"], "C6B4b receipt action store");
  if (field(store, "schema", "C6B4b receipt action store") !== "shellx-motion/relation-actions@2") throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt action store schema is invalid.");
  hash(field(store, "sha256", "C6B4b receipt action store"));
  const definition = record(field(action, "definition", "C6B4b receipt action"), ["id", "sha256"], "C6B4b receipt action definition"); identifier(field(definition, "id", "C6B4b receipt action definition")); hash(field(definition, "sha256", "C6B4b receipt action definition"));
  const request = record(field(action, "request", "C6B4b receipt action"), ["instanceId", "sha256"], "C6B4b receipt action request"); identifier(field(request, "instanceId", "C6B4b receipt action request")); hash(field(request, "sha256", "C6B4b receipt action request"));
  hash(field(action, "applyPlanFingerprint", "C6B4b receipt action"));
  const counts = record(field(action, "counts", "C6B4b receipt action"), ["objects", "relations", "keyframeWrites"], "C6B4b receipt action counts");
  if (field(counts, "objects", "C6B4b receipt action counts") !== 0 || field(counts, "relations", "C6B4b receipt action counts") !== 1 || field(counts, "keyframeWrites", "C6B4b receipt action counts") !== 0) throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt action counts are invalid.");
  const changedPath = field(action, "changedPath", "C6B4b receipt action"); if (typeof changedPath !== "string" || !/^\/relations\/bindings\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(changedPath)) throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt action changed path is invalid.");
  hash(field(action, "outputCanonicalMotionSha256", "C6B4b receipt action")); identifier(field(action, "relationId", "C6B4b receipt action"));
  if (changedPath !== `/relations/bindings/${field(action, "relationId", "C6B4b receipt action")}`) throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt action changed path does not bind its sole relation.");
  const relation = record(field(approval, "relation", "C6B4b receipt approval"), ["storeSha256", "staticFingerprint", "gpuStaticFingerprint", "startFramePlanFingerprint", "endFramePlanFingerprint"], "C6B4b receipt relation");
  for (const key of ["storeSha256", "staticFingerprint", "gpuStaticFingerprint", "startFramePlanFingerprint", "endFramePlanFingerprint"] as const) hash(field(relation, key, "C6B4b receipt relation"));
  return approval as unknown as CheckpointStoryboardRelationActionMaterializationReceipt["approval"];
}

function assertOutput(value: unknown): CheckpointStoryboardRelationActionMaterializationReceipt["output"] {
  const output = record(value, ["packageId", "manifestRawSha256", "motionRawSha256", "canonicalMotionSha256", "nonReceiptInventory", "preservedLeaves", "changed"], "C6B4b receipt output");
  identifier(field(output, "packageId", "C6B4b receipt output"));
  for (const key of ["manifestRawSha256", "motionRawSha256", "canonicalMotionSha256"] as const) hash(field(output, key, "C6B4b receipt output"));
  assertInventory(field(output, "nonReceiptInventory", "C6B4b receipt output"));
  const preserved = record(field(output, "preservedLeaves", "C6B4b receipt output"), ["sha256", "count"], "C6B4b receipt preserved leaves"); hash(field(preserved, "sha256", "C6B4b receipt preserved leaves")); positive(field(preserved, "count", "C6B4b receipt preserved leaves"), 1_024);
  const changed = record(field(output, "changed", "C6B4b receipt output"), ["paths", "count", "motionPropertyPaths", "motionPropertyPathCount"], "C6B4b receipt changed");
  const paths = strings(field(changed, "paths", "C6B4b receipt changed"), 2), properties = strings(field(changed, "motionPropertyPaths", "C6B4b receipt changed"), 1);
  if (paths.length !== 2 || !paths.includes(C6B4B_RECEIPT_PATH) || !paths.some((path) => path !== C6B4B_RECEIPT_PATH && packagePath(path)) || field(changed, "count", "C6B4b receipt changed") !== 2 || properties.length !== 1 || properties[0] !== "relations" || field(changed, "motionPropertyPathCount", "C6B4b receipt changed") !== 1) throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt changed-leaf evidence is invalid.");
  return output as unknown as CheckpointStoryboardRelationActionMaterializationReceipt["output"];
}

export function readC6B4bExactBase(value: unknown): C6B4bExactBase {
  const keys = ["packageId", "manifestRawSha256", "motionRawSha256", "manifestCanonicalSha256", "motionCanonicalSha256", "inventory", "planFingerprint", "profileFingerprint", "actionStoreSchema", "actionStoreSha256", "actionDefinitionId", "actionDefinitionSha256", "actionRequestInstanceId", "actionRequestSha256", "actionApplyPlanFingerprint", "actionObjects", "actionRelations", "actionKeyframeWrites", "actionChangedPath", "actionOutputCanonicalMotionSha256", "relationId", "storeSha256", "staticFingerprint", "gpuStaticFingerprint", "startFramePlanFingerprint", "endFramePlanFingerprint"] as const;
  const base = record(value, keys, "C6B4b receipt base");
  for (const key of ["packageId", "actionDefinitionId", "actionRequestInstanceId", "relationId"] as const) identifier(field(base, key, "C6B4b receipt base"));
  if (field(base, "actionStoreSchema", "C6B4b receipt base") !== "shellx-motion/relation-actions@2") throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt action-store schema is invalid.");
  if (field(base, "actionObjects", "C6B4b receipt base") !== 0 || field(base, "actionRelations", "C6B4b receipt base") !== 1 || field(base, "actionKeyframeWrites", "C6B4b receipt base") !== 0) throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt action counts are invalid.");
  const changedPath = field(base, "actionChangedPath", "C6B4b receipt base"); if (typeof changedPath !== "string" || changedPath !== `/relations/bindings/${field(base, "relationId", "C6B4b receipt base")}`) throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt action changed path is invalid.");
  for (const key of ["manifestRawSha256", "motionRawSha256", "manifestCanonicalSha256", "motionCanonicalSha256", "planFingerprint", "profileFingerprint", "actionStoreSha256", "actionDefinitionSha256", "actionRequestSha256", "actionApplyPlanFingerprint", "actionOutputCanonicalMotionSha256", "storeSha256", "staticFingerprint", "gpuStaticFingerprint", "startFramePlanFingerprint", "endFramePlanFingerprint"] as const) hash(field(base, key, "C6B4b receipt base"));
  assertInventory(field(base, "inventory", "C6B4b receipt base"));
  return base as unknown as C6B4bExactBase;
}

function assertInventory(value: unknown): void { const inventory = record(value, ["sha256", "entryCount", "leafCount"], "C6B4b receipt inventory"); hash(field(inventory, "sha256", "C6B4b receipt inventory")); positive(field(inventory, "entryCount", "C6B4b receipt inventory"), 2_048); positive(field(inventory, "leafCount", "C6B4b receipt inventory"), 1_024); }
function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> { const result = object(value, label); const actual = Reflect.ownKeys(result); if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key)) || keys.some((key) => !actual.includes(key))) throw new PackageEditTransactionError("copy_mismatch", `${label} has unsupported fields.`); return result as Record<string, unknown>; }
function object(value: unknown, label: string): object { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new PackageEditTransactionError("copy_mismatch", `${label} is invalid.`); return value; }
function field(value: object, key: string, label: string): unknown { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new PackageEditTransactionError("copy_mismatch", `${label}.${key} is invalid.`); return descriptor.value; }
function hash(value: unknown, label = "C6B4b receipt"): void { if (typeof value !== "string" || !HASH.test(value)) throw new PackageEditTransactionError("copy_mismatch", `${label} hash is invalid.`); }
function identifier(value: unknown): value is string { if (typeof value !== "string" || value.length < 1 || value.length > 128) throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt identifier is invalid."); return true; }
function positive(value: unknown, maximum: number): void { if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt count is invalid."); }
function strings(value: unknown, maximum: number): readonly string[] { if (!Array.isArray(value) || value.length < 1 || value.length > maximum || value.some((item) => typeof item !== "string") || value.some((item, index) => index > 0 && compareCodeUnits(value[index - 1] as string, item) >= 0)) throw new PackageEditTransactionError("copy_mismatch", "C6B4b receipt paths are invalid."); return value; }
function packagePath(value: string): boolean { return !!value && !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."); }
