/** Native C6G retained-session qualification; proof-only, never a public render surface. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalJson, canonicalJsonSha256, inspectPngFile, type OperationReceipt } from "../packages/core/src/index";
import { COLLISION_SHOWCASE_RENDER_FRAME_COUNT, renderFrameAtUs } from "../packages/core/src/internal/collision-showcase/collision-showcase";
import { createGpuCollisionShowcasePreviewSession } from "../packages/renderer-browser/src/unadopted/gpu-collision-showcase-preview-session";
import { buildCollisionCheckpointProofCases, parseCollisionCheckpointProofArguments } from "./c6g-collision-checkpoint-proof-contract";

const PROOF_SCHEMA = "shellx-motion/c6g-collision-retained-preview-proof@2" as const;
const scriptPath = fileURLToPath(import.meta.url), repoRoot = resolve(dirname(scriptPath), "..");
const runFile = promisify(execFile), HASH = /^[a-f0-9]{64}$/;
const SOFTWARE_ADAPTER = /swiftshader|llvmpipe|software|lavapipe|microsoft basic render/i;
const operationTimeoutMs = 45_000;
type Json = Record<string, unknown>;

async function run(args: string[]): Promise<void> {
  let outputRoot: string | undefined, ownsOutputRoot = false;
  try {
    const parsed = parseCollisionCheckpointProofArguments(args);
    outputRoot = parsed.outputRoot;
    const source = await sourceEvidence(parsed.expectedCommit);
    await createFreshPrivateRoot(outputRoot); ownsOutputRoot = true;
    const stories = [] as Json[];
    let adapter: Json | undefined;
    for (const proofCase of buildCollisionCheckpointProofCases()) {
      const story = await renderStory(proofCase, outputRoot, adapter);
      adapter ??= story.adapter;
      assert.deepEqual(story.adapter, adapter, "C6G retained stories must use one exact adapter identity.");
      stories.push(story.evidence);
    }
    assert(adapter, "C6G retained proof produced no GPU adapter evidence.");
    const payload = {
      schema: PROOF_SCHEMA,
      status: "passed" as const,
      source,
      runtime: { node: process.version, platform: process.platform, arch: process.arch, operationTimeoutMs, adapter },
      stories,
      evidence: {
        sessionCount: 2,
        exactFramesPerSession: COLLISION_SHOWCASE_RENDER_FRAME_COUNT,
        totalFrames: COLLISION_SHOWCASE_RENDER_FRAME_COUNT * 2,
        oneStaticWrapperPerSession: true,
        oneRuntimePerSession: true,
        terminalCleanupComplete: true,
        genericReusableSessionWidened: false,
        finalMediaProduced: false,
      },
    };
    const proof = Object.freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
    const proofPath = join(outputRoot, "retained-preview-proof.json");
    await writeCanonicalExclusive(proofPath, proof);
    process.stdout.write(`${JSON.stringify({ ok: true, proofPath, fingerprint: proof.fingerprint }, null, 2)}\n`);
  } catch (error) {
    if (ownsOutputRoot && outputRoot) await writeCanonicalExclusive(join(outputRoot, "retained-preview-proof.failed.json"), { schema: PROOF_SCHEMA, status: "failed", error: safeError(error) }).catch(() => undefined);
    process.stderr.write(`${JSON.stringify({ ok: false, outputRoot: outputRoot ?? null, error: safeError(error) }, null, 2)}\n`);
    throw error;
  }
}

async function renderStory(proofCase: ReturnType<typeof buildCollisionCheckpointProofCases>[number], outputRoot: string, expectedAdapter?: Json): Promise<{ adapter: Json; evidence: Json }> {
  const storyRoot = join(outputRoot, proofCase.slug); await mkdir(storyRoot, { mode: 0o700 });
  const session = createGpuCollisionShowcasePreviewSession(proofCase.plan.recipe, { packageRoot: repoRoot });
  assert.deepEqual(session.identity, {
    schema: "shellx-motion/private-gpu-collision-showcase-preview-session@2",
    kind: proofCase.plan.kind,
    planFingerprint: proofCase.plan.fingerprint,
    loweringFingerprint: proofCase.lowering.fingerprint,
    motionSha256: proofCase.lowering.motionSha256,
    strictPreviewStaticFingerprint: proofCase.lowering.strictPreviewStaticFingerprint,
    bakeFrameCount: 61,
    frameCount: COLLISION_SHOWCASE_RENDER_FRAME_COUNT,
    frameRate: 30,
  });
  const frames = [] as Json[], pngHashes = [] as string[], framePlanHashes = [] as string[];
  let adapter: Json | undefined, cleanup: Json | undefined;
  for (let frameIndex = 0; frameIndex < COLLISION_SHOWCASE_RENDER_FRAME_COUNT; frameIndex += 1) {
    const outputPath = join(storyRoot, `frame-${String(frameIndex).padStart(3, "0")}.png`);
    assert.equal(await exists(outputPath), false, `Retained frame already exists: ${outputPath}`);
    const result = await session.renderNext({ outDir: storyRoot, outputPath, timeoutMs: operationTimeoutMs, callerId: "c6g-collision-retained-proof" });
    assert(result.ok, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
    if (!result.ok) throw new Error("Unreachable retained preview failure.");
    assert.equal(result.schedule.frameIndex, frameIndex); assert.equal(result.schedule.atUs, renderFrameAtUs(frameIndex));
    assert.equal(result.schedule.final, frameIndex === COLLISION_SHOWCASE_RENDER_FRAME_COUNT - 1);
    assert(/^[a-f0-9]{64}$/.test(result.schedule.stateSha256));
    assert.equal(result.frame.width, proofCase.lowering.motion.width); assert.equal(result.frame.height, proofCase.lowering.motion.height);
    assert.equal(result.frame.atMs, result.schedule.atUs / 1_000); assert.equal(result.frame.resources.state, "passed");
    assert.equal(result.frame.gpu.backend, "webgpu-browser"); assert(HASH.test(result.frame.gpu.adapterFingerprint));
    assert(!SOFTWARE_ADAPTER.test(JSON.stringify(result.frame.gpu.adapter)), "Software GPU adapter evidence is refused.");
    const currentAdapter = result.frame.gpu as unknown as Json;
    adapter ??= currentAdapter; assert.deepEqual(currentAdapter, adapter); if (expectedAdapter) assert.deepEqual(currentAdapter, expectedAdapter);
    const receipt = result.receipt; assertReceipt(receipt, proofCase.lowering.strictPreviewStaticFingerprint);
    const pixels = await inspectPngFile(result.frame.path); assert(pixels.ok, pixels.ok ? undefined : pixels.message);
    if (!pixels.ok) throw new Error("Unreachable invalid retained PNG.");
    assert.equal(pixels.blank, false, `${proofCase.slug}/${frameIndex} retained frame is blank.`);
    assert(pixels.luma.range > 2 && pixels.chroma.pixels > 0, `${proofCase.slug}/${frameIndex} retained frame lacks visual range.`);
    assert.equal(pixels.sha256, result.frame.sha256); assert.equal(await sha256File(result.frame.path), result.frame.sha256);
    const facts = await stat(result.frame.path); assert(facts.isFile() && facts.size > 0);
    const framePlan = receiptHash(receipt, "gpu-scene3d-animation-frame-plan");
    pngHashes.push(pixels.sha256); framePlanHashes.push(framePlan);
    frames.push({
      frameIndex, atUs: result.schedule.atUs, phase: result.schedule.phase, stateSha256: result.schedule.stateSha256,
      bakeFrameBeforeIndex: result.schedule.bakeFrameBeforeIndex, bakeFrameAfterIndex: result.schedule.bakeFrameAfterIndex,
      path: relative(outputRoot, result.frame.path), pngSha256: pixels.sha256, bytes: facts.size,
      lumaRange: pixels.luma.range, chromaPixels: pixels.chroma.pixels, edgePixels: pixels.edges.pixels,
      framePlanSha256: framePlan, gpuFramePlanSha256: receiptHash(receipt, "gpu-frame-plan"),
    });
    if (result.schedule.cleanup) cleanup = result.schedule.cleanup as unknown as Json;
  }
  assert.equal(framePlanHashes.length, COLLISION_SHOWCASE_RENDER_FRAME_COUNT); assert.equal(new Set(framePlanHashes).size, COLLISION_SHOWCASE_RENDER_FRAME_COUNT);
  assert(new Set(pngHashes).size >= 120, `${proofCase.slug} retained schedule has insufficient decoded visual variation.`);
  assert(adapter && cleanup, `${proofCase.slug} retained schedule omitted adapter or cleanup evidence.`);
  assert.deepEqual(cleanup, await session.close());
  assert.deepEqual(mustObject(cleanup.gpu, "retained GPU cleanup").scene3dAnimation, { staticWrapperCompilations: 1, framePlanCompilations: COLLISION_SHOWCASE_RENDER_FRAME_COUNT });
  assert.equal(cleanup.scheduleComplete, true); assert.equal(cleanup.completedFrames, COLLISION_SHOWCASE_RENDER_FRAME_COUNT);
  return { adapter, evidence: {
    slug: proofCase.slug, identity: session.identity, geometry: proofCase.lowering.geometry, budget: proofCase.lowering.budget,
    framePlanSequenceSha256: canonicalJsonSha256(framePlanHashes), pngSequenceSha256: canonicalJsonSha256(pngHashes), uniquePngHashes: new Set(pngHashes).size,
    checkpoints: proofCase.plan.checkpoints.map((checkpoint) => frames.find((frame) => frame.atUs === checkpoint.atUs)), frames, cleanup,
  } };
}
function assertReceipt(receipt: OperationReceipt, expectedStatic: string): void {
  assert.equal(receipt.operation, "preview.gpu.frame"); assert.equal(receipt.status, "passed"); assert.equal(receipt.lane, "gpu");
  assert.equal(receiptHash(receipt, "gpu-scene3d-animation-static-plan"), expectedStatic); receiptHash(receipt, "gpu-scene3d-animation-source");
  assert.equal("sessionCleanup" in mustObject(receipt.output, "retained frame receipt output"), false, "Retained intermediate receipt must not claim terminal cleanup.");
}
function receiptHash(receipt: OperationReceipt, key: string): string { const value = receipt.inputHashes[key]; assert(typeof value === "string" && HASH.test(value), `Receipt omitted ${key}.`); return value; }
async function sourceEvidence(expectedCommit: string): Promise<Json> {
  const [head, expected, tree, status, tracked] = await Promise.all([git("rev-parse", "HEAD"), git("rev-parse", `${expectedCommit}^{commit}`), git("rev-parse", "HEAD^{tree}"), git("status", "--porcelain", "--untracked-files=no"), git("ls-files", "--error-unmatch", relative(repoRoot, scriptPath))]);
  assert.equal(head, expected, `Harness requires checkout ${expectedCommit}, found ${head}.`); assert.equal(status, ""); assert.equal(tracked, relative(repoRoot, scriptPath));
  return { commit: head, tree, expectedCommit, harnessSha256: await sha256File(scriptPath) };
}
async function createFreshPrivateRoot(path: string): Promise<void> { assert.equal(await exists(path), false, `Output root already exists: ${path}`); await mkdir(path, { mode: 0o700 }); const facts = await lstat(path); assert(facts.isDirectory() && !facts.isSymbolicLink()); if (process.platform !== "win32") assert.equal(facts.mode & 0o077, 0); }
async function git(...args: string[]): Promise<string> { return (await runFile("git", args, { cwd: repoRoot })).stdout.trim(); }
async function sha256File(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
async function writeCanonicalExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${canonicalJson(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
async function exists(path: string): Promise<boolean> { return Boolean(await lstat(path).catch(() => null)); }
function mustObject(value: unknown, label: string): Json { assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`); return value as Json; }
function safeError(error: unknown): Json { return { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) }; }

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) { try { await run(process.argv.slice(2)); } catch { process.exitCode = 1; } }
