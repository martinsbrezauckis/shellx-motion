/** Shared paired-publication types, binding, cleanup, and error classification. */
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  DerivedOutputPublicationError,
  type DerivedFilePublicationEvidence,
  type DerivedOutputPublication,
  type DerivedOutputPublicationErrorCode
} from "./derived-output-publication";
import type { PublicationCommitUncertainEvidence } from "./publication-commit-uncertainty";
import { assertStrictLinearSrgbSdrFinalReceipt } from "./strict-linear-srgb-sdr-receipt";
import type { OperationReceipt, ReceiptArtifact } from "./types";

export type PairedArtifactSpec = {
  role: ReceiptArtifact["role"];
  mediaType?: ReceiptArtifact["mediaType"];
  primary?: ReceiptArtifact["primary"];
};

export type PairedOutputArtifactSpec = PairedArtifactSpec;

/** Public acquisition and deterministic test seams for a receipt-bound file pair. */
export interface PairedOutputReceiptPublicationOptions {
  outputPath: string;
  receiptPath: string;
  outputArtifact: PairedOutputArtifactSpec;
  receiptArtifact: PairedOutputArtifactSpec;
  forceOutput?: boolean;
  forceReceipt?: boolean;
  /** Internal authorities can retain a committed receipt after any later failure for terminal forensics. */
  retainCommittedEvidenceOnFailure?: boolean;
  /** Opaque descriptor-held parent accepted only inside Core; plain /proc strings are never authority. */
  internalHeldDirectoryAuthority?: unknown;
  /** Opt-in only: fsync both bounded private stages and the publication parent after each link. */
  durablePublication?: Readonly<{
    outputMaxBytes: number;
    receiptMaxBytes: number;
  }>;
  /** Optional internal serializer and ceiling applied after all pair-owned receipt rebinding. */
  receiptSerialization?: Readonly<{
    serialize(receipt: OperationReceipt): string;
    maxBytes: number;
  }>;
  faults?: {
    afterReceiptPreflight?: () => Promise<void> | void;
    afterReceiptStaged?: () => Promise<void> | void;
    beforeReceiptCommit?: () => Promise<void> | void;
    afterReceiptCommitted?: () => Promise<void> | void;
    beforeOutputCommit?: () => Promise<void> | void;
    afterOutputCommitAttempt?: () => Promise<void> | void;
    /** Held V1 hostile seam after cached stage verification but before public FD capture. */
    afterHeldCachedVerification?: (member: "output" | "receipt") => Promise<void> | void;
    /** Held V1 hostile seam after stage/anchor release but before retained FD rehash. */
    afterHeldAnchorRelease?: () => Promise<void> | void;
  };
  /** Internal deterministic-test hooks. CLI production never supplies these. */
  testHooks?: {
    acquirePublication?: (input: { outputPath: string; kind: "file"; force: boolean; internalHeldDirectoryAuthority?: unknown }) => Promise<DerivedOutputPublication>;
    writeReceiptStage?: (path: string, contents: string) => Promise<void>;
    copySecondaryStage?: (source: string, destination: string) => Promise<void>;
    inspectSecondaryStage?: (path: string) => Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
    /** Observes completed durable-sync steps after the corresponding real fsync call. */
    onDurabilityStep?: (step: "output_private" | "receipt_private" | "receipt_parent" | "output_parent") => Promise<void> | void;
  };
}

/** Renderer-produced evidence that must become public before its receipt-bound primary output. */
export interface PairedSecondaryArtifactInput {
  stagedPath: string;
  outputPath: string;
  artifact: PairedOutputArtifactSpec;
  inputHashKey: string;
}

export type BoundSecondaryArtifact = {
  publication: { outputPath: string };
  evidence: DerivedFilePublicationEvidence;
  artifact: ReceiptArtifact;
  inputHashKey: string;
};

export function bindSecondaryArtifacts(receipt: OperationReceipt, secondaryArtifacts: readonly BoundSecondaryArtifact[]): void {
  if (secondaryArtifacts.length === 0) return;
  const output = plainRecord(receipt.output);
  if (!output) throw new Error("Receipt output is required before binding secondary artifacts.");
  const inputHashes = { ...receipt.inputHashes };
  const pairedSecondaryArtifactHashes: Record<string, string> = {};
  for (const secondary of secondaryArtifacts) {
    const expected = inputHashes[secondary.inputHashKey];
    if (expected !== undefined && expected !== secondary.evidence.sha256) {
      throw new Error(`Receipt input hash ${secondary.inputHashKey} does not match the verified secondary artifact.`);
    }
    inputHashes[secondary.inputHashKey] = secondary.evidence.sha256;
    pairedSecondaryArtifactHashes[secondary.publication.outputPath] = secondary.evidence.sha256;
  }
  receipt.inputHashes = inputHashes;
  receipt.output = { ...output, pairedSecondaryArtifactHashes };
  receipt.artifacts = dedupeArtifacts([...(receipt.artifacts ?? []), ...secondaryArtifacts.map((secondary) => secondary.artifact)]);
}

export function assertPrivateSecondarySource(candidate: string, primaryStagePath: string): void {
  const root = resolve(primaryStagePath, "..");
  const source = resolve(candidate);
  const relation = relative(root, source);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation) || source === resolve(primaryStagePath)) {
    throw new Error("Paired secondary artifact escaped the private primary-output stage root.");
  }
}

export function normalizeReceiptArtifacts(
  receipt: OperationReceipt,
  stagedOutputPath: string,
  outputPath: string,
  receiptPath: string,
  outputArtifact: PairedArtifactSpec,
  receiptArtifact: PairedArtifactSpec
): void {
  receipt.artifacts = dedupeArtifacts([
    ...(receipt.artifacts ?? []).map((artifact) => ({
      ...artifact,
      path: resolve(artifact.path) === resolve(stagedOutputPath) ? outputPath : artifact.path
    })),
    { role: outputArtifact.role, path: outputPath, status: "available" as const, ...(outputArtifact.mediaType ? { mediaType: outputArtifact.mediaType } : {}), ...(outputArtifact.primary === undefined ? { primary: true } : { primary: outputArtifact.primary }) },
    { role: receiptArtifact.role, path: receiptPath, status: "available" as const, ...(receiptArtifact.mediaType ? { mediaType: receiptArtifact.mediaType } : {}) }
  ]);
}

export function rebindReceiptOutput(
  receipt: OperationReceipt,
  stagedOutputPath: string,
  outputPath: string,
  evidence: DerivedFilePublicationEvidence
): void {
  const output = plainRecord(receipt.output);
  assertStrictPrivateOutputAdoption(receipt, evidence);
  if (!output || output.sha256 !== evidence.sha256) {
    throw new Error("Renderer receipt does not bind the verified private output SHA-256.");
  }
  const receiptPath = typeof output.path === "string" ? resolve(output.path) : undefined;
  if (receiptPath !== resolve(stagedOutputPath) && receiptPath !== outputPath) {
    throw new Error("Renderer receipt output path does not match the governed private stage.");
  }
  receipt.output = { ...output, path: outputPath };
}

export function assertReceiptBindsOutput(receipt: OperationReceipt, outputPath: string, evidence: DerivedFilePublicationEvidence): void {
  const output = plainRecord(receipt.output);
  assertStrictPrivateOutputAdoption(receipt, evidence);
  if (!output || resolve(String(output.path ?? "")) !== outputPath || output.sha256 !== evidence.sha256) {
    throw new Error("Receipt does not bind the verified final output path and SHA-256.");
  }
}

export type PairedOutputReceiptArtifact = "media_output" | "receipt_sidecar";

export class PairedOutputReceiptDestinationError extends Error {
  constructor(
    readonly code: DerivedOutputPublicationErrorCode,
    readonly artifact: PairedOutputReceiptArtifact,
    readonly path: string,
    readonly outputPath: string,
    readonly receiptPath: string,
    cause: DerivedOutputPublicationError
  ) {
    super(destinationMessage(code, artifact, path, cause.message), { cause });
    this.name = "PairedOutputReceiptDestinationError";
    Object.setPrototypeOf(this, PairedOutputReceiptDestinationError.prototype);
  }
}

/** Reclassify only Core's path-specific refusal; all other failures retain their original type. */
export function pairedOutputReceiptDestinationError(
  artifact: PairedOutputReceiptArtifact,
  outputPath: string,
  receiptPath: string,
  cause: unknown
): unknown {
  if (!(cause instanceof DerivedOutputPublicationError)) return cause;
  return new PairedOutputReceiptDestinationError(cause.code, artifact, cause.path, outputPath, receiptPath, cause);
}

export function isPairedOutputReceiptDestinationError(error: unknown): error is PairedOutputReceiptDestinationError {
  return error instanceof PairedOutputReceiptDestinationError;
}

/** Stable command-envelope vocabulary for a collision in either public pair member. */
export function pairedOutputReceiptDestinationErrorFields(error: PairedOutputReceiptDestinationError): {
  code: DerivedOutputPublicationErrorCode;
  message: string;
  artifact: PairedOutputReceiptArtifact;
  path: string;
} {
  return { code: error.code, message: error.message, artifact: error.artifact, path: error.path };
}

export class PairedOutputReceiptCommitUncertainError extends Error {
  readonly code = "paired_output_commit_uncertain";
  readonly outputPath: string;
  readonly receiptPath: string;
  readonly phase: "receipt" | "secondary" | "output";
  readonly publicPaths: readonly string[];
  readonly expectedPublications: readonly PublicationCommitUncertainEvidence[];

  constructor(input: {
    outputPath: string;
    receiptPath: string;
    phase: "receipt" | "secondary" | "output";
    publicPaths: readonly string[];
    expectedPublications?: readonly PublicationCommitUncertainEvidence[];
    cause: unknown;
  }) {
    super(`${input.phase === "output" ? "Output" : input.phase === "receipt" ? "Receipt" : "Secondary evidence"} publication may have committed; inspect the reported public evidence before retrying.`, { cause: input.cause });
    this.name = "PairedOutputReceiptCommitUncertainError";
    this.outputPath = input.outputPath;
    this.receiptPath = input.receiptPath;
    this.phase = input.phase;
    this.publicPaths = Object.freeze([...new Set(input.publicPaths)]);
    this.expectedPublications = Object.freeze([...(input.expectedPublications ?? [])]);
  }
}

/** Literal cancellation boundary for receipt-first publication. */
export class PairedOutputReceiptCancelledError extends Error {
  constructor(readonly phase: "before_receipt" | "after_receipt") {
    super(phase === "before_receipt"
      ? "Preview or render was cancelled before receipt publication."
      : "Preview or render was cancelled after receipt publication but before output publication.");
    this.name = "PairedOutputReceiptCancelledError";
    Object.setPrototypeOf(this, PairedOutputReceiptCancelledError.prototype);
  }
}

/** Exact hash-bound inode facts.  Timestamp/link facts close same-inode, same-length rewrites. */
export type PairedPublishedFileIdentity = Readonly<{
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
}>;
export type PairedPublishedPairIdentity = Readonly<{
  output: PairedPublishedFileIdentity;
  receipt: PairedPublishedFileIdentity;
}>;

/** Best-effort release of retained private reservation state after a completed primary delivery. */
export async function releaseRetainedPairedPrivateReservations(
  receipt: DerivedOutputPublication,
  secondaryArtifacts: readonly { publication: DerivedOutputPublication }[]
): Promise<void> {
  await Promise.allSettled([receipt.abort(), ...secondaryArtifacts.map((secondary) => secondary.publication.abort())]);
}

/** Strict SDR is the one route whose final public digest must remain tied to its private adoption. */
function assertStrictPrivateOutputAdoption(receipt: OperationReceipt, evidence: DerivedFilePublicationEvidence): void {
  const strictSdr = assertStrictLinearSrgbSdrFinalReceipt(receipt);
  if (strictSdr.kind !== "strict-v2") return;
  if (evidence.sha256 !== strictSdr.adoption.verifiedOutput.sha256 || evidence.byteLength !== strictSdr.adoption.verifiedOutput.byteLength) {
    throw new Error("Strict linear-sRGB SDR paired publication stage does not match its private-output adoption identity.");
  }
}

function dedupeArtifacts(artifacts: ReceiptArtifact[]): ReceiptArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = `${artifact.role}\0${resolve(artifact.path)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function destinationMessage(
  code: DerivedOutputPublicationErrorCode,
  artifact: PairedOutputReceiptArtifact,
  path: string,
  fallback: string
): string {
  const label = artifact === "media_output" ? "Render media output" : "Render receipt sidecar";
  if (code === "derived_output_exists") return `${label} already exists at ${path}; it was preserved rather than overwritten.`;
  if (code === "derived_output_busy") return `${label} is already being published at ${path}; wait for that publication to settle.`;
  return `${label} could not be reserved at ${path}: ${fallback}`;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
