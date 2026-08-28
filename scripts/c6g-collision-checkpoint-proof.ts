/**
 * Host-operated C6G-C checkpoint qualification. This is a repository proof harness,
 * not a public Motion command or renderer lane. It preserves every PNG and its
 * aggregate evidence under one caller-supplied fresh project scratch directory.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  canonicalJson,
  canonicalJsonSha256,
  comparePngFiles,
  inspectPngFile,
  type OperationReceipt,
  type PngQuality,
} from "../packages/core/src/index";
import type { CollisionShowcasePlan } from "../packages/core/src/internal/collision-showcase/collision-showcase";
import {
  renderMotionGpuPreview,
  type GpuPreviewResult,
} from "../packages/renderer-browser/src/index";
import { verifyGpuScene3dAnimationPreviewReceiptEvidence } from "../packages/renderer-browser/src/gpu-preview-output";
import {
  buildCollisionCheckpointProofCases,
  c6gProofRepoRoot,
  parseCollisionCheckpointProofArguments,
  type CollisionCheckpointProofCase,
} from "./c6g-collision-checkpoint-proof-contract";

const PROOF_SCHEMA = "shellx-motion/c6g-collision-checkpoint-proof@1" as const;
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = c6gProofRepoRoot;
const runFile = promisify(execFile);
const operationTimeoutMs = 45_000;
const HASH = /^[a-f0-9]{64}$/;
const SOFTWARE_ADAPTER = /swiftshader|llvmpipe|software|lavapipe|microsoft basic render/i;

type Json = Record<string, unknown>;

export async function runCollisionCheckpointProof(args: string[]): Promise<void> {
  let outputRoot: string | undefined;
  let ownsOutputRoot = false;
  try {
    const parsed = parseCollisionCheckpointProofArguments(args);
    outputRoot = parsed.outputRoot;
    const source = await sourceEvidence(parsed.expectedCommit);
    await createFreshPrivateRoot(outputRoot);
    ownsOutputRoot = true;
    const framesRoot = join(outputRoot, "frames");
    await mkdir(framesRoot, { mode: 0o700 });

    const stories = [] as Json[];
    let admittedAdapter: Json | undefined;
    for (const proofCase of buildCollisionCheckpointProofCases()) {
      const result = await renderCase(proofCase, outputRoot, framesRoot, admittedAdapter);
      admittedAdapter ??= result.adapter;
      assert.deepEqual(result.adapter, admittedAdapter, "All C6G checkpoint frames must use one exact hardware adapter identity.");
      stories.push(result.story);
    }

    assert(admittedAdapter, "C6G checkpoint qualification produced no adapter evidence.");
    const payload = {
      schema: PROOF_SCHEMA,
      status: "passed" as const,
      source,
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        operationTimeoutMs,
        adapter: admittedAdapter,
      },
      stories,
      evidence: {
        nativeWebGpuFrames: 8,
        oneShotSessions: 8,
        terminalCleanupBoundToEveryReceipt: true,
        sourceFramesRetained: true,
        publicOrInstalledSurfaceAdded: false,
        finalMediaProduced: false,
      },
    };
    const proof = Object.freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
    const proofPath = join(outputRoot, "checkpoint-proof.json");
    await writeCanonicalJsonExclusive(proofPath, proof);
    process.stdout.write(`${JSON.stringify({ ok: true, proofPath, frameRoot: framesRoot, fingerprint: proof.fingerprint }, null, 2)}\n`);
  } catch (error) {
    if (ownsOutputRoot && outputRoot) {
      await writeCanonicalJsonExclusive(join(outputRoot, "checkpoint-proof.failed.json"), {
        schema: PROOF_SCHEMA,
        status: "failed",
        error: safeError(error),
      }).catch(() => undefined);
    }
    process.stderr.write(`${JSON.stringify({ ok: false, outputRoot: outputRoot ?? null, error: safeError(error) }, null, 2)}\n`);
    throw error;
  }
}

async function renderCase(proofCase: CollisionCheckpointProofCase, outputRoot: string, framesRoot: string, expectedAdapter?: Json): Promise<{ story: Json; adapter: Json }> {
  const checkpoints = [] as Json[];
  const framePaths = [] as string[];
  const frameHashes = new Set<string>();
  const framePlanHashes = new Set<string>();
  let staticPlanHash: string | undefined;
  let adapter: Json | undefined;

  for (const checkpoint of proofCase.plan.checkpoints) {
    const frameName = `${proofCase.slug}-${String(checkpoint.frameIndex).padStart(2, "0")}-${checkpoint.id}.png`;
    const outputPath = join(framesRoot, frameName);
    assert.equal(await exists(outputPath), false, `Checkpoint output already exists: ${outputPath}`);
    const atMs = checkpoint.atUs / 1_000;
    const result = await renderMotionGpuPreview(proofCase.pkg, {
      atMs,
      outDir: framesRoot,
      outputPath,
      timeoutMs: operationTimeoutMs,
      callerId: "c6g-collision-checkpoint-proof",
      jobId: `c6g:${proofCase.slug}:${checkpoint.id}`,
    });
    const evidence = await assertCheckpointResult(proofCase, checkpoint, result, outputRoot, expectedAdapter ?? adapter);
    adapter ??= evidence.adapter;
    assert.deepEqual(evidence.adapter, adapter, `${proofCase.slug} changed GPU adapter between checkpoints.`);
    staticPlanHash ??= evidence.receiptHashes.staticPlan;
    assert.equal(evidence.receiptHashes.staticPlan, staticPlanHash, `${proofCase.slug} changed its static plan hash between checkpoints.`);
    frameHashes.add(evidence.png.sha256);
    framePlanHashes.add(evidence.receiptHashes.framePlan);
    framePaths.push(outputPath);
    checkpoints.push(evidence as unknown as Json);
  }

  assert.equal(frameHashes.size, proofCase.plan.checkpoints.length, `${proofCase.slug} checkpoint PNGs are not all visually distinct.`);
  assert.equal(framePlanHashes.size, proofCase.plan.checkpoints.length, `${proofCase.slug} checkpoint frame-plan hashes are not all distinct.`);
  const transitions = [] as Json[];
  for (let index = 1; index < framePaths.length; index += 1) {
    const comparison = await comparePngFiles(framePaths[index]!, framePaths[index - 1]!);
    assert(comparison.ok, comparison.ok ? undefined : comparison.message);
    if (!comparison.ok) continue;
    assert(comparison.changedPixels > 0, `${proofCase.slug} transition ${index - 1}->${index} changed no decoded pixels.`);
    transitions.push({ from: proofCase.plan.checkpoints[index - 1]!.id, to: proofCase.plan.checkpoints[index]!.id, ...comparison });
  }

  assert(adapter, `${proofCase.slug} emitted no adapter evidence.`);
  return {
    adapter,
    story: {
      slug: proofCase.slug,
      kind: proofCase.plan.kind,
      recipeSha256: proofCase.plan.recipeSha256,
      planFingerprint: proofCase.plan.fingerprint,
      contactLedgerSha256: proofCase.plan.contacts.ledgerSha256,
      loweringFingerprint: proofCase.lowering.fingerprint,
      motionSha256: proofCase.lowering.motionSha256,
      strictPreviewStaticFingerprint: proofCase.lowering.strictPreviewStaticFingerprint,
      geometry: proofCase.lowering.geometry,
      budget: proofCase.lowering.budget,
      targetLayerIds: proofCase.targetLayerIds,
      checkpoints,
      transitions,
    },
  };
}

async function assertCheckpointResult(
  proofCase: CollisionCheckpointProofCase,
  checkpoint: CollisionShowcasePlan["checkpoints"][number],
  result: GpuPreviewResult,
  outputRoot: string,
  expectedAdapter?: Json,
): Promise<{
  id: string;
  frameIndex: number;
  atUs: number;
  stateSha256: string;
  path: string;
  png: PngQuality & { bytes: number };
  receiptHashes: { staticPlan: string; source: string; framePlan: string; gpuFramePlan: string };
  scene3dAnimation: Json;
  resources: Json;
  cleanup: Json;
  adapter: Json;
}> {
  assert(result.ok, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
  if (!result.ok) throw new Error("Unreachable failed GPU preview result.");
  assert.equal(result.frame.width, proofCase.lowering.motion.width);
  assert.equal(result.frame.height, proofCase.lowering.motion.height);
  assert.equal(result.frame.atMs, checkpoint.atUs / 1_000);
  assert.equal(result.frame.gpu.backend, "webgpu-browser");
  assert(HASH.test(result.frame.gpu.adapterFingerprint), "GPU adapter fingerprint is not a SHA-256 identity.");
  assert(!SOFTWARE_ADAPTER.test(JSON.stringify(result.frame.gpu.adapter)), "Software GPU adapter evidence is refused.");
  assert.equal(result.frame.resources.lane, "gpu");
  assert.equal(result.frame.resources.operation, "gpu.preview");
  assert.equal(result.frame.resources.state, "passed");

  const adapter = result.frame.gpu as unknown as Json;
  if (expectedAdapter) assert.deepEqual(adapter, expectedAdapter, "GPU adapter identity differs from the admitted checkpoint run.");
  const receipt = result.receipt;
  assertReceiptEnvelope(receipt, proofCase.pkg.manifest.id);
  const output = mustObject(receipt.output, "GPU preview receipt output");
  const animationEvidence = verifyGpuScene3dAnimationPreviewReceiptEvidence(output.gpuScene3dAnimation) as unknown as Json;
  assert.equal(animationEvidence.atUs, checkpoint.atUs);
  assert.deepEqual(animationEvidence.targetLayerIds, proofCase.targetLayerIds);
  assert.equal(animationEvidence.staticWrapperFingerprint, proofCase.lowering.strictPreviewStaticFingerprint);
  const cleanup = mustObject(output.sessionCleanup, "GPU preview session cleanup");
  assert.equal(cleanup.closed, true, "GPU one-shot session did not close before publication.");
  assert(cleanup.runtimeResources && typeof cleanup.runtimeResources === "object", "GPU cleanup omitted runtime resource evidence.");
  assert.equal(cleanup.provider, null, "Asset-free C6G proof unexpectedly opened a video provider.");
  const resources = mustObject(output.resources, "GPU preview receipt resources");
  assert.equal(resources.state, "passed");

  const staticPlan = receiptHash(receipt, "gpu-scene3d-animation-static-plan");
  const source = receiptHash(receipt, "gpu-scene3d-animation-source");
  const framePlan = receiptHash(receipt, "gpu-scene3d-animation-frame-plan");
  const gpuFramePlan = receiptHash(receipt, "gpu-frame-plan");
  assert.equal(staticPlan, proofCase.lowering.strictPreviewStaticFingerprint);
  const pixels = await inspectPngFile(result.frame.path);
  assert(pixels.ok, pixels.ok ? undefined : pixels.message);
  if (!pixels.ok) throw new Error("Unreachable invalid PNG result.");
  assert.equal(pixels.width, proofCase.lowering.motion.width);
  assert.equal(pixels.height, proofCase.lowering.motion.height);
  const checkpointLabel = `${proofCase.slug}/${checkpoint.id}`;
  assert.equal(pixels.blank, false, `${checkpointLabel} GPU checkpoint frame is blank.`);
  assert(pixels.luma.range > 2, `${checkpointLabel} GPU checkpoint frame has insufficient luma range.`);
  assert(pixels.chroma.pixels > 0, `${checkpointLabel} GPU checkpoint frame has no chromatic pixels.`);
  assert.equal(pixels.sha256, result.frame.sha256);
  assert.equal(await sha256File(result.frame.path), result.frame.sha256);
  const facts = await stat(result.frame.path);
  assert(facts.isFile() && facts.size > 0, "GPU checkpoint output is not a nonempty regular file.");

  return {
    id: checkpoint.id,
    frameIndex: checkpoint.frameIndex,
    atUs: checkpoint.atUs,
    stateSha256: checkpoint.stateSha256,
    path: relative(outputRoot, result.frame.path),
    png: { ...pixels, bytes: facts.size },
    receiptHashes: { staticPlan, source, framePlan, gpuFramePlan },
    scene3dAnimation: animationEvidence,
    resources,
    cleanup,
    adapter,
  };
}

async function sourceEvidence(expectedCommit: string): Promise<Json> {
  const [head, expected, tree, trackedStatus, scriptTracked] = await Promise.all([
    git("rev-parse", "HEAD"),
    git("rev-parse", `${expectedCommit}^{commit}`),
    git("rev-parse", "HEAD^{tree}"),
    git("status", "--porcelain", "--untracked-files=no"),
    git("ls-files", "--error-unmatch", relative(repoRoot, scriptPath)),
  ]);
  assert.equal(head, expected, `Harness requires checkout ${expectedCommit}, found ${head}.`);
  assert.equal(trackedStatus, "", "Harness requires a clean tracked working tree.");
  assert.equal(scriptTracked, relative(repoRoot, scriptPath), "Harness source is not tracked by the admitted commit.");
  return { commit: head, tree, expectedCommit, harnessSha256: await sha256File(scriptPath) };
}

function assertReceiptEnvelope(receipt: OperationReceipt, packageId: string): void {
  assert.equal(receipt.schema, "shellx-motion/receipt@1");
  assert.equal(receipt.operation, "preview.gpu.frame");
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.packageId, packageId);
  assert.equal(receipt.lane, "gpu");
}

function receiptHash(receipt: OperationReceipt, key: string): string {
  const value = receipt.inputHashes[key];
  assert(typeof value === "string" && HASH.test(value), `GPU receipt omitted exact ${key} SHA-256 evidence.`);
  return value;
}

async function createFreshPrivateRoot(path: string): Promise<void> {
  assert.equal(await exists(path), false, `Output root already exists and will not be reused: ${path}`);
  await mkdir(path, { mode: 0o700 });
  const facts = await lstat(path);
  assert(facts.isDirectory() && !facts.isSymbolicLink(), "Output root is not a regular directory.");
  if (process.platform !== "win32") assert.equal(facts.mode & 0o077, 0, "Output root is not private (expected 0700).");
}

async function git(...args: string[]): Promise<string> {
  return (await runFile("git", args, { cwd: repoRoot })).stdout.trim();
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function writeCanonicalJsonExclusive(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${canonicalJson(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function exists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => null));
}

function mustObject(value: unknown, label: string): Json {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
  return value as Json;
}

function safeError(error: unknown): Json {
  return { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    await runCollisionCheckpointProof(process.argv.slice(2));
  } catch {
    process.exitCode = 1;
  }
}
