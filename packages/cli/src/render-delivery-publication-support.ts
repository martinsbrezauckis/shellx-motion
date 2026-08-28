/** Receipt-bound render delivery helpers kept outside the CLI command dispatcher. */
import { lstat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  acquireDerivedOutputPublication,
  hashFile,
  prepareOutputDir,
  type OperationReceipt,
  type ReceiptArtifact
} from "@shellx-motion/core";
import { renderMotionBrowserFrame } from "@shellx-motion/renderer-browser";
import { redactAbortedFinalOutputEvidence, type MotionExportPreset } from "@shellx-motion/renderer-ffmpeg";
import {
  dedupeReceiptArtifacts,
  renderReceiptPathForOutput,
  writeRenderReceiptFile,
  type RenderReceiptFinalizeResult
} from "./render-receipt-file.js";
import { publishGovernedDirectoryBundle } from "./governed-directory-delivery";

export type RenderDeliveryCliResult = Record<string, unknown> & { ok: boolean; command?: string };

/** Preserve CLI empty/force semantics, then bind the exact empty placeholder to private staging. */
export async function prepareImageSequencePublication(outputPath: string, force: boolean) {
  const guard = await prepareOutputDir(outputPath, { force });
  if (!guard.ok) return { ok: false as const, error: guard.error };
  try {
    const publication = await acquireDerivedOutputPublication({ outputPath, kind: "directory", replaceEmptyDirectory: true });
    return { ok: true as const, publication };
  } catch (error) {
    return {
      ok: false as const,
      error: { code: (error as { code?: string }).code ?? "derived_output_publish_failed", message: error instanceof Error ? error.message : String(error) }
    };
  }
}

/** Write a durable failed receipt only after the caller withheld the primary delivery. */
export async function renderQualityManifestFailure(input: {
  packageId: string;
  lane: "ffmpeg" | "image-sequence" | "image";
  frameLane: string;
  preset: MotionExportPreset;
  outputPath: string;
  receipt: OperationReceipt;
  frameReceipt?: unknown;
  frames?: { dir: string; count: number };
  qualityManifestPath: string;
  qualityCheck: RenderDeliveryCliResult;
  force: boolean;
  extra?: Record<string, unknown>;
}): Promise<RenderDeliveryCliResult> {
  const qualityError = record(input.qualityCheck.error);
  const failure = {
    code: typeof qualityError?.code === "string" ? qualityError.code : "quality_check_failed",
    message: typeof qualityError?.message === "string"
      ? qualityError.message
      : "Final render quality manifest check failed."
  };
  redactAbortedFinalOutputEvidence(input.receipt, failure);
  const frameReceipt = operationReceipt(input.frameReceipt);
  if (frameReceipt) redactAbortedFinalOutputEvidence(frameReceipt, failure);
  const receiptPath = await writeRenderReceiptFile(
    input.receipt,
    renderReceiptPathForOutput(input.packageId, input.outputPath, input.lane),
    { force: input.force }
  );
  return {
    ok: false,
    command: "render",
    receiptPath,
    lane: input.lane,
    frameLane: input.frameLane,
    preset: input.preset,
    outputPath: input.outputPath,
    receipt: input.receipt,
    ...(frameReceipt ? { frameReceipt } : input.frameReceipt !== undefined ? { frameReceipt: input.frameReceipt } : {}),
    ...(input.frames ? { frames: input.frames } : {}),
    qualityManifestPath: input.qualityManifestPath,
    qualityCheck: input.qualityCheck,
    error: failure,
    warnings: input.receipt.warnings,
    ...(input.extra ?? {})
  };
}

/** Replace the private stage spelling only after its receipt hash was verified against that stage. */
export function remapReceiptOutputPath(receipt: OperationReceipt, stagedPath: string, outputPath: string): void {
  const output = record(receipt.output);
  if (output) receipt.output = { ...output, path: outputPath };
  receipt.artifacts = receipt.artifacts?.map((artifact) =>
    resolve(artifact.path) === resolve(stagedPath) ? { ...artifact, path: outputPath } : artifact
  );
}

/** Replace only absolute paths inside a private publication root with their public spelling. */
export function remapPrivatePublicationResultPaths<T>(value: T, stagedRoot: string, outputRoot: string): T {
  const privateRoot = resolve(stagedRoot);
  const publicRoot = resolve(outputRoot);
  const remap = (candidate: unknown): unknown => {
    if (typeof candidate === "string" && isAbsolute(candidate)) {
      const normalized = resolve(candidate);
      const suffix = relative(privateRoot, normalized);
      if (suffix === "") return publicRoot;
      if (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)) return join(publicRoot, suffix);
      return candidate;
    }
    if (Array.isArray(candidate)) return candidate.map(remap);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(Object.entries(candidate as Record<string, unknown>).map(([key, entry]) => [key, remap(entry)]));
    }
    return candidate;
  };
  return remap(value) as T;
}

/** Browser HTML evidence is private until the paired publisher reserves and commits it. */
export function availableRendererArtifacts(
  frame: Awaited<ReturnType<typeof renderMotionBrowserFrame>>,
  primaryStagePath: string
): ReceiptArtifact[] {
  const artifacts = [...(frame.output.artifacts ?? []), ...(frame.receipt.artifacts ?? [])];
  if (artifacts.some((artifact) => artifact.status !== "available")) {
    throw new Error("Browser renderer returned a non-available companion artifact for a successful final delivery.");
  }
  return dedupeReceiptArtifacts(artifacts.filter((artifact) => resolve(artifact.path) !== resolve(primaryStagePath)));
}

/** Return a closed renderer-evidence inventory remapped from a private directory bundle. */
export async function bindDirectoryRendererArtifacts(
  receipt: OperationReceipt,
  artifacts: readonly ReceiptArtifact[],
  stagingDir: string,
  outputDir: string
): Promise<{ artifacts: ReceiptArtifact[]; inventory: string[] }> {
  const remapped: ReceiptArtifact[] = [];
  const inventory: string[] = [];
  const artifactHashes: Record<string, string> = {};
  for (const artifact of dedupeReceiptArtifacts([...artifacts])) {
    if (artifact.status !== "available") throw new Error("Browser renderer returned a non-available companion artifact for a directory delivery.");
    const relativePath = relativeBundleFilePath(stagingDir, artifact.path);
    if (!relativePath) throw new Error("Browser renderer companion artifact escaped the private directory delivery stage.");
    const stagePath = join(resolve(stagingDir), relativePath);
    const facts = await lstat(stagePath);
    if (!facts.isFile() || facts.isSymbolicLink()) throw new Error("Browser renderer companion artifact must remain a regular non-symlink private file.");
    const publicPath = join(resolve(outputDir), relativePath);
    const hash = await hashFile(stagePath);
    remapped.push({ ...artifact, path: publicPath, primary: false });
    inventory.push(relativePath);
    artifactHashes[publicPath] = hash;
    receipt.inputHashes[`renderer-artifact:${relativePath}`] = hash;
    if (artifact.role === "browser_capture_html" && receipt.inputHashes["browser-capture-html"] !== undefined && receipt.inputHashes["browser-capture-html"] !== hash) {
      throw new Error("Browser renderer HTML receipt hash did not match the verified private directory evidence.");
    }
  }
  if (Object.keys(artifactHashes).length > 0) receipt.output = { ...(record(receipt.output) ?? {}), rendererArtifactHashes: artifactHashes };
  return { artifacts: remapped, inventory };
}

export function rebindDirectoryReceiptPaths(receipt: OperationReceipt, stagingDir: string, outputDir: string): void {
  const output = record(receipt.output);
  if (output && typeof output.path === "string" && resolve(output.path) === resolve(stagingDir)) {
    receipt.output = { ...output, path: resolve(outputDir) };
  }
  receipt.artifacts = receipt.artifacts?.map((artifact) => {
    const relativePath = relativeBundleFilePath(stagingDir, artifact.path);
    return relativePath ? { ...artifact, path: join(resolve(outputDir), relativePath) } : artifact;
  });
}

export function relativeBundleFilePath(root: string, path: string): string | undefined {
  const value = relative(resolve(root), resolve(path)).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../") || isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
  return value;
}

export function closedDirectoryBundleInventory(entries: readonly string[]): string[] {
  const normalized = [...new Set(entries)];
  if (normalized.length !== entries.length || normalized.some((entry) => !entry || entry.includes("\\") || entry.startsWith("/") || entry.endsWith("/") || entry.split("/").some((part) => !part || part === "." || part === ".."))) {
    throw new Error("Directory delivery bundle contains an escaped, duplicate, or empty inventory entry.");
  }
  return normalized;
}

/** A failed directory render may retain only its failed receipt; no partial frames are published. */
export async function publishFailedImageSequenceBundle(input: {
  outputPath: string;
  receiptPath: string;
  receipt: OperationReceipt;
}): Promise<string> {
  const publication = await acquireDerivedOutputPublication({
    outputPath: input.outputPath,
    kind: "directory",
    replaceEmptyDirectory: true
  });
  try {
    const receiptRelativePath = relativeBundleFilePath(input.outputPath, input.receiptPath);
    if (!receiptRelativePath) throw new Error("Image-sequence receipt must be a leaf inside the governed output directory.");
    input.receipt.output = { ...(record(input.receipt.output) ?? {}), path: resolve(input.outputPath), delivery: "not_published" };
    input.receipt.artifacts = [{ role: "render_receipt", path: input.receiptPath, status: "available", mediaType: "application/json" }];
    await writeFile(join(publication.stagingPath, receiptRelativePath), `${JSON.stringify(input.receipt, null, 2)}\n`, "utf8");
    const inventory = closedDirectoryBundleInventory([receiptRelativePath]);
    await publishGovernedDirectoryBundle(publication, inventory);
    return input.receiptPath;
  } catch (error) {
    await publication.abort().catch(() => undefined);
    throw error;
  }
}

export function remapFfmpegOutputPath<T extends { args: string[] }>(command: T, stagedPath: string, outputPath: string): T {
  return { ...command, args: command.args.map((arg) => arg === stagedPath ? outputPath : arg) };
}

export function readMinUniqueFrameHashes(raw: string): { minUniqueFrameHashes: number } | null {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? { minUniqueFrameHashes: value } : null;
}

export function workflowCatalogFields(result: RenderReceiptFinalizeResult): Record<string, unknown> {
  return {
    ...(result.workflowCatalogPath ? { workflowCatalogPath: result.workflowCatalogPath } : {}),
    ...(result.workflowDrift ? { workflowDrift: result.workflowDrift } : {}),
    ...(result.receiptPath ? { receiptPath: result.receiptPath } : {}),
    ...(result.artifacts ? { artifacts: result.artifacts } : {})
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function operationReceipt(value: unknown): OperationReceipt | undefined {
  const candidate = record(value);
  return candidate?.schema === "shellx-motion/receipt@1" && typeof candidate.id === "string" && typeof candidate.lane === "string" ? value as OperationReceipt : undefined;
}
