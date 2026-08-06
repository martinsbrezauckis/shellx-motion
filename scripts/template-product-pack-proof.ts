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
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";
import { expandMotionPackageRows, loadPackageDataRows } from "../packages/core/src/data";
import { loadMotionPackage, resolvePackageAsset } from "../packages/core/src/package";
import { inspectPngFile } from "../packages/core/src/quality";
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
  selectProductTemplateDirectories
} from "./template-product-pack-catalog";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sourcePackRoot = resolve(optionValue("--template-root") ?? join(repoRoot, "templates", "shellx-product-pack"));
const outRoot = resolve(optionValue("--out") ?? join(repoRoot, ".scratch", "template-product-pack-proof"));
const proofFps = positiveIntegerOption("--fps", 8);
const fullDuration = hasFlag("--full-duration");
// No default count: the expected number differs between the implementation tree (public + withheld)
// and the published tree (public only), so it is derived from the contract at the assertion below
// rather than frozen here. --expected-count stays available for a caller pinning an exact number.
const expectedTemplateCount = positiveIntegerOption("--expected-count", 0);

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
const evidencePath = join(outRoot, "evidence.json");
const contactSheetPath = join(outRoot, "contact-sheet.svg");

await rm(outRoot, { recursive: true, force: true });
await mkdir(outRoot, { recursive: true });

const packageDirs = (await readdir(sourcePackRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (expectedTemplateCount > 0) {
  assert.equal(packageDirs.length, expectedTemplateCount, `expected ${expectedTemplateCount} product-pack templates, got ${packageDirs.length}`);
}
assertProductTemplateContract(packageDirs);
const selectedTemplateDirs = selectProductTemplateDirectories(packageDirs, optionValue("--only"));

const proofs: ProductTemplateProof[] = [];
const failures: ProductTemplateFailure[] = [];
for (const packageDirName of selectedTemplateDirs) {
  try {
    proofs.push(await proveTemplate(packageDirName));
  } catch (error) {
    failures.push({
      packageDirName,
      code: error instanceof ProofGateError ? error.code : "proof_failed",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

await writeContactSheet(contactSheetPath, proofs);
const ok = failures.length === 0 && proofs.length === selectedTemplateDirs.length;
const evidence = {
  ok,
  command: "template-pack:proof",
  sourcePackRoot,
  outRoot,
  proofProfile: {
    fullDuration,
    // Every family renders its full story duration so the declared representative frames — which
    // routinely sit past 3s, where CTAs and resolve beats live — are actually reachable. Only the
    // frame rate is reduced (unless --full-duration pins the template's own fps).
    fps: fullDuration ? null : proofFps,
    preserveStoryDurations: true,
    selectedTemplateDirs
  },
  catalogTemplateCount: packageDirs.length,
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
  failureCount: failures.length,
  failures,
  contactSheetPath,
  templates: proofs
};
await writeJson(evidencePath, evidence);

console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));
if (!ok) process.exitCode = 1;

interface ProductTemplateProof {
  packageDirName: string;
  packageRoot: string;
  outputPath: string;
  framePath: string;
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  hasAudio: boolean;
  bytes: number;
  receiptId: string;
  qualityAtMs: number;
  gates: { instantiation: "passed"; visual: "declared-manifest"; poster: "passed"; typography: "passed" };
  batchSource: boolean;
  poster: { path: string; width: number; height: number; edgePixels: number; edgeRatio: number; blank: false };
  typography: {
    bundledFamilies: string[];
    hostGenericOnlyLayers: number;
    fontAssetRefs: string[];
    fontAssetBytes: number;
  };
  qualityManifestPath: string;
  dataRowCount?: number;
  dataRowId?: string;
}

interface ProductTemplateFailure {
  packageDirName: string;
  code: string;
  message: string;
}

/**
 * Render and prove one template family. Throws `ProofGateError` on any gate failure so the caller
 * can record it and keep proving the remaining families (a single broken template must not hide
 * the state of the other fourteen).
 */
async function proveTemplate(packageDirName: string): Promise<ProductTemplateProof> {
  const sourcePackageRoot = join(sourcePackRoot, packageDirName);
  const proofPackageRoot = join(proofPackagesRoot, packageDirName);
  await cp(sourcePackageRoot, proofPackageRoot, { recursive: true });
  const materialized = await materializeProofPackage(proofPackageRoot, packageDirName);
  const motionPath = join(proofPackageRoot, "motion.json");
  const motion = materialized.motion;
  const width = readPositiveNumber(readObjectField(motion, "width", "motion.width"), "motion.width");
  const height = readPositiveNumber(readObjectField(motion, "height", "motion.height"), "motion.height");
  const durationMs = readPositiveNumber(readObjectField(motion, "durationMs", "motion.durationMs"), "motion.durationMs");
  const fps = fullDuration
    ? readPositiveNumber(readObjectField(motion, "fps", "motion.fps"), "motion.fps")
    : proofFps;
  motion.durationMs = durationMs;
  motion.fps = fps;
  patchAudioLayerDurations(motion, durationMs);
  await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");

  // Final instantiation gate on the exact bytes handed to the renderer.
  assertTokenFree(packageDirName, "rendered motion document", motion);
  // Static gates run before the render so a template that is already provably broken fails in
  // seconds instead of after a full encode.
  const typography = await proveTypography(packageDirName, proofPackageRoot, motion, materialized.manifestAssets);
  const poster = await proveShippedPoster(packageDirName, sourcePackageRoot, materialized.posterRef, width, height);

  const outputPath = join(rendersRoot, `${packageDirName}.mp4`);
  const render = await runCli([
    "render",
    proofPackageRoot,
    "--lane",
    "ffmpeg",
    "--out",
    outputPath,
    "--min-unique-frames",
    "2",
    "--quality-manifest",
    materialized.qualityManifestPath
  ], { scratchRoot: join(framesRoot, packageDirName) });
  if (!render.ok) {
    throw new ProofGateError("render_failed", `${packageDirName} render failed: ${JSON.stringify(render, null, 2)}`);
  }
  await stat(outputPath);
  const mp4 = await assertMp4Container(outputPath, `${packageDirName} render`);

  const renderReceipt = readRecord(readObjectField(render, "receipt", `${packageDirName}.render.receipt`), `${packageDirName}.render.receipt`);
  // Acceptance follows the shared contract rule in `scripts/render-smoke-status.ts` rather than a
  // hard-coded `passed`. Ten of the fifteen shipped templates animate in and then HOLD — a lower
  // third, a stat card and a tutorial overlay are supposed to settle and stay readable — so the
  // motion-density measurement reports them as substantially static, and since the
  // unified status rule the render receipt escalates on it. That advisory is declared here by
  // anchored pattern; ANY other warning still fails this proof.
  assertReceiptSucceeded(renderReceipt, {
    label: `${packageDirName} render`,
    expectedAdvisories: [MOTION_DENSITY_ADVISORY]
  });
  const renderOutput = readRecord(readObjectField(render, "output", `${packageDirName}.render.output`), `${packageDirName}.render.output`);
  assert.equal(readObjectField(renderOutput, "width", `${packageDirName}.render.output.width`), width);
  assert.equal(readObjectField(renderOutput, "height", `${packageDirName}.render.output.height`), height);

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
    "--preview-package",
    proofPackageRoot,
    "--preview-lane",
    "browser",
    "--max-changed-pixels",
    String(width * height),
    "--max-mean-diff",
    "8",
    "--min-psnr-db",
    "28",
    ...(hasAudio ? ["--expect-audio", "--min-audio-peak-db", "-45", "--min-audio-mean-db", "-55"] : [])
  ], { scratchRoot: join(qualityRoot, packageDirName) });
  if (!quality.ok) {
    throw new ProofGateError("quality_check_failed", `${packageDirName} quality-check failed: ${JSON.stringify(quality, null, 2)}`);
  }
  const media = readRecord(readObjectField(quality, "media", `${packageDirName}.quality.media`), `${packageDirName}.quality.media`);
  if (hasAudio) {
    // The success-status invariant matters on exactly this family: a successful audio
    // deliverable was reported `status: "warning"` because the frame lane's expected audio handoff
    // and routine loudnorm chatter rode the array that derives status. Neither of those escalates
    // any more — the handoff is structured evidence and the chatter is chatter — and the status
    // asserted above accepts only a warning this proof DECLARED; these gates prove the artifact
    // behind that status is real —
    // both streams present, both the same length as the container, and the frame lane's handoff
    // resolved against the delivered audio rather than assumed.
    const audio = readRecord(readObjectField(media, "audio", `${packageDirName}.quality.media.audio`), `${packageDirName}.quality.media.audio`);
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
    const receiptOutput = readRecord(readObjectField(renderReceipt, "output", `${packageDirName}.render.receipt.output`), `${packageDirName}.render.receipt.output`);
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

  return {
    packageDirName,
    packageRoot: proofPackageRoot,
    outputPath,
    framePath: readString(readObjectField(quality, "framePath", `${packageDirName}.quality.framePath`), `${packageDirName}.quality.framePath`),
    width,
    height,
    durationMs,
    fps,
    hasAudio,
    ...(materialized.dataRowId ? { dataRowId: materialized.dataRowId } : {}),
    ...(materialized.dataRowCount ? { dataRowCount: materialized.dataRowCount } : {}),
    bytes: mp4.bytes,
    receiptId: String(readObjectField(renderReceipt, "id", `${packageDirName}.render.receipt.id`)),
    qualityAtMs,
    gates: { instantiation: "passed", visual: "declared-manifest", poster: "passed", typography: "passed" },
    batchSource: materialized.batchSource,
    poster,
    typography,
    qualityManifestPath: materialized.qualityManifestPath
  };
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
  if (!verdict.ok) {
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
  if (!inspected.ok) {
    throw new ProofGateError("unreadable_preview_poster", `${packageDirName} poster ${posterRef} is not a readable PNG: ${inspected.message}`);
  }
  const verdict = evaluatePosterGate(
    { width: inspected.width, height: inspected.height, blank: inspected.blank, edgeRatio: inspected.edges.ratio },
    width,
    height
  );
  if (!verdict.ok) {
    throw new ProofGateError(
      verdict.code,
      `${packageDirName} ${verdict.reason}; regenerate the poster from a real instantiated render.`
    );
  }
  return {
    path: posterPath,
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
    qualityManifestPath,
    posterRef,
    batchSource: shippedTokens.length > 0,
    manifestAssets: assetRefsOf(firstJob.manifest),
    dataRowCount: jobs.length,
    dataRowId: firstJob.row.id
  };
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
    const imageHref = escapeXml(relative(dirname(path), proof.framePath).replaceAll("\\", "/"));
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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${svg}\n`, "utf8");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
