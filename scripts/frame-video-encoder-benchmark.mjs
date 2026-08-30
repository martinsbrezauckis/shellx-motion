import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { arch, platform, release, version as osVersion } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FRAME_VIDEO_ENCODER_BENCHMARK_CONTRACT,
  createSyntheticFrameSet,
  decodedFrameEvidence,
  existingFfmpegInputArgs,
  existingFfmpegOutputArgs,
  sha256,
  timestampEvidence,
} from "./frame-video-encoder-benchmark-contract.mjs";
import { runIsolatedMediabunnyBenchmark } from "./frame-video-encoder-benchmark-browser.mjs";
import { resolveTrustedScriptExecutable } from "./trusted-executable-resolution.mjs";

const PROCESS_OUTPUT_LIMIT = 64 * 1024 * 1024;

export async function runFrameVideoEncoderBenchmark(options) {
  validateOptions(options);
  const contract = FRAME_VIDEO_ENCODER_BENCHMARK_CONTRACT;
  await mkdir(options.outDir, { recursive: false, mode: 0o700 });
  const candidateBundle = await readFile(options.mediabunnyBundle);
  const cases = contract.cases.map((entry) => ({ ...entry, ...createSyntheticFrameSet(entry.id, contract) }));
  const toolEvidence = await collectToolEvidence(options);
  const existing = [];
  for (const benchmarkCase of cases) existing.push(await encodeExistingFfmpeg(benchmarkCase, options, contract));
  const candidateStartedAt = performance.now();
  const candidateRuntime = await runIsolatedMediabunnyBenchmark({
    browserPath: options.browser,
    bundlePath: options.mediabunnyBundle,
    outDir: options.outDir,
    contract,
    cases,
  });
  const candidateElapsedMs = performance.now() - candidateStartedAt;
  toolEvidence.browser = {
    ...toolEvidence.browser,
    product: candidateRuntime.browserVersion?.product ?? null,
    protocolVersion: candidateRuntime.browserVersion?.protocolVersion ?? null,
    revision: candidateRuntime.browserVersion?.revision ?? null,
    userAgent: candidateRuntime.browserVersion?.userAgent ?? candidateRuntime.userAgent,
  };
  const candidate = [];
  for (const caseResult of candidateRuntime.cases) {
    const source = cases.find((entry) => entry.id === caseResult.caseId);
    if (!source) throw new Error(`Candidate returned an unknown benchmark case: ${caseResult.caseId}.`);
    if (!caseResult.ok) {
      candidate.push({ ...caseResult, inspection: null });
      continue;
    }
    const outputPath = candidateRuntime.outputFiles[caseResult.caseId];
    candidate.push({
      ...caseResult,
      admittedTimestampExact: arraysEqual(caseResult.admittedTimestampsUs, source.timestampUs),
      inspection: await inspectEncodedOutput(outputPath, source, options, contract),
    });
  }
  const receipt = buildReceipt({
    contract,
    options,
    cases,
    toolEvidence,
    candidateBundleSha256: sha256(candidateBundle),
    existing,
    candidate,
    candidateRuntime: {
      schema: candidateRuntime.schema,
      userAgent: candidateRuntime.userAgent,
      browserVersion: candidateRuntime.browserVersion,
      webCodecs: candidateRuntime.webCodecs,
      elapsedMs: rounded(candidateElapsedMs, 3),
    },
  });
  const receiptPath = join(options.outDir, "benchmark.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { receipt, receiptPath };
}

async function encodeExistingFfmpeg(benchmarkCase, options, contract) {
  const outputPath = join(options.outDir, `ffmpeg-${benchmarkCase.id}.webm`);
  const args = [
    "-hide_banner", "-v", "error", "-nostdin", "-n",
    ...existingFfmpegInputArgs(contract),
    "-map", "0:v:0", "-an", "-frames:v", String(contract.frameCount),
    ...existingFfmpegOutputArgs(benchmarkCase.id, contract),
    outputPath,
  ];
  const startedAt = performance.now();
  await runProcess(options.ffmpeg, args, { input: benchmarkCase.bytes, maximumOutputBytes: 4 * 1024 * 1024 });
  const elapsedMs = performance.now() - startedAt;
  return {
    caseId: benchmarkCase.id,
    alpha: benchmarkCase.alpha,
    elapsedMs: rounded(elapsedMs, 3),
    commandContract: { input: existingFfmpegInputArgs(contract), output: existingFfmpegOutputArgs(benchmarkCase.id, contract) },
    inspection: await inspectEncodedOutput(outputPath, benchmarkCase, options, contract),
  };
}

async function inspectEncodedOutput(outputPath, source, options, contract) {
  const mediaProbe = await runProcess(options.ffprobe, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,profile,pix_fmt,width,height,avg_frame_rate,r_frame_rate,time_base,duration,nb_frames,color_range,color_space,color_transfer,color_primaries:stream_tags=alpha_mode:format=format_name,duration,size",
    "-of", "json", outputPath,
  ]);
  const media = JSON.parse(mediaProbe.stdout.toString("utf8"));
  const stream = media.streams?.[0];
  if (!stream || stream.codec_name !== contract.codec || stream.width !== contract.width || stream.height !== contract.height) throw new Error(`Encoded ${basename(outputPath)} does not match the VP9 benchmark contract.`);
  const frameProbe = await runProcess(options.ffprobe, [
    "-v", "error", "-select_streams", "v:0", "-show_frames",
    "-show_entries", "frame=best_effort_timestamp_time,pkt_duration_time,key_frame,pict_type",
    "-of", "json", outputPath,
  ]);
  const frames = JSON.parse(frameProbe.stdout.toString("utf8")).frames;
  if (!Array.isArray(frames)) throw new Error(`Encoded ${basename(outputPath)} exposed no frame timestamp array.`);
  const decodeArgs = [
    "-hide_banner", "-v", "error", "-nostdin",
    ...(source.alpha === "keep" ? ["-c:v", "libvpx-vp9"] : []),
    "-i", outputPath,
    "-map", "0:v:0", "-an", "-frames:v", String(contract.frameCount),
    ...(stream.color_range === "tv" ? ["-vf", "scale=in_range=tv:out_range=full"] : []),
    "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ];
  const decoded = await runProcess(options.ffmpeg, decodeArgs, { maximumOutputBytes: PROCESS_OUTPUT_LIMIT });
  const outputBytes = await readFile(outputPath);
  return {
    file: { name: basename(outputPath), byteLength: outputBytes.byteLength, sha256: sha256(outputBytes) },
    media: { stream, format: media.format },
    timestamps: timestampEvidence(source.timestampUs, frames, contract),
    decoded: decodedFrameEvidence(source.bytes, decoded.stdout, contract),
  };
}

function buildReceipt(input) {
  const sourceInputs = input.cases.map((entry) => ({
    caseId: entry.id,
    alpha: entry.alpha,
    byteLength: entry.byteLength,
    sha256: entry.sha256,
    frameSha256: entry.frameSha256,
    timestampUs: entry.timestampUs,
    durationUs: entry.durationUs,
  }));
  const existingAlpha = input.existing.find((entry) => entry.caseId === "alpha")?.inspection.decoded.alpha;
  const candidateOpaque = input.candidate.find((entry) => entry.caseId === "opaque");
  const candidateAlpha = input.candidate.find((entry) => entry.caseId === "alpha");
  const allExistingExact = input.existing.every((entry) => entry.inspection.decoded.frameCountExact && entry.inspection.timestamps.withinContainerTolerance);
  const candidateOpaqueReady = candidateOpaque?.ok === true && candidateOpaque.admittedTimestampExact === true && candidateOpaque.inspection?.decoded.frameCountExact === true && candidateOpaque.inspection?.timestamps.withinContainerTolerance === true;
  const alphaFinding = candidateAlpha?.ok !== true
    ? `Mediabunny/WebCodecs alpha case refused: ${candidateAlpha?.error ?? "no result"}`
    : candidateAlpha.inspection.decoded.alpha.hasDecodedTransparency
      ? "Mediabunny/WebCodecs retained non-opaque decoded pixels in the VP9 alpha case."
      : "Mediabunny/WebCodecs encoded the alpha case but decoded output was fully opaque.";
  return {
    schema: "shellx-motion/frame-video-encoder-benchmark@1",
    sourceRevision: input.options.sourceRevision,
    contract: input.contract,
    host: {
      platform: platform(),
      release: release(),
      osVersion: osVersion(),
      arch: arch(),
      node: process.version,
      tools: input.toolEvidence,
    },
    candidate: {
      ...input.contract.candidate,
      bundleSha256: input.candidateBundleSha256,
      scope: "isolated-repository-benchmark-only",
      productionDependency: false,
      productionLane: false,
      networkPolicy: "loopback-only-with-dead-external-proxy",
    },
    inputs: sourceInputs,
    lanes: {
      existingFfmpegPresetContract: input.existing,
      isolatedMediabunnyWebCodecs: { runtime: input.candidateRuntime, cases: input.candidate },
    },
    comparison: {
      sameOwnedRgbaInputs: true,
      existingFrameAndTimestampEvidenceComplete: allExistingExact,
      existingAlphaDecodedTransparency: existingAlpha?.hasDecodedTransparency === true,
      candidateOpaqueFrameAndTimestampEvidenceComplete: candidateOpaqueReady,
      candidateAlphaFinding: alphaFinding,
      outputByteLengths: Object.fromEntries([
        ...input.existing.map((entry) => [`ffmpeg-${entry.caseId}`, entry.inspection.file.byteLength]),
        ...input.candidate.filter((entry) => entry.ok).map((entry) => [`mediabunny-${entry.caseId}`, entry.inspection.file.byteLength]),
      ]),
    },
    decision: {
      productionAdopted: false,
      recommendation: "retain-existing-production-route",
      reason: "This bounded comparison records host-specific codec, timestamp, pixel-quality, alpha, and throughput evidence; it does not establish production lifecycle, containment, cancellation, durable staging, audio, or release readiness for the candidate.",
    },
    complete: allExistingExact && candidateOpaqueReady,
  };
}

async function collectToolEvidence(options) {
  const [ffmpeg, ffprobe, browser] = await Promise.all([
    toolVersion(options.ffmpeg, ["-hide_banner", "-version"]),
    toolVersion(options.ffprobe, ["-hide_banner", "-version"]),
    executableIdentity(options.browser),
  ]);
  return { ffmpeg, ffprobe, browser };
}

async function executableIdentity(executable) {
  const executableStat = await stat(executable);
  if (!executableStat.isFile()) throw new Error(`Tool ${basename(executable)} is not a regular file.`);
  return { executable: basename(executable), executableSha256: sha256(await readFile(executable)) };
}

async function toolVersion(executable, args) {
  const result = await runProcess(executable, args, { maximumOutputBytes: 2 * 1024 * 1024 });
  const line = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`.split(/\r?\n/u).map((entry) => entry.trim()).find(Boolean);
  if (!line) throw new Error(`Tool ${basename(executable)} returned no version identity.`);
  const executableStat = isAbsolute(executable) ? await stat(executable) : null;
  return { executable: basename(executable), version: line, ...(executableStat?.isFile() ? { executableSha256: sha256(await readFile(executable)) } : {}) };
}

async function runProcess(executable, args, options = {}) {
  const child = spawn(executable, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const maximum = options.maximumOutputBytes ?? 16 * 1024 * 1024;
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes + stderrBytes > maximum) child.kill();
    else stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.byteLength;
    if (stdoutBytes + stderrBytes > maximum) child.kill();
    else stderr.push(chunk);
  });
  child.stdin.on("error", () => {
    // The child can close stdin early after reporting a bounded diagnostic.
  });
  const errorPromise = new Promise((_resolve, reject) => child.once("error", reject));
  if (options.input) child.stdin.end(options.input);
  else child.stdin.end();
  const [code, signal] = await Promise.race([new Promise((resolve) => child.once("exit", (...values) => resolve(values))), errorPromise]);
  const result = { code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  if (stdoutBytes + stderrBytes > maximum) throw new Error(`${basename(executable)} exceeded the ${maximum}-byte diagnostic output bound.`);
  if (code !== 0) throw new Error(`${basename(executable)} exited ${code ?? signal}: ${result.stderr.toString("utf8").trim().slice(0, 2_000)}`);
  return result;
}

export function parseFrameVideoEncoderBenchmarkArgs(argv) {
  const values = {};
  const allowed = new Set(["--browser", "--mediabunny-bundle", "--out-dir", "--source-revision", "--ffmpeg", "--ffprobe"]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || typeof value !== "string" || value.length === 0) throw new Error(usage());
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate argument ${key}.`);
    values[key] = value;
  }
  const options = {
    browser: values["--browser"],
    mediabunnyBundle: values["--mediabunny-bundle"],
    outDir: values["--out-dir"],
    sourceRevision: values["--source-revision"],
    ffmpeg: resolveTrustedScriptExecutable("ffmpeg", { override: values["--ffmpeg"] ?? process.env.SHELLX_MOTION_FFMPEG }).executable,
    ffprobe: resolveTrustedScriptExecutable("ffprobe", { override: values["--ffprobe"] ?? process.env.SHELLX_MOTION_FFPROBE }).executable,
  };
  validateOptions(options);
  return options;
}

function validateOptions(options) {
  for (const [key, value] of [["browser", options.browser], ["mediabunny bundle", options.mediabunnyBundle], ["output directory", options.outDir]]) {
    if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`Frame-video encoder benchmark ${key} must be an absolute path.`);
  }
  if (typeof options.sourceRevision !== "string" || !/^[a-f0-9]{7,40}$/u.test(options.sourceRevision)) throw new Error("Frame-video encoder benchmark source revision must be a 7-through-40-character lowercase Git commit id.");
  for (const key of ["ffmpeg", "ffprobe"]) if (typeof options[key] !== "string" || !isAbsolute(options[key])) throw new Error(`Frame-video encoder benchmark requires an absolute ${key} executable.`);
}

function arraysEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function rounded(value, digits) {
  return Number(value.toFixed(digits));
}

function usage() {
  return "usage: node scripts/frame-video-encoder-benchmark.mjs --browser <absolute Chrome path> --mediabunny-bundle <absolute mediabunny.mjs path> --out-dir <new absolute directory> --source-revision <git commit> [--ffmpeg <absolute executable>] [--ffprobe <absolute executable>]";
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runFrameVideoEncoderBenchmark(parseFrameVideoEncoderBenchmarkArgs(process.argv.slice(2)))
    .then(({ receipt, receiptPath }) => {
      process.stdout.write(`${JSON.stringify({ ok: receipt.complete, receipt: receiptPath, comparison: receipt.comparison, decision: receipt.decision }, null, 2)}\n`);
      if (!receipt.complete) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
