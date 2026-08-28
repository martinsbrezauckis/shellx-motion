import { OutputDirectoryReservation, canonicalJson, inspectPngFile, type MotionPackage } from "@shellx-motion/core";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createGpuFrameRenderSession, type GpuFrameRenderSession } from "./gpu-frame-renderer";
import { renderMotionGpuPointsPreview } from "./gpu-points-preview";
import type { GpuBrowserSessionIdentity } from "./gpu-browser-session-identity";
import type { GpuPreviewFrame, GpuPreviewResult } from "./gpu-preview-session-types";
import {
  assertSameCleanSource,
  assertSameGpuQualificationSourceBundle,
  collectGpuQualificationSourceIdentity,
  createGpuQualificationSourceBundle,
  GPU_QUALIFICATION_SOURCE_BUNDLE_NAME,
  readGpuQualificationSourceBundle,
  type GpuQualificationSourceBundle,
  type GpuQualificationSourceIdentity
} from "./gpu-qualification-source-bundle.test-support";
const QUALIFICATION_PNG_NAME = "points-preview.png";
const MOTION_RECEIPT_NAME = "motion-preview.receipt.json";
const QUALIFICATION_EVIDENCE_NAME = "gpu-points-qualification.json";
const QUALIFICATION_SESSION_ID_RX = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Raw, private input for Release Studio's release-specific GPU evidence composer. */
export const GPU_POINTS_QUALIFICATION_EVIDENCE_SCHEMA = "shellx-motion/gpu-points-qualification-evidence@2" as const;
export const GPU_POINTS_QUALIFICATION_SESSION_SCHEMA = "shellx-motion/windows-gpu-session@1" as const;
export { assertSameCleanSource, collectGpuQualificationSourceIdentity } from "./gpu-qualification-source-bundle.test-support";
export type { GpuQualificationSourceIdentity } from "./gpu-qualification-source-bundle.test-support";

export interface GpuPointsQualificationSession {
  readonly schema: typeof GPU_POINTS_QUALIFICATION_SESSION_SCHEMA;
  /** Random per-qualification identifier binding source, browser, GPU, and PNG evidence. */
  readonly id: string;
  readonly sourceBundle: GpuQualificationSourceBundle;
}

export interface GpuPointsQualificationEvidence {
  readonly schema: typeof GPU_POINTS_QUALIFICATION_EVIDENCE_SCHEMA;
  readonly generatedAt: string;
  /** This source/hardware oracle is intentionally Windows-only, never installed-candidate proof. */
  readonly host: { readonly platform: "win32" };
  /** Both snapshots must be clean and byte-identical. */
  readonly source: {
    readonly before: GpuQualificationSourceIdentity;
    readonly after: GpuQualificationSourceIdentity;
  };
  readonly session: GpuPointsQualificationSession;
  /** Browser policy and identity observed on the Chromium session that rendered this PNG. */
  readonly browser: {
    readonly identity: Pick<GpuBrowserSessionIdentity, "name" | "version" | "userAgent" | "executableSha256">;
    readonly source: GpuBrowserSessionIdentity["source"];
    readonly args: readonly string[];
    readonly ignoredDefaultArgs: readonly string[];
    readonly sandbox: GpuBrowserSessionIdentity["sandbox"];
  };
  /** The hardware adapter evidence emitted with this exact rendered frame. */
  readonly gpu: GpuPreviewFrame["gpu"];
  readonly pointsPreview: {
    readonly artifact: { readonly path: typeof QUALIFICATION_PNG_NAME; readonly mediaType: "image/png"; readonly bytes: number; readonly sha256: string; };
    readonly png: { readonly width: number; readonly height: number; readonly transparentPixels: number; readonly nonTransparentPixels: number; readonly opaquePixels: number; };
  };
  readonly motionPreviewReceipt: { readonly path: typeof MOTION_RECEIPT_NAME; readonly mediaType: "application/json"; readonly bytes: number; readonly sha256: string; };
}

/** Retained Core authority for the caller-selected evidence root. */
export interface GpuPrivateQualificationOutputRoot {
  readonly path: string;
  /** Revalidates canonical route, identity, and native write authority before each evidence write. */
  assertCurrent(): Promise<void>;
}

export type GpuPointsQualificationEvidenceResult =
  | {
      ok: true;
      preview: Extract<GpuPreviewResult, { ok: true }>;
      evidence: GpuPointsQualificationEvidence;
      outputRoot: string;
      evidencePath: string;
    }
  | {
      ok: false;
      error: { code: "gpu_qualification_source_refused" | "gpu_qualification_evidence_refused"; message: string };
    };

type GpuQualificationFailureCode = Extract<GpuPointsQualificationEvidenceResult, { ok: false }>["error"]["code"];

export interface GpuPointsQualificationEvidenceOptions {
  /** Repository whose immutable release identity must bind this hardware result. */
  readonly sourceDir: string;
  /** Pre-created, empty private directory outside `sourceDir`; it receives only qualification evidence. */
  readonly outputRoot: string;
  readonly atMs?: number;
  readonly timeoutMs?: number;
}

/**
 * Renders the fixed points preview and writes a raw, private qualification
 * bundle. It deliberately has no Release Studio schema or path knowledge.
 */
export async function renderGpuPointsQualificationEvidence(
  pkg: MotionPackage,
  options: GpuPointsQualificationEvidenceOptions
): Promise<GpuPointsQualificationEvidenceResult> {
  let sourceBefore: GpuQualificationSourceIdentity;
  let outputRoot: GpuPrivateQualificationOutputRoot;
  let sourceBundle: GpuQualificationSourceBundle;
  let session: GpuPointsQualificationSession;
  try {
    assertWindowsGpuQualificationHost();
    sourceBefore = await collectGpuQualificationSourceIdentity(options.sourceDir);
    outputRoot = await preparePrivateQualificationOutputRoot(options.outputRoot, options.sourceDir);
    sourceBundle = await createGpuQualificationSourceBundle(options.sourceDir, sourceBefore, outputRoot);
    session = Object.freeze({ schema: GPU_POINTS_QUALIFICATION_SESSION_SCHEMA, id: randomUUID(), sourceBundle });
  } catch (error) {
    return qualificationFailure("gpu_qualification_source_refused", error);
  }

  let browserIdentity: GpuBrowserSessionIdentity | undefined;
  const openRuntime: typeof createGpuFrameRenderSession = async (images, fonts, sessionOptions) => {
    const opened = await createGpuFrameRenderSession(images, fonts, sessionOptions);
    if (opened.ok) browserIdentity = opened.session.browserIdentity;
    return opened;
  };
  try {
    // The preview itself publishes the PNG; do not enter that renderer-owned
    // write path after the retained caller root has changed.
    await outputRoot.assertCurrent();
  } catch (error) {
    return qualificationFailure("gpu_qualification_evidence_refused", error);
  }
  const preview = await renderMotionGpuPointsPreview(pkg, {
    atMs: options.atMs ?? 500,
    outDir: outputRoot.path,
    outputPath: join(outputRoot.path, QUALIFICATION_PNG_NAME),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    sessionOptions: { openRuntime }
  });
  if (!preview.ok) {
    return qualificationFailure("gpu_qualification_evidence_refused", new Error(`The GPU points preview did not complete: ${preview.error.message}`));
  }
  if (!browserIdentity) {
    return qualificationFailure("gpu_qualification_evidence_refused", new Error("The GPU points preview did not expose an exact browser-session identity."));
  }

  let sourceAfter: GpuQualificationSourceIdentity;
  try {
    sourceAfter = await collectGpuQualificationSourceIdentity(options.sourceDir);
    assertSameCleanSource(sourceBefore, sourceAfter);
    const sourceBundleAfter = await readGpuQualificationSourceBundle(sourceAfter, outputRoot);
    assertSameGpuQualificationSourceBundle(sourceBundle, sourceBundleAfter);
    const evidence = await writeGpuPointsQualificationEvidence({
      outputRoot,
      sourceBefore,
      sourceAfter,
      sourceBundle: sourceBundleAfter,
      session,
      browserIdentity,
      preview,
      generatedAt: preview.receipt.createdAt
    });
    return { ok: true, preview, evidence: evidence.evidence, outputRoot: outputRoot.path, evidencePath: evidence.path };
  } catch (error) {
    return qualificationFailure("gpu_qualification_source_refused", error);
  }
}

/** Writes the raw Motion evidence that the Release Studio-owned composer will later consume. */
export async function writeGpuPointsQualificationEvidence(input: {
  outputRoot: GpuPrivateQualificationOutputRoot;
  /** Test-only override; source/hardware qualification defaults to the actual host platform. */
  platform?: NodeJS.Platform;
  sourceBefore: GpuQualificationSourceIdentity;
  sourceAfter: GpuQualificationSourceIdentity;
  sourceBundle: GpuQualificationSourceBundle;
  session: GpuPointsQualificationSession;
  browserIdentity: GpuBrowserSessionIdentity;
  preview: Extract<GpuPreviewResult, { ok: true }>;
  generatedAt: string;
}): Promise<{ path: string; evidence: GpuPointsQualificationEvidence }> {
  assertWindowsGpuQualificationHost(input.platform ?? process.platform);
  assertSameCleanSource(input.sourceBefore, input.sourceAfter);
  assertGpuPointsQualificationSession(input.session, input.sourceBefore);
  assertSameGpuQualificationSourceBundle(input.session.sourceBundle, input.sourceBundle);
  if (input.generatedAt !== input.preview.receipt.createdAt) throw new Error("GPU qualification generatedAt must exactly match the unchanged Motion preview receipt timestamp.");
  if (!isIsoTimestamp(input.generatedAt)) throw new Error("GPU qualification evidence requires an ISO generatedAt timestamp.");
  const root = input.outputRoot.path;
  await input.outputRoot.assertCurrent();
  const persistedSourceBundle = await readGpuQualificationSourceBundle(input.sourceBefore, input.outputRoot);
  assertSameGpuQualificationSourceBundle(input.sourceBundle, persistedSourceBundle);
  const pngPath = await privateArtifactPath(root, QUALIFICATION_PNG_NAME);
  if (resolve(input.preview.frame.path) !== pngPath) throw new Error("GPU qualification preview PNG did not publish at the caller-selected private output root.");
  const pngStats = await inspectPngFile(pngPath);
  if (!pngStats.ok || pngStats.width !== 96 || pngStats.height !== 64 || pngStats.blank || pngStats.transparentPixels === 0 || pngStats.nonTransparentPixels === 0 || pngStats.nonTransparentPixels <= pngStats.opaquePixels) {
    throw new Error("GPU qualification preview must be a nonblank 96x64 PNG with transparent background and translucent points.");
  }
  const pngFacts = await stat(pngPath);
  if (!pngFacts.isFile() || pngFacts.isSymbolicLink() || pngFacts.size < 1 || pngStats.sha256 !== input.preview.frame.sha256) {
    throw new Error("GPU qualification preview PNG bytes do not match the rendered frame evidence.");
  }

  const receiptPath = join(root, MOTION_RECEIPT_NAME);
  const receiptText = `${canonicalJson(input.preview.receipt)}\n`;
  await input.outputRoot.assertCurrent();
  await writeFile(receiptPath, receiptText, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const persistedReceipt = await readFile(receiptPath);
  if (persistedReceipt.toString("utf8") !== receiptText) throw new Error("GPU qualification could not re-read the immutable Motion preview receipt.");
  const receiptSha256 = sha256(persistedReceipt);

  const evidence: GpuPointsQualificationEvidence = Object.freeze({
    schema: GPU_POINTS_QUALIFICATION_EVIDENCE_SCHEMA,
    generatedAt: input.generatedAt,
    host: Object.freeze({ platform: "win32" as const }),
    source: Object.freeze({ before: input.sourceBefore, after: input.sourceAfter }),
    session: input.session,
    browser: Object.freeze({
      identity: Object.freeze({
        name: input.browserIdentity.name,
        version: input.browserIdentity.version,
        userAgent: input.browserIdentity.userAgent,
        executableSha256: input.browserIdentity.executableSha256
      }),
      source: input.browserIdentity.source,
      args: Object.freeze([...input.browserIdentity.args]),
      ignoredDefaultArgs: Object.freeze([...input.browserIdentity.ignoredDefaultArgs]),
      sandbox: input.browserIdentity.sandbox
    }),
    gpu: input.preview.frame.gpu,
    pointsPreview: Object.freeze({
      artifact: Object.freeze({ path: QUALIFICATION_PNG_NAME, mediaType: "image/png" as const, bytes: pngFacts.size, sha256: input.preview.frame.sha256 }),
      png: Object.freeze({ width: pngStats.width, height: pngStats.height, transparentPixels: pngStats.transparentPixels, nonTransparentPixels: pngStats.nonTransparentPixels, opaquePixels: pngStats.opaquePixels })
    }),
    motionPreviewReceipt: Object.freeze({ path: MOTION_RECEIPT_NAME, mediaType: "application/json" as const, bytes: persistedReceipt.byteLength, sha256: receiptSha256 })
  });
  const path = join(root, QUALIFICATION_EVIDENCE_NAME);
  const evidenceText = `${canonicalJson(evidence)}\n`;
  await input.outputRoot.assertCurrent();
  await writeFile(path, evidenceText, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await input.outputRoot.assertCurrent();
  if (await readFile(path, "utf8") !== evidenceText) throw new Error("GPU qualification could not re-read its immutable evidence document.");
  const inventory = (await readdir(root)).sort();
  const expectedInventory = [GPU_QUALIFICATION_SOURCE_BUNDLE_NAME, QUALIFICATION_PNG_NAME, MOTION_RECEIPT_NAME, QUALIFICATION_EVIDENCE_NAME].sort();
  if (inventory.length !== expectedInventory.length || inventory.some((name, index) => name !== expectedInventory[index])) {
    throw new Error("GPU qualification output root must contain exactly the four bound raw evidence artifacts.");
  }
  return { path, evidence };
}

function assertGpuPointsQualificationSession(session: GpuPointsQualificationSession, source: GpuQualificationSourceIdentity): void {
  if (session.schema !== GPU_POINTS_QUALIFICATION_SESSION_SCHEMA || !QUALIFICATION_SESSION_ID_RX.test(session.id)) {
    throw new Error("GPU qualification evidence requires a random Windows GPU session schema and identifier.");
  }
  assertSameGpuQualificationSourceBundle(session.sourceBundle, session.sourceBundle);
  if (session.sourceBundle.gitCommit !== source.gitCommit || session.sourceBundle.gitTree !== source.gitTree || session.sourceBundle.version !== source.version) {
    throw new Error("GPU qualification session source.bundle does not match the clean candidate source identity.");
  }
}

/** Refuses before source.bundle, PNG, receipt, or evidence writes on any non-Windows host. */
export function assertWindowsGpuQualificationHost(platform: NodeJS.Platform = process.platform): asserts platform is "win32" {
  if (platform !== "win32") throw new Error("GPU qualification source/hardware evidence requires a native Windows host; it is not installed-candidate proof.");
}

/**
 * Retains an already-existing empty private root before the native render.
 * This admission never creates a source-tree child on refusal.
 */
export async function preparePrivateQualificationOutputRoot(outputRoot: string, sourceDir: string): Promise<GpuPrivateQualificationOutputRoot> {
  if (!outputRoot.trim() || !isAbsolute(outputRoot)) throw new Error("GPU qualification outputRoot must be an absolute caller-selected private directory.");
  const root = resolve(outputRoot);
  const [canonicalRoot, canonicalSource] = await Promise.all([canonicalExistingPrivateOutputRoot(root), realpath(resolve(sourceDir))]);
  if (isInside(canonicalSource, canonicalRoot)) throw new Error("GPU qualification outputRoot must be outside the source tree so evidence cannot make the candidate dirty.");
  const reservation = await OutputDirectoryReservation.acquire(canonicalRoot, {
    requireExisting: true,
    requirePrivate: true,
    requireExclusiveChildAuthority: true
  });
  await assertOwner0700(canonicalRoot);
  if ((await readdir(canonicalRoot)).length !== 0) {
    throw new Error("GPU qualification outputRoot must be empty before native evidence capture.");
  }
  return Object.freeze({
    path: canonicalRoot,
    assertCurrent: async () => {
      await reservation.assertCurrent();
      await assertOwner0700(canonicalRoot);
    }
  });
}

async function canonicalExistingPrivateOutputRoot(outputRoot: string): Promise<string> {
  const root = resolve(outputRoot);
  const facts = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("GPU qualification outputRoot must already exist as a new empty private directory.");
    throw error;
  });
  if (!facts.isDirectory() || facts.isSymbolicLink()) throw new Error("GPU qualification outputRoot must be a regular non-symlink directory.");
  const canonical = await realpath(root);
  if (canonical !== root) throw new Error("GPU qualification outputRoot must be a canonical non-symlink directory.");
  return canonical;
}

async function privateArtifactPath(root: string, name: string): Promise<string> {
  const path = join(root, name);
  const facts = await lstat(path);
  if (!facts.isFile() || facts.isSymbolicLink() || !isInside(root, await realpath(path))) throw new Error("GPU qualification evidence artifact is missing or escapes its private output root.");
  return path;
}

async function assertOwner0700(root: string): Promise<void> {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const facts = await lstat(root);
  if (!facts.isDirectory() || facts.isSymbolicLink() || facts.uid !== process.getuid() || (Number(facts.mode) & 0o777) !== 0o700) {
    throw new Error("GPU qualification outputRoot must be an active-user-owned POSIX 0700 directory.");
  }
}

function qualificationFailure(code: GpuQualificationFailureCode, error: unknown): Extract<GpuPointsQualificationEvidenceResult, { ok: false }> {
  return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } };
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
