import { canonicalJson, canonicalJsonSha256 } from "@shellx-motion/core";
import {
  describeMotionRenderDelivery,
  deriveMotionRenderDeliveryImportPlan,
  MAX_RENDER_DELIVERY_ANCHOR_BYTES,
  MAX_RENDER_DELIVERY_BEAUTY_FRAME_BYTES,
  MAX_RENDER_DELIVERY_SEQUENCE_BYTES,
  renderDeliveryAnchorDeliveryBindingSha256,
  renderDeliveryFingerprint,
  renderDeliverySourceManifestFingerprint,
  type MotionRenderDeliverySourceManifest,
} from "@shellx-motion/core/internal/render-delivery-source";
import { PackageEditTransactionError } from "../package-edit-transaction-error.js";

export interface PackageIdentity {
  readonly packageId: string;
  readonly manifestSha256: string;
  readonly motionSha256: string;
  readonly assetInventorySha256: string;
}

export interface RenderDeliveryPackageImportReceipt {
  readonly schema: "shellx-motion/render-delivery-package-import-receipt/v1";
  /** Canonical payload hash; integrity evidence only, never execution authority. */
  readonly fingerprint: string;
  readonly delivery: MotionRenderDeliverySourceManifest["delivery"];
  readonly deliveryFingerprint: string;
  readonly plan: MotionRenderDeliverySourceManifest["plan"];
  readonly planFingerprint: string;
  readonly sourceManifest: {
    readonly fingerprint: string;
    readonly sourceByteLength: number;
    readonly beauty: MotionRenderDeliverySourceManifest["sources"]["beauty"];
    readonly anchors?: NonNullable<MotionRenderDeliverySourceManifest["sources"]["anchors"]>;
  };
  readonly packageInput: PackageIdentity;
  readonly copiedOutput: {
    readonly assetCount: number;
    readonly byteLength: number;
    readonly beauty: MotionRenderDeliverySourceManifest["sources"]["beauty"];
    readonly anchors?: NonNullable<MotionRenderDeliverySourceManifest["sources"]["anchors"]>;
  };
  readonly reopenedPackage: PackageIdentity;
  readonly cow: { readonly outcome: "installed" };
}

export function createRenderDeliveryPackageImportReceipt(
  manifest: MotionRenderDeliverySourceManifest,
  packageInput: PackageIdentity,
  reopenedPackage: PackageIdentity,
): RenderDeliveryPackageImportReceipt {
  const payload = {
    schema: "shellx-motion/render-delivery-package-import-receipt/v1" as const,
    delivery: manifest.delivery, deliveryFingerprint: manifest.deliveryFingerprint,
    plan: manifest.plan, planFingerprint: canonicalJsonSha256(manifest.plan),
    sourceManifest: {
      fingerprint: manifest.fingerprint, sourceByteLength: manifest.sourceByteLength, beauty: manifest.sources.beauty,
      ...(manifest.sources.anchors ? { anchors: manifest.sources.anchors } : {}),
    },
    packageInput,
    copiedOutput: {
      assetCount: manifest.sources.beauty.length + (manifest.sources.anchors ? 1 : 0),
      byteLength: manifest.sourceByteLength,
      beauty: manifest.sources.beauty,
      ...(manifest.sources.anchors ? { anchors: manifest.sources.anchors } : {}),
    },
    reopenedPackage, cow: { outcome: "installed" as const },
  };
  return deepFreeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

export function serializedRenderDeliveryPackageImportReceipt(receipt: RenderDeliveryPackageImportReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

/** Structural/integrity check for durable evidence only; it grants neither execution nor package authority. */
export function assertRenderDeliveryPackageImportReceipt(value: unknown): asserts value is RenderDeliveryPackageImportReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidReceipt();
  const record = value as Record<string, unknown>;
  const keys = ["schema", "fingerprint", "delivery", "deliveryFingerprint", "plan", "planFingerprint", "sourceManifest", "packageInput", "copiedOutput", "reopenedPackage", "cow"];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))
    || record.schema !== "shellx-motion/render-delivery-package-import-receipt/v1"
    || !hash(record.fingerprint) || !hash(record.deliveryFingerprint) || !hash(record.planFingerprint)
    || !record.delivery || !record.plan || !sourceManifestShape(record.sourceManifest)
    || !packageIdentityShape(record.packageInput) || !copiedOutputShape(record.copiedOutput)
    || !packageIdentityShape(record.reopenedPackage) || !cowShape(record.cow)) throw invalidReceipt();
  if (!receiptCrossBindings(record)) throw invalidReceipt();
  const { fingerprint: _fingerprint, ...payload } = record;
  if (canonicalJsonSha256(payload) !== record.fingerprint) {
    throw new PackageEditTransactionError("copy_mismatch", "Provider delivery package receipt fingerprint does not match its payload.");
  }
}

function sourceManifestShape(value: unknown): boolean {
  const record = exactRecord(value, ["fingerprint", "sourceByteLength", "beauty"], ["anchors"]);
  return !!record && hash(record.fingerprint) && integer(record.sourceByteLength) && Array.isArray(record.beauty)
    && record.beauty.every(beautySourceFactShape) && (record.anchors === undefined || anchorSourceFactShape(record.anchors));
}
function copiedOutputShape(value: unknown): boolean {
  const record = exactRecord(value, ["assetCount", "byteLength", "beauty"], ["anchors"]);
  return !!record && integer(record.assetCount) && integer(record.byteLength) && Array.isArray(record.beauty)
    && record.assetCount === record.beauty.length + (record.anchors === undefined ? 0 : 1)
    && record.beauty.every(beautySourceFactShape) && (record.anchors === undefined || anchorSourceFactShape(record.anchors));
}
function beautySourceFactShape(value: unknown): boolean {
  const record = exactRecord(value, ["role", "frameIndex", "packagePath", "sha256", "byteLength"]);
  return !!record && record.role === "beauty" && integer(record.frameIndex) && packagePath(record.packagePath) && hash(record.sha256)
    && integer(record.byteLength) && record.byteLength <= MAX_RENDER_DELIVERY_BEAUTY_FRAME_BYTES;
}
function anchorSourceFactShape(value: unknown): boolean {
  const record = exactRecord(value, ["role", "packagePath", "sha256", "byteLength", "schema", "deliveryBindingSha256", "frameCount", "convention"]);
  return !!record && record.role === "anchors" && packagePath(record.packagePath) && hash(record.sha256)
    && integer(record.byteLength) && record.byteLength <= MAX_RENDER_DELIVERY_ANCHOR_BYTES
    && record.schema === "motion.render-provider-anchor-payload/v1" && hash(record.deliveryBindingSha256)
    && integer(record.frameCount) && record.convention === "screen-pixel-top-left-q1024";
}
function receiptCrossBindings(record: Record<string, unknown>): boolean {
  try {
    const delivery = describeMotionRenderDelivery(record.delivery);
    const source = plainRecord(record.sourceManifest);
    const copied = plainRecord(record.copiedOutput);
    if (!delivery.ok || !source || !copied || delivery.fingerprint !== record.deliveryFingerprint
      || renderDeliveryFingerprint(delivery.delivery) !== record.deliveryFingerprint) return false;

    const expectedPlan = deriveMotionRenderDeliveryImportPlan(delivery.delivery, delivery.fingerprint);
    if (!canonicalExactEqual(record.plan, expectedPlan) || canonicalJsonSha256(record.plan) !== record.planFingerprint) return false;

    const sourceHasAnchor = hasOwn(source, "anchors");
    const copiedHasAnchor = hasOwn(copied, "anchors");
    const expectedAnchor = expectedPlan.assets.anchors;
    if (sourceHasAnchor !== copiedHasAnchor || sourceHasAnchor !== (expectedAnchor !== undefined)) return false;
    const beauty = source.beauty as unknown[];
    const sourceFacts = { beauty, ...(sourceHasAnchor ? { anchors: source.anchors } : {}) };
    const sum = byteLengthOf(sourceFacts.beauty, sourceFacts.anchors);
    if (sum === undefined || sum > MAX_RENDER_DELIVERY_SEQUENCE_BYTES || source.sourceByteLength !== sum || copied.byteLength !== sum
      || copied.assetCount !== sourceFacts.beauty.length + (sourceHasAnchor ? 1 : 0)
      || !beautyFactsMatchPlan(sourceFacts.beauty, expectedPlan.assets.beauty)
      || !canonicalExactEqual(sourceFacts.beauty, copied.beauty)
      || renderDeliverySourceManifestFingerprint(delivery.fingerprint, expectedPlan, sourceFacts as MotionRenderDeliverySourceManifest["sources"], sum) !== source.fingerprint) return false;

    if (!expectedAnchor) return !sourceHasAnchor && !copiedHasAnchor;
    if (!sourceHasAnchor || !copiedHasAnchor || !anchorSourceFactShape(source.anchors) || !anchorSourceFactShape(copied.anchors)) return false;
    const sourceAnchor = source.anchors as Record<string, unknown>;
    const copiedAnchor = copied.anchors as Record<string, unknown>;
    return canonicalExactEqual(sourceAnchor, copiedAnchor)
      && anchorFactMatchesPlan(sourceAnchor, expectedAnchor)
      && sourceAnchor.deliveryBindingSha256 === renderDeliveryAnchorDeliveryBindingSha256(delivery.delivery);
  } catch {
    return false;
  }
}
function beautyFactsMatchPlan(facts: readonly unknown[], expected: MotionRenderDeliverySourceManifest["plan"]["assets"]["beauty"]): boolean {
  return facts.length === expected.length && facts.every((fact, index) => {
    const source = plainRecord(fact);
    const asset = expected[index]!;
    return !!source && source.role === asset.role && source.frameIndex === asset.frameIndex
      && source.sha256 === asset.sha256 && source.packagePath === asset.packagePath;
  });
}
function anchorFactMatchesPlan(fact: Record<string, unknown>, expected: NonNullable<MotionRenderDeliverySourceManifest["plan"]["assets"]["anchors"]>): boolean {
  return fact.role === expected.role && fact.sha256 === expected.sha256 && fact.packagePath === expected.packagePath
    && fact.schema === expected.schema && fact.deliveryBindingSha256 === expected.deliveryBindingSha256
    && fact.frameCount === expected.frameCount && fact.convention === expected.convention;
}
function byteLengthOf(beauty: unknown, anchor: unknown): number | undefined {
  if (!Array.isArray(beauty)) return undefined;
  let total = 0;
  for (const fact of beauty) {
    const source = plainRecord(fact);
    if (!source || !integer(source.byteLength) || total > Number.MAX_SAFE_INTEGER - source.byteLength) return undefined;
    total += source.byteLength;
  }
  if (anchor !== undefined) {
    const source = plainRecord(anchor);
    if (!source || !integer(source.byteLength) || total > Number.MAX_SAFE_INTEGER - source.byteLength) return undefined;
    total += source.byteLength;
  }
  return total;
}
function packageIdentityShape(value: unknown): boolean { const record = plainRecord(value); return !!record && typeof record.packageId === "string" && hash(record.manifestSha256) && hash(record.motionSha256) && hash(record.assetInventorySha256); }
function cowShape(value: unknown): boolean { const record = plainRecord(value); return !!record && Object.keys(record).length === 1 && record.outcome === "installed"; }
function packagePath(value: unknown): value is string { return typeof value === "string" && value.startsWith("assets/"); }
function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  const record = plainRecord(value);
  if (!record) return undefined;
  const keys = Object.keys(record);
  const allowed = new Set([...required, ...optional]);
  return keys.length >= required.length && keys.every((key) => allowed.has(key)) && required.every((key) => Object.prototype.hasOwnProperty.call(record, key)) ? record : undefined;
}
function hasOwn(value: Record<string, unknown>, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function canonicalExactEqual(value: unknown, expected: unknown): boolean { return exactDataEqual(value, expected) && canonicalJson(value) === canonicalJson(expected); }
function exactDataEqual(value: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return typeof expected === "number" ? typeof value === "number" && Number.isFinite(value) && value === expected : value === expected;
  if (Array.isArray(expected)) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== expected.length) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length > 0 || Object.keys(descriptors).length !== value.length + 1) return false;
    return expected.every((item, index) => {
      const descriptor = descriptors[String(index)];
      return !!descriptor && descriptor.enumerable && "value" in descriptor && exactDataEqual(descriptor.value, item);
    });
  }
  const record = plainRecord(value);
  if (!record || ![Object.prototype, null].includes(Object.getPrototypeOf(record))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(record);
  const expectedRecord = expected as Record<string, unknown>;
  const expectedKeys = Object.keys(expectedRecord);
  if (Object.getOwnPropertySymbols(record).length > 0 || Object.keys(descriptors).length !== expectedKeys.length) return false;
  return expectedKeys.every((key) => {
    const descriptor = descriptors[key];
    return !!descriptor && descriptor.enumerable && "value" in descriptor && exactDataEqual(descriptor.value, expectedRecord[key]);
  });
}
function plainRecord(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function invalidReceipt(): PackageEditTransactionError { return new PackageEditTransactionError("copy_mismatch", "Provider delivery package receipt has an invalid structural shape."); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
