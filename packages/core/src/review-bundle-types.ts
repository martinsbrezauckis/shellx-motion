import type { OperationReceipt } from "./types";
import type { RetainedDirectoryAuthority } from "./output-path-topology";

export interface ReviewBundleReceiptEntry {
  path?: string;
  relativePath?: string;
  receipt: OperationReceipt;
}

/** How strongly one copied attribution is bound to the receipt-producing renderer. */
export type ReviewBundleProducerIdentity = "producer_verified" | "unattested";

/**
 * Stable facts produced by a host-owned receipt reader. Core reopens and verifies these facts
 * before it grants the resulting entry its private snapshot authority.
 */
export interface StableReviewBundleReceiptInput {
  readonly path: string;
  readonly receipt: OperationReceipt;
  readonly snapshot: {
    readonly sha256: string;
    readonly byteLength: number;
    readonly identity: { readonly dev: number; readonly ino: number };
  };
}

declare const boundReviewBundleReceiptEntryBrand: unique symbol;

/**
 * Returned only by Core's stable-receipt admission. The brand is compile-time opaque and the
 * actual root, relative identity, digest, and opened-file identity remain private in Core.
 */
export interface BoundReviewBundleReceiptEntry extends ReviewBundleReceiptEntry {
  readonly [boundReviewBundleReceiptEntryBrand]: never;
}

export interface ReviewBundleCopiedArtifact {
  role: string;
  sourceName: string;
  path: string;
  relativePath: string;
  mediaType?: string;
  primary?: boolean;
  receiptId: string;
  operation: string;
  /** Backward-compatible alias for the bytes observed while the bundle streamed this source. */
  sha256: string;
  /** SHA-256 observed while the bundle streamed this source into its staged portable copy. */
  observedSha256: string;
  /** Byte count observed while the bundle streamed this source into its staged portable copy. */
  observedByteLength: number;
  /** Renderer-provided output SHA-256, when this attribution matched that output path. */
  expectedProducerSha256?: string;
  /** Renderer-provided output byte length, when that receipt carried one. */
  expectedProducerByteLength?: number;
  /** `producer_verified` only after a validated expected SHA-256 matched the streamed bytes. */
  producerIdentity: ReviewBundleProducerIdentity;
}

export interface ReviewBundleOmittedArtifact {
  role: string;
  /**
   * Receipt-declared file name only — never the full host path. The bundle is built to be
   * shared, and the point of omitting the file is that its location was not approved; echoing
   * the absolute path back into the portable HTML/receipt would leak the very host layout the
   * omission exists to protect.
   */
  sourceName: string;
  /**
   * Why the artifact is not in the bundle. Every path out of the copy loop lands on one of these:
   * the ledger's whole purpose is that a reviewer can tell "this render never had evidence" apart
   * from "evidence existed but was withheld", and a `continue` that skips the ledger hands a
   * hostile receipt a way to make an artifact vanish while the bundle still reads as complete.
   *
   * - `outside_approved_roots` — the canonical source sits outside every approved artifact root.
   * - `unreadable_source` — the source could not be resolved, opened, or hashed.
   * - `declared_unavailable` — the receipt itself declared the artifact `planned`, `not_required`
   *   or `failed`, so there are no bytes to ship. Disclosed rather than skipped: those statuses are
   *   receipt-controlled, and silently honouring them let a receipt hide a real artifact.
   * - `non_local_path` — the declared path carries a URL scheme (`file:`, `https:`, ...) instead of
   *   naming a local file. The bundler only ships local files; a scheme is never dereferenced.
   * - `missing_path` — the artifact declared no usable path at all.
   */
  reason:
    | "outside_approved_roots"
    | "unreadable_source"
    | "declared_unavailable"
    | "non_local_path"
    | "missing_path";
  receiptId: string;
  operation: string;
}

export interface ReviewBundleResult {
  ok: true;
  packageId: string;
  htmlPath: string;
  receiptPath: string;
  receiptCount: number;
  copiedArtifactCount: number;
  omittedArtifactCount: number;
  qualityGateCount: number;
  failedQualityGateCount: number;
  copiedArtifacts: ReviewBundleCopiedArtifact[];
  omittedArtifacts: ReviewBundleOmittedArtifact[];
  receipt: OperationReceipt;
}

export interface WriteReviewBundleInput {
  packageRoot?: string;
  receiptsRoot?: string;
  receipts?: ReviewBundleReceiptEntry[];
  outDir: string;
  title?: string;
  createdAt?: string;
  copyArtifacts?: boolean;
  /**
   * Extra directories whose files receipts may legitimately reference (for example a render
   * output directory that sits beside, not inside, receiptsRoot). Receipt-referenced artifact
   * paths are only hashed and copied when their canonical path stays inside packageRoot,
   * receiptsRoot, or one of these roots. Receipts are review INPUT DATA: a crafted receipt under
   * the selected receipts directory must not be able to turn an arbitrary readable host path
   * into a file that ships inside a bundle built to be shared. Anything outside the approved
   * roots is recorded as an explicit omission instead of being copied.
   */
  artifactRoots?: string[];
  /**
   * Host-retained authorities for long-lived configured artifact roots. A server must capture
   * these when it accepts its configuration; recanonicalizing the same strings per request would
   * adopt a replacement directory created after startup.
   */
  artifactRootAuthorities?: readonly RetainedDirectoryAuthority[];
}
