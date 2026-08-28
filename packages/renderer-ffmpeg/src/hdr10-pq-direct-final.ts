import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  canonicalJson,
  canonicalJsonSha256,
  isPublicationCommitUncertain,
  OutputDirectoryTransaction,
  type MotionPackage,
  type PublicationCommitUncertainEvidence
} from "@shellx-motion/core";
import { createGpuScene3dGltfPbrHdr10StreamingProducer, resolveGpuScene3dGltfPbrHdr10Route, type GpuScene3dGltfPbrHdr10StreamingFrame, type GpuScene3dGltfPbrHdr10StreamingProducer } from "@shellx-motion/renderer-browser/internal/scene3d-gltf-pbr-hdr10-streaming";
import { HDR10_PQ_CONVERSION_CONTRACT } from "./hdr10-pq-conversion-contract.js";
import { convertHdr10PqReadbackAsync, createHdr10PqConversionSequence } from "./hdr10-pq-conversion.js";
import { createHdr10PqFfmpegCommand, HDR10_PQ_C1_FFMPEG_ARGS } from "./hdr10-pq-ffmpeg-command.js";
import { HDR10_PQ_FFPROBE_PIPE_ARGS, HDR10_PQ_FFPROBE_QUERY, verifyHdr10PqFfprobeObservation } from "./hdr10-pq-ffprobe.js";
import { HDR10_PQ_DIRECT_FINAL_MAX_FFPROBE_BYTES, HDR10_PQ_DIRECT_FINAL_MAX_OUTPUT_BYTES, HDR10_PQ_DIRECT_FINAL_MAX_PROCESS_TREE_RSS_BYTES, HDR10_PQ_DIRECT_FINAL_OUTPUT_FILE, HDR10_PQ_DIRECT_FINAL_RECEIPT_FILE, HDR10_PQ_DIRECT_FINAL_SCHEMA, HDR10_PQ_DIRECT_FINAL_TIMEOUT_MS, createHdr10PqDirectFinalReceipt, type Hdr10PqDirectFinalReceipt } from "./hdr10-pq-direct-final-contract.js";
import { assertHdr10PqOutputDisjoint } from "./hdr10-pq-output-topology.js";
import { createHdr10PqDirectFinalDeadline, isHdr10PqDirectFinalJob, type Hdr10PqDirectFinalJob } from "./hdr10-pq-direct-final-job.js";
import { assertHdr10PqExactBundleChildren, assertHdr10PqNoFollowStagedFileSupport, assertHdr10PqPinnedStagedFileCurrent, closeHdr10PqPinnedStagedFile, copyHdr10PqPinnedStagedFileExclusive, hashHdr10PqPinnedStagedFile, type Hdr10PqPinnedStagedFile, openHdr10PqPinnedStagedFile, removeHdr10PqPinnedStagedFile, writeHdr10PqExclusiveStagedReceipt } from "./hdr10-pq-staged-file.js";
import { resolveFfmpegExecutable, resolveFfprobeExecutable, type FfmpegCommand } from "./index.js";
import { startStreamingFfmpegProcess, type StreamingFfmpegProcess, type StreamingFfmpegProcessFactory } from "./streaming-process.js";

export type { Hdr10PqDirectFinalJob } from "./hdr10-pq-direct-final-job.js";
export interface Hdr10PqDirectFinalInput { readonly schema: typeof HDR10_PQ_DIRECT_FINAL_SCHEMA; readonly pkg: MotionPackage; readonly outputDirectory: string; readonly job: Hdr10PqDirectFinalJob; }
type Hdr10PqDirectFinalFailureCode = "hdr10_direct_final_refused" | "hdr10_direct_final_cancelled" | "hdr10_direct_final_failed" | "publication_commit_uncertain";
export type Hdr10PqDirectFinalResult = { readonly ok: true; readonly outputDirectory: string; readonly receipt: Hdr10PqDirectFinalReceipt } | {
  readonly ok: false;
  readonly code: Hdr10PqDirectFinalFailureCode;
  readonly message: string;
  readonly possiblyCommitted?: true;
  readonly publicPaths?: readonly string[];
  readonly expectedPublication?: PublicationCommitUncertainEvidence;
};
type PipeLease = { readonly process: StreamingFfmpegProcess; readonly packageId: string };
const ACTIVE_PIPE_LEASES = new WeakSet<PipeLease>();
type DirectFinalServices = { readonly resolveRoute: typeof resolveGpuScene3dGltfPbrHdr10Route; readonly createProducer: typeof createGpuScene3dGltfPbrHdr10StreamingProducer; readonly startProcess: StreamingFfmpegProcessFactory; readonly createTransaction: typeof OutputDirectoryTransaction.create; };
const PRODUCTION_SERVICES: DirectFinalServices = Object.freeze({ resolveRoute: resolveGpuScene3dGltfPbrHdr10Route, createProducer: createGpuScene3dGltfPbrHdr10StreamingProducer, startProcess: startStreamingFfmpegProcess, createTransaction: OutputDirectoryTransaction.create });

/**
 * Private C2 vertical: it is not a generic final route and only accepts an
 * authenticated HDR marker route, one contained Browser session, and one
 * software FFmpeg pipe. C1 results are computation evidence, never authority.
 */
export async function renderHdr10PqDirectFinalInternal(input: Hdr10PqDirectFinalInput): Promise<Hdr10PqDirectFinalResult> {
  return await render(input, PRODUCTION_SERVICES);
}

/** Test-only relative-module seam; it is deliberately not a package export or host route. */
export async function renderHdr10PqDirectFinalForTest(input: Hdr10PqDirectFinalInput, services: DirectFinalServices): Promise<Hdr10PqDirectFinalResult> {
  return await render(input, services);
}

async function render(input: Hdr10PqDirectFinalInput, services: DirectFinalServices): Promise<Hdr10PqDirectFinalResult> {
  let transaction: OutputDirectoryTransaction | undefined, encoder: StreamingFfmpegProcess | undefined, probe: StreamingFfmpegProcess | undefined, workFile: Hdr10PqPinnedStagedFile | undefined, outputFile: Hdr10PqPinnedStagedFile | undefined, receiptFile: Hdr10PqPinnedStagedFile | undefined, succeeded = false;
  const deadline = input && typeof input === "object" && isHdr10PqDirectFinalJob((input as { job?: unknown }).job) ? createHdr10PqDirectFinalDeadline((input as Hdr10PqDirectFinalInput).job.signal) : undefined;
  try {
    if (!validInput(input)) return failure("hdr10_direct_final_refused", "HDR10 direct final requires one exact pre-acquired private request.");
    if (!deadline) return failure("hdr10_direct_final_refused", "HDR10 direct final requires one exact pre-acquired private request.");
    assertHdr10PqNoFollowStagedFileSupport();
    if (deadline.signal.aborted) return failure("hdr10_direct_final_cancelled", "HDR10 direct final was cancelled before authenticated route resolution.");
    if (hasAudio(input.pkg.motion)) return failure("hdr10_direct_final_refused", "HDR10 direct final does not admit package audio or video-audio.");
    const resolved = await services.resolveRoute(input.pkg); if (resolved.kind !== "present") return failure("hdr10_direct_final_refused", "HDR10 direct final requires an authenticated HDR marker route.");
    await assertHdr10PqOutputDisjoint(input.pkg.root, input.outputDirectory); transaction = await services.createTransaction(input.outputDirectory, { requireAbsent: true }); await transaction.assertCurrent();
    const workPath = join(transaction.stagingPath, `.hdr10-c2-work-${randomUUID()}.mp4`), outputPath = join(transaction.stagingPath, HDR10_PQ_DIRECT_FINAL_OUTPUT_FILE), command = encoderCommand(workPath), producer = services.createProducer(resolved, input.pkg.motion);
    const job = { ...input.job, signal: deadline.signal }, processInput = { command, signal: deadline.signal, scratchRoot: job.scratchRoot, maxProcessTreeRssBytes: job.maxProcessTreeRssBytes, watchProcess: job.watchProcess, reportProcessContainment: job.reportProcessContainment };
    encoder = await services.startProcess(processInput); const lease = Object.freeze({ process: encoder, packageId: resolved.hdrRoute.packageId }); ACTIVE_PIPE_LEASES.add(lease);
    const receipts = await writeProducerToLease(producer, lease, job); const encoderResult = await encoder.end(); encoder = undefined;
    if (encoderResult.exitCode !== 0) throw new Error("HDR10 software encoder did not complete successfully.");
    const conversion = createHdr10PqConversionSequence(receipts), c1 = createHdr10PqFfmpegCommand(conversion); if (canonicalJson(c1.command.args) !== canonicalJson(c1CommandArgs())) throw new Error("HDR10 C1 command plan drifted from the C2 pinned command.");
    workFile = await openHdr10PqPinnedStagedFile(workPath, HDR10_PQ_DIRECT_FINAL_MAX_OUTPUT_BYTES); const work = { sha256: await hashHdr10PqPinnedStagedFile(workFile), byteLength: workFile.byteLength };
    const probeCommand = ffprobeCommand(), probeInput = { command: probeCommand, signal: deadline.signal, scratchRoot: job.scratchRoot, maxProcessTreeRssBytes: job.maxProcessTreeRssBytes, watchProcess: job.watchProcess, reportProcessContainment: job.reportProcessContainment };
    probe = await services.startProcess(probeInput); const probeResult = await probePinnedFile(probe, workFile); probe = undefined;
    if (probeResult.exitCode !== 0 || Buffer.byteLength(probeResult.stdout, "utf8") > HDR10_PQ_DIRECT_FINAL_MAX_FFPROBE_BYTES) throw new Error("HDR10 FFprobe did not return bounded successful readback.");
    let observed: unknown; try { observed = JSON.parse(probeResult.stdout); } catch { throw new Error("HDR10 FFprobe returned invalid JSON."); }
    const validation = verifyHdr10PqFfprobeObservation(observed); if (!validation) throw new Error("HDR10 FFprobe readback does not match the fixed Main10 contract.");
    const stableAfterProbe = { sha256: await hashHdr10PqPinnedStagedFile(workFile), byteLength: workFile.byteLength }; if (work.sha256 !== stableAfterProbe.sha256 || work.byteLength !== stableAfterProbe.byteLength) throw new Error("HDR10 staged work artifact changed during FFprobe verification."); outputFile = await copyHdr10PqPinnedStagedFileExclusive(workFile, outputPath, HDR10_PQ_DIRECT_FINAL_MAX_OUTPUT_BYTES); await removeHdr10PqPinnedStagedFile(workFile); await closeHdr10PqPinnedStagedFile(workFile); workFile = undefined;
    const evidence = producer.evidence; if (!evidence.fingerprint || evidence.cleanup.state !== "complete" || !evidence.cleanup.resourcesReleased || !evidence.cleanup.readbackReleased || !evidence.cleanup.pageClosed || evidence.framesRendered !== 90 || !evidence.rawFrameSequenceSha256) throw new Error("HDR10 Browser producer did not prove terminal 90-frame cleanup.");
    const output = { sha256: await hashHdr10PqPinnedStagedFile(outputFile), byteLength: outputFile.byteLength }; const receipt = createHdr10PqDirectFinalReceipt({ packageId: resolved.hdrRoute.packageId, route: { fingerprint: resolved.hdrRoute.fingerprint, sourceInputHashes: resolved.hdrRoute.inputHashes, sceneStateSha256: resolved.hdrRoute.staticPlan.inheritedSdr.sceneStateSha256, staticFingerprint: resolved.hdrRoute.staticPlan.fingerprint, sdrStaticFingerprint: resolved.sdrRoute.renderPlan.staticPlan.fingerprint, frameFingerprint: resolved.sdrRoute.renderPlan.framePlan.fingerprint }, browser: { catalogSha256: evidence.catalogSha256, pipelineSha256: evidence.pipelineSha256, producerEvidenceSha256: evidence.fingerprint, rawFrameSequenceSha256: evidence.rawFrameSequenceSha256, framesRendered: 90 }, conversion: { contractSha256: canonicalJsonSha256(HDR10_PQ_CONVERSION_CONTRACT), sequenceFingerprint: conversion.fingerprint, generatedReceiptSha256: conversion.generatedReceiptSha256, generatedFrameSequenceSha256: conversion.generatedFrameSequenceSha256, frameCount: 90, generatedYuvFrameByteLength: 2_764_800 }, command: { c1InertPlanSha256: c1.fingerprint, c2TokenizedCommandSha256: canonicalJsonSha256({ schema: HDR10_PQ_DIRECT_FINAL_SCHEMA, c1Args: c1CommandArgs(), maxOutputBytes: HDR10_PQ_DIRECT_FINAL_MAX_OUTPUT_BYTES }), softwareEncoder: "libx265", hardware: "refused" }, probe: { querySha256: canonicalJsonSha256(HDR10_PQ_FFPROBE_QUERY), observedJsonSha256: canonicalJsonSha256(observed), observedStreamSha256: validation.streamSha256, validationFingerprint: validation.fingerprint }, output: { file: HDR10_PQ_DIRECT_FINAL_OUTPUT_FILE, ...output }, limits: { maxOutputBytes: HDR10_PQ_DIRECT_FINAL_MAX_OUTPUT_BYTES, timeoutMs: HDR10_PQ_DIRECT_FINAL_TIMEOUT_MS, maxFfprobeBytes: HDR10_PQ_DIRECT_FINAL_MAX_FFPROBE_BYTES, maximumProcessTreeRssBytes: HDR10_PQ_DIRECT_FINAL_MAX_PROCESS_TREE_RSS_BYTES, governedProcessTreeRssBytes: input.job.maxProcessTreeRssBytes }, cleanup: { browserTerminal: true, encoderExitCode: 0, ffprobeExitCode: 0 } });
    const receiptBytes = Buffer.from(canonicalJson(receipt), "utf8"); receiptFile = await writeHdr10PqExclusiveStagedReceipt(join(transaction.stagingPath, HDR10_PQ_DIRECT_FINAL_RECEIPT_FILE), receiptBytes);
    await transaction.assertCurrent(); await assertHdr10PqExactBundleChildren(transaction.stagingPath, outputFile, receiptFile); await transaction.commit(); await transaction.assertPublishedCurrent(); succeeded = true; return { ok: true, outputDirectory: transaction.outputPath, receipt };
  } catch (error) {
    if (isPublicationCommitUncertain(error)) {
      return failure(error.code, error.message, {
        possiblyCommitted: true,
        publicPaths: [error.evidence.publicPath],
        expectedPublication: error.evidence
      });
    }
    return deadline?.signal.aborted ? failure("hdr10_direct_final_cancelled", "HDR10 direct final cancelled before a public bundle was committed.") : failure("hdr10_direct_final_failed", error instanceof Error ? `HDR10 direct final failed closed: ${error.message.slice(0, 280)}` : "HDR10 direct final failed closed.");
  } finally {
    deadline?.close(); await closeHdr10PqPinnedStagedFile(receiptFile); await closeHdr10PqPinnedStagedFile(outputFile); await closeHdr10PqPinnedStagedFile(workFile); if (!succeeded) { await probe?.abort(new Error("HDR10 direct final did not complete.")).catch(() => undefined); await encoder?.abort(new Error("HDR10 direct final did not complete.")).catch(() => undefined); await transaction?.abort(); }
  }
}

async function writeProducerToLease(producer: GpuScene3dGltfPbrHdr10StreamingProducer, lease: PipeLease, job: Hdr10PqDirectFinalJob): Promise<Awaited<ReturnType<typeof convertHdr10PqReadbackAsync>>[]> {
  const receipts: Awaited<ReturnType<typeof convertHdr10PqReadbackAsync>>[] = [];
  await producer.produce({ write: async (frame) => { const receipt = await convertHdr10PqReadbackAsync(frame, async (chunk) => { if (!ACTIVE_PIPE_LEASES.has(lease) || lease.process.closed === undefined) throw new Error("HDR10 C2 pipe lease is no longer active."); const ack = await lease.process.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)); if (typeof ack.backpressured !== "boolean" || !integer(ack.bufferedInputBytes, 0, 64 * 1024 * 1024) || !integer(ack.inputHighWaterMarkBytes, 1, 64 * 1024 * 1024)) throw new Error("HDR10 C2 pipe did not return a bounded write acknowledgement."); }); receipts.push(receipt); } }, job);
  if (receipts.length !== 90 || receipts.some((receipt, index) => receipt.frameIndex !== index)) throw new Error("HDR10 C2 did not convert exactly the fixed frame sequence."); return receipts;
}

function encoderCommand(outputPath: string): FfmpegCommand { return { executable: resolveFfmpegExecutable(), shell: false, args: ["-hide_banner", "-nostdin", "-n", "-f", "rawvideo", "-pixel_format", "yuv420p10le", "-video_size", "1280x720", "-framerate", "30", "-i", "pipe:0", "-map", "0:v:0", "-an", "-frames:v", "90", "-c:v", "libx265", "-profile:v", "main10", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", "-color_range", "tv", "-chroma_sample_location", "topleft", "-x265-params", "hdr10=1:repeat-headers=1:master-display=G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(10000000,1)", "-movflags", "+faststart", "-fs", String(HDR10_PQ_DIRECT_FINAL_MAX_OUTPUT_BYTES), outputPath] }; }
function c1CommandArgs(): readonly string[] { return HDR10_PQ_C1_FFMPEG_ARGS; }
function ffprobeCommand(): FfmpegCommand { return { executable: resolveFfprobeExecutable(), shell: false, args: [...HDR10_PQ_FFPROBE_PIPE_ARGS] }; }
async function probePinnedFile(process: StreamingFfmpegProcess, file: Hdr10PqPinnedStagedFile) { const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, file.byteLength)); let offset = 0; while (offset < file.byteLength) { const { bytesRead } = await file.handle.read(buffer, 0, Math.min(buffer.length, file.byteLength - offset), offset); if (bytesRead < 1) throw new Error("HDR10 pinned output ended before FFprobe could read it."); const ack = await process.write(buffer.subarray(0, bytesRead)); if (!validPipeAck(ack)) throw new Error("HDR10 FFprobe pipe did not return a bounded write acknowledgement."); offset += bytesRead; } const result = await process.end(); await assertHdr10PqPinnedStagedFileCurrent(file); return result; }
function validInput(value: unknown): value is Hdr10PqDirectFinalInput { return !!value && typeof value === "object" && Object.keys(value).sort().join(",") === "job,outputDirectory,pkg,schema" && (value as Hdr10PqDirectFinalInput).schema === HDR10_PQ_DIRECT_FINAL_SCHEMA && !!(value as Hdr10PqDirectFinalInput).pkg && typeof (value as Hdr10PqDirectFinalInput).outputDirectory === "string" && (value as Hdr10PqDirectFinalInput).outputDirectory.length > 0 && validJob((value as Hdr10PqDirectFinalInput).job); }
function validJob(value: unknown): value is Hdr10PqDirectFinalJob { return isHdr10PqDirectFinalJob(value); }
function hasAudio(motion: unknown): boolean { const layers = (motion as { layers?: unknown })?.layers; return Array.isArray(layers) && layers.some((layer) => !!layer && typeof layer === "object" && ((layer as { type?: unknown }).type === "audio" || (layer as { type?: unknown; includeAudio?: unknown }).type === "video" && (layer as { includeAudio?: unknown }).includeAudio === true)); }
function failure(
  code: Hdr10PqDirectFinalFailureCode,
  message: string,
  detail: Omit<Extract<Hdr10PqDirectFinalResult, { ok: false }>, "ok" | "code" | "message"> = {}
): Hdr10PqDirectFinalResult { return { ok: false, code, message, ...detail }; }
function integer(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max; }
function validPipeAck(value: unknown): value is { backpressured: boolean; bufferedInputBytes: number; inputHighWaterMarkBytes: number } { return !!value && typeof value === "object" && typeof (value as { backpressured?: unknown }).backpressured === "boolean" && integer((value as { bufferedInputBytes?: unknown }).bufferedInputBytes, 0, 64 * 1024 * 1024) && integer((value as { inputHighWaterMarkBytes?: unknown }).inputHighWaterMarkBytes, 1, 64 * 1024 * 1024); }
