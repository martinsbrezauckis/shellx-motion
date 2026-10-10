import { constants as fsConstants } from "node:fs";
import { open, readdir, rmdir, type FileHandle } from "node:fs/promises";
import { canonicalJsonSha256, type DerivedOutputPublication } from "@shellx-motion/core";
import { recordStrictSdrCandidateHeldMediaStage, type StrictSdrCandidateHeldPairRendererBinding } from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import type { LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import { compareLinearSrgbSdrFinalFrames } from "./linear-srgb-sdr-final-compare.js";
import { LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES } from "./linear-srgb-sdr-final-ffmpeg-contract.js";
import { heldEncodeCommand, heldInverseCommand, heldProbeCommand } from "./linear-srgb-sdr-final-held-media-command.js";
import { assertHeldMediaWriteAcknowledgement, closeHeldMediaAfterFailure, heldMediaEncodeFrameCount } from "./linear-srgb-sdr-final-held-media-support.js";
import { parseFfprobeOutput } from "./linear-srgb-sdr-final-ffprobe-output.js";
import { validateLinearSrgbSdrFinalMedia } from "./linear-srgb-sdr-final-media.js";
import { runLinearSrgbSdrHeldInverseChild, runLinearSrgbSdrHeldProbeChild } from "./ffmpeg-process-lifecycle.js";
import { copyHeldMediaToPublication } from "./linear-srgb-sdr-final-held-media-publication.js";
import { runHeldMediaF2aInverse, runHeldMediaThreeSlotAllDeliveredFrames, runHeldMediaThreeSlotInverse, type StrictSdrCandidateAllDeliveredFramesInverseResult } from "./linear-srgb-sdr-final-held-media-candidate-inverse.js";
import { captureCurrentStrictSdrCandidateF2aFrame, discardStrictSdrCandidateF2aFrameSnapshot, transferCurrentStrictSdrCandidateF2aLease, type StrictSdrCandidateF2aFrameSnapshot, type StrictSdrCandidateF2aLeaseOwner, type StrictSdrCandidateF2aLeaseTransfer } from "./linear-srgb-sdr-final-f2a-evaluator.js";
import { captureHeldMediaFrameForActiveHook, currentHeldMediaToolsForActiveHook, discardHeldMediaFrameForActiveHook, transferHeldMediaLeaseForActiveHook } from "./linear-srgb-sdr-final-held-media-hooks.js";
import type { HeldMediaExtensionOwner, HeldMediaExtensionTransfer } from "./linear-srgb-sdr-final-held-media-extension-types.js";
import { startLinearSrgbSdrHeldStreamingFfmpegProcess } from "./streaming-process.js";
import { revalidateStreamingFinalLaunch } from "./streaming-final-lineage-revalidation.js";
import { resolveFfmpegExecutable, resolveFfprobeExecutable, type FfmpegCommand } from "./index.js";
import { assertCurrentHeldToolResolution, assertHeldDirectoryIdentity, assertHeldMp4FastStart, assertHeldTool, assertHeldMediaPrivateNames, assertPinnedHeldLeaf, createExclusiveHeldLeaf, hashHeldLeaf, heldDirectoryFacts, openHeldTool, readExactHeldLeaf, removeHeldLeaf, sameHeldFacts, type HeldFileFacts, type HeldLeaf, type HeldTool } from "./linear-srgb-sdr-final-held-media-files.js";
import type { LinearSrgbSdrFinalExecutionEvidence, LinearSrgbSdrFinalJob } from "./linear-srgb-sdr-final-adapter.js";
import type { LinearSrgbSdrFinalWebGpuFrame } from "@shellx-motion/renderer-browser/internal/linear-srgb-sdr-final";

const HELD_SOURCE = "/proc/self/fd/4";
/** Private, descriptive proof of this one renderer operation. It grants no qualification. */
export type LinearSrgbSdrHeldMediaWitness = Readonly<{
  state: "copied-nonqualifying"; source: Readonly<{ sha256: string; byteLength: number; dev: number; ino: number }>;
  commands: LinearSrgbSdrHeldMediaSuccess["evidence"]["commands"]; privateStage: Readonly<{ sha256: string; byteLength: number }>;
}>;

const heldMediaWitnesses = new WeakMap<LinearSrgbSdrHeldMediaSuccess, LinearSrgbSdrHeldMediaWitness>();

/** The private adoption route consumes the identity recorded by the actual held copy. */
export function assertLinearSrgbSdrHeldMediaWitness(success: LinearSrgbSdrHeldMediaSuccess, staged: Readonly<{ sha256: string; byteLength: number }>): void {
  const witness = heldMediaWitnesses.get(success);
  if (!witness) throw new Error("Strict SDR held-media adoption has no completed operation witness.");
  if (witness.source.sha256 !== success.evidence.output.sha256 || witness.source.byteLength !== success.evidence.output.byteLength
    || witness.privateStage.sha256 !== staged.sha256 || witness.privateStage.byteLength !== staged.byteLength
    || witness.commands.encodeSha256 !== success.evidence.commands.encodeSha256 || witness.commands.probeSha256 !== success.evidence.commands.probeSha256
    || witness.commands.inverseSha256 !== success.evidence.commands.inverseSha256) {
    throw new Error("Strict SDR held-media adoption changed after its operation witness.");
  }
}

export interface LinearSrgbSdrHeldMediaSuccess {
  readonly evidence: Pick<LinearSrgbSdrFinalExecutionEvidence, "commands" | "media" | "comparison" | "output">;
  readonly encodeCommand: FfmpegCommand;
  copyToPublication(publication: DerivedOutputPublication, binding?: StrictSdrCandidateHeldPairRendererBinding): Promise<{ readonly sha256: string; readonly byteLength: number }>;
  transferF2aLease(transfer: StrictSdrCandidateF2aLeaseTransfer): boolean;
  transferThreeSlotLease(transfer: HeldMediaExtensionTransfer): boolean;
  close(): Promise<void>;
}

/** Candidate-only operation owner: it pins the private root before normal GPU production begins. */
export interface LinearSrgbSdrHeldMediaOperation {
  execute(frame: LinearSrgbSdrFinalWebGpuFrame): Promise<LinearSrgbSdrHeldMediaSuccess>;
  close(): Promise<void>;
}

type HeldMediaOperationInput = Readonly<{
  route: LinearSrgbSdrFinalRoute;
  job: LinearSrgbSdrFinalJob;
  privateRoot: string;
  outputPath: string;
  decodedPath: string;
}>;
/** Relative-source operation opener; root identity is held before the normal producer is invoked. */
export async function openLinearSrgbSdrHeldMedia(input: HeldMediaOperationInput): Promise<LinearSrgbSdrHeldMediaOperation> {
  if (process.platform !== "linux" || !fsConstants.O_NOFOLLOW) {
    throw new Error("Strict SDR held-media execution is limited to Linux hosts with O_NOFOLLOW.");
  }
  assertHeldMediaPrivateNames(input.privateRoot, input.outputPath, input.decodedPath);
  const operation = new HeldMediaOperation(input);
  try {
    await operation.openRoot();
    return Object.freeze({
      execute: async (frame: LinearSrgbSdrFinalWebGpuFrame) => await operation.execute(frame),
      close: async () => await operation.close(),
    });
  } catch (error) {
    await closeHeldMediaAfterFailure(operation, error);
    throw error;
  }
}

class HeldMediaOperation {
  readonly #input: HeldMediaOperationInput;
  #root: FileHandle | undefined;
  #rootIdentity: HeldFileFacts | undefined;
  #ffmpeg: HeldTool | undefined;
  #ffprobe: HeldTool | undefined;
  #sharedTools = false;
  #source: HeldLeaf | undefined;
  #decoded: HeldLeaf | undefined;
  #sourceFacts: { readonly sha256: string; readonly byteLength: number; readonly identity: HeldFileFacts } | undefined;
  #f2aSnapshot: StrictSdrCandidateF2aFrameSnapshot | undefined;
  #f2aDecodedCleanupError: unknown | undefined;
  #threeSlotDecodedCleanupError: unknown | undefined;
  #evidence: LinearSrgbSdrHeldMediaSuccess["evidence"] | undefined;
  #encode: FfmpegCommand | undefined;
  #success: LinearSrgbSdrHeldMediaSuccess | undefined;
  #copyAttempted = false;
  #closed = false;

  constructor(input: HeldMediaOperationInput) { this.#input = input; }

  async openRoot(): Promise<void> {
    this.#root = await open(this.#input.privateRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    this.#rootIdentity = await heldDirectoryFacts(this.#root, this.#input.privateRoot, "Strict SDR held-media private root");
    await assertHeldDirectoryIdentity(this.#root, this.#input.privateRoot, this.#rootIdentity, "Strict SDR held-media private root");
  }

  async execute(frame: LinearSrgbSdrFinalWebGpuFrame): Promise<LinearSrgbSdrHeldMediaSuccess> {
    if (this.#closed || this.#source || this.#evidence) throw new Error("Strict SDR held-media operation cannot execute twice.");
    const sharedTools = await currentHeldMediaToolsForActiveHook();
    if (sharedTools) {
      this.#ffmpeg = sharedTools.ffmpeg;
      this.#ffprobe = sharedTools.ffprobe;
      this.#sharedTools = true;
    } else {
      this.#ffmpeg = await openHeldTool(resolveFfmpegExecutable(), "FFmpeg");
      this.#ffprobe = await openHeldTool(resolveFfprobeExecutable(), "FFprobe");
    }
    this.#source = await createExclusiveHeldLeaf(this.root, this.#rootIdentity!, this.#input.outputPath, "Strict SDR held-media source");
    await this.encode(frame);
    await this.validate(frame);
    this.#f2aSnapshot = captureCurrentStrictSdrCandidateF2aFrame(this.#input.route, frame);
    captureHeldMediaFrameForActiveHook(this.#input.route, frame);
    return this.success();
  }

  async encode(frame: LinearSrgbSdrFinalWebGpuFrame): Promise<void> {
    const { route, job } = this.#input;
    const source = this.source;
    const ffmpeg = this.ffmpeg;
    const encode = heldEncodeCommand({
      width: route.canvas.width,
      height: route.canvas.height,
      fps: route.canvas.fps,
      frameCount: Math.ceil((route.canvas.durationMs / 1_000) * route.canvas.fps),
    }, ffmpeg.path);
    this.#encode = encode;
    assertCurrentHeldToolResolution(ffmpeg, resolveFfmpegExecutable, "FFmpeg before strict held encode");
    await assertHeldTool(ffmpeg, "FFmpeg before strict held encode");
    await assertPinnedHeldLeaf(this.root, this.#rootIdentity!, source, "Strict SDR held-media source before encode");
    await revalidateStreamingFinalLaunch();
    const active = await startLinearSrgbSdrHeldStreamingFfmpegProcess({
      command: encode,
      signal: job.signal,
      scratchRoot: job.scratchRoot,
      maxProcessTreeRssBytes: job.maxProcessTreeRssBytes,
      watchProcess: job.watchProcess,
      reportProcessContainment: job.reportProcessContainment,
    }, encode, ffmpeg.handle.fd, source.handle.fd);
    try {
      for (let index = 0; index < heldMediaEncodeFrameCount(route); index += 1) assertHeldMediaWriteAcknowledgement(await active.write(frame.rgba8Srgb));
      const result = await active.end();
      if (result.exitCode !== 0) throw new Error("Strict SDR held-media encoder did not complete successfully.");
    } catch (error) {
      try {
        await active.abort(new Error("Strict SDR held-media encoder failed."));
      } catch (abortError) {
        throw new AggregateError([error, abortError], "Strict SDR held-media encoder failed and its child could not settle.");
      }
      throw error;
    }
    const after = await assertPinnedHeldLeaf(this.root, this.#rootIdentity!, source, "Strict SDR held-media source after encode");
    if (after.size < 1 || after.size > LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES) throw new Error("Strict SDR held-media encoder produced an out-of-bounds source.");
    assertCurrentHeldToolResolution(ffmpeg, resolveFfmpegExecutable, "FFmpeg after strict held encode");
    await assertHeldTool(ffmpeg, "FFmpeg after strict held encode");
  }

  async validate(frame: LinearSrgbSdrFinalWebGpuFrame): Promise<void> {
    const { route, job } = this.#input;
    const source = this.source;
    const ffmpeg = this.ffmpeg;
    const ffprobe = this.ffprobe;
    const before = await hashHeldLeaf(this.root, this.#rootIdentity!, source, LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES, "Strict SDR held-media source before consumers");
    await assertHeldMp4FastStart(this.root, this.#rootIdentity!, source);

    assertCurrentHeldToolResolution(ffprobe, resolveFfprobeExecutable, "FFprobe before strict held probe");
    await assertHeldTool(ffprobe, "FFprobe before strict held probe");
    const probe = heldProbeCommand();
    await revalidateStreamingFinalLaunch();
    const probed = await runLinearSrgbSdrHeldProbeChild(probe, ffprobe.handle.fd, source.handle.fd, job.signal, job.watchProcess, () => "unix-process-group");
    if (probed.exitCode !== 0) throw new Error("Strict SDR held FFprobe did not complete successfully.");
    const media = validateLinearSrgbSdrFinalMedia({
      media: parseFfprobeOutput(HELD_SOURCE, probed.stdout),
      width: route.canvas.width,
      height: route.canvas.height,
      fps: route.canvas.fps,
      frameCount: heldMediaEncodeFrameCount(route),
    });
    await assertPinnedHeldLeaf(this.root, this.#rootIdentity!, source, "Strict SDR held-media source after FFprobe");
    assertCurrentHeldToolResolution(ffprobe, resolveFfprobeExecutable, "FFprobe after strict held probe");
    await assertHeldTool(ffprobe, "FFprobe after strict held probe");

    this.#decoded = await createExclusiveHeldLeaf(this.root, this.#rootIdentity!, this.#input.decodedPath, "Strict SDR held-media decoded output");
    const inverse = heldInverseCommand(ffmpeg.path);
    assertCurrentHeldToolResolution(ffmpeg, resolveFfmpegExecutable, "FFmpeg before strict held inverse");
    await assertHeldTool(ffmpeg, "FFmpeg before strict held inverse");
    await revalidateStreamingFinalLaunch();
    const decodedResult = await runLinearSrgbSdrHeldInverseChild(inverse, ffmpeg.handle.fd, source.handle.fd, this.#decoded.handle.fd, job.signal, job.watchProcess, () => "unix-process-group");
    if (decodedResult.exitCode !== 0) throw new Error("Strict SDR held-media inverse decode did not complete successfully.");
    const decoded = await readExactHeldLeaf(this.root, this.#rootIdentity!, this.#decoded, frame.rgba8Srgb.byteLength, "Strict SDR held-media decoded frame");
    const comparison = compareLinearSrgbSdrFinalFrames({ width: route.canvas.width, height: route.canvas.height, source: frame.rgba8Srgb, decoded });
    if (!comparison.accepted) throw new Error("Strict SDR held-media decoded-frame comparison refused the delivery result.");
    await removeHeldLeaf(this.root, this.#rootIdentity!, this.#decoded, "Strict SDR held-media decoded output");
    this.#decoded = undefined;
    assertCurrentHeldToolResolution(ffmpeg, resolveFfmpegExecutable, "FFmpeg after strict held inverse");
    await assertHeldTool(ffmpeg, "FFmpeg after strict held inverse");

    const after = await hashHeldLeaf(this.root, this.#rootIdentity!, source, LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES, "Strict SDR held-media source after consumers");
    if (before.sha256 !== after.sha256 || before.byteLength !== after.byteLength || !sameHeldFacts(before.identity, after.identity)) {
      throw new Error("Strict SDR held-media source changed during FFprobe or inverse decode.");
    }
    this.#sourceFacts = after;
    this.#evidence = Object.freeze({
      commands: Object.freeze({ encodeSha256: canonicalJsonSha256(this.#encode!), probeSha256: canonicalJsonSha256(probe), inverseSha256: canonicalJsonSha256(inverse) }),
      media,
      comparison,
      output: Object.freeze({ sha256: after.sha256, byteLength: after.byteLength }),
    });
  }

  success(): LinearSrgbSdrHeldMediaSuccess {
    if (!this.#evidence || !this.#encode || !this.#sourceFacts) throw new Error("Strict SDR held-media operation did not reach a verified source state.");
    if (this.#success) return this.#success;
    this.#success = Object.freeze({
      evidence: this.#evidence,
      encodeCommand: this.#encode,
      copyToPublication: async (publication: DerivedOutputPublication, binding?: StrictSdrCandidateHeldPairRendererBinding) => await this.copyToPublication(publication, binding),
      transferF2aLease: (transfer: StrictSdrCandidateF2aLeaseTransfer) => this.transferF2aLease(transfer),
      transferThreeSlotLease: (transfer: HeldMediaExtensionTransfer) => this.transferThreeSlotLease(transfer),
      close: async () => await this.close(),
    });
    return this.#success;
  }

  transferF2aLease(transfer: StrictSdrCandidateF2aLeaseTransfer): boolean {
    const snapshot = this.#f2aSnapshot;
    const transferred = transferCurrentStrictSdrCandidateF2aLease(snapshot, Object.freeze({
      runF2aInverse: async (input) => await this.runF2aInverse(input),
      close: async () => await this.close(),
    }), transfer);
    if (transferred) this.#f2aSnapshot = undefined;
    return transferred;
  }

  transferThreeSlotLease(transfer: HeldMediaExtensionTransfer): boolean {
    return transferHeldMediaLeaseForActiveHook(Object.freeze({
      runThreeSlotInverse: async (input) => await this.runThreeSlotInverse(input),
      runThreeSlotAllDeliveredFrames: async (input) => await this.runThreeSlotAllDeliveredFrames(input),
      close: async () => await this.close(),
    }), transfer);
  }
  async runF2aInverse(input: Parameters<StrictSdrCandidateF2aLeaseOwner["runF2aInverse"]>[0]): Promise<Awaited<ReturnType<StrictSdrCandidateF2aLeaseOwner["runF2aInverse"]>>> {
    if (this.#closed || this.#decoded) throw new Error("Strict SDR held-media F2a inverse is unavailable after closure or duplicate decode.");
    return await runHeldMediaF2aInverse({
      root: this.root, rootIdentity: this.#rootIdentity!, decodedPath: this.#input.decodedPath, route: this.#input.route,
      ffmpeg: this.ffmpeg, sourceFd: input.sourceFd, job: input.job,
      trackDecoded: (leaf) => { const current = this.#decoded; this.#decoded = leaf; return current; },
      compareDecoded: input.compareDecoded,
      recordDecodedCleanupError: (error) => { this.#f2aDecodedCleanupError = error; },
    });
  }
  async runThreeSlotInverse(input: Parameters<HeldMediaExtensionOwner["runThreeSlotInverse"]>[0]): Promise<Awaited<ReturnType<HeldMediaExtensionOwner["runThreeSlotInverse"]>>> {
    if (this.#closed || this.#decoded) throw new Error("Strict SDR held-media three-slot inverse is unavailable after closure or duplicate decode.");
    return await runHeldMediaThreeSlotInverse({
      root: this.root, rootIdentity: this.#rootIdentity!, decodedPath: this.#input.decodedPath, route: this.#input.route,
      ffmpeg: this.ffmpeg, sourceFd: input.sourceFd, job: input.job,
      trackDecoded: (leaf) => { const current = this.#decoded; this.#decoded = leaf; return current; },
      measureDecoded: input.measureDecoded,
      recordDecodedCleanupError: (error) => { this.#threeSlotDecodedCleanupError = error; },
    });
  }
  async runThreeSlotAllDeliveredFrames<T>(input: Readonly<{
    slot: "f2a" | "f2b-screen" | "f2b-screen-controls";
    sourceFd: number;
    job: import("./linear-srgb-sdr-final-adapter.js").LinearSrgbSdrFinalJob;
    observeFrame(input: Readonly<{
      frame: import("./linear-srgb-sdr-final-held-media-all-frames-inverse.js").StrictSdrCandidateAllDeliveredFrame;
      withOwnedRgba(operation: (rgba: Buffer) => Promise<T> | T): Promise<T>;
    }>): T | Promise<T>;
  }>): Promise<StrictSdrCandidateAllDeliveredFramesInverseResult<T>> {
    if (this.#closed || this.#decoded) throw new Error("Strict SDR held-media all-delivered-frame inverse is unavailable after closure or a retained decoded leaf.");
    return await runHeldMediaThreeSlotAllDeliveredFrames({ slot: input.slot, route: this.#input.route, ffmpeg: this.ffmpeg, sourceFd: input.sourceFd, job: input.job, observeFrame: input.observeFrame });
  }
  async copyToPublication(publication: DerivedOutputPublication, binding?: StrictSdrCandidateHeldPairRendererBinding): Promise<{ readonly sha256: string; readonly byteLength: number }> {
    const expected = this.#sourceFacts;
    if (!expected) throw new Error("Strict SDR held-media source is not verified for publication staging.");
    if (this.#closed || this.#copyAttempted) throw new Error("Strict SDR held-media private stage copy is closed or already attempted.");
    this.#copyAttempted = true;
    const staged = await copyHeldMediaToPublication({ root: this.root, rootIdentity: this.#rootIdentity!, source: this.source, sourceFacts: expected, publication });
    const success = this.#success;
    if (!success || !this.#evidence) throw new Error("Strict SDR held-media operation lost its verified success identity.");
    heldMediaWitnesses.set(success, Object.freeze({
      state: "copied-nonqualifying", source: Object.freeze({ sha256: expected.sha256, byteLength: expected.byteLength, dev: expected.identity.dev, ino: expected.identity.ino }),
      commands: this.#evidence.commands, privateStage: Object.freeze({ sha256: staged.sha256, byteLength: staged.byteLength }),
    }));
    assertLinearSrgbSdrHeldMediaWitness(success, staged);
    if (binding) {
      const coreStage = await recordStrictSdrCandidateHeldMediaStage(binding, publication);
      if (coreStage.sha256 !== staged.sha256 || coreStage.byteLength !== staged.byteLength) throw new Error("Strict SDR held-media copy did not match Core's verified private stage.");
    }
    return staged;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const errors: unknown[] = [];
    if (this.#f2aSnapshot) discardStrictSdrCandidateF2aFrameSnapshot(this.#f2aSnapshot);
    this.#f2aSnapshot = undefined;
    discardHeldMediaFrameForActiveHook();
    if (this.#f2aDecodedCleanupError) errors.push(this.#f2aDecodedCleanupError);
    if (this.#threeSlotDecodedCleanupError) errors.push(this.#threeSlotDecodedCleanupError);
    if (this.#decoded) await removeHeldLeaf(this.root, this.#rootIdentity!, this.#decoded, "Strict SDR held-media decoded cleanup").catch((error) => errors.push(error));
    this.#decoded = undefined;
    if (this.#source) await removeHeldLeaf(this.root, this.#rootIdentity!, this.#source, "Strict SDR held-media source cleanup").catch((error) => errors.push(error));
    this.#source = undefined;
    if (!this.#sharedTools) {
      await this.#ffmpeg?.handle.close().catch((error) => errors.push(error));
      await this.#ffprobe?.handle.close().catch((error) => errors.push(error));
    }
    this.#ffmpeg = undefined;
    this.#ffprobe = undefined;
    if (this.#root && this.#rootIdentity) {
      try {
        await assertHeldDirectoryIdentity(this.#root, this.#input.privateRoot, this.#rootIdentity, "Strict SDR held-media root cleanup");
        const entries = await readdir(this.#input.privateRoot);
        if (entries.length !== 0) throw new Error("Strict SDR held-media root retained unknown children.");
        await this.#root.close();
        this.#root = undefined;
        await rmdir(this.#input.privateRoot);
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.#root) await this.#root.close().catch((error) => errors.push(error));
    this.#root = undefined;
    if (errors.length > 0) throw new AggregateError(errors, "Strict SDR held-media cleanup retained an uncertain root.");
  }

  get root(): FileHandle { if (!this.#root) throw new Error("Strict SDR held-media root is not open."); return this.#root; }
  get source(): HeldLeaf { if (!this.#source) throw new Error("Strict SDR held-media source is not open."); return this.#source; }
  get ffmpeg(): HeldTool { if (!this.#ffmpeg) throw new Error("Strict SDR held-media FFmpeg is not open."); return this.#ffmpeg; }
  get ffprobe(): HeldTool { if (!this.#ffprobe) throw new Error("Strict SDR held-media FFprobe is not open."); return this.#ffprobe; }
}
