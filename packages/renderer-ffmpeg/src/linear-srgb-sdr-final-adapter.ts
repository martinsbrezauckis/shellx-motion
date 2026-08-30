import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  canonicalJsonSha256,
  type LocalMotionProcessContainmentEvidence,
} from "@shellx-motion/core";
import {
  resolveLinearSrgbSdrFinalRoute,
  type LinearSrgbSdrFinalRoute,
} from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import {
  createLinearSrgbSdrFinalWebGpuProducer,
  type LinearSrgbSdrFinalWebGpuProducerEvidence,
  type LinearSrgbSdrFinalWebGpuProducerResolution,
} from "@shellx-motion/renderer-browser/internal/linear-srgb-sdr-final";
import { probeMedia, type FfmpegCommand, type FfmpegRunner } from "./index.js";
import { compareLinearSrgbSdrFinalFrames, type LinearSrgbSdrFinalComparison } from "./linear-srgb-sdr-final-compare.js";
import {
  LINEAR_SRGB_SDR_FINAL_DECODE_TOKEN,
  LINEAR_SRGB_SDR_FINAL_FFMPEG_CONTRACT_SHA256,
  LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES,
  LINEAR_SRGB_SDR_FINAL_OUTPUT_TOKEN,
  linearSrgbSdrFinalEncodeCommand,
  linearSrgbSdrFinalInverseDecodeCommand,
  preflightLinearSrgbSdrFinalFfmpeg,
  type LinearSrgbSdrFinalFfmpegPreflightEvidence,
} from "./linear-srgb-sdr-final-ffmpeg-contract.js";
import { validateLinearSrgbSdrFinalMedia, type LinearSrgbSdrFinalMediaObservation } from "./linear-srgb-sdr-final-media.js";
import { startStreamingFfmpegProcess, type StreamingFfmpegProcess, type StreamingFfmpegProcessFactory } from "./streaming-process.js";

export const LINEAR_SRGB_SDR_FINAL_PREPARATION_SCHEMA = "shellx-motion/linear-srgb-sdr-final-preparation@1" as const;
export const LINEAR_SRGB_SDR_FINAL_EXECUTION_SCHEMA = "shellx-motion/linear-srgb-sdr-final-execution@1" as const;

const REQUEST = Object.freeze({ target: "final" as const, frameLane: "gpu" as const, delivery: "streamed" as const, finalLane: "ffmpeg" as const, preset: "mp4-h264" as const });
const ISSUED_PREPARATIONS = new WeakSet<object>();
const CLAIMED_PREPARATIONS = new WeakSet<object>();

export interface LinearSrgbSdrFinalPreparation {
  readonly schema: typeof LINEAR_SRGB_SDR_FINAL_PREPARATION_SCHEMA;
  readonly route: LinearSrgbSdrFinalRoute;
  readonly ffmpeg: LinearSrgbSdrFinalFfmpegPreflightEvidence;
  readonly fingerprint: string;
}

export interface LinearSrgbSdrFinalJob {
  readonly admission: "pre-acquired";
  readonly signal: AbortSignal;
  readonly scratchRoot: string;
  readonly maxProcessTreeRssBytes: number;
  watchProcess(pid: number): void;
  reportProcessContainment(evidence: LocalMotionProcessContainmentEvidence): void;
}

export interface LinearSrgbSdrFinalExecutionEvidence {
  readonly schema: typeof LINEAR_SRGB_SDR_FINAL_EXECUTION_SCHEMA;
  readonly routeFingerprint: string;
  readonly documentFingerprint: string;
  readonly preparationFingerprint: string;
  readonly ffmpegContractSha256: string;
  readonly producerEvidenceSha256: string;
  readonly producer: LinearSrgbSdrFinalWebGpuProducerEvidence;
  readonly retainedFrame: { readonly sha256: string; readonly byteLength: number; readonly repeatedFrames: number; readonly sequenceSha256: string };
  readonly commands: { readonly encodeSha256: string; readonly probeSha256: string; readonly inverseSha256: string };
  readonly media: LinearSrgbSdrFinalMediaObservation;
  readonly comparison: LinearSrgbSdrFinalComparison;
  readonly output: { readonly sha256: string; readonly byteLength: number };
  readonly cleanup: { readonly browserTerminal: true; readonly encoderExitCode: 0; readonly probeExitCode: 0; readonly inverseExitCode: 0; readonly decodedFrameRemoved: true };
  readonly fingerprint: string;
}

export type LinearSrgbSdrFinalExecutionResult =
  | { readonly ok: true; readonly privateOutputPath: string; readonly evidence: LinearSrgbSdrFinalExecutionEvidence }
  | { readonly ok: false; readonly code: "linear_srgb_sdr_final_refused" | "linear_srgb_sdr_final_cancelled" | "linear_srgb_sdr_final_failed"; readonly message: string };

type Services = {
  readonly createProducer: (route: unknown) => LinearSrgbSdrFinalWebGpuProducerResolution;
  readonly startProcess: StreamingFfmpegProcessFactory;
};
const PRODUCTION: Services = Object.freeze({ createProducer: createLinearSrgbSdrFinalWebGpuProducer, startProcess: startStreamingFfmpegProcess });

/** Pure route resolution plus the governed output-free FFmpeg exercise; no job, GPU, or output exists yet. */
export async function prepareLinearSrgbSdrFinal(motion: unknown): Promise<LinearSrgbSdrFinalPreparation> {
  return await prepare(motion);
}

/** Relative-module test seam; production callers cannot replace the governed tool runner. */
export async function prepareLinearSrgbSdrFinalForTest(motion: unknown, runner: FfmpegRunner): Promise<LinearSrgbSdrFinalPreparation> {
  return await prepare(motion, runner);
}

async function prepare(motion: unknown, runner?: FfmpegRunner): Promise<LinearSrgbSdrFinalPreparation> {
  const resolved = resolveLinearSrgbSdrFinalRoute(motion, REQUEST);
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  const ffmpeg = await preflightLinearSrgbSdrFinalFfmpeg({ ...(runner ? { runner } : {}) });
  const current = resolveLinearSrgbSdrFinalRoute(motion, REQUEST);
  if (!current.ok || current.route.fingerprint !== resolved.route.fingerprint || current.route.documentFingerprint !== resolved.route.documentFingerprint) {
    throw new Error("Strict SDR preparation became stale during tool preflight.");
  }
  const base = { schema: LINEAR_SRGB_SDR_FINAL_PREPARATION_SCHEMA, route: current.route, ffmpeg };
  const preparation = freeze({ ...base, fingerprint: canonicalJsonSha256(base) });
  ISSUED_PREPARATIONS.add(preparation);
  return preparation;
}

/** Validate an issued preparation against the current document without consuming its one-shot authority. */
export function validateLinearSrgbSdrFinalPreparation(motion: unknown, preparation: LinearSrgbSdrFinalPreparation): LinearSrgbSdrFinalRoute {
  if (!validPreparation(preparation) || !ISSUED_PREPARATIONS.has(preparation)) {
    throw new Error("Strict SDR preparation authority is absent or already consumed.");
  }
  const current = resolveLinearSrgbSdrFinalRoute(motion, REQUEST);
  if (!current.ok || current.route.fingerprint !== preparation.route.fingerprint || current.route.documentFingerprint !== preparation.route.documentFingerprint) {
    throw new Error("Strict SDR preparation is stale for the current Motion document.");
  }
  return preparation.route;
}

/** Atomically consume issued authority before any output, job, GPU, or scratch acquisition. */
export function claimLinearSrgbSdrFinalPreparation(motion: unknown, preparation: LinearSrgbSdrFinalPreparation): LinearSrgbSdrFinalRoute {
  const route = validateLinearSrgbSdrFinalPreparation(motion, preparation);
  if (!ISSUED_PREPARATIONS.delete(preparation)) throw new Error("Strict SDR preparation authority is absent or already consumed.");
  CLAIMED_PREPARATIONS.add(preparation);
  return route;
}

/** Executes only inside an already acquired job, producing one still-private verified MP4 work artifact. */
export async function executeLinearSrgbSdrFinal(input: { readonly preparation: LinearSrgbSdrFinalPreparation; readonly outputPath: string; readonly decodedPath: string; readonly job: LinearSrgbSdrFinalJob }): Promise<LinearSrgbSdrFinalExecutionResult> {
  return await execute(input, PRODUCTION);
}

/** Relative-module test seam; neither the strict route nor this service is a public capability. */
export async function executeLinearSrgbSdrFinalForTest(input: Parameters<typeof executeLinearSrgbSdrFinal>[0], services: Services): Promise<LinearSrgbSdrFinalExecutionResult> {
  return await execute(input, services);
}

async function execute(input: Parameters<typeof executeLinearSrgbSdrFinal>[0], services: Services): Promise<LinearSrgbSdrFinalExecutionResult> {
  let active: StreamingFfmpegProcess | undefined;
  let outputStarted = false;
  let succeeded = false;
  try {
    const route = validateInput(input);
    const processJob = strictProcessJob(input.job);
    if (resolve(input.outputPath) === resolve(input.decodedPath)) throw new Error("Strict SDR encoded and decoded private artifacts must be distinct.");
    await assertAbsentPrivateChild(input.job.scratchRoot, input.outputPath);
    await assertAbsentPrivateChild(input.job.scratchRoot, input.decodedPath);
    const producerResolution = services.createProducer(route);
    if (!producerResolution.ok) throw new Error(producerResolution.refusal.message);
    const frame = await producerResolution.producer.produce(processJob);
    const producerEvidence = producerResolution.producer.evidence;
    if (!producerEvidence.fingerprint || producerEvidence.cleanup.state !== "complete" || !producerEvidence.cleanup.resourcesReleased || !producerEvidence.cleanup.pageClosed || !producerEvidence.cleanup.runtimeClosed
      || frame.routeFingerprint !== route.fingerprint || frame.documentFingerprint !== route.documentFingerprint || frame.width !== route.canvas.width || frame.height !== route.canvas.height
      || frame.bytesPerRow !== route.canvas.width * 4 || frame.rgba8Srgb.byteLength !== route.canvas.width * route.canvas.height * 4 || sha256(frame.rgba8Srgb) !== frame.rgba8SrgbSha256) {
      throw new Error("Strict SDR WebGPU producer evidence or retained frame is invalid.");
    }
    for (let offset = 3; offset < frame.rgba8Srgb.byteLength; offset += 4) if (frame.rgba8Srgb[offset] !== 255) throw new Error("Strict SDR WebGPU producer returned a non-opaque frame.");
    const frameCount = Math.ceil((route.canvas.durationMs / 1_000) * route.canvas.fps);
    const encode = linearSrgbSdrFinalEncodeCommand({ width: route.canvas.width, height: route.canvas.height, fps: route.canvas.fps, frameCount }, input.outputPath);
    active = await start(services, encode, processJob); outputStarted = true;
    for (let index = 0; index < frameCount; index += 1) assertAck(await active.write(frame.rgba8Srgb));
    const encoded = await active.end(); active = undefined;
    if (encoded.exitCode !== 0) throw new Error("Strict SDR software encoder did not complete successfully.");
    const output = await boundedFile(input.outputPath, LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES);

    let probeCommand: FfmpegCommand | undefined;
    const runner: FfmpegRunner = async (command) => { probeCommand = command; active = await start(services, command, processJob); const result = await active.end(); active = undefined; return result; };
    const media = validateLinearSrgbSdrFinalMedia({ media: await probeMedia(input.outputPath, { runner, inputRoots: [input.job.scratchRoot] }), width: route.canvas.width, height: route.canvas.height, fps: route.canvas.fps, frameCount });
    if (!probeCommand) throw new Error("Strict SDR FFprobe command evidence is absent.");

    const inverse = linearSrgbSdrFinalInverseDecodeCommand(input.outputPath, input.decodedPath);
    active = await start(services, inverse, processJob); const inverseResult = await active.end(); active = undefined;
    if (inverseResult.exitCode !== 0) throw new Error("Strict SDR inverse decode did not complete successfully.");
    const decodedFacts = await boundedFile(input.decodedPath, frame.rgba8Srgb.byteLength);
    if (decodedFacts.byteLength !== frame.rgba8Srgb.byteLength) throw new Error("Strict SDR inverse decode did not produce exactly one RGBA8 frame.");
    const decoded = await readFile(input.decodedPath);
    const comparison = compareLinearSrgbSdrFinalFrames({ width: route.canvas.width, height: route.canvas.height, source: frame.rgba8Srgb, decoded });
    if (!comparison.accepted) throw new Error("Strict SDR decoded-frame comparison refused the lossy delivery result.");
    await unlink(input.decodedPath); await assertAbsent(input.decodedPath);

    const base = {
      schema: LINEAR_SRGB_SDR_FINAL_EXECUTION_SCHEMA,
      routeFingerprint: route.fingerprint,
      documentFingerprint: route.documentFingerprint,
      preparationFingerprint: input.preparation.fingerprint,
      ffmpegContractSha256: LINEAR_SRGB_SDR_FINAL_FFMPEG_CONTRACT_SHA256,
      producerEvidenceSha256: producerEvidence.fingerprint,
      producer: cloneProducerEvidence(producerEvidence),
      retainedFrame: { sha256: frame.rgba8SrgbSha256, byteLength: frame.rgba8Srgb.byteLength, repeatedFrames: frameCount, sequenceSha256: canonicalJsonSha256({ mode: "repeated-static", frameSha256: frame.rgba8SrgbSha256, frameCount }) },
      commands: { encodeSha256: commandHash(encode, input.outputPath, LINEAR_SRGB_SDR_FINAL_OUTPUT_TOKEN), probeSha256: commandHash(probeCommand, input.outputPath, LINEAR_SRGB_SDR_FINAL_OUTPUT_TOKEN), inverseSha256: inverseHash(inverse, input.outputPath, input.decodedPath) },
      media,
      comparison,
      output,
      cleanup: { browserTerminal: true as const, encoderExitCode: 0 as const, probeExitCode: 0 as const, inverseExitCode: 0 as const, decodedFrameRemoved: true as const },
    };
    succeeded = true;
    return { ok: true, privateOutputPath: input.outputPath, evidence: freeze({ ...base, fingerprint: canonicalJsonSha256(base) }) };
  } catch (error) {
    return input?.job?.signal?.aborted
      ? { ok: false, code: "linear_srgb_sdr_final_cancelled", message: "Strict linear-sRGB SDR final execution was cancelled before private verification completed." }
      : { ok: false, code: outputStarted ? "linear_srgb_sdr_final_failed" : "linear_srgb_sdr_final_refused", message: safeMessage(error) };
  } finally {
    await active?.abort(new Error("Strict SDR execution did not complete.")).catch(() => undefined);
    await removePrivateFailureChild(input?.decodedPath, input?.job?.scratchRoot);
    if (outputStarted && !succeeded) await removePrivateFailureChild(input?.outputPath, input?.job?.scratchRoot);
  }
}

function validateInput(input: Parameters<typeof executeLinearSrgbSdrFinal>[0]): LinearSrgbSdrFinalRoute {
  if (!input || !validJob(input.job)) throw new Error("Strict SDR execution requires one exact pre-acquired private request.");
  if (!validPreparation(input.preparation) || !CLAIMED_PREPARATIONS.delete(input.preparation)) throw new Error("Strict SDR execution requires one exact claimed private request.");
  return input.preparation.route;
}

function validPreparation(value: LinearSrgbSdrFinalPreparation): boolean { if (!value || !Object.isFrozen(value) || value.schema !== LINEAR_SRGB_SDR_FINAL_PREPARATION_SCHEMA || !Object.isFrozen(value.route) || !Object.isFrozen(value.ffmpeg)) return false; const { fingerprint, ...base } = value; return /^[a-f0-9]{64}$/u.test(fingerprint) && fingerprint === canonicalJsonSha256(base); }
function validJob(value: LinearSrgbSdrFinalJob): boolean { return value?.admission === "pre-acquired" && value.signal instanceof AbortSignal && typeof value.scratchRoot === "string" && value.scratchRoot.length > 0 && Number.isSafeInteger(value.maxProcessTreeRssBytes) && value.maxProcessTreeRssBytes >= 64 * 1024 * 1024 && typeof value.watchProcess === "function" && typeof value.reportProcessContainment === "function"; }
function strictProcessJob(job: LinearSrgbSdrFinalJob): LinearSrgbSdrFinalJob {
  let containmentFingerprint: string | undefined;
  return {
    admission: "pre-acquired",
    signal: job.signal,
    scratchRoot: job.scratchRoot,
    maxProcessTreeRssBytes: job.maxProcessTreeRssBytes,
    watchProcess: (pid) => job.watchProcess(pid),
    reportProcessContainment: (evidence) => {
      const fingerprint = canonicalJsonSha256(evidence);
      if (containmentFingerprint === undefined) {
        job.reportProcessContainment(evidence);
        containmentFingerprint = fingerprint;
      } else if (containmentFingerprint !== fingerprint) {
        throw new Error("Strict SDR subprocesses reported conflicting process-containment evidence.");
      }
    },
  };
}
async function start(services: Services, command: FfmpegCommand, job: LinearSrgbSdrFinalJob): Promise<StreamingFfmpegProcess> { return await services.startProcess({ command, signal: job.signal, scratchRoot: job.scratchRoot, maxProcessTreeRssBytes: job.maxProcessTreeRssBytes, watchProcess: job.watchProcess, reportProcessContainment: job.reportProcessContainment }); }
function assertAck(value: { backpressured: boolean; bufferedInputBytes: number; inputHighWaterMarkBytes: number }): void { if (typeof value.backpressured !== "boolean" || !integer(value.bufferedInputBytes, 0, 64 * 1024 * 1024) || !integer(value.inputHighWaterMarkBytes, 1, 64 * 1024 * 1024)) throw new Error("Strict SDR encoder returned an invalid bounded write acknowledgement."); }
async function assertAbsentPrivateChild(root: string, path: string): Promise<void> { const base = resolve(root), child = resolve(path), relation = relative(base, child); if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw new Error("Strict SDR private artifact escaped the admitted scratch root."); await assertAbsent(child); }
async function assertAbsent(path: string): Promise<void> { await lstat(path).then(() => { throw new Error("Strict SDR private artifact already exists."); }, (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
async function boundedFile(path: string, maximum: number): Promise<{ sha256: string; byteLength: number }> { const facts = await lstat(path); if (!facts.isFile() || facts.isSymbolicLink() || facts.nlink !== 1 || !Number.isSafeInteger(facts.size) || facts.size < 1 || facts.size > maximum) throw new Error("Strict SDR private artifact is not one bounded regular file."); const hash = createHash("sha256"); await new Promise<void>((done, reject) => { const stream = createReadStream(path); stream.on("data", (chunk) => hash.update(chunk)); stream.once("error", reject); stream.once("end", done); }); const after = await lstat(path); if (after.dev !== facts.dev || after.ino !== facts.ino || after.size !== facts.size || after.mtimeMs !== facts.mtimeMs) throw new Error("Strict SDR private artifact changed while hashing."); return { sha256: hash.digest("hex"), byteLength: facts.size }; }
function commandHash(command: FfmpegCommand, path: string, token: string): string { return canonicalJsonSha256({ ...command, args: command.args.map((arg) => arg === path ? token : arg) }); }
function inverseHash(command: FfmpegCommand, input: string, output: string): string { return canonicalJsonSha256({ ...command, args: command.args.map((arg) => arg === input ? LINEAR_SRGB_SDR_FINAL_OUTPUT_TOKEN : arg === output ? LINEAR_SRGB_SDR_FINAL_DECODE_TOKEN : arg) }); }
async function removePrivateFailureChild(path: string | undefined, root: string | undefined): Promise<void> { if (!path || !root) return; const base = resolve(root), child = resolve(path), relation = relative(base, child); if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return; await unlink(child).catch(() => undefined); }
function safeMessage(error: unknown): string { const message = error instanceof Error ? error.message : "Strict linear-sRGB SDR final execution failed."; return message.replace(/(?:[A-Za-z]:)?[\\/][^\s"']+/gu, "<path>").slice(0, 360); }
function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function integer(value: unknown, minimum: number, maximum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
function cloneProducerEvidence(value: LinearSrgbSdrFinalWebGpuProducerEvidence): LinearSrgbSdrFinalWebGpuProducerEvidence { return freeze(structuredClone(value)); }
