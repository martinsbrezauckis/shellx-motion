/** Exact private C2 continuation authority-record reader and parser. */
import { canonicalJson, canonicalJsonSha256, type OperationReceipt } from "@shellx-motion/core";
import {
  readImmutableJsonPair,
  type StablePathIdentity,
  type TrustedAuthorityDirectory,
} from "./timeline-layout-application-authority-store.js";
import {
  MAX_STABLE_PATH_CHARS,
  receiptFacts,
  sameIdentity,
} from "./timeline-layout-gap-animation-authority-evidence.js";
import { MAX_C2_LAYOUT_AUTHORITY_RECORD_BYTES } from "./timeline-layout-authority-record-caps.js";
import type {
  ActiveAuthority,
  PackageLineage,
  ReceiptEvidence,
  StaticEvidence,
} from "./timeline-layout-gap-animation-authority-types.js";

export const ACTIVE_SCHEMA = "shellx-motion/timeline-layout-gap-animation-authority@1" as const;
export const MAX_RECEIPT_BYTES = 256 * 1024;

export async function optionalActiveAuthority(
  directory: TrustedAuthorityDirectory,
  key: string,
  lineage: PackageLineage,
): Promise<ActiveAuthority | null> {
  try {
    return await requiredActiveAuthority(directory, key, lineage);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export async function verifyActiveReceipt(
  directory: TrustedAuthorityDirectory,
  authority: ActiveAuthority,
  source: PackageLineage,
): Promise<void> {
  const pair = await readImmutableJsonPair(directory, {
    key: authority.authorityKey,
    recordKinds: ["layout-gap-continuation"],
    outputLineage: source,
    receiptMaximumBytes: MAX_RECEIPT_BYTES,
    authorityMaximumBytes: MAX_C2_LAYOUT_AUTHORITY_RECORD_BYTES,
  });
  if (canonicalJsonSha256(pair.receipt) !== authority.receipt.sha256
    || canonicalJson(pair.authority) !== canonicalJson(authority)) {
    throw new Error("Layout gap continuation host pair does not match its immutable authority record.");
  }
  const receipt = receiptFacts(
    pair.receipt as OperationReceipt,
    authority.receipt.packageId,
    authority.receipt.outputMotionSha256,
  );
  if (canonicalJson(receipt) !== canonicalJson(authority.receipt)
    || authority.receipt.outputMotionSha256 !== source.motionCanonicalSha256) {
    throw new Error("Layout gap continuation host receipt does not bind the current output lineage.");
  }
}

async function requiredActiveAuthority(
  directory: TrustedAuthorityDirectory,
  key: string,
  lineage: PackageLineage,
): Promise<ActiveAuthority> {
  const pair = await readImmutableJsonPair(directory, {
    key,
    recordKinds: ["layout-gap-continuation"],
    outputLineage: lineage,
    receiptMaximumBytes: MAX_RECEIPT_BYTES,
    authorityMaximumBytes: MAX_C2_LAYOUT_AUTHORITY_RECORD_BYTES,
  });
  const authority = parseActive(pair.authority, directory.root, key);
  if (canonicalJsonSha256(pair.receipt) !== authority.receipt.sha256) {
    throw new Error("Layout gap continuation authority pair receipt does not match its authority record.");
  }
  return authority;
}

function parseActive(
  value: unknown,
  root: StablePathIdentity,
  key: string,
): ActiveAuthority {
  const record = object(value, "layout gap continuation authority");
  exact(
    record,
    [
      "schema",
      "authorityKey",
      "receiptsRoot",
      "package",
      "application",
      "static",
      "previousAuthorityKey",
      "receipt",
    ],
    "layout gap continuation authority",
  );
  if (record.schema !== ACTIVE_SCHEMA || record.authorityKey !== key) {
    throw new Error("Layout gap continuation authority schema or key is invalid.");
  }
  const receiptsRoot = identity(record.receiptsRoot, "layout gap continuation receiptsRoot");
  if (!sameIdentity(receiptsRoot, root)) {
    throw new Error("Layout gap continuation authority belongs to another receiptsRoot identity.");
  }
  const packageValue = lineage(record.package, "layout gap continuation package");
  const application = object(record.application, "layout gap continuation application");
  const staticValue = staticRecord(record.static);
  const receipt = object(record.receipt, "layout gap continuation receipt");
  exact(application, ["id", "fingerprint"], "layout gap continuation application");
  exact(
    receipt,
    ["id", "sha256", "operation", "status", "packageId", "outputMotionSha256"],
    "layout gap continuation receipt",
  );
  return {
    schema: ACTIVE_SCHEMA,
    authorityKey: key,
    receiptsRoot,
    package: packageValue,
    application: {
      id: text(application.id, "layout gap continuation application id"),
      fingerprint: sha(application.fingerprint, "layout gap continuation application fingerprint"),
    },
    static: staticValue,
    previousAuthorityKey: text(
      record.previousAuthorityKey,
      "layout gap continuation previousAuthorityKey",
    ),
    receipt: {
      id: text(receipt.id, "layout gap continuation receipt id"),
      sha256: sha(receipt.sha256, "layout gap continuation receipt sha256"),
      operation: text(receipt.operation, "layout gap continuation receipt operation"),
      status: parseReceiptStatus(receipt.status),
      packageId: text(receipt.packageId, "layout gap continuation receipt packageId"),
      outputMotionSha256: sha(
        receipt.outputMotionSha256,
        "layout gap continuation outputMotionSha256",
      ),
    },
  };
}

function staticRecord(value: unknown): StaticEvidence {
  const record = object(value, "layout gap continuation static");
  exact(
    record,
    ["layoutApplicationsSha256", "applicationSha256", "directChildrenSha256", "patchesSha256"],
    "layout gap continuation static",
  );
  return {
    layoutApplicationsSha256: sha(record.layoutApplicationsSha256, "layout gap continuation layoutApplicationsSha256"),
    applicationSha256: sha(record.applicationSha256, "layout gap continuation applicationSha256"),
    directChildrenSha256: sha(record.directChildrenSha256, "layout gap continuation directChildrenSha256"),
    patchesSha256: sha(record.patchesSha256, "layout gap continuation patchesSha256"),
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} must contain exact fields.`);
  }
}

function identity(value: unknown, label: string): StablePathIdentity {
  const record = object(value, label);
  exact(record, ["path", "dev", "ino"], label);
  return {
    path: pathText(record.path, `${label} path`),
    dev: integer(record.dev, `${label} dev`),
    ino: integer(record.ino, `${label} ino`),
  };
}

function lineage(value: unknown, label: string): PackageLineage {
  const record = object(value, label);
  exact(record, ["path", "dev", "ino", "manifestId", "manifestSha256", "motionSha256", "motionCanonicalSha256"], label);
  return {
    path: pathText(record.path, `${label} path`),
    dev: integer(record.dev, `${label} dev`),
    ino: integer(record.ino, `${label} ino`),
    manifestId: text(record.manifestId, `${label} manifestId`),
    manifestSha256: sha(record.manifestSha256, `${label} manifestSha256`),
    motionSha256: sha(record.motionSha256, `${label} motionSha256`),
    motionCanonicalSha256: sha(record.motionCanonicalSha256, `${label} motionCanonicalSha256`),
  };
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 128) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function pathText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > MAX_STABLE_PATH_CHARS || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as number;
}

function parseReceiptStatus(value: unknown): ReceiptEvidence["status"] {
  if (value !== "passed" && value !== "warning") {
    throw new Error("Layout gap continuation receipt status is invalid.");
  }
  return value;
}
