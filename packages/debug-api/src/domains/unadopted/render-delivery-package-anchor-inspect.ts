/** Read-only C5B2 reopening of one imported package-local provider-anchor payload. */

import { join } from "node:path";
import {
  canonicalJsonSha256,
  loadMotionPackage,
  readBoundedStableFile,
  requiredLoadedPackageDocumentHashes,
  resolvePackageAsset,
  type MotionDocument,
  type MotionPackage,
  type StableFileReadResult,
} from "@shellx-motion/core";
import {
  parseMotionRenderDeliveryAnchorPayload,
} from "@shellx-motion/core/internal/render-delivery-source";
import {
  assertRenderDeliveryPackageImportReceipt,
  serializedRenderDeliveryPackageImportReceipt,
  type PackageIdentity,
  type RenderDeliveryPackageImportReceipt,
} from "./render-delivery-package-import-receipt.js";
import {
  withRenderDeliveryPackageWorkspaceAuthority,
  type RenderDeliveryPackageWorkspaceHost,
} from "./render-delivery-package-workspace.js";

const RECEIPT_PATH = "receipts/render-delivery-import.v1.json";
const MAX_RECEIPT_BYTES = 1024 * 1024;
const motionByInspection = new WeakMap<ImportedRenderDeliveryAnchorInspection, MotionDocument>();

export const MOTION_RENDER_DELIVERY_PACKAGE_ANCHOR_INSPECTION_SCHEMA = "shellx-motion/render-delivery-package-anchor-inspection/v1" as const;

export interface ImportedRenderDeliveryAnchorInspection {
  readonly schema: typeof MOTION_RENDER_DELIVERY_PACKAGE_ANCHOR_INSPECTION_SCHEMA;
  readonly fingerprint: string;
  readonly package: PackageIdentity;
  readonly receiptFingerprint: string;
  readonly delivery: {
    readonly fingerprint: string;
    readonly scheduleFingerprint: string;
    readonly rate: { readonly numerator: number; readonly denominator: number };
    readonly width: number;
    readonly height: number;
    readonly schedule: readonly { readonly index: number; readonly presentationTime: { readonly numerator: number; readonly denominator: number } }[];
  };
  readonly anchorAsset: {
    readonly sha256: string;
    readonly byteLength: number;
    readonly deliveryBindingSha256: string;
    readonly coordinateConvention: "screen-pixel-top-left-q1024";
  };
  /** Numeric provider identities only: no labels, paths, or provider authority are retained. */
  readonly anchors: readonly ImportedRenderDeliveryAnchorTrack[];
}

export interface ImportedRenderDeliveryAnchorTrack {
  readonly id: number;
  readonly visibility: { readonly visibleSamples: number; readonly notVisibleSamples: number };
  readonly samples: readonly ImportedRenderDeliveryAnchorSample[];
}

export type ImportedRenderDeliveryAnchorSample =
  | { readonly frameIndex: number; readonly visible: true; readonly xQ1024: number; readonly yQ1024: number }
  | { readonly frameIndex: number; readonly visible: false };

interface ReopenedImportedRenderDeliveryAnchors {
  readonly inspection: ImportedRenderDeliveryAnchorInspection;
  readonly motion: MotionDocument;
}

interface AnchorInspectionServices {
  /** Test-only gate after the initial receipt and anchor snapshot, before the final freshness reads. */
  readonly afterInitialAnchorSnapshot?: () => Promise<void>;
  /** Test-only gate after one unified reread and before the final unified reread. */
  readonly afterFinalAnchorSnapshot?: () => Promise<void>;
}

interface ReadReceiptResult {
  readonly receipt: RenderDeliveryPackageImportReceipt;
  readonly file: StableFileReadResult;
}

interface ReadAnchorResult {
  readonly file: StableFileReadResult;
  readonly payload: Awaited<ReturnType<typeof parseMotionRenderDeliveryAnchorPayload>>;
}

interface PackageAnchorEvidenceSet {
  readonly packageIdentity: PackageIdentity;
  readonly receipt: ReadReceiptResult;
  readonly anchor: ReadAnchorResult;
}

/** Reopen with only package-local receipt/anchor bytes; the prior provider authority is irrelevant. */
export async function inspectImportedRenderDeliveryAnchors(
  host: RenderDeliveryPackageWorkspaceHost,
  services: AnchorInspectionServices = {},
): Promise<ImportedRenderDeliveryAnchorInspection> {
  const reopened = await reopenImportedRenderDeliveryAnchors(host, services);
  motionByInspection.set(reopened.inspection, deepFreeze(structuredClone(reopened.motion)));
  return reopened.inspection;
}

/** One-shot private planner bridge; only this module can mint a receipt-verified inspection pairing. */
export function takeImportedRenderDeliveryAnchorInspectionMotion(
  inspection: ImportedRenderDeliveryAnchorInspection,
): MotionDocument {
  const motion = motionByInspection.get(inspection);
  if (!motion) throw new Error("Provider-anchor inspection has no current package Motion authority.");
  motionByInspection.delete(inspection);
  return motion;
}

/** Package-local reopen only; its Motion snapshot never leaves this module except through an opaque one-shot bridge. */
async function reopenImportedRenderDeliveryAnchors(
  host: RenderDeliveryPackageWorkspaceHost,
  services: AnchorInspectionServices = {},
): Promise<ReopenedImportedRenderDeliveryAnchors> {
  return await withRenderDeliveryPackageWorkspaceAuthority(host, async () => {
    const pkg = await loadMotionPackage(host.sourcePackageRoot);
    const initial = await collectPackageAnchorEvidence(pkg);
    await services.afterInitialAnchorSnapshot?.();
    assertSameEvidenceSet(initial, await collectPackageAnchorEvidence(pkg));
    await services.afterFinalAnchorSnapshot?.();
    const finalEvidence = await collectPackageAnchorEvidence(pkg);
    assertSameEvidenceSet(initial, finalEvidence);
    return Object.freeze({ inspection: inspectionFrom(initial.packageIdentity, initial.receipt.receipt, initial.anchor.file, initial.anchor.payload), motion: pkg.motion });
  });
}

async function collectPackageAnchorEvidence(pkg: MotionPackage): Promise<PackageAnchorEvidenceSet> {
  const packageIdentity = await currentPackageIdentity(pkg);
  const receipt = await readReceipt(pkg);
  if (!sameIdentity(packageIdentity, receipt.receipt.reopenedPackage)) {
    throw new Error("Imported provider delivery receipt does not bind the current package identity.");
  }
  const anchor = await readAnchor(pkg, receipt.receipt);
  const after = await currentPackageIdentity(pkg);
  if (!sameIdentity(packageIdentity, after)) {
    throw new Error("Imported package identity changed while provider-anchor evidence was collected.");
  }
  return { packageIdentity, receipt, anchor };
}

async function readReceipt(pkg: MotionPackage): Promise<ReadReceiptResult> {
  const file = await readBoundedStableFile(join(pkg.root, RECEIPT_PATH), {
    label: "Imported provider delivery receipt", maxBytes: MAX_RECEIPT_BYTES, withinRoot: pkg.root, requireSingleLink: true, captureIdentity: true,
  });
  let parsed: unknown;
  try { parsed = JSON.parse(file.bytes.toString("utf8")); }
  catch { throw new Error("Imported provider delivery receipt is not valid JSON."); }
  assertRenderDeliveryPackageImportReceipt(parsed);
  if (file.bytes.toString("utf8") !== serializedRenderDeliveryPackageImportReceipt(parsed)) {
    throw new Error("Imported provider delivery receipt is not canonical evidence.");
  }
  return { receipt: parsed, file };
}

async function readAnchor(pkg: MotionPackage, receipt: RenderDeliveryPackageImportReceipt): Promise<ReadAnchorResult> {
  const anchorFact = receipt.sourceManifest.anchors;
  if (!anchorFact || !receipt.delivery.anchors || !receipt.copiedOutput.anchors) {
    throw new Error("Imported package has no provider anchor payload to inspect.");
  }
  const file = await readBoundedStableFile(resolvePackageAsset(pkg, anchorFact.packagePath), {
    label: "Imported provider anchor payload", maxBytes: anchorFact.byteLength, withinRoot: pkg.root, requireSingleLink: true, captureIdentity: true,
  });
  if (file.byteLength !== anchorFact.byteLength || file.sha256 !== anchorFact.sha256
    || receipt.delivery.anchors.sha256 !== anchorFact.sha256 || receipt.delivery.anchors.frameCount !== anchorFact.frameCount
    || receipt.delivery.anchors.convention !== anchorFact.convention) {
    throw new Error("Imported provider anchor bytes do not match the delivery receipt.");
  }
  const payload = parseMotionRenderDeliveryAnchorPayload(file.bytes, receipt.delivery);
  if (payload.deliveryBindingSha256 !== anchorFact.deliveryBindingSha256 || payload.anchors.some((track) => track.samples.length !== receipt.delivery.schedule.length)) {
    throw new Error("Imported provider anchor payload does not bind the delivered schedule.");
  }
  return { file, payload };
}

async function currentPackageIdentity(pkg: MotionPackage): Promise<PackageIdentity> {
  const loaded = requiredLoadedPackageDocumentHashes(pkg, "Provider-anchor package inspection");
  const manifest = await readBoundedStableFile(join(pkg.root, "manifest.json"), {
    label: "Imported package manifest", maxBytes: 4 * 1024 * 1024, withinRoot: pkg.root, allowRootAlias: true, requireSingleLink: true,
  });
  const motion = await readBoundedStableFile(resolvePackageAsset(pkg, pkg.manifest.motion), {
    label: "Imported Motion document", maxBytes: 64 * 1024 * 1024, withinRoot: pkg.root, requireSingleLink: true,
  });
  if (loaded["manifest.json"] !== manifest.sha256 || loaded[pkg.manifest.motion] !== motion.sha256) {
    throw new Error("Imported package manifest or Motion bytes changed during inspection.");
  }
  return {
    packageId: pkg.manifest.id,
    manifestSha256: manifest.sha256,
    motionSha256: motion.sha256,
    assetInventorySha256: canonicalJsonSha256(pkg.manifest.assets),
  };
}

function inspectionFrom(
  packageIdentity: PackageIdentity,
  receipt: RenderDeliveryPackageImportReceipt,
  anchor: { readonly sha256: string; readonly byteLength: number },
  payload: Awaited<ReturnType<typeof parseMotionRenderDeliveryAnchorPayload>>,
): ImportedRenderDeliveryAnchorInspection {
  const anchors = payload.anchors.map((track) => {
    const samples = track.samples.map((sample) => sample.state === "visible"
      ? { frameIndex: sample.frameIndex, visible: true as const, xQ1024: sample.xQ1024, yQ1024: sample.yQ1024 }
      : { frameIndex: sample.frameIndex, visible: false as const });
    return {
      id: track.id,
      visibility: { visibleSamples: samples.filter((sample) => sample.visible).length, notVisibleSamples: samples.filter((sample) => !sample.visible).length },
      samples,
    };
  });
  const payloadForFingerprint = {
    schema: MOTION_RENDER_DELIVERY_PACKAGE_ANCHOR_INSPECTION_SCHEMA,
    package: packageIdentity,
    receiptFingerprint: receipt.fingerprint,
    delivery: {
      fingerprint: receipt.deliveryFingerprint,
      scheduleFingerprint: receipt.delivery.identity.scheduleSha256,
      rate: receipt.delivery.rate,
      width: beautyPass(receipt).width,
      height: beautyPass(receipt).height,
      schedule: receipt.delivery.schedule,
    },
    anchorAsset: {
      sha256: anchor.sha256, byteLength: anchor.byteLength,
      deliveryBindingSha256: payload.deliveryBindingSha256,
      coordinateConvention: payload.coordinateConvention,
    },
    anchors,
  };
  return deepFreeze({ ...payloadForFingerprint, fingerprint: canonicalJsonSha256(payloadForFingerprint) });
}

function beautyPass(receipt: RenderDeliveryPackageImportReceipt): { readonly width: number; readonly height: number } {
  const beauty = receipt.delivery.passes.find((pass) => pass.kind === "beauty");
  if (!beauty) throw new Error("Imported provider delivery receipt has no beauty pass dimensions.");
  return { width: beauty.width, height: beauty.height };
}

function sameIdentity(left: PackageIdentity, right: PackageIdentity): boolean {
  return left.packageId === right.packageId && left.manifestSha256 === right.manifestSha256
    && left.motionSha256 === right.motionSha256 && left.assetInventorySha256 === right.assetInventorySha256;
}

function sameStableRead(left: StableFileReadResult, right: StableFileReadResult): boolean {
  const leftIdentity = left.identity, rightIdentity = right.identity;
  return left.sha256 === right.sha256 && left.byteLength === right.byteLength && !!leftIdentity && !!rightIdentity
    && leftIdentity.dev === rightIdentity.dev && leftIdentity.ino === rightIdentity.ino && leftIdentity.nlink === rightIdentity.nlink
    && leftIdentity.byteLength === rightIdentity.byteLength && leftIdentity.mtimeMs === rightIdentity.mtimeMs && leftIdentity.ctimeMs === rightIdentity.ctimeMs;
}

function assertSameEvidenceSet(initial: PackageAnchorEvidenceSet, current: PackageAnchorEvidenceSet): void {
  if (!sameIdentity(initial.packageIdentity, current.packageIdentity)) {
    throw new Error("Imported package identity changed while provider anchors were inspected.");
  }
  if (!sameStableRead(initial.receipt.file, current.receipt.file)
    || initial.receipt.receipt.fingerprint !== current.receipt.receipt.fingerprint) {
    throw new Error("Imported provider delivery receipt changed while provider anchors were inspected.");
  }
  if (!sameStableRead(initial.anchor.file, current.anchor.file)
    || initial.anchor.payload.deliveryBindingSha256 !== current.anchor.payload.deliveryBindingSha256) {
    throw new Error("Imported provider anchor bytes changed while they were inspected.");
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
