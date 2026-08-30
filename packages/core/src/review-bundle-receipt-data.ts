import { readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { compareCodeUnits } from "./canonical-json";
import { resolvePackageAsset } from "./package";
import { loadedPackageInputHashes } from "./package-loaded-inputs";
import { hashFile } from "./receipts";
import { readBoundedStableFile } from "./stable-file-read";
import {
  assertBoundFilesystemReceiptEntry,
  bindLoadedReviewBundleReceipt,
  boundFilesystemReceipt,
  MAX_REVIEW_BUNDLE_RECEIPT_BYTES,
  readReviewBundleReceipt,
  recheckBoundFilesystemReceipt,
  reviewReceiptRelativePath
} from "./review-bundle-stable-receipts";
import type { MotionPackage, OperationReceipt, ReceiptArtifact } from "./types";
import type { ReviewBundleReceiptEntry } from "./review-bundle-types";

export { MAX_REVIEW_BUNDLE_RECEIPT_BYTES } from "./review-bundle-stable-receipts";

export async function readReviewBundleReceiptEntries(receiptsRoot: string): Promise<ReviewBundleReceiptEntry[]> {
  const root = resolve(receiptsRoot);
  const canonicalRoot = await realpath(root);
  const paths = await listJsonFiles(root);
  const entries: ReviewBundleReceiptEntry[] = [];
  for (const path of paths) {
    const source = await readBoundedStableFile(path, {
      label: "Review bundle receipt",
      maxBytes: MAX_REVIEW_BUNDLE_RECEIPT_BYTES,
      withinRoot: canonicalRoot,
      captureIdentity: true
    });
    const receipt = readReviewBundleReceipt(JSON.parse(source.bytes.toString("utf8")));
    if (receipt) {
      const entry = {
        path: source.canonicalPath,
        relativePath: reviewReceiptRelativePath(canonicalRoot, source.canonicalPath),
        receipt
      } satisfies ReviewBundleReceiptEntry;
      bindLoadedReviewBundleReceipt(entry, canonicalRoot, source);
      entries.push(entry);
    }
  }
  // Code-unit order, not localeCompare: this ordering IS the review bundle's identity. It fixes
  // the order of `copiedArtifacts`, whose sha256 list is hashed into the receipt id below, so a
  // locale-sensitive comparator here gave the same bundle two different ids on two machines.
  return entries.sort((a, b) => compareCodeUnits(a.path ?? "", b.path ?? ""));
}

export async function reviewBundleInputHashes(
  pkg: MotionPackage | undefined,
  receipts: ReviewBundleReceiptEntry[],
  options: { useLoadedPackageHashes?: boolean; useRetainedReceiptHashes?: boolean } = {}
): Promise<Record<string, string>> {
  const inputHashes: Record<string, string> = {};
  if (pkg) {
    const loaded = options.useLoadedPackageHashes !== false ? loadedPackageInputHashes(pkg) : null;
    if (loaded?.["manifest.json"] && loaded[pkg.manifest.motion]) {
      inputHashes["manifest.json"] = loaded["manifest.json"];
      inputHashes[pkg.manifest.motion] = loaded[pkg.manifest.motion];
      if (pkg.manifest.template && loaded[pkg.manifest.template]) inputHashes[pkg.manifest.template] = loaded[pkg.manifest.template];
    } else {
      inputHashes["manifest.json"] = await hashFile(resolvePackageAsset(pkg, "manifest.json"));
      inputHashes[pkg.manifest.motion] = await hashFile(resolvePackageAsset(pkg, pkg.manifest.motion));
      if (pkg.manifest.template) inputHashes[pkg.manifest.template] = await hashFile(resolvePackageAsset(pkg, pkg.manifest.template));
    }
  }
  for (const entry of receipts) {
    const retained = boundFilesystemReceipt(entry);
    if (retained) assertBoundFilesystemReceiptEntry(entry, retained);
    const path = retained?.path ?? entry.path;
    if (!path) continue;
    const key = `receipt:${retained?.relativePath ?? entry.relativePath ?? basename(path)}`;
    if (Object.hasOwn(inputHashes, key)) {
      throw new Error(`Duplicate review bundle receipt input identity: ${key}`);
    }
    if (options.useRetainedReceiptHashes !== false && retained) {
      inputHashes[key] = retained.sha256;
    } else if (retained) {
      inputHashes[key] = await recheckBoundFilesystemReceipt(retained);
    } else {
      inputHashes[key] = await hashFile(path);
    }
  }
  return inputHashes;
}

/**
 * A receipt artifact together with the producer identity carried by its matching output path.
 *
 * `ReceiptArtifact` deliberately stays a presentation/reference shape. Renderer receipts bind
 * their final bytes in `output`, so the review-bundle boundary carries that identity separately
 * rather than pretending every historical artifact declaration had one.
 */
export interface ReviewBundleArtifactCandidate extends ReceiptArtifact {
  expectedProducerSha256?: string;
  expectedProducerByteLength?: number;
}

export function artifactCandidates(receipt: OperationReceipt): ReviewBundleArtifactCandidate[] {
  const candidates: ReviewBundleArtifactCandidate[] = Array.isArray(receipt.artifacts)
    ? receipt.artifacts.map((artifact) => ({ ...artifact }))
    : [];
  const output = recordOf(receipt.output);
  const outputPath = typeof output?.path === "string" ? output.path : typeof output?.outputPath === "string" ? output.outputPath : null;
  if (outputPath) {
    const producerIdentity = outputArtifactProducerIdentity(output);
    const matchingOutputCandidates = candidates.filter((artifact) => artifact.path && sameLocalPath(artifact.path, outputPath));
    if (matchingOutputCandidates.length > 0) {
      for (const candidate of matchingOutputCandidates) Object.assign(candidate, producerIdentity);
    } else {
      candidates.push({
        role: "receipt_output",
        path: outputPath,
        status: "available",
        mediaType: mediaTypeForPath(outputPath),
        primary: candidates.length === 0,
        ...producerIdentity
      });
    }
  }
  return candidates;
}

function outputArtifactProducerIdentity(output: Record<string, unknown> | null): Pick<ReviewBundleArtifactCandidate, "expectedProducerSha256" | "expectedProducerByteLength"> {
  const sha256 = output?.sha256;
  const byteLength = output?.byteLength;
  if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256))) {
    throw new Error("Review bundle receipt output sha256 must be a lowercase SHA-256 digest when present.");
  }
  if (byteLength !== undefined && (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 0)) {
    throw new Error("Review bundle receipt output byteLength must be a non-negative safe integer when present.");
  }
  return {
    ...(typeof sha256 === "string" ? { expectedProducerSha256: sha256 } : {}),
    ...(typeof byteLength === "number" ? { expectedProducerByteLength: byteLength } : {})
  };
}

export function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

export function readStringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function hasProtocolScheme(path: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(path)) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path);
}

export function mediaTypeForPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".html")) return "text/html";
  return undefined;
}

async function listJsonFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return listJsonFiles(path);
    return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
  }));
  return files.flat();
}

function sameLocalPath(left: string, right: string): boolean {
  if (hasProtocolScheme(left) || hasProtocolScheme(right)) return false;
  return resolve(left) === resolve(right);
}
