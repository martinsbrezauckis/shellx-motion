import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { LocalMotionJobEvidence } from "./job-governor";
import { escalateReceiptStatusForWarnings, receiptStatusForWarnings } from "./receipt-status";
import type {
  MotionAudioDucking,
  MotionKeyframe,
  OperationReceipt,
  ReceiptActor,
  ReceiptActorKind,
  ReceiptActorTransport,
  RenderLoudnessSummary
} from "./types";

export function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** The permitted {@link ReceiptActorKind} values, for validation and enumeration. */
export const RECEIPT_ACTOR_KINDS: readonly ReceiptActorKind[] = ["agent", "human", "host", "unknown"];

/** The permitted {@link ReceiptActorTransport} values, for validation and enumeration. */
export const RECEIPT_ACTOR_TRANSPORTS: readonly ReceiptActorTransport[] = [
  "cli", "http", "ws", "mcp", "sdk", "connector"
];

/** Narrow an arbitrary value to a trimmed non-empty string, or undefined. */
function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The caller-CLAIMED actor label for a receipt, if any, in precedence order:
 *   1. an explicit `actor.label` already stamped on the receipt (e.g. by a connector), then
 *   2. a caller-supplied `output.createdBy`.
 * Returns undefined when the caller made no identity claim (attribution then falls back to the
 * transport-inferred label). This is the "claim" half of the evidence/authentication split.
 *
 * @param receipt A receipt whose caller-claimed identity should be extracted.
 * @returns The claimed label, or undefined when the caller claimed no identity.
 */
export function receiptClaimedActorLabel(receipt: OperationReceipt): string | undefined {
  const claimedByActor = receipt.actor ? trimmedString(receipt.actor.label) : undefined;
  if (claimedByActor) return claimedByActor;
  const output = receipt.output;
  if (output && typeof output === "object" && !Array.isArray(output)) {
    return trimmedString((output as Record<string, unknown>).createdBy);
  }
  return undefined;
}

/**
 * Stamp transport-inferred actor attribution onto a receipt IN PLACE, honoring the
 * evidence-vs-authentication precedence documented on {@link ReceiptActor}:
 *
 *   - `label`/`kind`: the caller's CLAIM wins when present (an explicit `actor.label` or a
 *     `createdBy`), otherwise the transport-inferred value is used.
 *   - `transport`/`sessionId`/`grantedTier`/`clientInfo`: the OBSERVED transport facts always
 *     win — a caller can never overwrite them, so a spoofed label still rides visibly with the
 *     real transport identity.
 *
 * This is a no-op when `inferred` is undefined: paths that observed no transport (legacy/direct
 * callers) leave the receipt exactly as it was, so every historical receipt stays byte-for-byte
 * valid and the History view keeps its honest "unattributed" fallback. Mutation-in-place matches
 * the receipt-enrichment idiom already used in the debug-api render path, and guarantees the disk
 * copy and any inline `result.receipt` (same object reference) carry identical attribution.
 *
 * @param receipt The receipt to attribute. Mutated in place.
 * @param inferred Transport-observed actor facts, or undefined to leave the receipt unchanged.
 * @returns The same receipt reference, for convenient chaining at write sites.
 */
export function applyReceiptActor(receipt: OperationReceipt, inferred?: ReceiptActor): OperationReceipt {
  if (!inferred) return receipt;

  const claimedLabel = receiptClaimedActorLabel(receipt);
  const claimedKind = receipt.actor?.kind;
  // Observed transport facts prefer the freshly-inferred values, but fall back to any facts a
  // prior stamp (e.g. a connector) already recorded so re-stamping never loses observed evidence.
  const transport = inferred.transport ?? receipt.actor?.transport;
  const clientInfo = inferred.clientInfo ?? receipt.actor?.clientInfo;
  const sessionId = inferred.sessionId ?? receipt.actor?.sessionId;
  const grantedTier = inferred.grantedTier ?? receipt.actor?.grantedTier;

  receipt.actor = {
    kind: claimedKind ?? inferred.kind,
    label: claimedLabel ?? inferred.label,
    ...(transport ? { transport } : {}),
    ...(clientInfo ? { clientInfo } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(grantedTier ? { grantedTier } : {})
  };
  return receipt;
}

/**
 * Parse and validate a persisted/untrusted actor record into a {@link ReceiptActor}, or return
 * undefined when the value is absent or malformed. Used by the receipt-reading validators so the
 * actor field survives the round-trip from disk into the engine-room History view (a validator
 * that silently dropped it would make attribution invisible).
 *
 * @param value An arbitrary value that may be a serialized actor.
 * @returns A validated ReceiptActor, or undefined when absent/invalid.
 */
export function readReceiptActor(value: unknown): ReceiptActor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const label = trimmedString(record.label);
  if (!label) return undefined;
  if (typeof kind !== "string" || !RECEIPT_ACTOR_KINDS.includes(kind as ReceiptActorKind)) return undefined;

  const transport = typeof record.transport === "string"
    && RECEIPT_ACTOR_TRANSPORTS.includes(record.transport as ReceiptActorTransport)
    ? (record.transport as ReceiptActorTransport)
    : undefined;
  const clientInfo = trimmedString(record.clientInfo);
  const sessionId = trimmedString(record.sessionId);
  const grantedTier = trimmedString(record.grantedTier);

  return {
    kind: kind as ReceiptActorKind,
    label,
    ...(transport ? { transport } : {}),
    ...(clientInfo ? { clientInfo } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(grantedTier ? { grantedTier } : {})
  };
}

export async function hashFile(path: string): Promise<string> {
  const pathBefore = await lstat(path);
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) throw new Error("Hash input must be a regular non-symlink file.");
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino) {
      throw new Error("Hash input changed before it could be opened.");
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    const [after, pathAfter] = await Promise.all([handle.stat(), lstat(path)]);
    if (!after.isFile()
      || pathAfter.isSymbolicLink()
      || after.dev !== before.dev || after.ino !== before.ino
      || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) {
      throw new Error("Hash input changed while it was being read.");
    }
    return hash.digest("hex");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * How many frames may be hashed at once by {@link hashFramePaths}.
 *
 * Each in-flight {@link hashFile} holds one open descriptor plus one read stream (64 KiB default
 * highWaterMark), so the naive `Promise.all(framePaths.map(hashFile))` cost scales with the LENGTH
 * OF THE RENDER: the local render guard admits up to 36,000 frames, which is 36,000 simultaneous
 * descriptors and ~2.2 GiB of stream buffers on a machine that has just finished an expensive
 * render. That is over macOS's default 256-descriptor soft limit by two orders of magnitude, so the
 * failure mode was a late `EMFILE` after all the work was already paid for (the bounded-frame-hash invariant).
 *
 * 16 is chosen to keep the pass I/O-bound without becoming a fan-out: sha256 of a frame is fast
 * relative to reading it, so a handful of concurrent reads already saturates a disk queue, and the
 * ceiling stays far below every platform's default descriptor limit with room for the descriptors
 * the rest of the process is holding. Fixed rather than derived from `ulimit` so the bound is a
 * property of Motion, identical on every machine and therefore testable.
 */
export const FRAME_HASH_CONCURRENCY = 16;

/**
 * Hash an ordered list of frame files with a bounded number of concurrent reads.
 *
 * Returns hashes in INPUT ORDER regardless of completion order — callers fold the result into a
 * sequence hash, so order is part of the contract, not an implementation detail.
 *
 * The pool is a fixed set of workers pulling from a shared cursor rather than a chunked
 * `Promise.all` over slices: a chunked shape stalls the whole batch on its slowest member, and the
 * slowest member here is whichever frame the page cache missed.
 *
 * A failure rejects, and in-flight work is allowed to settle before the rejection propagates so a
 * concurrent read failure can never surface as an unhandled rejection.
 *
 * @param framePaths Frame files to hash, in sequence order.
 * @param concurrency Maximum simultaneously open frames. Defaults to {@link FRAME_HASH_CONCURRENCY}.
 * @param hash Test seam; production hashes with {@link hashFile}.
 * @returns sha256 hex digests, one per input path, in input order.
 */
export async function hashFramePaths(
  framePaths: readonly string[],
  options: { concurrency?: number; hash?: (path: string) => Promise<string> } = {}
): Promise<string[]> {
  const hash = options.hash ?? hashFile;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? FRAME_HASH_CONCURRENCY, framePaths.length || 1));
  const hashes = new Array<string>(framePaths.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= framePaths.length) return;
      hashes[index] = await hash(framePaths[index]);
    }
  };
  // allSettled, then rethrow: every worker finishes (and closes its descriptor) before the first
  // failure escapes, so a mid-sequence unreadable frame cannot leak an open handle.
  const settled = await Promise.allSettled(Array.from({ length: concurrency }, () => worker()));
  const failed = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
  if (failed) throw failed.reason;
  return hashes;
}

/**
 * The external programs Motion resolves and shells out to.
 *
 * `chromium` is a peer of the codec tools, not a lesser dependency: Motion's DEFAULT frame lane
 * (`render --frame-lane browser`) rasterizes every frame in a real Chrome/Chromium, and the
 * `playwright-core` dependency deliberately downloads no browser. Leaving it out of this vocabulary
 * is what let `doctor --operation render.final` report a clean machine and the very next `render`
 * fail with "No Chrome/Chromium executable found for browser renderer."
 */
export type MotionToolName = "ffmpeg" | "ffprobe" | "chromium";

/**
 * How a tool executable was located.
 *
 *   - `override` — an explicit `SHELLX_MOTION_FFMPEG` / `SHELLX_MOTION_FFPROBE` /
 *     `SHELLX_MOTION_BROWSER` path.
 *   - `shellx-family` — a copy bundled under a ShellX product's tools folder (Windows).
 *   - `path` — a well-known location: the bare command name resolved by the OS through PATH for the
 *     codec tools, or a documented install/Playwright-cache location for Chromium, which is never
 *     PATH-resolved (see `browser-executable.ts`).
 */
export type MotionToolSource = "override" | "shellx-family" | "path";

/**
 * Redacted identity of an external tool that contributed to a receipt (the tool-identity invariant).
 *
 * Lives in core because it is receipt vocabulary: `renderer-ffmpeg` produces it, the render receipt
 * carries it, and hosts read it — a single definition rather than one per package.
 *
 * `executable` is a basename, never an absolute path: a receipt is shared evidence, and a full path
 * names a user's home directory, username and install layout. `source` carries the part that is
 * actually needed to reproduce an encode — whether the binary came from PATH, an explicit override,
 * or a bundled ShellX copy.
 */
export interface MotionToolIdentity {
  tool: MotionToolName;
  source: MotionToolSource;
  executable: string;
  /** Bounded, redacted first line of the tool's `-version` output, when it was probed. */
  version?: string;
}

/**
 * Why a particular video encoder ran for a final render. Recorded on the
 * render receipt so an verifier can tell hardware from software encodes and understand fallbacks:
 *   - "probe-selected-hardware": a hardware encoder was proved usable by the per-machine probe and ran.
 *   - "hardware-fallback": a probe-selected hardware encoder failed at encode time; software ran instead.
 *   - "forced-software": software was forced (SHELLX_MOTION_FORCE_SOFTWARE_ENCODE / option) for reproducibility.
 *   - "software-default": software ran because no usable hardware candidate was selected.
 */
export type RenderEncoderReason =
  | "probe-selected-hardware"
  | "hardware-fallback"
  | "forced-software"
  | "software-default";

export interface PreviewReceiptInput {
  id: string;
  packageId: string;
  lane: string;
  inputHashes: Record<string, string>;
  outputFrame: { path: string; sha256: string; width: number; height: number; atMs: number };
  quality?: PreviewQualityEvidence;
  warnings: string[];
}

export type PreviewReceiptStatus = Extract<OperationReceipt["status"], "passed" | "warning" | "failed">;

export interface PreviewQualityEvidence {
  status: PreviewReceiptStatus;
  code?: string;
  message?: string;
  metrics?: Record<string, unknown>;
}

export function createPreviewReceipt(input: PreviewReceiptInput): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: input.id,
    operation: "preview.frame",
    status: previewReceiptStatus({ warnings: input.warnings, quality: input.quality }),
    packageId: input.packageId,
    inputHashes: input.inputHashes,
    createdAt: new Date().toISOString(),
    lane: input.lane,
    output: input.quality ? { ...input.outputFrame, quality: input.quality } : input.outputFrame,
    warnings: input.warnings
  };
}

/**
 * A preview frame's status: measured quality evidence first, then the shared receipt-status rule.
 *
 * Quality evidence is a verdict this lane reached about the pixels it drew, so it outranks the
 * warnings text. Everything below it defers to {@link receiptStatusForWarnings} — the single
 * definition in `./receipt-status`, shared with the final render lane and the connectors, so the
 * three surfaces cannot drift back into three opinions.
 */
export function previewReceiptStatus(input: { warnings: string[]; quality?: PreviewQualityEvidence }): PreviewReceiptStatus {
  if (input.quality?.status === "failed") return "failed";
  if (input.quality?.status === "warning") return "warning";
  return receiptStatusForWarnings({ warnings: input.warnings });
}

export interface RenderReceiptInput {
  id: string;
  packageId: string;
  lane: string;
  status: OperationReceipt["status"];
  inputHashes: Record<string, string>;
  output: null | {
    path: string;
    sha256: string;
    width: number;
    height: number;
    durationMs: number;
    codec: string;
    container: string;
    preset?: string;
    /** Encoder that actually produced the output bitstream (e.g. "libx264", "h264_nvenc"). */
    encoder?: string;
    /** Whether the encoder that ran was a hardware (GPU/fixed-function) or software encoder. */
    encoderSource?: "hardware" | "software";
    /** Why this encoder ran (probe/default/forced/fallback). See RenderEncoderReason. */
    encoderReason?: RenderEncoderReason;
    /**
     * Hardware usability-probe evidence: which hardware encoders initialized, and which was chosen.
     * `provenance` records where the probe evidence came from — a fresh probe run for this render, or
     * a cached probe reused from the shared encode-policy cache. Absent when the probe was run
     * ad hoc without the centralized policy.
     */
    encoderProbe?: { usableHardwareEncoders: string[]; selectedHardwareEncoder: string | null; provenance?: "fresh-probe" | "cached" };
    /** Present only when a hardware encode failed and software took over — the attempted encoder + reason. */
    encoderFallback?: { attemptedEncoder: string; reason: string };
    color?: {
      profile: string;
      primaries: string;
      transfer: string;
      matrix: string;
      range: string;
      conversion: string;
    };
    audio?: {
      path?: string;
      codec: string;
      mix?: string;
      tracks?: Array<{
        path: string;
        startMs?: number;
        durationMs?: number;
        trimStartMs?: number;
        trimDurationMs?: number;
        loop?: boolean;
        volume?: number;
        pan?: number;
        muted?: boolean;
        fadeInMs?: number;
        fadeOutMs?: number;
        normalizeLoudness?: boolean;
        playbackRate?: number;
        ducking?: MotionAudioDucking;
        volumeKeyframes?: MotionKeyframe[];
      }>;
      startMs?: number;
      durationMs?: number;
      trimStartMs?: number;
      trimDurationMs?: number;
      loop?: boolean;
      volume?: number;
      pan?: number;
      muted?: boolean;
      fadeInMs?: number;
      fadeOutMs?: number;
      normalizeLoudness?: boolean;
      playbackRate?: number;
      ducking?: MotionAudioDucking;
      volumeKeyframes?: MotionKeyframe[];
      /** EBU R128 loudness normalization evidence (two-pass measured values). */
      loudness?: RenderLoudnessSummary;
    };
    resources?: LocalMotionJobEvidence;
    /**
     * Which external tools produced this artifact. `ffmpeg` is always present on an ffmpeg-lane
     * receipt; `ffprobe` appears once a validation pass has actually read the media back (review
     * finding the tool-identity invariant — encoder name alone cannot reproduce or vouch for an encode).
     */
    tools?: { ffmpeg: MotionToolIdentity; ffprobe?: MotionToolIdentity };
  };
  warnings: string[];
}

/**
 * Build a final render receipt, with the shared receipt-status rule applied at the door.
 *
 * The rule is applied HERE rather than at each call site because this function is the only way a
 * `render.final` receipt is constructed in the engine, so applying it here is what makes "one rule"
 * an invariant instead of a convention three renderer paths have to remember. A caller that already
 * decided `failed` / `not_run` keeps its verdict; a `passed` claim carrying an actionable warning
 * becomes `warning`; a `passed` receipt cannot carry warnings while a
 * preview receipt could not, and the connector aggregating the same warning said `warning`).
 */
export function createRenderReceipt(input: RenderReceiptInput): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: input.id,
    operation: "render.final",
    status: escalateReceiptStatusForWarnings(input.status, input.warnings),
    packageId: input.packageId,
    inputHashes: input.inputHashes,
    createdAt: new Date().toISOString(),
    lane: input.lane,
    output: input.output,
    warnings: input.warnings
  };
}
