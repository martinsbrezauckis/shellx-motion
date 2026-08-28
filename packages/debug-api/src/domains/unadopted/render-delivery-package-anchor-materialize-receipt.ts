/** Durable C5B3 evidence for one private COW provider-anchor keyframe materialization. */

import { canonicalJsonSha256, type UnrenderablePackageRefusal } from "@shellx-motion/core";
import type { RenderDeliveryAnchorKeyframeIntentPlan, RenderDeliveryAnchorKeyframeIntentRequest } from "./render-delivery-package-anchor-bake-plan.js";
import type { PackageIdentity } from "./render-delivery-package-import-receipt.js";

export const RENDER_DELIVERY_ANCHOR_KEYFRAME_MATERIALIZATION_RECEIPT_SCHEMA = "shellx-motion/render-delivery-anchor-keyframe-materialization-receipt/v1" as const;

/** Compact durable B3 evidence; the full immutable B2 plan is bound by fingerprint and must be rederived. */
export interface RenderDeliveryAnchorKeyframeMaterializationPlanEvidence {
  readonly schema: RenderDeliveryAnchorKeyframeIntentPlan["schema"];
  readonly fingerprint: string;
  readonly operation: "keyframe-intent";
  readonly requestFingerprint: string;
  readonly timing: RenderDeliveryAnchorKeyframeIntentPlan["timing"];
  readonly limits: RenderDeliveryAnchorKeyframeIntentPlan["limits"];
  readonly counts: RenderDeliveryAnchorKeyframeIntentPlan["counts"];
  readonly mappings: readonly Pick<RenderDeliveryAnchorKeyframeIntentPlan["mappings"][number], "anchorId" | "target">[];
  readonly changedPathIntents: readonly string[];
}

export interface RenderDeliveryAnchorKeyframeMaterializationReceipt {
  readonly schema: typeof RENDER_DELIVERY_ANCHOR_KEYFRAME_MATERIALIZATION_RECEIPT_SCHEMA;
  /** Canonical payload hash; integrity evidence only, never package or execution authority. */
  readonly fingerprint: string;
  readonly source: {
    readonly expectedBase: Pick<PackageIdentity, "packageId" | "manifestSha256" | "motionSha256">;
    readonly package: PackageIdentity;
    readonly inspectionFingerprint: string;
    readonly importReceiptFingerprint: string;
    readonly delivery: RenderDeliveryAnchorKeyframeIntentPlan["inspection"]["delivery"];
    readonly anchorAsset: RenderDeliveryAnchorKeyframeIntentPlan["inspection"]["anchorAsset"];
    readonly request: RenderDeliveryAnchorKeyframeIntentRequest;
  };
  readonly plan: RenderDeliveryAnchorKeyframeMaterializationPlanEvidence;
  readonly output: {
    readonly package: PackageIdentity;
    /** SHA-256 of the exact pretty-JSON Motion bytes persisted in motion.json. */
    readonly persistedMotionSha256: string;
    /** Canonical object fingerprint used for graph/compositing idempotence evidence. */
    readonly canonicalMotionFingerprint: string;
    readonly renderTruth: { readonly lanes: readonly string[]; readonly unrenderable: UnrenderablePackageRefusal | null };
  };
  /** The receipt is written before private workspace cleanup, so it records only the truthful transaction-owned state. */
  readonly cow: { readonly outcome: "installed"; readonly cleanup: "transaction-owned"; readonly receipt: "exclusive-absent" };
}

export function createRenderDeliveryAnchorKeyframeMaterializationReceipt(input: {
  readonly expectedBase: Pick<PackageIdentity, "packageId" | "manifestSha256" | "motionSha256">;
  readonly sourcePackage: PackageIdentity;
  readonly request: RenderDeliveryAnchorKeyframeIntentRequest;
  readonly plan: RenderDeliveryAnchorKeyframeIntentPlan;
  readonly outputPackage: PackageIdentity;
  readonly canonicalMotionFingerprint: string;
  readonly renderTruth: { readonly lanes: readonly string[]; readonly unrenderable: UnrenderablePackageRefusal | null };
}): RenderDeliveryAnchorKeyframeMaterializationReceipt {
  const payload = {
    schema: RENDER_DELIVERY_ANCHOR_KEYFRAME_MATERIALIZATION_RECEIPT_SCHEMA,
    source: {
      expectedBase: input.expectedBase,
      package: input.sourcePackage,
      inspectionFingerprint: input.plan.inspection.fingerprint,
      importReceiptFingerprint: input.plan.inspection.receiptFingerprint,
      delivery: input.plan.inspection.delivery,
      anchorAsset: input.plan.inspection.anchorAsset,
      request: input.request,
    },
    plan: planEvidence(input.plan),
    output: {
      package: input.outputPackage,
      persistedMotionSha256: input.outputPackage.motionSha256,
      canonicalMotionFingerprint: input.canonicalMotionFingerprint,
      renderTruth: input.renderTruth,
    },
    cow: { outcome: "installed" as const, cleanup: "transaction-owned" as const, receipt: "exclusive-absent" as const },
  };
  assertReceiptBindings(payload);
  return deepFreeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

export function serializedRenderDeliveryAnchorKeyframeMaterializationReceipt(receipt: RenderDeliveryAnchorKeyframeMaterializationReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

/** Structural/integrity proof for durable evidence only. Future execution must reopen and rederive. */
export function assertRenderDeliveryAnchorKeyframeMaterializationReceipt(value: unknown): asserts value is RenderDeliveryAnchorKeyframeMaterializationReceipt {
  const record = plainRecord(value);
  if (!record || !exactKeys(record, ["schema", "fingerprint", "source", "plan", "output", "cow"])
    || record.schema !== RENDER_DELIVERY_ANCHOR_KEYFRAME_MATERIALIZATION_RECEIPT_SCHEMA || !hash(record.fingerprint)
    || !plainRecord(record.source) || !plainRecord(record.plan) || !plainRecord(record.output) || !plainRecord(record.cow)) throw invalidReceipt();
  const { fingerprint, ...payload } = record;
  if (canonicalJsonSha256(payload) !== fingerprint) throw invalidReceipt();
  assertReceiptBindings(payload);
}

function assertReceiptBindings(payload: Record<string, unknown>): void {
  const source = plainRecord(payload.source), plan = plainRecord(payload.plan), output = plainRecord(payload.output), cow = plainRecord(payload.cow);
  if (!source || !plan || !output || !cow
    || !exactKeys(source, ["expectedBase", "package", "inspectionFingerprint", "importReceiptFingerprint", "delivery", "anchorAsset", "request"])
    || !exactKeys(output, ["package", "persistedMotionSha256", "canonicalMotionFingerprint", "renderTruth"])
    || !exactKeys(cow, ["outcome", "cleanup", "receipt"])
    || cow.outcome !== "installed" || cow.cleanup !== "transaction-owned" || cow.receipt !== "exclusive-absent") throw invalidReceipt();
  if (!baseIdentity(source.expectedBase) || !packageIdentity(source.package) || !packageIdentity(output.package)
    || !hash(source.inspectionFingerprint) || !hash(source.importReceiptFingerprint) || !hash(output.persistedMotionSha256) || !hash(output.canonicalMotionFingerprint)
    || !intentRequest(source.request) || !deliveryShape(source.delivery) || !anchorAssetShape(source.anchorAsset) || !planShape(plan) || !renderTruth(output.renderTruth)) throw invalidReceipt();
  if (source.expectedBase.packageId !== source.package.packageId
    || source.expectedBase.manifestSha256 !== source.package.manifestSha256 || source.expectedBase.motionSha256 !== source.package.motionSha256
    || plainRecord(source.request)!.inspectionFingerprint !== source.inspectionFingerprint
    || plainRecord(source.request)!.receiptFingerprint !== source.importReceiptFingerprint
    || plan.requestFingerprint !== canonicalJsonSha256(source.request)
    || !planEvidenceBindsDelivery(plan, plainRecord(source.delivery)!)
    || output.persistedMotionSha256 !== output.package.motionSha256) throw invalidReceipt();
}

function planShape(value: Record<string, unknown>): boolean {
  return exactKeys(value, ["schema", "fingerprint", "operation", "requestFingerprint", "timing", "limits", "counts", "mappings", "changedPathIntents"])
    && value.schema === "shellx-motion/render-delivery-anchor-keyframe-intent-plan/v1" && value.operation === "keyframe-intent"
    && hash(value.fingerprint) && hash(value.requestFingerprint)
    && timingShape(value.timing) && limitShape(value.limits) && countShape(value.counts)
    && Array.isArray(value.mappings) && value.mappings.every(planMappingShape) && Array.isArray(value.changedPathIntents)
    && value.changedPathIntents.every((path) => typeof path === "string") && planCountsAndPaths(value);
}
function intentRequest(value: unknown): boolean {
  const record = plainRecord(value);
  return !!record && exactKeys(record, ["schema", "inspectionFingerprint", "receiptFingerprint", "mappings"])
    && record.schema === "shellx-motion/render-delivery-anchor-keyframe-intent-request/v1" && hash(record.inspectionFingerprint)
    && hash(record.receiptFingerprint) && Array.isArray(record.mappings) && record.mappings.length >= 1 && record.mappings.length <= 16
    && record.mappings.every(requestMappingShape);
}
function deliveryShape(value: unknown): boolean {
  const record = plainRecord(value), rate = record && plainRecord(record.rate);
  return !!record && !!rate && exactKeys(record, ["fingerprint", "scheduleFingerprint", "rate", "width", "height", "schedule"])
    && hash(record.fingerprint) && hash(record.scheduleFingerprint) && exactKeys(rate, ["numerator", "denominator"])
    && positiveInteger(rate.numerator) && positiveInteger(rate.denominator) && positiveInteger(record.width) && positiveInteger(record.height)
    && Array.isArray(record.schedule) && record.schedule.length >= 1 && record.schedule.every(scheduleFrameShape);
}
function scheduleFrameShape(value: unknown): boolean {
  const record = plainRecord(value), time = record && plainRecord(record.presentationTime);
  return !!record && !!time && exactKeys(record, ["index", "presentationTime"]) && nonNegativeInteger(record.index)
    && exactKeys(time, ["numerator", "denominator"]) && nonNegativeInteger(time.numerator) && positiveInteger(time.denominator);
}
function anchorAssetShape(value: unknown): boolean {
  const record = plainRecord(value);
  return !!record && exactKeys(record, ["sha256", "byteLength", "deliveryBindingSha256", "coordinateConvention"])
    && hash(record.sha256) && nonNegativeInteger(record.byteLength) && hash(record.deliveryBindingSha256)
    && record.coordinateConvention === "screen-pixel-top-left-q1024";
}
function timingShape(value: unknown): boolean {
  const record = plainRecord(value), coverage = record && plainRecord(record.coverage);
  return !!record && !!coverage && exactKeys(record, ["scheduleFingerprint", "derivedAtMs", "derivedAtMsFingerprint", "coverage"])
    && hash(record.scheduleFingerprint) && Array.isArray(record.derivedAtMs) && record.derivedAtMs.length >= 1
    && record.derivedAtMs.every((atMs) => typeof atMs === "number" && Number.isFinite(atMs) && atMs >= 0)
    && hash(record.derivedAtMsFingerprint) && canonicalJsonSha256(record.derivedAtMs) === record.derivedAtMsFingerprint
    && exactKeys(coverage, ["policy", "endMs"]) && coverage.policy === "final-frame-interval-at-most"
    && typeof coverage.endMs === "number" && Number.isFinite(coverage.endMs) && coverage.endMs > 0;
}
function limitShape(value: unknown): boolean { const record = plainRecord(value); return !!record && exactKeys(record, ["maxMappings", "maxSamples", "maxKeyframeWrites"]) && record.maxMappings === 16 && record.maxSamples === 3600 && record.maxKeyframeWrites === 7200; }
function countShape(value: unknown): boolean { const record = plainRecord(value); return !!record && exactKeys(record, ["mappings", "samples", "keyframeWrites"]) && nonNegativeInteger(record.mappings) && nonNegativeInteger(record.samples) && nonNegativeInteger(record.keyframeWrites); }
function requestMappingShape(value: unknown): boolean {
  const record = plainRecord(value), offset = record && plainRecord(record.localTargetAnchorOffsetQ1024);
  return !!record && !!offset && exactKeys(record, ["anchorId", "targetLayerId", "localTargetAnchorOffsetQ1024"])
    && positiveInteger(record.anchorId) && typeof record.targetLayerId === "string" && record.targetLayerId.length > 0
    && exactKeys(offset, ["xQ1024", "yQ1024"]) && integerInRange(offset.xQ1024, 1_048_576) && integerInRange(offset.yQ1024, 1_048_576);
}
function planMappingShape(value: unknown): boolean {
  const record = plainRecord(value), target = record && plainRecord(record.target), base = target && plainRecord(target.baseTransform), offset = target && plainRecord(target.localTargetAnchorOffsetQ1024);
  return !!record && !!target && !!base && !!offset && exactKeys(record, ["anchorId", "target"])
    && positiveInteger(record.anchorId) && exactKeys(target, ["layerId", "layerIndex", "baseTransform", "localTargetAnchorOffsetQ1024"])
    && typeof target.layerId === "string" && target.layerId.length > 0 && nonNegativeInteger(target.layerIndex)
    && exactKeys(base, ["x", "y"]) && finite(base.x) && finite(base.y)
    && exactKeys(offset, ["xQ1024", "yQ1024"]) && integerInRange(offset.xQ1024, 1_048_576) && integerInRange(offset.yQ1024, 1_048_576);
}
function planCountsAndPaths(plan: Record<string, unknown>): boolean {
  const timing = plainRecord(plan.timing)!, counts = plainRecord(plan.counts)!, mappings = plan.mappings as unknown[], paths = plan.changedPathIntents as unknown[];
  if (counts.mappings !== mappings.length || counts.samples !== (timing.derivedAtMs as unknown[]).length * mappings.length || counts.keyframeWrites !== counts.samples * 2 || counts.mappings > 16 || counts.samples > 3600 || counts.keyframeWrites > 7200 || paths.length !== mappings.length * 2) return false;
  return mappings.every((mapping, index) => {
    const target = plainRecord(mapping)!.target as Record<string, unknown>, layerIndex = target.layerIndex;
    return paths[index * 2] === `/layers/${layerIndex}/keyframes/transform.x` && paths[index * 2 + 1] === `/layers/${layerIndex}/keyframes/transform.y`;
  });
}
function planEvidenceBindsDelivery(plan: Record<string, unknown>, delivery: Record<string, unknown>): boolean {
  const timing = plainRecord(plan.timing)!;
  return timing.scheduleFingerprint === delivery.scheduleFingerprint;
}
function baseIdentity(value: unknown): value is Pick<PackageIdentity, "packageId" | "manifestSha256" | "motionSha256"> {
  const record = plainRecord(value);
  return !!record && exactKeys(record, ["packageId", "manifestSha256", "motionSha256"])
    && typeof record.packageId === "string" && record.packageId.length > 0 && hash(record.manifestSha256) && hash(record.motionSha256);
}
function packageIdentity(value: unknown): value is PackageIdentity {
  const record = plainRecord(value);
  return !!record && exactKeys(record, ["packageId", "manifestSha256", "motionSha256", "assetInventorySha256"])
    && typeof record.packageId === "string" && record.packageId.length > 0 && hash(record.manifestSha256)
    && hash(record.motionSha256) && hash(record.assetInventorySha256);
}
function renderTruth(value: unknown): boolean {
  const record = plainRecord(value);
  const refusal = record?.unrenderable;
  return !!record && exactKeys(record, ["lanes", "unrenderable"]) && Array.isArray(record.lanes)
    && record.lanes.every((lane) => typeof lane === "string") && (refusal === null || refusalShape(refusal));
}
function refusalShape(value: unknown): boolean {
  const record = plainRecord(value);
  return !!record && exactKeys(record, ["code", "message", "suggestedAction", "layers"])
    && record.code === "package_unrenderable" && typeof record.message === "string" && typeof record.suggestedAction === "string"
    && Array.isArray(record.layers) && record.layers.every((layer) => {
      const item = plainRecord(layer);
      return !!item && exactKeys(item, ["layerId", "type"]) && typeof item.layerId === "string" && typeof item.type === "string";
    });
}
function plainRecord(value: unknown): Record<string, any> | undefined { return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, any> : undefined; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value); return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function nonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function integerInRange(value: unknown, range: number): boolean { return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= range; }
function finite(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value); }
function invalidReceipt(): never { throw new Error("Provider-anchor keyframe materialization receipt is structurally invalid."); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
function planEvidence(plan: RenderDeliveryAnchorKeyframeIntentPlan): RenderDeliveryAnchorKeyframeMaterializationPlanEvidence {
  return {
    schema: plan.schema, fingerprint: plan.fingerprint, operation: plan.operation, requestFingerprint: plan.request.fingerprint,
    timing: plan.timing, limits: plan.limits, counts: plan.counts,
    mappings: plan.mappings.map((mapping) => ({ anchorId: mapping.anchorId, target: mapping.target })),
    changedPathIntents: plan.changedPathIntents,
  };
}
