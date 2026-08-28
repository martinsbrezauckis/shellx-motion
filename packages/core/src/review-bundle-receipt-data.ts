import { readdir, realpath } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { compareCodeUnits } from "./canonical-json";
import { resolvePackageAsset } from "./package";
import { loadedPackageInputHashes } from "./package-loaded-inputs";
import { hashFile, readReceiptActor } from "./receipts";
import { readBoundedStableFile } from "./stable-file-read";
import type { MotionPackage, OperationReceipt, ReceiptArtifact } from "./types";
import type { ReviewBundleReceiptEntry } from "./review-bundle-types";

/** Receipts are control-plane inputs, not an unbounded log-ingestion channel. */
export const MAX_REVIEW_BUNDLE_RECEIPT_BYTES = 16 * 1024 * 1024;

// A caller may construct or mutate a ReviewBundleReceiptEntry, so the parsed snapshot authority
// must remain private and identity-bound rather than live on the public object.
const filesystemReceiptHashes = new WeakMap<ReviewBundleReceiptEntry, string>();
const filesystemReceiptRoots = new WeakMap<ReviewBundleReceiptEntry, string>();

export async function readReviewBundleReceiptEntries(receiptsRoot: string): Promise<ReviewBundleReceiptEntry[]> {
  const root = resolve(receiptsRoot);
  const canonicalRoot = await realpath(root);
  const paths = await listJsonFiles(root);
  const entries: ReviewBundleReceiptEntry[] = [];
  for (const path of paths) {
    const source = await readBoundedStableFile(path, {
      label: "Review bundle receipt",
      maxBytes: MAX_REVIEW_BUNDLE_RECEIPT_BYTES,
      withinRoot: canonicalRoot
    });
    const receipt = readOperationReceipt(JSON.parse(source.bytes.toString("utf8")));
    if (receipt) {
      const entry = {
        path,
        relativePath: reviewReceiptRelativePath(root, path),
        receipt
      } satisfies ReviewBundleReceiptEntry;
      filesystemReceiptHashes.set(entry, source.sha256);
      filesystemReceiptRoots.set(entry, canonicalRoot);
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
    if (!entry.path) continue;
    const key = `receipt:${entry.relativePath ?? basename(entry.path)}`;
    const retainedReceiptHash = filesystemReceiptHashes.get(entry);
    const retainedReceiptRoot = filesystemReceiptRoots.get(entry);
    if (options.useRetainedReceiptHashes !== false && retainedReceiptHash) {
      inputHashes[key] = retainedReceiptHash;
    } else if (retainedReceiptHash && retainedReceiptRoot) {
      // Directory-loaded entries must compare their parsed snapshot with a bounded, stable live
      // reread at publication. Direct in-memory entries deliberately keep the historic hashFile
      // behavior below, even when a caller attaches an identically named field.
      inputHashes[key] = (await readBoundedStableFile(entry.path, {
        label: "Review bundle receipt",
        maxBytes: MAX_REVIEW_BUNDLE_RECEIPT_BYTES,
        withinRoot: retainedReceiptRoot
      })).sha256;
    } else {
      inputHashes[key] = await hashFile(entry.path);
    }
  }
  return inputHashes;
}

export function artifactCandidates(receipt: OperationReceipt): ReceiptArtifact[] {
  const candidates = Array.isArray(receipt.artifacts) ? [...receipt.artifacts] : [];
  const output = recordOf(receipt.output);
  const outputPath = typeof output?.path === "string" ? output.path : typeof output?.outputPath === "string" ? output.outputPath : null;
  if (outputPath && !candidates.some((artifact) => artifact.path && sameLocalPath(artifact.path, outputPath))) {
    candidates.push({
      role: "receipt_output",
      path: outputPath,
      status: "available",
      mediaType: mediaTypeForPath(outputPath),
      primary: candidates.length === 0
    });
  }
  return candidates;
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

function readOperationReceipt(value: unknown): OperationReceipt | null {
  const record = recordOf(value);
  if (!record) return null;
  if (record.schema !== "shellx-motion/receipt@1") return null;
  if (typeof record.id !== "string" || typeof record.operation !== "string" || typeof record.packageId !== "string") return null;
  const status = readReceiptStatus(record.status);
  if (!status || typeof record.lane !== "string" || typeof record.createdAt !== "string") return null;
  return {
    schema: "shellx-motion/receipt@1",
    id: record.id,
    operation: record.operation,
    status,
    packageId: record.packageId,
    inputHashes: readStringRecord(record.inputHashes),
    createdAt: record.createdAt,
    lane: record.lane,
    output: record.output,
    ...(Array.isArray(record.artifacts) ? { artifacts: record.artifacts.map(readArtifact).filter((artifact): artifact is ReceiptArtifact => artifact !== null) } : {}),
    warnings: Array.isArray(record.warnings) ? record.warnings.filter((warning): warning is string => typeof warning === "string") : [],
    // Preserve actor attribution through the review-bundle round-trip; a validator that dropped it
    // would strip the "BY WHO" evidence from any receipt copied into a review bundle.
    ...(readReceiptActor(record.actor) ? { actor: readReceiptActor(record.actor) } : {})
  };
}

function readArtifact(value: unknown): ReceiptArtifact | null {
  const record = recordOf(value);
  if (!record || typeof record.role !== "string" || typeof record.path !== "string") return null;
  if (record.status !== "available" && record.status !== "planned" && record.status !== "not_required" && record.status !== "failed") return null;
  return {
    role: record.role,
    path: record.path,
    status: record.status,
    ...(typeof record.label === "string" ? { label: record.label } : {}),
    ...(typeof record.mediaType === "string" ? { mediaType: record.mediaType } : {}),
    ...(typeof record.primary === "boolean" ? { primary: record.primary } : {})
  };
}

function readStringRecord(value: unknown): Record<string, string> {
  const record = recordOf(value);
  if (!record) return {};
  const strings: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") strings[key] = item;
  }
  return strings;
}

function readReceiptStatus(value: unknown): OperationReceipt["status"] | null {
  return value === "passed" || value === "failed" || value === "warning" || value === "not_run" ? value : null;
}

function sameLocalPath(left: string, right: string): boolean {
  if (hasProtocolScheme(left) || hasProtocolScheme(right)) return false;
  return resolve(left) === resolve(right);
}

function reviewReceiptRelativePath(root: string, path: string): string {
  return relative(root, path).split(/[/\\]+/).join("/");
}
