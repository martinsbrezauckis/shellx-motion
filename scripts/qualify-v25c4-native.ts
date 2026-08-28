/**
 * Host-operated V25-C4 qualification. This is deliberately not a public CLI
 * surface: the only registry capability it imports is the internal host bridge.
 * It retains the supplied run root on every outcome for later operator review.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadMotionPackage, motionBrowserExecutableVerificationProblem, resolveMotionBrowserExecutable } from "../packages/core/src/index";
import { createEffectModuleRegistryAuthority, createEffectModuleRegistryUseAuthority } from "../packages/renderer-browser/src/effect-module-registry";
import { renderStreamingFinal, type RenderStreamingFinalResult } from "../packages/renderer-ffmpeg/src/index";

const runFile = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const fixtureRoot = join(repoRoot, "fixtures", "packages", "gpu-v25c-second-take");
const generatorPath = join(repoRoot, "templates", "generators", "second-take", "generate.py");
const recipePath = join(repoRoot, "templates", "generators", "second-take", "recipe.json");
const manifestPath = join(repoRoot, "templates", "generators", "second-take", "effect-module-manifest.json");
const frameAtSeconds = 4;

type Json = Record<string, unknown>;

export async function qualifyV25c4Native(args: string[]): Promise<void> {
  let scratchRoot: string | undefined;
  let aggregate: Json | undefined;
  let ownsScratchRoot = false;
  try {
    const arguments_ = parseArguments(args);
    const admittedScratchRoot = arguments_.scratchRoot;
    scratchRoot = admittedScratchRoot;
    const source = await sourceEvidence(arguments_.expectedCommit);
    await createFreshPrivateRoot(admittedScratchRoot);
    ownsScratchRoot = true;
    const paths = await prepareRunPaths(admittedScratchRoot);
    await Promise.all([
      runFile("python3", [generatorPath, "--variant", "module-on", "--out", paths.moduleOnPackage], { cwd: repoRoot }),
      runFile("python3", [generatorPath, "--variant", "module-off", "--out", paths.moduleOffPackage], { cwd: repoRoot }),
      materializeInstallManifest(paths.installManifestPath, source)
    ]);
    await assertGeneratedModuleOnParity(paths.moduleOnPackage, source);
    const [moduleOn, moduleOff] = await Promise.all([loadMotionPackage(paths.moduleOnPackage), loadMotionPackage(paths.moduleOffPackage)]);
    assert(hasEffectModule(moduleOn.motion), "Committed Second Take module-on package has no effect module.");
    assert(!hasEffectModule(moduleOff.motion), "Scratch Second Take module-off twin still has an effect module.");

    const installed = await installInternalAuthority(paths.registryRoot, paths.installManifestPath);
    let moduleOnRun: QualifiedRender | undefined;
    let moduleOffRun: QualifiedRender | undefined;
    let coldReplayRun: QualifiedRender | undefined;
    try {
      moduleOnRun = await renderCase("module-on", moduleOn, paths, installed.authority);
      moduleOffRun = await renderCase("module-off", moduleOff, paths);
      // A new package load and render session make this a cold runtime replay. The unchanged
      // installed registry preserves the identity that application ledgers are meant to bind.
      coldReplayRun = await renderCase("cold-replay", await loadMotionPackage(paths.moduleOnPackage), paths, installed.authority);
    } finally {
      await installed.registry.close();
    }

    const pixelDifference = await compareDecodedFrames(moduleOnRun.outputPath, moduleOffRun.outputPath, moduleOn.motion.width, moduleOn.motion.height);
    assert(pixelDifference.changedPixels > 1_000, "Module-on and module-off final frames did not have a material pixel difference.");
    assertEqualIdentity(moduleOnRun, coldReplayRun);
    aggregate = {
      schema: "shellx-motion/v25-c4-native-qualification@1", status: "passed", source,
      runtime: { node: process.version, platform: process.platform, arch: process.arch, browser: await browserEvidence(), ffmpeg: await executableEvidence("ffmpeg"), ffprobe: await executableEvidence("ffprobe") },
      registry: installed.installed,
      moduleOn: moduleOnRun.evidence, moduleOff: moduleOffRun.evidence, coldReplay: coldReplayRun.evidence,
      comparisons: { moduleOnVsModuleOff: pixelDifference, coldReplay: coldIdentity(moduleOnRun, coldReplayRun) },
      paths: { runRoot: admittedScratchRoot, receipts: paths.receiptsRoot, outputs: paths.outputsRoot }
    };
    await writeJson(paths.aggregatePath, aggregate);
    process.stdout.write(`${JSON.stringify({ ok: true, aggregatePath: paths.aggregatePath, outputPaths: [moduleOnRun.outputPath, moduleOffRun.outputPath, coldReplayRun.outputPath] }, null, 2)}\n`);
  } catch (error) {
    const failure = { schema: "shellx-motion/v25-c4-native-qualification@1", status: "failed", error: safeError(error), ...(aggregate ? { aggregate } : {}) };
    if (ownsScratchRoot && scratchRoot) await writeJson(join(scratchRoot, "evidence", "v25-c4-native-qualification.json"), failure).catch(() => undefined);
    process.stderr.write(`${JSON.stringify({ ok: false, scratchRoot: scratchRoot ?? null, error: safeError(error) }, null, 2)}\n`);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try { await qualifyV25c4Native(process.argv.slice(2)); }
  catch { process.exitCode = 1; }
}

type RunPaths = { moduleOnPackage: string; moduleOffPackage: string; installManifestPath: string; registryRoot: string; outputsRoot: string; receiptsRoot: string; jobsRoot: string; aggregatePath: string };
type QualifiedRender = { outputPath: string; evidence: Json; identities: Json };
type PixelDifference = { atSeconds: number; changedPixels: number; totalAbsoluteDifference: number; meanAbsoluteDifference: number };

async function prepareRunPaths(root: string): Promise<RunPaths> {
  const outputsRoot = join(root, "outputs"), receiptsRoot = join(root, "receipts"), jobsRoot = join(root, "jobs");
  for (const path of [outputsRoot, receiptsRoot, jobsRoot]) await mkdir(path, { recursive: true, mode: 0o700 });
  return { moduleOnPackage: join(root, "module-on-package"), moduleOffPackage: join(root, "module-off-package"), installManifestPath: join(root, "effect-module-manifest.json"), registryRoot: join(root, "internal-effect-module-registry"), outputsRoot, receiptsRoot, jobsRoot, aggregatePath: join(root, "evidence", "v25-c4-native-qualification.json") };
}

async function installInternalAuthority(stateRoot: string, installManifestPath: string) {
  await mkdir(stateRoot, { mode: 0o700 });
  const registry = createEffectModuleRegistryAuthority({ stateRoot });
  const pending = await registry.prepareInstallFromManifestFile(installManifestPath);
  const installed = await registry.confirmInstall(pending.confirmationId);
  return { registry, authority: createEffectModuleRegistryUseAuthority(registry), installed };
}

async function renderCase(name: string, pkg: Awaited<ReturnType<typeof loadMotionPackage>>, paths: RunPaths, authority?: ReturnType<typeof createEffectModuleRegistryUseAuthority>): Promise<QualifiedRender> {
  const outputPath = join(paths.outputsRoot, `${name}.mp4`);
  const jobScratch = join(paths.jobsRoot, name);
  await mkdir(jobScratch, { mode: 0o700 });
  const result = await renderStreamingFinal({
    pkg, frameLane: "gpu", outputPath, inputRoots: [pkg.root], outputRoots: [paths.outputsRoot], scratchRoot: jobScratch,
    operation: "v25-c4-native-qualification", callerId: "v25-c4-native-qualification", jobId: `v25-c4:${name}`,
    quality: { minDurationMs: 7_900 },
    ...(authority ? { toolPolicy: { gpu: { effectModuleUseAuthority: authority } } } : {})
  });
  if (!result.ok) {
    await writeJson(join(paths.receiptsRoot, `${name}.failure.json`), result);
    throw new Error(`${name} final render failed: ${result.error.code}: ${result.error.message}`);
  }
  const evidence = assertQualifiedGpuFinal(result, Boolean(authority));
  await writeJson(join(paths.receiptsRoot, `${name}.render.final.receipt.json`), result.receipt);
  const probe = await ffprobe(outputPath, pkg.motion.width, pkg.motion.height, pkg.motion.fps, pkg.motion.durationMs);
  return { outputPath, evidence: { outputPath, sha256: await sha256File(outputPath), ffprobe: probe, receipt: result.receipt, transport: result.transport }, identities: identities(result) };
}

function assertQualifiedGpuFinal(result: Extract<RenderStreamingFinalResult, { ok: true }>, expectsModule: boolean): Json {
  assert.equal(result.transport.frameLane, "gpu", "Final did not use the GPU frame lane.");
  assert.equal(result.transport.producer.frameLane, "gpu", "Final did not expose GPU producer evidence.");
  const evidence = result.transport.producer.evidence;
  const gpu = mustObject(evidence.gpu, "GPU runtime evidence");
  assert.equal(gpu.backend, "webgpu-browser", "Renderer did not report Browser WebGPU.");
  assert(!/swiftshader|llvmpipe|software|lavapipe|microsoft basic render/i.test(JSON.stringify(gpu.adapter)), "Software GPU evidence is refused.");
  assert.equal(mustObject(evidence.session, "GPU session").cleanup, "complete", "GPU session cleanup was incomplete.");
  assert.equal(mustObject(evidence.session, "GPU session").state, "closed", "GPU session was not closed.");
  if (!expectsModule) {
    assert.equal(result.transport.effectModules, undefined, "Module-off render unexpectedly carried module evidence.");
    assert.equal(evidence.effectModules, undefined, "Module-off producer unexpectedly carried module evidence.");
    return evidence as unknown as Json;
  }
  assert(typeof evidence.browserVersion === "string" && evidence.browserVersion.length > 0, "GPU producer omitted the launched Browser version.");
  assert.equal(mustObject(evidence.effectModules, "streaming effect module").runtimeCleanup, "complete", "Effect-module runtime cleanup was incomplete.");
  const modules = mustObject(result.transport.effectModules, "final effect-module evidence");
  assert.equal(modules.release, "released", "Effect-module lease did not release.");
  const applications = mustArray(modules.applications, "effect-module applications");
  assert(applications.length > 0, "Effect-module render recorded no applications.");
  assert(applications.every((application) => mustObject(application, "effect application").release === "released"), "Effect-module application was not released.");
  const live = mustObject(mustObject(mustObject(evidence.effectModules, "streaming effect module").resources, "module resources").live, "module live resources");
  const terminal = mustObject(mustObject(mustObject(evidence.effectModules, "streaming effect module").resources, "module resources").terminal, "module terminal resources");
  assert.equal(live.uniformBytes, 160, "Afterimage live uniform evidence mismatch.");
  assert.equal(terminal.uniformBytes, 0, "Afterimage terminal cleanup did not release uniforms.");
  for (const key of ["gpu-effect-module-catalog", "gpu-effect-module-begin-use", "gpu-effect-module-applications", "gpu-effect-module-resources", "gpu-effect-module-cleanup"]) assert(/^[a-f0-9]{64}$/.test(String(record(result.receipt.inputHashes)?.[key])), `Missing receipt hash ${key}.`);
  return evidence as unknown as Json;
}

function identities(result: Extract<RenderStreamingFinalResult, { ok: true }>): Json {
  const producer = result.transport.producer;
  assert.equal(producer.frameLane, "gpu", "Identity projection requires GPU producer evidence.");
  if (producer.frameLane !== "gpu") throw new Error("Identity projection requires GPU producer evidence.");
  const evidence = producer.evidence;
  const module = result.transport.effectModules;
  return {
    frameSequenceSha256: evidence.frameSequenceSha256, framePlanSequenceSha256: evidence.framePlanSequenceSha256,
    staticPlanFingerprint: record(evidence.provenance.staticPlan)?.fingerprint,
    applicationSequenceSha256: module?.applicationSequenceSha256,
    applicationCount: module?.applications.length ?? 0
  };
}

function assertEqualIdentity(first: QualifiedRender, replay: QualifiedRender): void {
  for (const [key, value] of Object.entries(first.identities)) assert.equal(replay.identities[key], value, `Cold replay identity differs at ${key}.`);
}

function coldIdentity(first: QualifiedRender, replay: QualifiedRender): Json { return { expected: first.identities, observed: replay.identities, matched: true }; }

async function ffprobe(path: string, width: number, height: number, fps: number, durationMs: number): Promise<Json> {
  const { stdout } = await runFile("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", path], { maxBuffer: 1_000_000 });
  const parsed = mustObject(JSON.parse(String(stdout)), "ffprobe JSON");
  const video = mustArray(parsed.streams, "ffprobe streams").map((value) => mustObject(value, "ffprobe stream")).filter((stream) => stream.codec_type === "video");
  assert.equal(video.length, 1, "Final must have exactly one video stream.");
  const stream = video[0]!;
  assert.equal(stream.codec_name, "h264", "Final codec must be H.264."); assert.equal(stream.width, width, "Final width mismatch."); assert.equal(stream.height, height, "Final height mismatch.");
  assert.equal(rational(stream.avg_frame_rate), fps, "Final frame rate mismatch."); assert.equal(Number(stream.nb_read_frames), Math.round((durationMs / 1_000) * fps), "Final frame count mismatch.");
  assert(Math.abs(Number(stream.duration ?? record(parsed.format)?.duration) * 1_000 - durationMs) <= 150, "Final duration mismatch.");
  assert(String(record(parsed.format)?.format_name ?? "").split(",").includes("mp4"), "Final container is not MP4.");
  return parsed;
}

async function compareDecodedFrames(moduleOn: string, moduleOff: string, width: number, height: number): Promise<PixelDifference> {
  const [on, off] = await Promise.all([decodeFrame(moduleOn), decodeFrame(moduleOff)]);
  assert.equal(on.length, width * height * 4, "Module-on decoded frame length mismatch."); assert.equal(off.length, on.length, "Module-off decoded frame length mismatch.");
  let changedPixels = 0, totalAbsoluteDifference = 0;
  for (let index = 0; index < on.length; index += 4) { const difference = Math.max(Math.abs(on[index]! - off[index]!), Math.abs(on[index + 1]! - off[index + 1]!), Math.abs(on[index + 2]! - off[index + 2]!)); totalAbsoluteDifference += difference; if (difference > 8) changedPixels += 1; }
  return { atSeconds: frameAtSeconds, changedPixels, totalAbsoluteDifference, meanAbsoluteDifference: totalAbsoluteDifference / (width * height) };
}

async function decodeFrame(path: string): Promise<Buffer> {
  const { stdout } = await runFile("ffmpeg", ["-v", "error", "-ss", String(frameAtSeconds), "-i", path, "-map", "0:v:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  assert(Buffer.isBuffer(stdout), "FFmpeg frame decode did not return bytes."); return stdout;
}

async function sourceEvidence(expectedCommit: string): Promise<Json> {
  const [head, expected, tree, trackedStatus] = await Promise.all([git("rev-parse", "HEAD"), git("rev-parse", `${expectedCommit}^{commit}`), git("rev-parse", "HEAD^{tree}"), git("status", "--porcelain", "--untracked-files=no")]);
  assert.equal(head, expected, `Harness requires checkout ${expectedCommit}, found ${head}.`);
  assert.equal(trackedStatus, "", "Harness requires a clean tracked working tree.");
  return { commit: head, tree, expectedCommit, files: Object.fromEntries(await Promise.all([scriptPath, generatorPath, recipePath, manifestPath, join(fixtureRoot, "manifest.json"), join(fixtureRoot, "motion.json"), join(fixtureRoot, "assets", "second-take-subject.svg"), join(fixtureRoot, "assets", "second-take-copy.svg")].map(async (path) => [relative(repoRoot, path), await sha256File(path)]))) };
}

async function materializeInstallManifest(outputPath: string, source: Json): Promise<void> {
  const bytes = await readFile(manifestPath);
  assert.equal(sha256Bytes(bytes), sourceFileHash(source, manifestPath), "Effect-module install manifest changed after source admission.");
  await writeFile(outputPath, bytes, { mode: 0o600 });
}

async function assertGeneratedModuleOnParity(packageRoot: string, source: Json): Promise<void> {
  for (const relativePath of ["manifest.json", "motion.json", join("assets", "second-take-subject.svg"), join("assets", "second-take-copy.svg")]) {
    assert.equal(await sha256File(join(packageRoot, relativePath)), sourceFileHash(source, join(fixtureRoot, relativePath)), `Generated module-on package differs from the committed fixture at ${relativePath}.`);
  }
}

function sourceFileHash(source: Json, path: string): string {
  const hash = record(source.files)?.[relative(repoRoot, path)];
  assert(/^[a-f0-9]{64}$/.test(String(hash)), `Source evidence omitted ${relative(repoRoot, path)}.`);
  return String(hash);
}

async function browserEvidence(): Promise<Json> {
  const location = resolveMotionBrowserExecutable();
  assert.equal(motionBrowserExecutableVerificationProblem(location), null, "Motion trusted Chromium is unavailable or unverified.");
  return { source: location.source, executable: await realpath(location.executable), sha256: await sha256File(location.executable) };
}

async function executableEvidence(command: string): Promise<Json> { const path = await resolveExecutable(command); const version = await runFile(path, ["-version"], { maxBuffer: 32_000 }); return { path, sha256: await sha256File(path), version: String(version.stdout).split("\n")[0] ?? "" }; }
async function resolveExecutable(command: string): Promise<string> { for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) { const candidate = join(directory, command); const candidateFacts = await lstat(candidate).catch(() => null); if (!candidateFacts || (!candidateFacts.isFile() && !candidateFacts.isSymbolicLink())) continue; const resolved = await realpath(candidate); const facts = await lstat(resolved); if (facts.isFile() && (facts.mode & 0o111) !== 0) return resolved; } throw new Error(`${command} was not a regular executable on PATH.`); }
async function git(...args: string[]): Promise<string> { return (await runFile("git", args, { cwd: repoRoot })).stdout.trim(); }
async function sha256File(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
function sha256Bytes(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
async function writeJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); }
async function exists(path: string): Promise<boolean> { return Boolean(await lstat(path).catch(() => null)); }
function parseArguments(args: string[]): { scratchRoot: string; expectedCommit: string } { const normalized = args[0] === "--" ? args.slice(1) : args; assert.deepEqual(normalized.length === 4 && normalized[0] === "--scratch-root" && isAbsolute(normalized[1] ?? "") && normalized[2] === "--expected-commit" && /^[a-f0-9]{40}$/.test(normalized[3] ?? ""), true, "Usage: pnpm run qualify:v25c4-native -- --scratch-root /absolute/fresh/run-root --expected-commit <40-hex-commit>"); const root = resolve(normalized[1]!); const fromRepo = relative(repoRoot, root); assert(fromRepo === ".." || fromRepo.startsWith(`..${sep}`) || isAbsolute(fromRepo), "Scratch root must be outside this repository."); return { scratchRoot: root, expectedCommit: normalized[3]! }; }
async function createFreshPrivateRoot(root: string): Promise<void> { assert(!await exists(root), `Scratch root already exists and will not be reused: ${root}`); await mkdir(root, { mode: 0o700 }); const facts = await lstat(root); assert(facts.isDirectory() && !facts.isSymbolicLink(), "Scratch root is not a regular directory."); if (process.platform !== "win32") assert((facts.mode & 0o077) === 0, "Scratch root is not private (expected 0700)."); }
function hasEffectModule(motion: { layers: readonly unknown[] }): boolean { return motion.layers.some((layer) => Boolean(record(layer)?.effectModule)); }
function rational(value: unknown): number { const match = typeof value === "string" ? value.match(/^(\d+)\/(\d+)$/) : null; assert(match && Number(match[2]) > 0, "FFprobe reported invalid frame rate."); return Number(match[1]) / Number(match[2]); }
function record(value: unknown): Json | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined; }
function mustObject(value: unknown, label: string): Json { const result = record(value); assert(result, `${label} must be an object.`); return result; }
function mustArray(value: unknown, label: string): unknown[] { assert(Array.isArray(value), `${label} must be an array.`); return value; }
function safeError(error: unknown): Json { return { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) }; }
