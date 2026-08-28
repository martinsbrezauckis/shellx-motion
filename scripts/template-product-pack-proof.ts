/**
 * Product-pack proof lane.
 *
 * Role: the release gate for `templates/shellx-product-pack`. It renders every promoted template
 * family to a real MP4 and refuses to certify a family it has not actually inspected.
 *
 * Gates (all fail closed — a family that cannot be proven makes the whole run `ok:false`, exit 1):
 *   1. instantiation  — the motion document that is actually rendered must contain zero unresolved
 *                       `{{token}}` placeholders. Data-driven families must resolve cleanly for
 *                       *every* declared row, not just the first one, and a family that ships
 *                       tokens without any `manifest.data.rows` to resolve them is rejected
 *                       outright (`uninstantiated_template`).
 *   2. visual gate    — every promoted family must declare `metadata.qualityTargets.manifest`.
 *                       Absence is a reported failure, never a silent skip: the manifest is what
 *                       drives multi-sample frame inspection (blank/edge/luma/chroma floors,
 *                       inter-sample motion, pre-encode encode-fidelity comparison) inside
 *                       `render`. previously only 5/15 families declared one and the other
 *                       10 were certified without any per-frame inspection at all.
 *   3. poster gate    — the shipped `metadata.preview.poster` must be a real render of the template:
 *                       correct dimensions, not blank, and carrying real ink coverage. A poster
 *                       captured from an un-instantiated document (blank frame + floating mustache
 *                       tokens) fails this gate.
 *   4. typography     — a family may not depend on a font it does not carry. Every text layer's
 *                       stack must end in a CSS generic (bare `"Inter"` resolves to the browser
 *                       DEFAULT font, a serif in Chromium — that is how ten families shipped a
 *                       geometric-sans design painted in Times), every non-generic family must be
 *                       bundled and declared, and the bundled weights must select the same faces a
 *                       complete 100-900 family would. Declaring only a CSS generic is allowed and
 *                       counted separately as the deliberate host-type choice.
 *   5. media gate     — MP4 container facts, output dimensions, receipt status, and the existing
 *                       frame/preview quality comparison, plus audio evidence for audio families.
 *
 * Dependencies: `packages/cli` (render + quality-check), `packages/core` (package/data/quality).
 * Primary callers: `pnpm run template-pack:proof`, release checks, CI.
 */
import assert from "node:assert/strict";
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";
import { expandMotionPackageRows, loadPackageDataRows } from "../packages/core/src/data";
import { LocalMotionJobGovernor, localMotionJobPolicyFromEnvironment } from "../packages/core/src/job-governor";
import { loadMotionPackage, resolvePackageAsset } from "../packages/core/src/package";
import { inspectPngFile } from "../packages/core/src/quality";
import { hashBuffer, hashFile, hashFramePaths } from "../packages/core/src/receipts";
import { createGovernedFfmpegRunner } from "../packages/renderer-ffmpeg/src/index";
import { assertReceiptSucceeded, MOTION_DENSITY_ADVISORY } from "./render-smoke-status";
import {
  assertMp4Container,
  readObjectField,
  readRecord,
  readString,
  writeJson
} from "./real-workflow-media-quality";
import {
  evaluatePosterGate,
  evaluateTypographyGate,
  findInterpolatedTokenKeys,
  findTemplateTokens,
  findUnbackedTokenKeys,
  assertProductTemplateContract,
  PUBLIC_PRODUCT_TEMPLATE_DIRS,
  selectProductTemplateDirectories
} from "./template-product-pack-catalog";
import {
  defaultTemplateMovingProofPolicyPath,
  evaluateMotionDensityAcceptance,
  loadTemplateMovingProofPolicy,
  selectMovingProofUniqueFrameHashGate,
  type MotionDensityAcceptanceResult,
  type MovingProofMotionDensityAnalysis
} from "./template-moving-proof-policy";
import { motionDensityCompositionPaths, stripFilmGrainEffects } from "./template-motion-density-composition";
import { assertResumableTemplateProofEvidence } from "./template-proof-resume";
import { inspectRetainedTemplateProofScratch, prepareTemplateProofScratch } from "./template-proof-scratch";
import { assertPrivateRepoScratchPath, preparePrivateRepoScratch } from "./repo-scratch.mjs";
import {
  inspectCompleteFrameSequenceMotionEvidence,
  type FrameSequenceMotionEvidence
} from "./frame-sequence-motion-evidence";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sourcePackRoot = resolve(optionValue("--template-root") ?? join(repoRoot, "templates", "shellx-product-pack"));
const requestedOutRoot = optionValue("--out");
const profileScratchRoot = requestedOutRoot ? null : await preparePrivateRepoScratch(repoRoot);
const outRoot = requestedOutRoot
  ? resolve(requestedOutRoot)
  : join(profileScratchRoot, "template-product-pack-proof");
if (profileScratchRoot) await assertPrivateRepoScratchPath(repoRoot, outRoot);
// Most proof encodes finish inside the product governor's normal one-second sampling period. That
// interval is appropriate for long jobs but recorded only process-start RSS for those short
// encodes, making the checked per-family cap look far smaller than the real FFmpeg process tree.
// The release proof uses the governor's supported minimum so every current receipt carries an
// honestly sampled resource measurement. This is a host-owned proof policy, not a CLI/package knob.
const templateProofRssPollIntervalMs = 25;
const templateProofGovernor = new LocalMotionJobGovernor({
  ...localMotionJobPolicyFromEnvironment(),
  rssPollIntervalMs: templateProofRssPollIntervalMs
});
const templateProofFfmpegRunner = createGovernedFfmpegRunner({
  governor: templateProofGovernor,
  scratchRoot: outRoot,
  operation: "template-product-pack-proof.ffmpeg"
});
const movingProofPolicyPath = defaultTemplateMovingProofPolicyPath();
const movingProofPolicy = await loadTemplateMovingProofPolicy(movingProofPolicyPath);
const proofFps = positiveIntegerOption("--fps", movingProofPolicy.delivery.fps);
const retainArtifacts = hasFlag("--retain-artifacts");
const resumeInspection = hasFlag("--resume-inspection");
// Calibration is a diagnostic command, never a release success. It is the only
// route allowed to carry the renderer's generic static-motion advisory while
// collecting the exact sequence measurements needed to replace it.
const calibrateMotionDensity = hasFlag("--calibrate-motion-density");
assert.equal(proofFps, movingProofPolicy.delivery.fps,
  `template moving proof is calibrated at ${movingProofPolicy.delivery.fps} fps; update the checked policy from a measured proof before changing --fps.`);
assert(!hasFlag("--full-duration"),
  "--full-duration is not a certified moving-proof profile. Update the checked per-family policy from measured full-rate evidence before enabling it.");
assert(!resumeInspection || !hasFlag("--force"),
  "--resume-inspection is non-destructive and cannot be combined with --force.");
assert(!resumeInspection || !calibrateMotionDensity,
  "--calibrate-motion-density requires a fresh render and cannot inspect retained diagnostics.");

/**
 * Gate failure carrying a stable machine-readable code for the evidence file. Declared before the
 * top-level proof loop so it is initialized when the loop's catch block references it.
 */
class ProofGateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProofGateError";
  }
}

const proofPackagesRoot = join(outRoot, "packages");
const rendersRoot = join(outRoot, "renders");
const framesRoot = join(outRoot, "frames");
const qualityRoot = join(outRoot, "quality");
const receiptsRoot = join(outRoot, "receipts");
const evidencePath = join(outRoot, "evidence.json");
const resumeFailureEvidencePath = join(outRoot, "resume-inspection.failure.json");
const contactSheetPath = join(outRoot, "contact-sheet.svg");

const proofScratch = resumeInspection
  ? await inspectRetainedTemplateProofScratch({ root: outRoot, repoRoot })
  : await prepareTemplateProofScratch({
    root: outRoot,
    repoRoot,
    // The built-in path is repository-owned and can be repeated by platform verification, but it
    // still cannot touch a legacy markerless root or unknown content. A caller-specified path always
    // needs explicit `--force` before its already-owned proof roles can be reset.
    force: hasFlag("--force") || requestedOutRoot === undefined
  });

const packageDirs = (await readdir(sourcePackRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assertProductTemplateContract(packageDirs);
// The implementation tree may retain withheld families. Promotion proof has to be exact over the
// public catalog, so no extra on-disk directory can silently expand release coverage.
const selectedTemplateDirs = selectProductTemplateDirectories([...PUBLIC_PRODUCT_TEMPLATE_DIRS], optionValue("--only"));
const resumeSourceEvidence = resumeInspection
  ? await assertResumeInspectionEvidence(selectedTemplateDirs)
  : undefined;

const proofs: ProductTemplateProof[] = [];
const failures: ProductTemplateFailure[] = [];
for (const packageDirName of selectedTemplateDirs) {
  try {
    proofs.push(await proveTemplate(packageDirName, { resumeInspection, calibrateMotionDensity }));
  } catch (error) {
    failures.push({
      packageDirName,
      code: error instanceof ProofGateError ? error.code : "proof_failed",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

const proofPassed = failures.length === 0 && proofs.length === selectedTemplateDirs.length;
// A calibration run deliberately retains diagnostics and exits non-zero: its
// measurements are inputs to a human threshold decision, not a proof that a
// release should ship.
const ok = !calibrateMotionDensity && proofPassed;
const retained = !ok || retainArtifacts;
if (retained) await writeContactSheet(contactSheetPath, proofs);
if (!retained) await pruneSuccessfulProofArtifacts();
for (const proof of proofs) proof.artifactAvailableAfterRun = retained;
const evidence = {
  ok,
  schema: "shellx-motion/template-moving-proof@1",
  command: "template-pack:proof",
  proofProfile: {
    // Every family renders its full story duration so the declared representative frames — which
    // routinely sit past 3s, where CTAs and resolve beats live — are actually reachable. The
    // source-owned policy locks this CI profile to a measured 8 fps.
    fps: proofFps,
    preserveStoryDurations: true,
    selectedTemplateDirs,
    ...(calibrateMotionDensity
      ? { mode: "motion_density_calibration_only" }
      : (resumeInspection ? { mode: "retained_diagnostics_inspection" } : { mode: "fresh_render" }))
  },
  policy: {
    source: relative(repoRoot, movingProofPolicyPath),
    sha256: await hashFile(movingProofPolicyPath),
    schema: movingProofPolicy.schema,
    calibration: movingProofPolicy.calibration,
    delivery: movingProofPolicy.delivery
  },
  promotedCatalogTemplateCount: PUBLIC_PRODUCT_TEMPLATE_DIRS.length,
  onDiskTemplateCount: packageDirs.length,
  templateCount: proofs.length,
  renderedMp4Count: proofs.length,
  audioTemplateCount: proofs.filter((proof) => proof.hasAudio).length,
  // Coverage is reported as hard counts so a future regression cannot hide behind `ok:true`.
  coverage: {
    selectedTemplateCount: selectedTemplateDirs.length,
    // Families whose rendered motion document was proven token-free.
    instantiationGatedCount: proofs.filter((proof) => proof.gates.instantiation === "passed").length,
    // Families inspected by a declared quality manifest. Silent skips are impossible: a family
    // without a manifest fails `missing_quality_manifest` and lands in `failures`.
    visuallyGatedCount: proofs.filter((proof) => proof.gates.visual === "declared-manifest").length,
    // Families rejected for having no declared visual gate at all — the old silent-skip population.
    visuallyUngatedCount: failures.filter((failure) => failure.code === "missing_quality_manifest").length,
    posterGatedCount: proofs.filter((proof) => proof.gates.poster === "passed").length,
    // Families whose declared font stacks were proven portable: every non-generic family bundled at
    // the weights it renders with, every stack terminated in a CSS generic.
    typographyGatedCount: proofs.filter((proof) => proof.gates.typography === "passed").length,
    // Families that carry their own font binaries rather than depending on host-installed fonts.
    fontBundlingTemplates: proofs.filter((proof) => proof.typography.bundledFamilies.length > 0).map((proof) => proof.packageDirName),
    // Families that deliberately render in the host's own UI type (CSS generic only, by design).
    hostGenericTypographyTemplates: proofs.filter((proof) => proof.typography.bundledFamilies.length === 0).map((proof) => proof.packageDirName),
    // Families whose shipped motion.json carries tokens resolved from `manifest.data.rows`.
    batchSourceTemplates: proofs.filter((proof) => proof.batchSource).map((proof) => proof.packageDirName),
    dataRowsProvenCount: proofs.reduce((total, proof) => total + (proof.dataRowCount ?? 0), 0)
  },
  cutStaticParity: {
    requiredFamilies: proofs.filter((proof) => proof.cutHandoff !== undefined).map((proof) => proof.packageDirName),
    command: "pnpm run template-pack:host-parity -- --canvas-root <path> --cut-root <path>",
    scope: "required separately because it inspects host contracts and starts no renderer"
  },
  retention: retained
    ? {
      state: "retained",
      reason: calibrateMotionDensity
        ? "motion_density_calibration_not_release_eligible"
        : (ok ? "requested_by_--retain-artifacts" : "failure_diagnostics")
    }
    : { state: "media_pruned_after_success", retainedRoles: ["evidence", "render_receipt"], prunedRoles: ["rendered_media", "frames", "quality_frames", "scratch_package_copy"] },
  scratch: {
    ownershipMarker: relative(outRoot, proofScratch.markerPath),
    preparation: proofScratch.state,
    resourceScope: "per-family caller-scratch tree; FFmpeg RSS is receipt-observed encode-process-tree only, not browser or total process RSS"
  },
  ...(resumeSourceEvidence ? {
    recovery: {
      mode: "retained_diagnostics_inspection",
      priorEvidenceSha256: resumeSourceEvidence.sha256,
      assertion: "marker-bound failed diagnostics were re-inspected without a browser render; final receipt, source-frame, and FFprobe facts were revalidated before cleanup"
    }
  } : {}),
  failureCount: failures.length,
  failures,
  ...(calibrateMotionDensity ? {
    motionDensityCalibration: {
      state: "not_release_eligible",
      reason: "Calibration measurements require a checked per-family acceptance decision before release proof can pass."
    }
  } : {}),
  ...(retained ? { contactSheetPath: relative(outRoot, contactSheetPath) } : {}),
  templates: proofs
};
const writtenEvidencePath = resumeInspection && !ok ? resumeFailureEvidencePath : evidencePath;
await writeJson(writtenEvidencePath, evidence);

console.log(JSON.stringify({ ...evidence, evidencePath: relative(outRoot, writtenEvidencePath) }, null, 2));
if (!ok) process.exitCode = 1;

interface ProductTemplateProof {
  packageDirName: string;
  packageRoot: string;
  outputPath: string;
  artifactAvailableAfterRun: boolean;
  framePath: string;
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  hasAudio: boolean;
  bytes: number;
  receiptId: string;
  receiptPath: string;
  receiptSha256: string;
  qualityAtMs: number;
  gates: { instantiation: "passed"; visual: "declared-manifest"; poster: "passed"; typography: "passed" };
  motion: {
    frameCount: number;
    uniqueFrameHashes: number;
    uniqueFrameRatio: number;
    uniqueFrameHashGate: "calibration-diagnostic" | "release-policy";
    minUniqueFrameHashes: number;
    releaseMinUniqueFrameHashes: number;
  };
  motionDensity: FrameSequenceMotionEvidence;
  motionDensityAcceptance: {
    analysis: MovingProofMotionDensityAnalysis;
    measured: FrameSequenceMotionEvidence;
    result: MotionDensityAcceptanceResult;
  };
  delivery: {
    durationMs: number;
    fps: number;
    durationDeltaMs: number;
    codec: string;
    container: string;
    color: { pixelFormat: string | null; space: string | null; transfer: string | null; primaries: string | null; range: string | null };
    audio: { present: boolean; streamCount: number };
  };
  resources: {
    scratchBytes: number;
    maxScratchBytes: number;
    encodePeakRssBytes: number;
    maxEncodePeakRssBytes: number;
    encodeDurationMs: number;
  };
  batchSource: boolean;
  poster: { path: string; width: number; height: number; edgePixels: number; edgeRatio: number; blank: false };
  typography: {
    bundledFamilies: string[];
    hostGenericOnlyLayers: number;
    fontAssetRefs: string[];
    fontAssetBytes: number;
  };
  qualityManifestPath: string;
  cutHandoff?: { mode: "generate_static_contract" | "rendered_media_static_contract" };
  dataRowCount?: number;
  dataRowId?: string;
}

interface ProductTemplateFailure {
  packageDirName: string;
  code: string;
  message: string;
}

function assertProofGate(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new ProofGateError(code, message);
}

/**
 * Render and prove one template family. Throws `ProofGateError` on any gate failure so the caller
 * can record it and keep proving the remaining families (a single broken template must not hide
 * the state of the other fourteen).
 */
async function proveTemplate(
  packageDirName: string,
  options: { resumeInspection: boolean; calibrateMotionDensity: boolean }
): Promise<ProductTemplateProof> {
  const policy = movingProofPolicy.families[packageDirName];
  assert(policy, `${packageDirName} is missing from the checked moving-proof policy`);
  const uniqueFrameHashGate = selectMovingProofUniqueFrameHashGate({
    calibrateMotionDensity: options.calibrateMotionDensity,
    releaseMinUniqueFrameHashes: policy.minUniqueFrameHashes
  });
  if (!options.calibrateMotionDensity && policy.motionDensity.state === "calibration-required") {
    throw new ProofGateError(
      "motion_density_policy_uncalibrated",
      `${packageDirName} cannot pass release proof: ${policy.motionDensity.reason} ` +
      "Run template-pack:proof -- --calibrate-motion-density on a qualified host, then commit visually reviewed source-owned caps."
    );
  }
  const sourcePackageRoot = join(sourcePackRoot, packageDirName);
  const proofPackageRoot = join(proofPackagesRoot, packageDirName);
  if (!options.resumeInspection) await cp(sourcePackageRoot, proofPackageRoot, { recursive: true });
  const materialized = options.resumeInspection
    ? await loadRetainedProofPackage(proofPackageRoot, packageDirName)
    : await materializeProofPackage(proofPackageRoot, packageDirName);
  const motionPath = join(proofPackageRoot, "motion.json");
  const motion = materialized.motion;
  const width = readPositiveNumber(readObjectField(motion, "width", "motion.width"), "motion.width");
  const height = readPositiveNumber(readObjectField(motion, "height", "motion.height"), "motion.height");
  const durationMs = readPositiveNumber(readObjectField(motion, "durationMs", "motion.durationMs"), "motion.durationMs");
  const fps = proofFps;
  const expectedFrameCount = Math.ceil((durationMs / 1000) * fps);
  assert(policy.minUniqueFrameHashes <= expectedFrameCount,
    `${packageDirName} policy requests ${policy.minUniqueFrameHashes} unique frames but the 8 fps proof contains only ${expectedFrameCount}`);
  if (options.resumeInspection) {
    assertProofGate(readPositiveNumber(readObjectField(motion, "fps", "retained motion.fps"), "retained motion.fps") === fps,
      "retained_motion_fps_mismatch", `${packageDirName} retained package is not the certified ${fps} fps proof profile.`);
  } else {
    motion.durationMs = durationMs;
    motion.fps = fps;
    patchAudioLayerDurations(motion, durationMs);
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
  }

  // Final instantiation gate on the exact bytes handed to the renderer.
  assertTokenFree(packageDirName, "rendered motion document", motion);
  // Static gates run before the render so a template that is already provably broken fails in
  // seconds instead of after a full encode.
  const typography = await proveTypography(packageDirName, proofPackageRoot, motion, materialized.manifestAssets);
  const poster = await proveShippedPoster(packageDirName, options.resumeInspection ? proofPackageRoot : sourcePackageRoot, materialized.posterRef, width, height);

  const outputPath = join(rendersRoot, `${packageDirName}.mp4`);
  const render = options.resumeInspection
    ? await retainedRenderResult(packageDirName, outputPath)
    : await runCli([
      "render",
      proofPackageRoot,
      "--lane",
      "ffmpeg",
      "--out",
      outputPath,
      // The renderer's materialized quality-manifest lane otherwise cleans its PNG sequence after
      // its own comparison. The moving-proof gate hashes that exact sequence, then owns pruning it
      // only after every receipt/readback/budget gate has passed.
      "--keep-frames",
      "--min-unique-frames",
      String(uniqueFrameHashGate.renderMinUniqueFrameHashes),
      "--quality-manifest",
      materialized.qualityManifestPath
    ], {
      scratchRoot: join(framesRoot, packageDirName),
      ffmpegRunner: templateProofFfmpegRunner
    });
  if (!render.ok) {
    throw new ProofGateError("render_failed", `${packageDirName} render failed: ${JSON.stringify(render, null, 2)}`);
  }
  await stat(outputPath);
  const mp4 = await assertMp4Container(outputPath, `${packageDirName} render`);

  const renderReceipt = readRecord(readObjectField(render, "receipt", `${packageDirName}.render.receipt`), `${packageDirName}.render.receipt`);
  // The generic renderer advisory is transport evidence, not release acceptance.
  // A calibrated family must subsequently satisfy its source-owned caps; an
  // uncalibrated family may carry it only in diagnostic calibration mode.
  assertReceiptSucceeded(renderReceipt, {
    label: `${packageDirName} render`,
    expectedAdvisories: options.calibrateMotionDensity || policy.motionDensity.state === "calibrated"
      ? [MOTION_DENSITY_ADVISORY]
      : []
  });
  const renderOutput = readRecord(readObjectField(render, "output", `${packageDirName}.render.output`), `${packageDirName}.render.output`);
  assert.equal(readObjectField(renderOutput, "width", `${packageDirName}.render.output.width`), width);
  assert.equal(readObjectField(renderOutput, "height", `${packageDirName}.render.output.height`), height);
  const receiptOutput = readRecord(readObjectField(renderReceipt, "output", `${packageDirName}.render.receipt.output`), `${packageDirName}.render.receipt.output`);
  const receiptQuality = readRecord(receiptOutput.qualityCheck, `${packageDirName}.render.receipt.output.qualityCheck`);
  assertProofGate(receiptQuality.status === "passed", "receipt_quality_manifest_failed",
    `${packageDirName} final render receipt does not attest a passing quality-manifest inspection.`);
  const receiptArtifactPath = readString(receiptOutput.path, `${packageDirName}.render.receipt.output.path`);
  assertProofGate(resolve(receiptArtifactPath) === outputPath, "receipt_artifact_path_mismatch",
    `${packageDirName} final receipt does not bind the requested proof artifact path.`);
  // A materializer may alter the package identity it hands to the renderer (the product-metric
  // generator adds a renderer-lane suffix). The sequence directory must therefore use the fresh
  // final receipt's identity, never the source manifest's pre-materialization id. Keep it a safe
  // single path component before it reaches `join`.
  const renderedPackageId = readString(renderReceipt.packageId, `${packageDirName}.render.receipt.packageId`);
  assertProofGate(/^[A-Za-z0-9_-]+$/.test(renderedPackageId), "invalid_rendered_package_id",
    `${packageDirName} final receipt returned an unsafe package identifier for its frame sequence.`);
  const receiptSha256 = readString(receiptOutput.sha256, `${packageDirName}.render.receipt.output.sha256`);
  const outputSha256 = await hashFile(outputPath);
  assertProofGate(outputSha256 === receiptSha256, "artifact_hash_mismatch",
    `${packageDirName} output SHA-256 does not match the final render receipt.`);
  assertProofGate(receiptSha256.match(/^[a-f0-9]{64}$/) !== null, "invalid_artifact_hash",
    `${packageDirName} final render receipt does not contain a SHA-256 artifact hash.`);
  const sequenceFrames = await listSequenceFrames(join(framesRoot, packageDirName, renderedPackageId));
  assertProofGate(sequenceFrames.length === expectedFrameCount, "frame_count_mismatch",
    `${packageDirName} produced ${sequenceFrames.length} source frames; expected ${expectedFrameCount} for its measured proof profile.`);
  const uniqueFrameHashes = new Set<string>();
  for (const framePath of sequenceFrames) uniqueFrameHashes.add(await hashFile(framePath));
  assertProofGate(uniqueFrameHashes.size >= uniqueFrameHashGate.renderMinUniqueFrameHashes, "motion_density_below_policy",
    `${packageDirName} produced ${uniqueFrameHashes.size} unique source-frame hashes; ` +
    `${uniqueFrameHashGate.evidence.uniqueFrameHashGate === "calibration-diagnostic" ? "calibration diagnostic" : "policy"} ` +
    `requires ${uniqueFrameHashGate.renderMinUniqueFrameHashes}.`);
  await assertReceiptFrameSequenceHash({
    packageDirName,
    sequenceFrames,
    framesDir: join(framesRoot, packageDirName, renderedPackageId),
    frameCount: expectedFrameCount,
    fps,
    width,
    height,
    durationMs,
    qualityManifestPath: materialized.qualityManifestPath,
    receipt: renderReceipt
  });
  // This reads the exact kept source frames that the render receipt has already bound. Unlike
  // unique hashes, Core's complete-sequence measurement combines MAFD with materially changed
  // pixels, so grain cannot manufacture a motion-density claim.
  const motionDensity = await inspectCompleteFrameSequenceMotionEvidence({
    framePaths: sequenceFrames,
    durationMs,
    fps
  });
  const measuredMotionDensity = await inspectDeclaredMotionDensity({
    packageDirName,
    policyAnalysis: policy.motionDensity.analysis,
    rendered: motionDensity,
    proofPackageRoot,
    materializedQualityManifestPath: materialized.qualityManifestPath,
    motion,
    width,
    height,
    durationMs,
    fps,
    expectedFrameCount
  });
  const motionDensityAcceptance = evaluateMotionDensityAcceptance(policy.motionDensity, measuredMotionDensity);
  if (!options.calibrateMotionDensity) {
    assertProofGate(motionDensityAcceptance.ok, motionDensityAcceptance.code ?? "motion_density_below_policy",
      `${packageDirName} ${motionDensityAcceptance.message ?? "did not satisfy its source-owned motion-density policy"}.`);
  }

  // The final receipt and independent FFprobe readback have different jobs. The receipt binds
  // the artifact to the exact local render operation; `quality-check` independently reads the
  // delivered container back. Do not infer any delivered fact from requested MotionIR values.
  const receiptDurationMs = positiveReceiptNumber(receiptOutput.durationMs, `${packageDirName}.render.receipt.output.durationMs`);
  const receiptColor = readRecord(receiptOutput.color, `${packageDirName}.render.receipt.output.color`);
  assertReceiptColor(packageDirName, receiptColor, movingProofPolicy.delivery.color);
  const receiptObservedColor = readRecord(receiptColor.observed, `${packageDirName}.render.receipt.output.color.observed`);
  assertObservedColor(packageDirName, receiptObservedColor, movingProofPolicy.delivery.color);
  assertProofGate(receiptOutput.codec === "h264" && receiptOutput.container === "mp4" && receiptOutput.preset === "mp4-h264",
    "receipt_delivery_format_mismatch", `${packageDirName} final receipt is not an MP4 H.264 delivery receipt.`);

  const resources = readRecord(receiptOutput.resources, `${packageDirName}.render.receipt.output.resources`);
  const resourcePolicy = readRecord(resources.policy, `${packageDirName}.render.receipt.output.resources.policy`);
  assertProofGate(resourcePolicy.rssPollIntervalMs === templateProofRssPollIntervalMs,
    "encode_rss_sampling_policy_mismatch",
    `${packageDirName} encode receipt was not sampled at the required ${templateProofRssPollIntervalMs}ms interval.`);
  const encodePeakRssBytes = nonNegativeReceiptNumber(resources.peakProcessTreeRssBytes,
    `${packageDirName}.render.receipt.output.resources.peakProcessTreeRssBytes`);
  const encodeDurationMs = nonNegativeReceiptNumber(resources.durationMs,
    `${packageDirName}.render.receipt.output.resources.durationMs`);
  assertProofGate(encodePeakRssBytes <= policy.maxEncodePeakRssBytes, "encode_rss_over_budget",
    `${packageDirName} encode peak RSS ${encodePeakRssBytes} exceeds source-owned policy cap ${policy.maxEncodePeakRssBytes}.`);
  assertProofGate(mp4.bytes <= policy.maxArtifactBytes, "artifact_size_over_budget",
    `${packageDirName} artifact bytes ${mp4.bytes} exceeds source-owned policy cap ${policy.maxArtifactBytes}.`);

  const hasAudio = motionHasAudio(motion);
  const qualityAtMs = Math.max(0, Math.min(Math.floor(durationMs / 2), durationMs - 200));
  const quality = await runCli([
    "quality-check",
    outputPath,
    "--at-ms",
    String(qualityAtMs),
    "--expect-width",
    String(width),
    "--expect-height",
    String(height),
    "--min-bright-pixels",
    "100",
    "--min-edge-pixels",
    "100",
    "--min-non-transparent-pixels",
    "1000",
    ...(!options.resumeInspection ? [
      "--preview-package",
      proofPackageRoot,
      "--preview-lane",
      "browser"
    ] : []),
    ...(!options.resumeInspection ? [
      "--max-changed-pixels",
      String(width * height),
      "--max-mean-diff",
      "8",
      "--min-psnr-db",
      "28"
    ] : []),
    ...(hasAudio ? ["--expect-audio", "--min-audio-peak-db", "-45", "--min-audio-mean-db", "-55"] : [])
  ], { scratchRoot: join(qualityRoot, packageDirName) });
  if (!quality.ok) {
    throw new ProofGateError("quality_check_failed", `${packageDirName} quality-check failed: ${JSON.stringify(quality, null, 2)}`);
  }
  const media = readRecord(readObjectField(quality, "media", `${packageDirName}.quality.media`), `${packageDirName}.quality.media`);
  assertProofGate(resolve(readString(media.path, `${packageDirName}.quality.media.path`)) === outputPath,
    "ffprobe_artifact_path_mismatch", `${packageDirName} FFprobe readback did not inspect the rendered proof artifact.`);
  const deliveredDurationMs = positiveReceiptNumber(media.durationMs, `${packageDirName}.quality.media.durationMs`);
  const deliveredFps = positiveReceiptNumber(media.fps, `${packageDirName}.quality.media.fps`);
  const maxDurationDriftMs = (1000 / deliveredFps) * movingProofPolicy.delivery.maxDurationDriftFrames;
  assertProofGate(deliveredFps === movingProofPolicy.delivery.fps, "delivered_fps_mismatch",
    `${packageDirName} delivered ${deliveredFps} fps; policy requires ${movingProofPolicy.delivery.fps} fps.`);
  assertProofGate(Math.abs(deliveredDurationMs - receiptDurationMs) <= maxDurationDriftMs,
    "receipt_duration_mismatch",
    `${packageDirName} FFprobe duration ${deliveredDurationMs}ms disagrees with final receipt ${receiptDurationMs}ms beyond ${maxDurationDriftMs}ms.`);
  assertProofGate(Math.abs(deliveredDurationMs - durationMs) <= maxDurationDriftMs,
    "delivered_duration_mismatch",
    `${packageDirName} FFprobe duration ${deliveredDurationMs}ms differs from the source story duration ${durationMs}ms beyond ${maxDurationDriftMs}ms.`);
  assertProofGate(media.codec === "h264" && String(media.container).split(",").includes("mp4"),
    "delivered_format_mismatch", `${packageDirName} FFprobe did not report MP4 H.264 delivery.`);
  const deliveredColor = readRecord(media.color, `${packageDirName}.quality.media.color`);
  assertDeliveredColor(packageDirName, deliveredColor, movingProofPolicy.delivery.color);
  const deliveredAudio = readRecord(media.audio, `${packageDirName}.quality.media.audio`);
  assertProofGate(deliveredAudio.present === hasAudio, "delivered_audio_presence_mismatch",
    `${packageDirName} FFprobe audio presence ${String(deliveredAudio.present)} does not match the rendered package's audio layers ${String(hasAudio)}.`);
  const deliveredAudioStreams = Array.isArray(deliveredAudio.streams) ? deliveredAudio.streams : [];
  assertProofGate(Number(deliveredAudio.streamCount) === deliveredAudioStreams.length, "delivered_audio_stream_count_mismatch",
    `${packageDirName} FFprobe audio stream count does not agree with its stream list.`);
  if (hasAudio) {
    // The success-status invariant matters on exactly this family: a successful audio
    // deliverable was reported `status: "warning"` because the frame lane's expected audio handoff
    // and routine loudnorm chatter rode the array that derives status. Neither of those escalates
    // any more — the handoff is structured evidence and the chatter is chatter — and the status
    // asserted above accepts only a warning this proof DECLARED; these gates prove the artifact
    // behind that status is real —
    // both streams present, both the same length as the container, and the frame lane's handoff
    // resolved against the delivered audio rather than assumed.
    const audio = deliveredAudio;
    assert.equal(readObjectField(audio, "present", `${packageDirName}.quality.media.audio.present`), true);
    const audioStreams = readObjectField(audio, "streams", `${packageDirName}.quality.media.audio.streams`);
    assert(Array.isArray(audioStreams) && audioStreams.length >= 1, `${packageDirName} delivered no audio stream`);
    const containerDurationMs = Number(readObjectField(media, "durationMs", `${packageDirName}.quality.media.durationMs`));
    for (const [index, entry] of audioStreams.entries()) {
      const stream = readRecord(entry, `${packageDirName}.quality.media.audio.streams[${index}]`);
      const streamDurationMs = Number(stream.durationMs);
      assert(Number.isFinite(streamDurationMs), `${packageDirName} audio stream ${index} reports no duration`);
      // One frame of tolerance: container and stream timestamps are quantized differently.
      assert(Math.abs(streamDurationMs - containerDurationMs) <= Math.ceil(1000 / fps),
        `${packageDirName} audio stream ${index} is ${streamDurationMs}ms against a ${containerDurationMs}ms container`);
    }
    const receiptAudio = readRecord(readObjectField(receiptOutput, "audio", `${packageDirName}.render.receipt.output.audio`), `${packageDirName}.render.receipt.output.audio`);
    assert(readString(receiptAudio.codec, `${packageDirName}.render.receipt.output.audio.codec`).length > 0);
    // Encoder provenance (the tool-identity invariant): a receipt that attests to an encode must name the
    // build that produced it, or the artifact cannot be reproduced or trusted.
    const tools = readRecord(readObjectField(receiptOutput, "tools", `${packageDirName}.render.receipt.output.tools`), `${packageDirName}.render.receipt.output.tools`);
    const ffmpegIdentity = readRecord(readObjectField(tools, "ffmpeg", `${packageDirName}.render.receipt.output.tools.ffmpeg`), `${packageDirName}.render.receipt.output.tools.ffmpeg`);
    assert.equal(ffmpegIdentity.tool, "ffmpeg");
    assert(readString(ffmpegIdentity.version, `${packageDirName}.render.receipt.output.tools.ffmpeg.version`).length > 0);
    assert(!readString(ffmpegIdentity.executable, `${packageDirName}...tools.ffmpeg.executable`).includes("/"),
      `${packageDirName} receipt leaked an absolute ffmpeg path`);
    const handoff = receiptOutput.audioHandoff === undefined
      ? undefined
      : readRecord(receiptOutput.audioHandoff, `${packageDirName}.render.receipt.output.audioHandoff`);
    if (handoff) {
      assert.equal(handoff.status, "handled_downstream");
      // Proof that the frame lane's claim was checked against the artifact, not trusted.
      assert.equal(handoff.resolution, "muxed");
    }
  }

  const sourceReceiptPath = readString(readObjectField(render, "receiptPath", `${packageDirName}.render.receiptPath`), `${packageDirName}.render.receiptPath`);
  assertProofGate(pathWithin(outRoot, sourceReceiptPath), "receipt_outside_proof_scratch",
    `${packageDirName} final render receipt escaped the caller proof scratch.`);
  const retainedReceiptPath = join(receiptsRoot, `${packageDirName}.render.receipt.json`);
  await mkdir(dirname(retainedReceiptPath), { recursive: true, mode: 0o700 });
  await copyFile(sourceReceiptPath, retainedReceiptPath);
  assertProofGate(await hashFile(retainedReceiptPath) === await hashFile(sourceReceiptPath), "receipt_copy_hash_mismatch",
    `${packageDirName} retained render receipt is not byte-identical to the final renderer receipt.`);

  const scratchBytes = await proofScratchBytes(packageDirName, outputPath, sourceReceiptPath, retainedReceiptPath);
  assertProofGate(scratchBytes <= policy.maxScratchBytes, "scratch_over_budget",
    `${packageDirName} proof scratch ${scratchBytes} bytes exceeds source-owned policy cap ${policy.maxScratchBytes}.`);

  return {
    packageDirName,
    packageRoot: relative(outRoot, proofPackageRoot),
    outputPath: relative(outRoot, outputPath),
    artifactAvailableAfterRun: true,
    framePath: relative(outRoot, qualityFramePath(packageDirName, quality)),
    width,
    height,
    durationMs: deliveredDurationMs,
    fps: deliveredFps,
    hasAudio,
    ...(materialized.dataRowId ? { dataRowId: materialized.dataRowId } : {}),
    ...(materialized.dataRowCount ? { dataRowCount: materialized.dataRowCount } : {}),
    bytes: mp4.bytes,
    receiptId: String(readObjectField(renderReceipt, "id", `${packageDirName}.render.receipt.id`)),
    receiptPath: relative(outRoot, retainedReceiptPath),
    receiptSha256: await hashFile(retainedReceiptPath),
    qualityAtMs,
    gates: { instantiation: "passed", visual: "declared-manifest", poster: "passed", typography: "passed" },
    batchSource: materialized.batchSource,
    poster,
    typography,
    qualityManifestPath: relative(outRoot, materialized.qualityManifestPath),
    motion: {
      frameCount: sequenceFrames.length,
      uniqueFrameHashes: uniqueFrameHashes.size,
      uniqueFrameRatio: uniqueFrameHashes.size / sequenceFrames.length,
      ...uniqueFrameHashGate.evidence
    },
    motionDensity,
    motionDensityAcceptance: {
      analysis: policy.motionDensity.analysis,
      measured: measuredMotionDensity,
      result: motionDensityAcceptance
    },
    delivery: {
      durationMs: deliveredDurationMs,
      fps: deliveredFps,
      durationDeltaMs: deliveredDurationMs - durationMs,
      codec: String(media.codec),
      container: String(media.container),
      color: {
        pixelFormat: stringOrNull(deliveredColor.pixelFormat),
        space: stringOrNull(deliveredColor.space),
        transfer: stringOrNull(deliveredColor.transfer),
        primaries: stringOrNull(deliveredColor.primaries),
        range: stringOrNull(deliveredColor.range)
      },
      audio: {
        present: deliveredAudio.present === true,
        streamCount: deliveredAudioStreams.length
      }
    },
    resources: {
      scratchBytes,
      maxScratchBytes: policy.maxScratchBytes,
      encodePeakRssBytes,
      maxEncodePeakRssBytes: policy.maxEncodePeakRssBytes,
      encodeDurationMs
    },
    ...(cutHandoffFor(materialized.hosts, packageDirName) ? { cutHandoff: cutHandoffFor(materialized.hosts, packageDirName) } : {})
  };
}

/**
 * Return the exact frame sequence declared by the family policy.  Film grain
 * is an intentional decorative effect but not composition motion, so its
 * alternate is rendered from the same materialized package with only that
 * effect removed.  It is diagnostic source-frame evidence, never a delivery
 * artifact or a substitute for the final receipt-bound render above.
 */
async function inspectDeclaredMotionDensity(input: {
  packageDirName: string;
  policyAnalysis: MovingProofMotionDensityAnalysis;
  rendered: FrameSequenceMotionEvidence;
  proofPackageRoot: string;
  materializedQualityManifestPath: string;
  motion: Record<string, unknown>;
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  expectedFrameCount: number;
}): Promise<FrameSequenceMotionEvidence> {
  if (input.policyAnalysis === "rendered") return input.rendered;

  const compositionPaths = motionDensityCompositionPaths({
    packageDirName: input.packageDirName,
    proofPackagesRoot,
    framesRoot,
    rendersRoot
  });
  const { packageRoot: compositionPackageRoot, scratchRoot: compositionScratchRoot, outputPath: compositionOutputPath } = compositionPaths;
  const compositionMotion = JSON.parse(JSON.stringify(input.motion)) as Record<string, unknown>;
  const removedGrainEffects = stripFilmGrainEffects(compositionMotion);
  assertProofGate(removedGrainEffects > 0, "motion_density_grain_alternate_missing",
    `${input.packageDirName} declares film-grain-stripped analysis but its materialized motion has no filmGrain effect.`);
  await cp(input.proofPackageRoot, compositionPackageRoot, { recursive: true });
  await writeFile(join(compositionPackageRoot, "motion.json"), `${JSON.stringify(compositionMotion, null, 2)}\n`, "utf8");
  const qualityManifestPath = join(compositionPackageRoot, relative(input.proofPackageRoot, input.materializedQualityManifestPath));
  const compositionRender = await runCli([
    "render",
    compositionPackageRoot,
    "--lane",
    "ffmpeg",
    "--out",
    compositionOutputPath,
    "--keep-frames",
    "--quality-manifest",
    qualityManifestPath
  ], {
    scratchRoot: compositionScratchRoot,
    ffmpegRunner: templateProofFfmpegRunner
  });
  if (!compositionRender.ok) {
    throw new ProofGateError("motion_density_grain_alternate_render_failed",
      `${input.packageDirName} film-grain-stripped diagnostic render failed: ${JSON.stringify(compositionRender, null, 2)}`);
  }
  const receipt = readRecord(readObjectField(compositionRender, "receipt", `${input.packageDirName}.composition.receipt`),
    `${input.packageDirName}.composition.receipt`);
  const packageId = readString(receipt.packageId, `${input.packageDirName}.composition.receipt.packageId`);
  assertProofGate(/^[A-Za-z0-9_-]+$/.test(packageId), "motion_density_grain_alternate_invalid_package_id",
    `${input.packageDirName} grain-stripped render returned an unsafe package id.`);
  const sequenceRoot = join(compositionScratchRoot, packageId);
  const sequenceFrames = await listSequenceFrames(sequenceRoot);
  assertProofGate(sequenceFrames.length === input.expectedFrameCount, "motion_density_grain_alternate_frame_count_mismatch",
    `${input.packageDirName} grain-stripped sequence has ${sequenceFrames.length} frames; expected ${input.expectedFrameCount}.`);
  await assertReceiptFrameSequenceHash({
    packageDirName: `${input.packageDirName}.motion-density-composition`,
    sequenceFrames,
    framesDir: sequenceRoot,
    frameCount: input.expectedFrameCount,
    fps: input.fps,
    width: input.width,
    height: input.height,
    durationMs: input.durationMs,
    qualityManifestPath,
    receipt
  });
  return inspectCompleteFrameSequenceMotionEvidence({ framePaths: sequenceFrames, durationMs: input.durationMs, fps: input.fps });
}

/**
 * Typography gate. Runs on the exact motion document handed to the renderer (row-expanded for data
 * families) so a family cannot pass by declaring fonts only in its un-instantiated source.
 */
async function proveTypography(
  packageDirName: string,
  proofPackageRoot: string,
  motion: Record<string, unknown>,
  manifestAssets: readonly string[]
): Promise<ProductTemplateProof["typography"]> {
  const verdict = evaluateTypographyGate({ motion, manifestAssets });
  if (verdict.ok === false) {
    throw new ProofGateError("typography_not_portable", `${packageDirName} ${verdict.reason}`);
  }
  const fontAssetRefs = manifestAssets.filter((assetRef) => assetRef.startsWith("assets/fonts/"));
  if (verdict.bundledFamilies.length > 0) {
    assert(
      fontAssetRefs.length > 0,
      `${packageDirName} claims bundled families ${verdict.bundledFamilies.join(", ")} but declares no assets/fonts/ file`
    );
    // The declaration is not the evidence: every declared face must exist on disk as a real file.
    for (const assetRef of fontAssetRefs) {
      const fontPath = resolvePackageAsset({ root: proofPackageRoot }, assetRef);
      const stats = await stat(fontPath);
      assert(stats.isFile() && stats.size > 0, `${packageDirName} font asset ${assetRef} is not a non-empty file`);
    }
  }
  return {
    bundledFamilies: verdict.bundledFamilies,
    hostGenericOnlyLayers: verdict.hostGenericOnlyLayers,
    fontAssetRefs,
    fontAssetBytes: (await Promise.all(fontAssetRefs.map(async (assetRef) => (
      (await stat(resolvePackageAsset({ root: proofPackageRoot }, assetRef))).size
    )))).reduce((total, bytes) => total + bytes, 0)
  };
}

/**
 * Instantiation gate. Scans any JSON value for residual mustache placeholders and throws with the
 * offending token list. This is the check that makes "a shipped template renders raw template
 * tokens" impossible to certify.
 */
function assertTokenFree(packageDirName: string, label: string, value: unknown): void {
  const tokens = findTemplateTokens(value);
  if (tokens.length === 0) return;
  throw new ProofGateError(
    "unresolved_tokens_after_instantiation",
    `${packageDirName} ${label} still contains unresolved template tokens after instantiation: ${tokens.join(", ")}`
  );
}

/**
 * Instantiation gate, second half: every token the shipped document depends on must have a real
 * value in every declared row. Without this, `{{unbackedHeadline}}` expands to `""` — the document
 * looks token-free while the layer it fed renders blank, which is the same shipped defect wearing a
 * different disguise.
 */
function assertTokensAreRowBacked(packageDirName: string, tokenKeys: string[], rowId: string, rowValues: Record<string, unknown>): void {
  const missing = findUnbackedTokenKeys(tokenKeys, rowValues);
  if (missing.length === 0) return;
  throw new ProofGateError(
    "unbacked_template_token",
    `${packageDirName} data row ${rowId} has no value for ${missing.length} template token(s) ` +
      `(${missing.map((key) => `{{${key}}}`).join(", ")}); those layers expand to empty content instead of failing loudly.`
  );
}

/**
 * Poster gate. The agent catalog and Cut/Canvas template pickers all render
 * `metadata.preview.poster`, so a stale or un-instantiated poster is a shipped defect even when the
 * template itself renders correctly. Requires: declared poster, real file, dimensions equal to the
 * template's own output size, `blank: false`, and ink coverage above `POSTER_MIN_EDGE_RATIO`.
 */
async function proveShippedPoster(
  packageDirName: string,
  sourcePackageRoot: string,
  posterRef: string | undefined,
  width: number,
  height: number
): Promise<ProductTemplateProof["poster"]> {
  if (!posterRef) {
    throw new ProofGateError(
      "missing_preview_poster",
      `${packageDirName} does not declare template.metadata.preview.poster; the catalog cannot show this family.`
    );
  }
  const posterPath = resolvePackageAsset({ root: sourcePackageRoot }, posterRef);
  const inspected = await inspectPngFile(posterPath);
  if (inspected.ok === false) {
    throw new ProofGateError("unreadable_preview_poster", `${packageDirName} poster ${posterRef} is not a readable PNG: ${inspected.message}`);
  }
  const verdict = evaluatePosterGate(
    { width: inspected.width, height: inspected.height, blank: inspected.blank, edgeRatio: inspected.edges.ratio },
    width,
    height
  );
  if (verdict.ok === false) {
    throw new ProofGateError(
      verdict.code,
      `${packageDirName} ${verdict.reason}; regenerate the poster from a real instantiated render.`
    );
  }
  return {
    // This evidence is portable: retain the package-local declaration rather than the caller's
    // absolute checkout path.
    path: posterRef,
    width: inspected.width,
    height: inspected.height,
    edgePixels: inspected.edges.pixels,
    edgeRatio: inspected.edges.ratio,
    blank: false
  };
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function positiveIntegerOption(name: string, fallback: number): number {
  const raw = optionValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  assert(Number.isInteger(value) && value > 0, `${name} must be a positive integer`);
  return value;
}

/**
 * Resolve the motion document the proof will actually render, and run the instantiation + visual
 * gate preconditions:
 *
 * - a promoted family MUST declare `metadata.qualityTargets.manifest` (no silent skip);
 * - a family whose shipped motion document carries `{{tokens}}` MUST declare `manifest.data.rows`
 *   that resolve them, otherwise it is un-instantiated and is rejected;
 * - when data rows exist, EVERY row must expand token-free, not just the first one.
 */
async function materializeProofPackage(packageRoot: string, packageDirName: string): Promise<{
  motion: Record<string, unknown>;
  packageId: string;
  hosts: string[];
  qualityManifestPath: string;
  posterRef?: string;
  batchSource: boolean;
  /** `manifest.assets` of the package as it will be rendered (row-expanded for data families). */
  manifestAssets: string[];
  dataRowCount?: number;
  dataRowId?: string;
}> {
  const pkg = await loadMotionPackage(packageRoot);
  const qualityManifestRef = pkg.template?.metadata?.qualityTargets?.manifest;
  if (!qualityManifestRef) {
    throw new ProofGateError(
      "missing_quality_manifest",
      `${packageDirName} does not declare template.metadata.qualityTargets.manifest, so its frames were never visually ` +
        `inspected. Every promoted product-pack family must declare a package-local quality/ manifest.`
    );
  }
  const qualityManifestPath = resolvePackageAsset(pkg, qualityManifestRef);
  const posterRef = pkg.template?.metadata?.preview?.poster;
  const shippedTokens = findTemplateTokens(pkg.motion);
  const manifestData = pkg.manifest.data === undefined ? null : readRecord(pkg.manifest.data, "manifest.data");
  const rowsRef = manifestData && typeof manifestData.rows === "string" ? manifestData.rows : undefined;

  if (!rowsRef) {
    if (shippedTokens.length > 0) {
      throw new ProofGateError(
        "uninstantiated_template",
        `${packageDirName} ships un-instantiated: motion.json carries ${shippedTokens.length} unresolved template ` +
          `token(s) (${shippedTokens.join(", ")}) and the package declares no manifest.data.rows to resolve them, ` +
          `so a plain \`render\` of this package paints raw mustache tokens.`
      );
    }
    return {
      motion: readRecord(pkg.motion, "motion"),
      packageId: pkg.manifest.id,
      hosts: [...(pkg.manifest.compatibility?.hosts ?? [])],
      qualityManifestPath,
      posterRef,
      batchSource: false,
      manifestAssets: [...(pkg.manifest.assets ?? [])]
    };
  }

  const rows = await loadPackageDataRows(pkg, rowsRef);
  const jobs = expandMotionPackageRows(pkg, rows);
  assert(jobs.length > 0, `${packageDirName} data package must expand at least one row`);
  // Prove every declared row, not only the row the proof renders: a template that resolves row 0
  // and paints tokens on row 3 is still a shipped defect.
  const tokenKeys = findInterpolatedTokenKeys(pkg.motion);
  for (const job of jobs) {
    assertTokensAreRowBacked(packageDirName, tokenKeys, job.row.id, job.row.values);
    assertTokenFree(packageDirName, `expanded data row ${job.row.id}`, job.motion);
    assertTokenFree(packageDirName, `expanded manifest for data row ${job.row.id}`, job.manifest);
  }
  const firstJob = jobs[0];
  await writeFile(join(packageRoot, "manifest.json"), `${JSON.stringify(firstJob.manifest, null, 2)}\n`, "utf8");
  return {
    motion: readRecord(firstJob.motion, "expanded motion"),
    packageId: pkg.manifest.id,
    hosts: [...(pkg.manifest.compatibility?.hosts ?? [])],
    qualityManifestPath,
    posterRef,
    batchSource: shippedTokens.length > 0,
    manifestAssets: assetRefsOf(firstJob.manifest),
    dataRowCount: jobs.length,
    dataRowId: firstJob.row.id
  };
}

/**
 * Recover the exact package bytes held by the marker-bound failed run. No copy
 * or rewrite is allowed here: recovery must inspect the materialized package
 * that produced the retained receipt, not reconstruct a new candidate.
 */
async function loadRetainedProofPackage(packageRoot: string, packageDirName: string): Promise<{
  motion: Record<string, unknown>;
  packageId: string;
  hosts: string[];
  qualityManifestPath: string;
  posterRef?: string;
  batchSource: boolean;
  manifestAssets: string[];
  dataRowCount?: number;
  dataRowId?: string;
}> {
  const pkg = await loadMotionPackage(packageRoot);
  const qualityManifestRef = pkg.template?.metadata?.qualityTargets?.manifest;
  if (!qualityManifestRef) {
    throw new ProofGateError("missing_quality_manifest", `${packageDirName} retained package has no quality manifest.`);
  }
  const qualityManifestPath = resolvePackageAsset(pkg, qualityManifestRef);
  const manifestData = pkg.manifest.data === undefined ? undefined : readRecord(pkg.manifest.data, "retained manifest.data");
  const rowsRef = manifestData && typeof manifestData.rows === "string" ? manifestData.rows : undefined;
  const dataRows = rowsRef ? await loadPackageDataRows(pkg, rowsRef) : undefined;
  return {
    motion: readRecord(pkg.motion, "retained motion"),
    packageId: pkg.manifest.id,
    hosts: [...(pkg.manifest.compatibility?.hosts ?? [])],
    qualityManifestPath,
    posterRef: pkg.template?.metadata?.preview?.poster,
    batchSource: dataRows !== undefined,
    manifestAssets: [...(pkg.manifest.assets ?? [])],
    ...(dataRows ? { dataRowCount: dataRows.length } : {})
  };
}

/** Read the one raw final receipt whose artifact path binds this proof family. */
async function retainedRenderResult(packageDirName: string, outputPath: string): Promise<{
  ok: true;
  output: Record<string, unknown>;
  receipt: Record<string, unknown>;
  receiptPath: string;
}> {
  const names = (await readdir(rendersRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith("-render.receipt.json"))
    .map((entry) => entry.name)
    .sort();
  const candidates = await Promise.all(names.map(async (name) => {
    const path = join(rendersRoot, name);
    const parsed = parseJsonRecord(await readFile(path, "utf8"), `retained render receipt ${name}`);
    const output = readRecord(parsed.output, `retained render receipt ${name}.output`);
    return { path, parsed, output };
  }));
  const matched = candidates.filter(({ output }) => resolve(readString(output.path, "retained render receipt output.path")) === outputPath);
  assertProofGate(matched.length === 1, "retained_receipt_missing_or_ambiguous",
    `${packageDirName} retained proof requires exactly one raw final receipt bound to ${outputPath}.`);
  const retained = matched[0]!;
  return { ok: true, output: retained.output, receipt: retained.parsed, receiptPath: retained.path };
}

async function assertReceiptFrameSequenceHash(input: {
  packageDirName: string;
  sequenceFrames: string[];
  framesDir: string;
  frameCount: number;
  fps: number;
  width: number;
  height: number;
  durationMs: number;
  qualityManifestPath: string;
  receipt: Record<string, unknown>;
}): Promise<void> {
  const inputHashes = readRecord(input.receipt.inputHashes, `${input.packageDirName}.render.receipt.inputHashes`);
  const expectedHash = readString(inputHashes.frames, `${input.packageDirName}.render.receipt.inputHashes.frames`);
  const expectedQualityManifestHash = readString(inputHashes.qualityManifest,
    `${input.packageDirName}.render.receipt.inputHashes.qualityManifest`);
  const frameHashes = await hashFramePaths(input.sequenceFrames);
  const actualHash = hashBuffer(Buffer.from(JSON.stringify({
    framesDir: input.framesDir,
    framePattern: "%06d.png",
    frameCount: input.frameCount,
    frameHashes,
    fps: input.fps,
    width: input.width,
    height: input.height,
    durationMs: input.durationMs
  }), "utf8"));
  assertProofGate(actualHash === expectedHash, "frame_sequence_hash_mismatch",
    `${input.packageDirName} retained source frames do not match the sequence hash attested by the final receipt.`);
  assertProofGate(await hashFile(input.qualityManifestPath) === expectedQualityManifestHash,
    "quality_manifest_hash_mismatch",
    `${input.packageDirName} retained quality manifest does not match the hash attested by the final receipt.`);
}

async function assertResumeInspectionEvidence(selectedTemplateDirs: readonly string[]): Promise<{ sha256: string }> {
  const text = await readFile(evidencePath, "utf8");
  const priorEvidence = parseJsonRecord(text, "retained template proof evidence");
  const policySha256 = await hashFile(movingProofPolicyPath);
  assertResumableTemplateProofEvidence({
    evidence: priorEvidence,
    selectedTemplateDirs,
    policySha256
  });
  return { sha256: hashBuffer(Buffer.from(text, "utf8")) };
}

function parseJsonRecord(text: string, label: string): Record<string, unknown> {
  try {
    return readRecord(JSON.parse(text), label);
  } catch (error) {
    throw new ProofGateError("invalid_retained_proof_evidence", `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** `manifest.assets` of an expanded (row-instantiated) manifest, which is a plain JSON value. */
function assetRefsOf(manifest: unknown): string[] {
  const assets = readRecord(manifest, "expanded manifest").assets;
  return Array.isArray(assets) ? assets.filter((value): value is string => typeof value === "string") : [];
}

function readPositiveNumber(value: unknown, label: string): number {
  assert(typeof value === "number" && Number.isFinite(value) && value > 0, `${label} must be a positive finite number`);
  return value;
}

function positiveReceiptNumber(value: unknown, label: string): number {
  assertProofGate(typeof value === "number" && Number.isFinite(value) && value > 0,
    "invalid_receipt_media_fact", `${label} must be a positive finite number from a fresh receipt or FFprobe readback.`);
  return value;
}

function nonNegativeReceiptNumber(value: unknown, label: string): number {
  assertProofGate(typeof value === "number" && Number.isFinite(value) && value >= 0,
    "invalid_receipt_resource_fact", `${label} must be a non-negative finite resource measurement.`);
  return value;
}

function assertReceiptColor(
  packageDirName: string,
  color: Record<string, unknown>,
  expected: typeof movingProofPolicy.delivery.color
): void {
  assertProofGate(
    color.profile === expected.profile
      && color.primaries === expected.primaries
      && color.transfer === expected.transfer
      && color.matrix === expected.matrix
      && color.range === expected.range,
    "receipt_color_mismatch",
    `${packageDirName} final receipt does not attest the policy SDR BT.709 delivery colour.`
  );
}

function assertObservedColor(
  packageDirName: string,
  observed: Record<string, unknown>,
  expected: typeof movingProofPolicy.delivery.color
): void {
  assertProofGate(
    observed.primaries === expected.primaries
      && observed.transfer === expected.transfer
      && observed.matrix === expected.matrix
      && observed.range === expected.range,
    "receipt_observed_color_mismatch",
    `${packageDirName} final receipt's observed colour readback is not policy SDR BT.709.`
  );
}

function assertDeliveredColor(
  packageDirName: string,
  color: Record<string, unknown>,
  expected: typeof movingProofPolicy.delivery.color
): void {
  assertProofGate(
    color.space === expected.matrix
      && color.transfer === expected.transfer
      && color.primaries === expected.primaries
      && color.range === expected.range,
    "delivered_color_mismatch",
    `${packageDirName} FFprobe readback is not policy SDR BT.709 limited-range delivery.`
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function qualityFramePath(packageDirName: string, quality: Record<string, unknown>): string {
  const framePath = readString(readObjectField(quality, "framePath", `${packageDirName}.quality.framePath`), `${packageDirName}.quality.framePath`);
  assertProofGate(pathWithin(qualityRoot, framePath), "quality_frame_outside_proof_scratch",
    `${packageDirName} quality frame escaped the caller proof scratch.`);
  return framePath;
}

function pathWithin(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rootWithSeparator = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(rootWithSeparator);
}

function cutHandoffFor(
  hosts: readonly string[],
  packageDirName: string
): ProductTemplateProof["cutHandoff"] | undefined {
  if (!hosts.includes("shellx-cut")) return undefined;
  // Rain is intentionally a rendered-media-only handoff. It may never acquire a fabricated Cut
  // Generate claim simply because its manifest advertises the Cut host.
  return packageDirName === "cinematic-rain-launch"
    ? { mode: "rendered_media_static_contract" }
    : { mode: "generate_static_contract" };
}

async function listSequenceFrames(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const frames = entries
    .filter((entry) => entry.isFile() && /^\d{4,}\.png$/i.test(entry.name))
    .map((entry) => join(path, entry.name))
    .sort();
  assertProofGate(frames.length > 0, "missing_source_frames", `No browser sequence frames were retained at ${path}.`);
  return frames;
}

async function proofScratchBytes(
  packageDirName: string,
  outputPath: string,
  sourceReceiptPath: string,
  retainedReceiptPath: string
): Promise<number> {
  const parts = await Promise.all([
    treeByteSize(join(proofPackagesRoot, packageDirName)),
    treeByteSize(join(framesRoot, packageDirName)),
    treeByteSize(join(qualityRoot, packageDirName)),
    treeByteSize(outputPath),
    treeByteSize(sourceReceiptPath),
    treeByteSize(retainedReceiptPath)
  ]);
  return parts.reduce((total, bytes) => total + bytes, 0);
}

async function treeByteSize(path: string): Promise<number> {
  const node = await stat(path);
  if (node.isFile()) return node.size;
  if (!node.isDirectory()) return 0;
  const entries = await readdir(path, { withFileTypes: true });
  const sizes = await Promise.all(entries.map((entry) => treeByteSize(join(path, entry.name))));
  return sizes.reduce((total, size) => total + size, 0);
}

async function pruneSuccessfulProofArtifacts(): Promise<void> {
  // Receipts are copied to `receipts/` before this point. The full package copies, raster frames,
  // quality diagnostics and MP4s are caller-scratch diagnostics, never source assets or CI output.
  await Promise.all([
    rm(proofPackagesRoot, { recursive: true, force: true }),
    rm(rendersRoot, { recursive: true, force: true }),
    rm(framesRoot, { recursive: true, force: true }),
    rm(qualityRoot, { recursive: true, force: true }),
    rm(contactSheetPath, { force: true }),
    rm(resumeFailureEvidencePath, { force: true })
  ]);
}

function patchAudioLayerDurations(motion: Record<string, unknown>, durationMs: number): void {
  const layers = Array.isArray(motion.layers) ? motion.layers : [];
  for (const layer of layers) {
    const record = readRecord(layer, "motion.layer");
    if (record.type === "audio") record.durationMs = durationMs;
  }
}

function motionHasAudio(motion: Record<string, unknown>): boolean {
  const layers = Array.isArray(motion.layers) ? motion.layers : [];
  return layers.some((layer) => readRecord(layer, "motion.layer").type === "audio");
}

async function writeContactSheet(path: string, proofs: ProductTemplateProof[]): Promise<void> {
  const columns = 5;
  const tileW = 360;
  const tileH = 256;
  const labelH = 54;
  const gap = 24;
  const margin = 32;
  const rows = Math.max(1, Math.ceil(proofs.length / columns));
  const width = margin * 2 + columns * tileW + (columns - 1) * gap;
  const height = margin * 2 + rows * (tileH + labelH) + (rows - 1) * gap + 72;
  const images = proofs.map((proof, index) => {
    const x = margin + (index % columns) * (tileW + gap);
    const y = margin + 72 + Math.floor(index / columns) * (tileH + labelH + gap);
    const imageHref = escapeXml(relative(dirname(path), join(outRoot, proof.framePath)).replaceAll("\\", "/"));
    return [
      `<g>`,
      `<rect x="${x}" y="${y}" width="${tileW}" height="${tileH}" rx="10" fill="#101820"/>`,
      `<image href="${imageHref}" x="${x}" y="${y}" width="${tileW}" height="${tileH}" preserveAspectRatio="xMidYMid meet"/>`,
      `<text x="${x}" y="${y + tileH + 26}" fill="#f8fafc" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="800">${escapeXml(proof.packageDirName)}</text>`,
      `<text x="${x}" y="${y + tileH + 48}" fill="#9fb2bf" font-family="Inter, Arial, sans-serif" font-size="14">${proof.width}x${proof.height} MP4${proof.hasAudio ? " + audio" : ""}</text>`,
      `</g>`
    ].join("");
  }).join("\n  ");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="ShellX product template pack contact sheet">`,
    `<rect width="${width}" height="${height}" fill="#071014"/>`,
    `<text x="${margin}" y="${margin + 28}" fill="#f8fafc" font-family="Inter, Arial, sans-serif" font-size="28" font-weight="850">ShellX Motion product template pack proof</text>`,
    `<text x="${margin}" y="${margin + 58}" fill="#9fb2bf" font-family="Inter, Arial, sans-serif" font-size="16">${proofs.length} real MP4 renders with frame/preview quality checks</text>`,
    `  ${images}`,
    `</svg>`
  ].join("\n");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${svg}\n`, "utf8");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
