/** Exact parsers for static layout and C2-restored removal authority host records. */
import { canonicalJson, type OperationReceipt } from "@shellx-motion/core";
import type { StablePathIdentity } from "./timeline-layout-application-authority-store.js";

export const AUTHORITY_SCHEMA = "shellx-motion/timeline-layout-application-authority@2" as const;
export const LEGACY_AUTHORITY_SCHEMA = "shellx-motion/timeline-layout-application-authority@1" as const;
export const RESTORED_GAP_AUTHORITY_SCHEMA = "shellx-motion/timeline-layout-gap-animation-restored-authority@1" as const;
const MAX_STABLE_PATH_CHARS = 4_096;

export interface PackageLineage extends StablePathIdentity {
  manifestId: string;
  manifestSha256: string;
  motionSha256: string;
  motionCanonicalSha256: string;
}

export interface LayoutApplicationAuthority {
  schema: typeof AUTHORITY_SCHEMA;
  authorityKey: string;
  receiptId: string;
  receiptSha256: string;
  receiptsRoot: StablePathIdentity;
  package: PackageLineage;
  application: { id: string; fingerprint: string };
  receipt: {
    operation: "timeline.layout.apply";
    lane: "debug-api";
    status: "passed" | "warning";
    packageId: string;
    applicationId: string;
    applicationFingerprint: string;
    outputMotionSha256: string;
  };
}

export interface RestoredGapAuthority {
  schema: typeof RESTORED_GAP_AUTHORITY_SCHEMA;
  authorityKey: string;
  receiptsRoot: StablePathIdentity;
  package: PackageLineage;
  application: { id: string; fingerprint: string };
  sourceAuthorityKey: string;
  static: { layoutApplicationsSha256: string; applicationSha256: string; directChildrenSha256: string; patchesSha256: string };
  teardown: { receiptId: string; receiptSha256: string; operation: "timeline.layout-gap-animation.track.remove"; status: "passed" | "warning"; packageId: string; outputMotionSha256: string };
}

export function readApplyReceiptFacts(
  value: unknown,
  receiptId: string,
  packageId: string,
  applicationId: string,
  applicationFingerprint: string,
): LayoutApplicationAuthority["receipt"] {
  const receipt = record(value, "apply receipt");
  // `artifacts` is optional on the durable receipt type for pre-artifact records, but every
  // newly emitted timeline COW receipt carries it. Keep the envelope closed to this known
  // compatibility field rather than treating a newer receipt as an arbitrary record.
  exactKnownKeys(
    receipt,
    ["schema", "id", "operation", "status", "packageId", "inputHashes", "createdAt", "lane", "output", "artifacts", "warnings"],
    ["schema", "id", "operation", "status", "packageId", "inputHashes", "createdAt", "lane", "output", "warnings"],
    "apply receipt",
  );
  if (receipt.id !== receiptId || receipt.operation !== "timeline.layout.apply" || receipt.lane !== "debug-api"
    || receipt.schema !== "shellx-motion/receipt@1" || (receipt.status !== "passed" && receipt.status !== "warning") || receipt.packageId !== packageId) {
    throw new Error("Layout apply receipt identity is not exact.");
  }
  const output = record(receipt.output, "apply receipt output");
  exactKnownKeys(output, ["packageDir", "manifestPath", "motionPath", "operation", "compilation", "removal", "application", "layoutFingerprint", "layoutFingerprintInput", "budget", "overflow", "repeaters", "changedLayerIds", "outputMotionSha256", "validation", "createdBy"], ["packageDir", "manifestPath", "motionPath", "operation", "compilation", "removal", "application", "layoutFingerprint", "layoutFingerprintInput", "budget", "overflow", "repeaters", "changedLayerIds", "outputMotionSha256", "validation"], "apply receipt output");
  const application = record(output.application, "apply receipt application");
  const removal = record(output.removal, "apply receipt removal");
  exactKeys(application, ["disposition", "id", "fingerprint", "groupId", "sourceChildLayerIds", "materializedChildLayerIds", "generatedLayerIds", "trackOrders"], "apply receipt application");
  exactKeys(removal, ["schema", "applicationId", "applicationFingerprint"], "apply receipt removal");
  const outputMotionSha256 = sha256(output.outputMotionSha256, "apply receipt outputMotionSha256");
  if (output.operation !== "apply" || application.disposition !== "applied" || application.id !== applicationId || application.fingerprint !== applicationFingerprint || removal.schema !== "shellx-motion/debug-layout-removal@1" || removal.applicationId !== applicationId || removal.applicationFingerprint !== applicationFingerprint) {
    throw new Error("Layout apply receipt application facts are not exact.");
  }
  return { operation: "timeline.layout.apply", lane: "debug-api", status: receipt.status, packageId, applicationId, applicationFingerprint, outputMotionSha256 };
}

export function parseAuthority(
  value: unknown,
  root: StablePathIdentity,
  authorityKey: string,
  schema: typeof AUTHORITY_SCHEMA | typeof LEGACY_AUTHORITY_SCHEMA,
): LayoutApplicationAuthority {
  const input = record(value, "layout authority");
  exactKeys(input, ["schema", "authorityKey", "receiptId", "receiptSha256", "receiptsRoot", "package", "application", "receipt"], "layout authority");
  if (input.schema !== schema || input.authorityKey !== authorityKey) throw new Error("Layout authority schema or key is invalid.");
  const receiptsRoot = parseIdentity(input.receiptsRoot, "layout authority receiptsRoot");
  if (!sameIdentity(receiptsRoot, root)) throw new Error("Layout authority belongs to another receiptsRoot identity.");
  const packageValue = parsePackage(input.package, "layout authority package");
  const application = record(input.application, "layout authority application");
  const receipt = record(input.receipt, "layout authority receipt");
  exactKeys(application, ["id", "fingerprint"], "layout authority application");
  exactKeys(receipt, ["operation", "lane", "status", "packageId", "applicationId", "applicationFingerprint", "outputMotionSha256"], "layout authority receipt");
  const parsed: LayoutApplicationAuthority = {
    schema: AUTHORITY_SCHEMA,
    authorityKey,
    receiptId: identifier(input.receiptId, "layout authority receiptId"),
    receiptSha256: sha256(input.receiptSha256, "layout authority receiptSha256"),
    receiptsRoot,
    package: packageValue,
    application: { id: identifier(application.id, "layout authority application id"), fingerprint: sha256(application.fingerprint, "layout authority application fingerprint") },
    receipt: {
      operation: receipt.operation === "timeline.layout.apply" ? receipt.operation : fail("Layout authority receipt operation is invalid."),
      lane: receipt.lane === "debug-api" ? receipt.lane : fail("Layout authority receipt lane is invalid."),
      status: receipt.status === "passed" || receipt.status === "warning" ? receipt.status : fail("Layout authority receipt status is invalid."),
      packageId: identifier(receipt.packageId, "layout authority receipt packageId"),
      applicationId: identifier(receipt.applicationId, "layout authority receipt applicationId"),
      applicationFingerprint: sha256(receipt.applicationFingerprint, "layout authority receipt applicationFingerprint"),
      outputMotionSha256: sha256(receipt.outputMotionSha256, "layout authority receipt outputMotionSha256"),
    },
  };
  if (parsed.application.id !== parsed.receipt.applicationId || parsed.application.fingerprint !== parsed.receipt.applicationFingerprint) {
    throw new Error("Layout authority application does not match its receipt facts.");
  }
  return parsed;
}

/** `null` preserves the exact v1 static authority parser for legacy records. */
export function parseRestoredGapAuthority(
  value: unknown,
  root: StablePathIdentity,
  authorityKey: string,
): RestoredGapAuthority | null {
  const candidate = record(value, "layout authority");
  if (candidate.schema !== RESTORED_GAP_AUTHORITY_SCHEMA) return null;
  exactKeys(candidate, ["schema", "authorityKey", "receiptsRoot", "package", "application", "sourceAuthorityKey", "static", "teardown"], "restored layout gap authority");
  if (candidate.authorityKey !== authorityKey) throw new Error("Restored layout gap authority key is invalid.");
  const receiptsRoot = parseIdentity(candidate.receiptsRoot, "restored layout gap authority receiptsRoot");
  if (!sameIdentity(receiptsRoot, root)) throw new Error("Restored layout gap authority belongs to another receiptsRoot identity.");
  const application = record(candidate.application, "restored layout gap authority application");
  const staticValue = record(candidate.static, "restored layout gap authority static");
  const teardown = record(candidate.teardown, "restored layout gap authority teardown");
  exactKeys(application, ["id", "fingerprint"], "restored layout gap authority application");
  exactKeys(staticValue, ["layoutApplicationsSha256", "applicationSha256", "directChildrenSha256", "patchesSha256"], "restored layout gap authority static");
  exactKeys(teardown, ["receiptId", "receiptSha256", "operation", "status", "packageId", "outputMotionSha256"], "restored layout gap authority teardown");
  return {
    schema: RESTORED_GAP_AUTHORITY_SCHEMA,
    authorityKey,
    receiptsRoot,
    package: parsePackage(candidate.package, "restored layout gap authority package"),
    application: { id: identifier(application.id, "restored layout gap authority application id"), fingerprint: sha256(application.fingerprint, "restored layout gap authority application fingerprint") },
    sourceAuthorityKey: identifier(candidate.sourceAuthorityKey, "restored layout gap authority sourceAuthorityKey"),
    static: { layoutApplicationsSha256: sha256(staticValue.layoutApplicationsSha256, "restored layout gap authority layoutApplicationsSha256"), applicationSha256: sha256(staticValue.applicationSha256, "restored layout gap authority applicationSha256"), directChildrenSha256: sha256(staticValue.directChildrenSha256, "restored layout gap authority directChildrenSha256"), patchesSha256: sha256(staticValue.patchesSha256, "restored layout gap authority patchesSha256") },
    teardown: { receiptId: identifier(teardown.receiptId, "restored layout gap authority receiptId"), receiptSha256: sha256(teardown.receiptSha256, "restored layout gap authority receiptSha256"), operation: teardown.operation === "timeline.layout-gap-animation.track.remove" ? teardown.operation : fail("Restored layout gap authority operation is invalid."), status: teardown.status === "passed" || teardown.status === "warning" ? teardown.status : fail("Restored layout gap authority status is invalid."), packageId: identifier(teardown.packageId, "restored layout gap authority packageId"), outputMotionSha256: sha256(teardown.outputMotionSha256, "restored layout gap authority outputMotionSha256") },
  };
}

export function assertSameAuthority(left: LayoutApplicationAuthority, right: LayoutApplicationAuthority): void {
  if (canonicalJson(left) !== canonicalJson(right)) throw new Error("Layout authority readback differs from the written record.");
}

function parsePackage(value: unknown, label: string): PackageLineage {
  const item = record(value, label);
  exactKeys(item, ["path", "dev", "ino", "manifestId", "manifestSha256", "motionSha256", "motionCanonicalSha256"], label);
  if (!Number.isSafeInteger(item.dev) || !Number.isSafeInteger(item.ino)) throw new Error(`${label} identity is invalid.`);
  return { path: stablePath(item.path, `${label} path`), dev: item.dev as number, ino: item.ino as number, manifestId: identifier(item.manifestId, `${label} manifestId`), manifestSha256: sha256(item.manifestSha256, `${label} manifestSha256`), motionSha256: sha256(item.motionSha256, `${label} motionSha256`), motionCanonicalSha256: sha256(item.motionCanonicalSha256, `${label} motionCanonicalSha256`) };
}
function parseIdentity(value: unknown, label: string): StablePathIdentity { const item = record(value, label); exactKeys(item, ["path", "dev", "ino"], label); if (!Number.isSafeInteger(item.dev) || !Number.isSafeInteger(item.ino)) throw new Error(`${label} is invalid.`); return { path: stablePath(item.path, `${label} path`), dev: item.dev as number, ino: item.ino as number }; }
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void { if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new Error(`${label} must contain exact fields.`); }
function exactKnownKeys(value: Record<string, unknown>, allowed: string[], required: string[], label: string): void { if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) throw new Error(`${label} contains unknown or missing fields.`); }
function identifier(value: unknown, label: string): string { if (typeof value !== "string" || !value || value.length > 128) throw new Error(`${label} is invalid.`); return value; }
function stablePath(value: unknown, label: string): string { if (typeof value !== "string" || !value || value.length > MAX_STABLE_PATH_CHARS || value.includes("\0")) throw new Error(`${label} is invalid.`); return value; }
function sha256(value: unknown, label: string): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} is invalid.`); return value; }
function sameIdentity(left: StablePathIdentity, right: StablePathIdentity): boolean { return left.path === right.path && left.dev === right.dev && left.ino === right.ino; }
function fail(message: string): never { throw new Error(message); }
