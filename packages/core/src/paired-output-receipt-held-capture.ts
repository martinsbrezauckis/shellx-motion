/** Module-local FD retention for exact held published pairs. */
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import type { DerivedFilePublicationEvidence } from "./derived-output-publication";
import type { PairedPublishedFileIdentity, PairedPublishedPairIdentity } from "./paired-output-receipt-publication-support";

type HeldPairedCapture = Readonly<{ output: FileHandle; receipt: FileHandle }>;
const captures = new WeakMap<object, HeldPairedCapture>();

/** Bounded, descriptor-only post-commit reads for the private strict-SDR candidate consumer. */
export type RetainedPairedPublishedPairReadCapability = Readonly<{
  hashOutput(): Promise<Readonly<{ sha256: string; byteLength: number }>>;
  readReceipt(): Promise<Readonly<{ bytes: Buffer; sha256: string; byteLength: number }>>;
  /**
   * One fresh, descriptor-bound pair read for an active private Core consumer. It deliberately
   * bypasses the cached initial output/receipt reads. The fresh facts stay in the supplied
   * sibling-Core validator, so a child observation never receives receipt bytes.
   */
  verifyCurrentPair<T>(operation: (facts: Readonly<{
    output: Readonly<{ sha256: string; byteLength: number }>;
    receipt: Readonly<{ bytes: Buffer; sha256: string; byteLength: number }>;
  }>) => Promise<T> | T): Promise<T>;
  /** One inherited-output-descriptor callback for the strict-SDR inverse only. */
  withF2aCommittedOutputDescriptor<T>(operation: (fd: number) => Promise<T> | T): Promise<T>;
  /** Literal three-slot F2a callback; all named callbacks share one retained output descriptor. */
  withThreeSlotF2aCommittedOutputDescriptor<T>(operation: (fd: number) => Promise<T> | T): Promise<T>;
  /** Literal F2b screen callback; it cannot be combined with another named descriptor callback. */
  withF2bScreenCommittedOutputDescriptor<T>(operation: (fd: number) => Promise<T> | T): Promise<T>;
  /** Literal F2b screen-controls callback; it cannot be combined with another named callback. */
  withF2bScreenControlsCommittedOutputDescriptor<T>(operation: (fd: number) => Promise<T> | T): Promise<T>;
}>;

export async function withRetainedPairedPublishedPairCapture<T>(identity: PairedPublishedPairIdentity, operation: (facts: PairedPublishedPairIdentity) => Promise<T>): Promise<T> {
  const capture = captures.get(identity as object);
  if (!capture) throw new Error("Paired held publication did not retain its exact public inode capture.");
  try {
    const [output, receipt] = await Promise.all([capture.output.stat(), capture.receipt.stat()]);
    const facts = Object.freeze({ output: identityOf(output), receipt: identityOf(receipt) });
    if (!sameIdentity(facts.output, identity.output) || !sameIdentity(facts.receipt, identity.receipt) || output.nlink !== 1 || receipt.nlink !== 1) throw new Error("Paired held publication lost its exact single-link inode capture.");
    return await operation(facts);
  } finally {
    captures.delete(identity as object);
    await Promise.allSettled([capture.output.close(), capture.receipt.close()]);
  }
}

/**
 * Consume a retained pair through its captured descriptors only. The callback never receives a
 * pathname or FileHandle. Both members are reread after the callback and its pending work settles;
 * the capture is always consumed and closed.
 */
export async function withRetainedPairedPublishedPairReadCapture<T>(
  identity: PairedPublishedPairIdentity,
  limits: Readonly<{ outputMaxBytes: number; receiptMaxBytes: number }>,
  operation: (capture: RetainedPairedPublishedPairReadCapability) => Promise<T>
): Promise<T> {
  assertMaximum(limits.outputMaxBytes, "output");
  assertMaximum(limits.receiptMaxBytes, "receipt");
  const capture = captures.get(identity as object);
  if (!capture) throw new Error("Paired held publication did not retain its exact public inode capture.");
  let active = true;
  let outputRead: Promise<Readonly<{ sha256: string; byteLength: number }>> | undefined;
  let receiptRead: Promise<Readonly<{ bytes: Buffer; sha256: string; byteLength: number }>> | undefined;
  let currentPairVerificationUsed = false;
  let committedOutputDescriptorUsed = false;
  const pending = new Set<Promise<unknown>>();
  const pendingFailures: unknown[] = [];
  const errors: unknown[] = [];
  let result: T | undefined;
  let callbackStarted = false;
  const track = <TValue>(promise: Promise<TValue>): Promise<TValue> => {
    if (!pending.has(promise)) {
      pending.add(promise);
      void promise.then(
        () => undefined,
        (error: unknown) => { pendingFailures.push(error); }
      );
    }
    return promise;
  };
  const unavailable = <TValue>(): Promise<TValue> => Promise.reject(new Error("Paired held read capability expired after its consumer callback returned."));
  const withCommittedOutputDescriptor = <TValue>(label: string, operation: (fd: number) => Promise<TValue> | TValue): Promise<TValue> => {
    if (!active) return unavailable();
    if (committedOutputDescriptorUsed) return Promise.reject(new Error(`Paired held ${label} committed-output descriptor callback is one-shot.`));
    committedOutputDescriptorUsed = true;
    return track(Promise.resolve().then(async () => {
      await assertExactCapture(capture, identity);
      return await operation(capture.output.fd);
    }));
  };
  const capability = Object.freeze({
    hashOutput: (): Promise<Readonly<{ sha256: string; byteLength: number }>> => {
      if (!active) return unavailable();
      outputRead ??= hashBoundedHandle(capture.output, identity.output, limits.outputMaxBytes, "output");
      return track(outputRead);
    },
    readReceipt: (): Promise<Readonly<{ bytes: Buffer; sha256: string; byteLength: number }>> => {
      if (!active) return unavailable();
      receiptRead ??= readBoundedHandle(capture.receipt, identity.receipt, limits.receiptMaxBytes, "receipt");
      return track(receiptRead);
    },
    verifyCurrentPair: <T>(operation: (facts: Readonly<{
      output: Readonly<{ sha256: string; byteLength: number }>;
      receipt: Readonly<{ bytes: Buffer; sha256: string; byteLength: number }>;
    }>) => Promise<T> | T): Promise<T> => {
      if (!active) return unavailable();
      if (currentPairVerificationUsed) return track(Promise.reject<T>(new Error("Paired held current-pair verification is one-shot.")));
      currentPairVerificationUsed = true;
      return track(Promise.resolve().then(async () => {
        await assertExactCapture(capture, identity);
        const [output, receipt] = await Promise.all([
          hashBoundedHandle(capture.output, identity.output, limits.outputMaxBytes, "output"),
          readBoundedHandle(capture.receipt, identity.receipt, limits.receiptMaxBytes, "receipt")
        ]);
        await assertExactCapture(capture, identity);
        return Object.freeze({ output, receipt });
      }).then(operation));
    },
    withF2aCommittedOutputDescriptor: <T>(operation: (fd: number) => Promise<T> | T): Promise<T> => withCommittedOutputDescriptor("F2a", operation),
    withThreeSlotF2aCommittedOutputDescriptor: <T>(operation: (fd: number) => Promise<T> | T): Promise<T> => withCommittedOutputDescriptor("three-slot F2a", operation),
    withF2bScreenCommittedOutputDescriptor: <T>(operation: (fd: number) => Promise<T> | T): Promise<T> => withCommittedOutputDescriptor("F2b screen", operation),
    withF2bScreenControlsCommittedOutputDescriptor: <T>(operation: (fd: number) => Promise<T> | T): Promise<T> => withCommittedOutputDescriptor("F2b screen controls", operation)
  }) as RetainedPairedPublishedPairReadCapability;
  try {
    await assertExactCapture(capture, identity);
    callbackStarted = true;
    result = await operation(capability);
  } catch (error) {
    errors.push(error);
  }
  active = false;
  await Promise.allSettled([...pending]);
  errors.push(...pendingFailures);
  if (callbackStarted) {
    try {
      await assertExactCapture(capture, identity);
      if (!outputRead || !receiptRead) {
        throw new Error("Paired held reader finished without both initially accepted pair members.");
      }
      const [acceptedOutput, acceptedReceipt] = await Promise.all([outputRead, receiptRead]);
      const [finalOutput, finalReceipt] = await Promise.all([
        hashBoundedHandle(capture.output, identity.output, limits.outputMaxBytes, "output"),
        readBoundedHandle(capture.receipt, identity.receipt, limits.receiptMaxBytes, "receipt")
      ]);
      if (
        finalOutput.sha256 !== acceptedOutput.sha256 || finalOutput.byteLength !== acceptedOutput.byteLength
        || finalReceipt.sha256 !== acceptedReceipt.sha256 || finalReceipt.byteLength !== acceptedReceipt.byteLength
      ) {
        throw new Error("Paired held public pair bytes changed after the consumer callback.");
      }
      await assertExactCapture(capture, identity);
    } catch (error) { errors.push(error); }
  }
  captures.delete(identity as object);
  const closed = await Promise.allSettled([capture.output.close(), capture.receipt.close()]);
  errors.push(...closed.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected").map((entry) => entry.reason));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Paired held strict-SDR reader failed before its retained descriptors were fully closed.");
  return result as T;
}

export async function captureExactHeldPair(outputPath: string, receiptPath: string, expected: PairedPublishedPairIdentity): Promise<HeldPairedCapture> {
  let output: FileHandle | undefined;
  let receipt: FileHandle | undefined;
  try {
    output = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    receipt = await open(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const [outputFacts, receiptFacts] = await Promise.all([output.stat(), receipt.stat()]);
    if (!sameIdentity(identityOf(outputFacts), expected.output) || !sameIdentity(identityOf(receiptFacts), expected.receipt) || outputFacts.nlink < 2 || receiptFacts.nlink < 2) throw new Error("Paired held publication public inode capture did not match its retained reservation.");
    return Object.freeze({ output, receipt });
  } catch (error) {
    await Promise.allSettled([output?.close(), receipt?.close()]);
    throw error;
  }
}

export async function retainReleasedHeldPairCapture(
  identity: PairedPublishedPairIdentity,
  capture: HeldPairedCapture,
  evidence: Readonly<{ output: DerivedFilePublicationEvidence; receipt: DerivedFilePublicationEvidence }>,
  afterAnchorRelease?: () => Promise<void> | void
): Promise<PairedPublishedPairIdentity> {
  try {
    await afterAnchorRelease?.();
    const [output, receipt] = await Promise.all([capture.output.stat(), capture.receipt.stat()]);
    const outputFacts = identityOf(output), receiptFacts = identityOf(receipt);
    assertReleasedTransition(identity.output, outputFacts, "output");
    assertReleasedTransition(identity.receipt, receiptFacts, "receipt");
    await Promise.all([
      verifyReleasedCapture(capture.output, outputFacts, evidence.output, "output"),
      verifyReleasedCapture(capture.receipt, receiptFacts, evidence.receipt, "receipt")
    ]);
    const released = Object.freeze({ output: outputFacts, receipt: receiptFacts });
    captures.set(released as object, capture);
    return released;
  } catch (error) {
    await Promise.allSettled([capture.output.close(), capture.receipt.close()]);
    throw error;
  }
}

function identityOf(facts: Stats): PairedPublishedFileIdentity {
  return Object.freeze({ dev: Number(facts.dev), ino: Number(facts.ino), size: facts.size, mtimeMs: facts.mtimeMs, ctimeMs: facts.ctimeMs, nlink: facts.nlink });
}

function sameIdentity(left: PairedPublishedFileIdentity, right: PairedPublishedFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.nlink === right.nlink;
}

async function assertExactCapture(capture: HeldPairedCapture, identity: PairedPublishedPairIdentity): Promise<void> {
  const [output, receipt] = await Promise.all([capture.output.stat(), capture.receipt.stat()]);
  if (
    !sameIdentity(identityOf(output), identity.output)
    || !sameIdentity(identityOf(receipt), identity.receipt)
    || output.nlink !== 1
    || receipt.nlink !== 1
  ) {
    throw new Error("Paired held publication lost its exact single-link inode capture.");
  }
}

async function hashBoundedHandle(
  handle: FileHandle,
  expected: PairedPublishedFileIdentity,
  maximumBytes: number,
  member: string
): Promise<Readonly<{ sha256: string; byteLength: number }>> {
  const before = identityOf(await handle.stat());
  assertReadableIdentity(before, expected, maximumBytes, member);
  const hash = createHash("sha256"), chunk = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < before.size) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.byteLength, before.size - offset), offset);
    if (bytesRead === 0) throw new Error(`Paired held ${member} evidence ended before its retained size.`);
    hash.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const after = identityOf(await handle.stat());
  if (offset !== before.size || !sameIdentity(before, after)) {
    throw new Error(`Paired held ${member} evidence changed during retained descriptor hashing.`);
  }
  return Object.freeze({ sha256: hash.digest("hex"), byteLength: offset });
}

async function readBoundedHandle(
  handle: FileHandle,
  expected: PairedPublishedFileIdentity,
  maximumBytes: number,
  member: string
): Promise<Readonly<{ bytes: Buffer; sha256: string; byteLength: number }>> {
  const before = identityOf(await handle.stat());
  assertReadableIdentity(before, expected, maximumBytes, member);
  const bytes = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (bytesRead === 0) throw new Error(`Paired held ${member} evidence ended before its retained size.`);
    offset += bytesRead;
  }
  const after = identityOf(await handle.stat());
  if (offset !== before.size || !sameIdentity(before, after)) {
    throw new Error(`Paired held ${member} evidence changed during retained descriptor reading.`);
  }
  return Object.freeze({ bytes, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength });
}

function assertReadableIdentity(
  actual: PairedPublishedFileIdentity,
  expected: PairedPublishedFileIdentity,
  maximumBytes: number,
  member: string
): void {
  if (!sameIdentity(actual, expected) || actual.nlink !== 1 || !Number.isSafeInteger(actual.size) || actual.size < 2 || actual.size > maximumBytes) {
    throw new Error(`Paired held ${member} evidence is outside its retained bounded identity.`);
  }
}

function assertMaximum(value: number, member: string): void {
  if (!Number.isSafeInteger(value) || value < 2) {
    throw new Error(`Paired held ${member} read maximum is invalid.`);
  }
}

function assertReleasedTransition(previous: PairedPublishedFileIdentity, current: PairedPublishedFileIdentity, member: string): void {
  if (previous.dev !== current.dev || previous.ino !== current.ino || previous.size !== current.size || previous.mtimeMs !== current.mtimeMs || previous.nlink < 2 || current.nlink !== 1 || current.ctimeMs < previous.ctimeMs) {
    throw new Error(`Paired held ${member} evidence changed outside its exact anchor-release transition.`);
  }
}

async function verifyReleasedCapture(handle: FileHandle, before: PairedPublishedFileIdentity, evidence: DerivedFilePublicationEvidence, member: string): Promise<void> {
  if (before.size !== evidence.byteLength) throw new Error(`Paired held ${member} evidence length changed before released capture.`);
  const hash = createHash("sha256"), chunk = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < before.size) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.byteLength, before.size - offset), offset);
    if (bytesRead === 0) throw new Error(`Paired held ${member} evidence ended before its retained size.`);
    hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
  }
  const after = identityOf(await handle.stat());
  if (offset !== before.size || !sameIdentity(before, after) || hash.digest("hex") !== evidence.sha256) {
    throw new Error(`Paired held ${member} evidence changed during released descriptor capture.`);
  }
}
