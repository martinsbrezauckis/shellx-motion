import { createWriteStream, constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { canonicalJsonSha256, compareCodeUnits } from "./canonical-json";
import { hashFile, readReceiptActor } from "./receipts";
import { loadMotionPackage, resolvePackageAsset } from "./package";
import { inspectMotionTimeline } from "./timeline-inspect";
import type { MotionPackage, OperationReceipt, ReceiptArtifact } from "./types";

export interface ReviewBundleReceiptEntry {
  path?: string;
  relativePath?: string;
  receipt: OperationReceipt;
}

export interface ReviewBundleCopiedArtifact {
  role: string;
  sourceName: string;
  path: string;
  relativePath: string;
  mediaType?: string;
  primary?: boolean;
  receiptId: string;
  operation: string;
  sha256: string;
}

export interface ReviewBundleOmittedArtifact {
  role: string;
  /**
   * Receipt-declared file name only — never the full host path. The bundle is built to be
   * shared, and the point of omitting the file is that its location was not approved; echoing
   * the absolute path back into the portable HTML/receipt would leak the very host layout the
   * omission exists to protect.
   */
  sourceName: string;
  /**
   * Why the artifact is not in the bundle. Every path out of the copy loop lands on one of these:
   * the ledger's whole purpose is that a reviewer can tell "this render never had evidence" apart
   * from "evidence existed but was withheld", and a `continue` that skips the ledger hands a
   * hostile receipt a way to make an artifact vanish while the bundle still reads as complete.
   *
   * - `outside_approved_roots` — the canonical source sits outside every approved artifact root.
   * - `unreadable_source` — the source could not be resolved, opened, or hashed.
   * - `declared_unavailable` — the receipt itself declared the artifact `planned`, `not_required`
   *   or `failed`, so there are no bytes to ship. Disclosed rather than skipped: those statuses are
   *   receipt-controlled, and silently honouring them let a receipt hide a real artifact.
   * - `non_local_path` — the declared path carries a URL scheme (`file:`, `https:`, ...) instead of
   *   naming a local file. The bundler only ships local files; a scheme is never dereferenced.
   * - `missing_path` — the artifact declared no usable path at all.
   */
  reason:
    | "outside_approved_roots"
    | "unreadable_source"
    | "declared_unavailable"
    | "non_local_path"
    | "missing_path";
  receiptId: string;
  operation: string;
}

interface ReviewQualityGateSummary {
  path?: string;
  status?: string;
  receiptId?: string;
  hostReceiptPath?: string;
  code?: string;
  message?: string;
  rows?: ReviewQualityGateRowSummary[];
}

interface ReviewQualityGateRowSummary {
  rowId?: string;
  packageId?: string;
  path?: string;
  status?: string;
  receiptId?: string;
  hostReceiptPath?: string;
  code?: string;
  message?: string;
}

export interface ReviewBundleResult {
  ok: true;
  packageId: string;
  htmlPath: string;
  receiptPath: string;
  receiptCount: number;
  copiedArtifactCount: number;
  omittedArtifactCount: number;
  qualityGateCount: number;
  failedQualityGateCount: number;
  copiedArtifacts: ReviewBundleCopiedArtifact[];
  omittedArtifacts: ReviewBundleOmittedArtifact[];
  receipt: OperationReceipt;
}

export interface WriteReviewBundleInput {
  packageRoot?: string;
  receiptsRoot?: string;
  receipts?: ReviewBundleReceiptEntry[];
  outDir: string;
  title?: string;
  createdAt?: string;
  copyArtifacts?: boolean;
  /**
   * Extra directories whose files receipts may legitimately reference (for example a render
   * output directory that sits beside, not inside, receiptsRoot). Receipt-referenced artifact
   * paths are only hashed and copied when their canonical path stays inside packageRoot,
   * receiptsRoot, or one of these roots. Receipts are review INPUT DATA: a crafted receipt under
   * the selected receipts directory must not be able to turn an arbitrary readable host path
   * into a file that ships inside a bundle built to be shared. Anything outside the approved
   * roots is recorded as an explicit omission instead of being copied.
   */
  artifactRoots?: string[];
}

export async function writeReviewBundle(input: WriteReviewBundleInput): Promise<ReviewBundleResult> {
  const outDir = resolve(input.outDir);
  const pkg = input.packageRoot ? await loadMotionPackage(input.packageRoot) : undefined;
  if (pkg && isPathInsideOrEqual(pkg.root, outDir)) {
    throw new Error("Review HTML bundle outDir must be outside packageRoot.");
  }
  await assertEmptyOrAbsentDir(outDir);
  await mkdir(outDir, { recursive: true });

  const packageId = pkg?.manifest.id ?? "workspace";
  const createdAt = input.createdAt ?? new Date().toISOString();
  const receiptEntries = input.receipts ?? (input.receiptsRoot ? await readReviewBundleReceiptEntries(input.receiptsRoot) : []);
  // Every receipt-referenced artifact path is bound to these canonical roots before it is hashed
  // or copied. Receipts arrive as JSON data from a directory the operator selected for review, so
  // a crafted receipt must not be able to point the bundler at credentials or any other readable
  // file and have it packaged into a portable bundle that leaves the machine.
  const approvedArtifactRoots = await canonicalApprovedArtifactRoots([
    pkg?.root,
    input.receiptsRoot,
    ...(input.artifactRoots ?? [])
  ]);
  const { copiedArtifacts, omittedArtifacts } = input.copyArtifacts === false
    ? { copiedArtifacts: [], omittedArtifacts: [] }
    : await copyReviewArtifacts(receiptEntries, outDir, approvedArtifactRoots);
  const qualityGateSummaries = receiptEntries.map((entry) => receiptQualityGateSummary(entry.receipt)).filter((summary): summary is ReviewQualityGateSummary => summary !== undefined);
  const qualityGateCount = qualityGateSummaries.length;
  const failedQualityGateCount = qualityGateSummaries.filter(isFailedQualityGateSummary).length;
  const htmlPath = join(outDir, "review-html-bundle.html");
  const receiptPath = join(outDir, "review-html-bundle.receipt.json");
  const inputHashes = await reviewBundleInputHashes(pkg, receiptEntries);
  const receipt = createReviewBundleReceipt({
    packageId,
    createdAt,
    htmlPath,
    receiptPath,
    inputHashes,
    receiptCount: receiptEntries.length,
    copiedArtifacts,
    omittedArtifacts,
    qualityGateCount,
    failedQualityGateCount,
    title: input.title
  });

  const html = renderReviewHtml({
    title: input.title ?? "ShellX Motion Review",
    createdAt,
    package: pkg ? packageSummary(pkg) : undefined,
    receipts: receiptEntries,
    copiedArtifacts,
    omittedArtifacts
  });
  await writeFile(htmlPath, html, "utf8");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  return {
    ok: true,
    packageId,
    htmlPath,
    receiptPath,
    receiptCount: receiptEntries.length,
    copiedArtifactCount: copiedArtifacts.length,
    omittedArtifactCount: omittedArtifacts.length,
    qualityGateCount,
    failedQualityGateCount,
    copiedArtifacts,
    omittedArtifacts,
    receipt
  };
}

export async function readReviewBundleReceiptEntries(receiptsRoot: string): Promise<ReviewBundleReceiptEntry[]> {
  const root = resolve(receiptsRoot);
  const paths = await listJsonFiles(root);
  const entries: ReviewBundleReceiptEntry[] = [];
  for (const path of paths) {
    const receipt = readOperationReceipt(JSON.parse(await readFile(path, "utf8")));
    if (receipt) entries.push({ path, relativePath: reviewReceiptRelativePath(root, path), receipt });
  }
  // Code-unit order, not localeCompare: this ordering IS the review bundle's identity. It fixes
  // the order of `copiedArtifacts`, whose sha256 list is hashed into the receipt id below, so a
  // locale-sensitive comparator here gave the same bundle two different ids on two machines.
  return entries.sort((a, b) => compareCodeUnits(a.path ?? "", b.path ?? ""));
}

async function assertEmptyOrAbsentDir(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error("Review HTML bundle outDir must be a directory or absent.");
    const entries = await readdir(path);
    if (entries.length > 0) throw new Error("Review HTML bundle outDir must be empty or absent before bundle collection.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
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

/**
 * Canonicalizes the directories receipt-referenced artifacts may be copied from. Roots are
 * realpath-resolved so containment below is checked against what the filesystem actually serves —
 * a lexical prefix check alone would let a symlink placed under an approved root smuggle
 * out-of-root files into the bundle. A root that is missing or not a directory is dropped rather
 * than kept as a phantom prefix: it can contain no real file, so keeping it would only widen the
 * boundary for no benefit.
 */
async function canonicalApprovedArtifactRoots(roots: (string | undefined)[]): Promise<string[]> {
  const canonical: string[] = [];
  for (const root of roots) {
    if (!root) continue;
    try {
      const canonicalRoot = await realpath(resolve(root));
      if ((await stat(canonicalRoot)).isDirectory() && !canonical.includes(canonicalRoot)) canonical.push(canonicalRoot);
    } catch {
      // ENOENT and friends: an unreachable root approves nothing.
    }
  }
  return canonical;
}

async function copyReviewArtifacts(
  entries: ReviewBundleReceiptEntry[],
  outDir: string,
  approvedRoots: string[]
): Promise<{ copiedArtifacts: ReviewBundleCopiedArtifact[]; omittedArtifacts: ReviewBundleOmittedArtifact[] }> {
  const copied: ReviewBundleCopiedArtifact[] = [];
  const omitted: ReviewBundleOmittedArtifact[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const artifact of artifactCandidates(entry.receipt)) {
      const declaredPath = typeof artifact.path === "string" ? artifact.path : "";
      // An artifact that cannot enter the bundle is recorded, never silently dropped: a reviewer
      // reading the bundle must be able to tell "this render never had evidence" apart from
      // "evidence existed but was withheld", or a hostile receipt could hide a failed artifact
      // simply by pointing its path somewhere unreadable. `sourceName` stays receipt-declared and
      // is always a basename, so nothing about host layout leaks into the shared bundle.
      const omission = (reason: ReviewBundleOmittedArtifact["reason"], sourceName: string): void => {
        omitted.push({
          role: artifact.role,
          sourceName,
          reason,
          receiptId: entry.receipt.id,
          operation: entry.receipt.operation
        });
      };
      // These three used to be a bare `continue` that predated the ledger, which is exactly the
      // hole the ledger exists to close: `status`, and the shape of `path`, are receipt-controlled,
      // so a crafted receipt could withhold an artifact and still report omittedArtifactCount: 0.
      // They are disclosed here with their own reasons instead. Deduped on the DECLARED string
      // (not a resolved path) because a non-local path must never be run through `resolve`, which
      // would splice the bundler's cwd onto attacker-chosen text.
      if (artifact.status !== "available" || !declaredPath || hasProtocolScheme(declaredPath)) {
        const declaredKey = `${artifact.role}:declared:${artifact.status}:${declaredPath}`;
        if (seen.has(declaredKey)) continue;
        seen.add(declaredKey);
        const declaredName = declaredPath ? basename(declaredPath) || declaredPath : artifact.role;
        if (artifact.status !== "available") omission("declared_unavailable", declaredName);
        else if (!declaredPath) omission("missing_path", artifact.role);
        else omission("non_local_path", declaredName);
        continue;
      }
      const sourcePath = resolve(declaredPath);
      const key = `${artifact.role}:${sourcePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // realpath does double duty: it proves the source exists and yields the canonical path the
      // root binding must run against. Binding the declared path instead would let a symlink
      // under an approved root read any file on the host into the bundle.
      let canonicalSource: string;
      try {
        canonicalSource = await realpath(sourcePath);
      } catch {
        omission("unreadable_source", basename(sourcePath));
        continue;
      }
      // The security boundary of this module: receipts are data, and data must not carry read
      // capability. Only files whose canonical location the caller approved (packageRoot,
      // receiptsRoot, or an explicit artifact root) may enter a bundle built to be shared.
      if (!approvedRoots.some((root) => isPathInsideOrEqual(root, canonicalSource))) {
        omission("outside_approved_roots", basename(sourcePath));
        continue;
      }
      // Hash and copy through ONE descriptor rather than through the path twice. A
      // `hashFile(path)` + `copyFile(path, ...)` pair re-resolves the path between the two reads,
      // so anything that can rewrite that path between them (a symlink swap under an approved
      // root, a re-render replacing the file) makes the recorded sha256 describe bytes other than
      // the ones shipped — the digest is also spliced into the bundled file name, so the mismatch
      // is silent. Binding both to the same open inode removes the second resolution.
      let staged: { digest: string; copy: (targetPath: string) => Promise<void>; close: () => Promise<void> };
      try {
        staged = await openApprovedArtifact(canonicalSource);
      } catch {
        omission("unreadable_source", basename(sourcePath));
        continue;
      }
      try {
        // Display names stay receipt-declared so reviewers see familiar names.
        const fileName = safeFileName(basename(sourcePath) || `${artifact.role}${extname(sourcePath)}`);
        const relativePath = `artifacts/${safeToken(artifact.role)}-${staged.digest.slice(0, 12)}-${fileName}`;
        const targetPath = join(outDir, ...relativePath.split("/"));
        await mkdir(join(outDir, "artifacts"), { recursive: true });
        await staged.copy(targetPath);
        copied.push({
          role: artifact.role,
          sourceName: basename(sourcePath),
          path: targetPath,
          relativePath,
          ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
          ...(artifact.primary ? { primary: artifact.primary } : {}),
          receiptId: entry.receipt.id,
          operation: entry.receipt.operation,
          sha256: staged.digest
        });
      } finally {
        await staged.close();
      }
    }
  }
  return { copiedArtifacts: copied, omittedArtifacts: omitted };
}

/**
 * Opens an approved artifact once and returns both its digest and a copy function that streams the
 * SAME descriptor, so the sha256 recorded in the bundle receipt provably describes the bytes that
 * were written into the bundle.
 *
 * `O_NOFOLLOW` (a no-op on Windows, where the constant is undefined and the bitwise OR coerces it
 * to 0) plus the dev/ino comparison against an `lstat` of the same canonical path rejects a
 * symlink or regular-file swap landing between the caller's `realpath` containment check and this
 * open. Mirrors the identity re-verification `hashFile` already performs.
 *
 * @param canonicalSource Realpath-resolved, root-bound path of the artifact to ship.
 * @returns `digest` (sha256 hex of the opened inode), `copy` (stream it to a target path), and
 *   `close` (release the descriptor; the caller must always call it).
 * @throws When the path cannot be opened as the same regular file it was checked as.
 */
async function openApprovedArtifact(
  canonicalSource: string
): Promise<{ digest: string; copy: (targetPath: string) => Promise<void>; close: () => Promise<void> }> {
  const linkInfo = await lstat(canonicalSource);
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) throw new Error("Review bundle artifact must be a regular file.");
  const handle = await open(canonicalSource, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== linkInfo.dev || opened.ino !== linkInfo.ino) {
      throw new Error("Review bundle artifact changed before it could be read.");
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
      hash.update(chunk as Buffer);
    }
    return {
      digest: hash.digest("hex"),
      copy: async (targetPath: string) => {
        await pipeline(handle.createReadStream({ start: 0, autoClose: false }), createWriteStream(targetPath));
      },
      close: async () => { await handle.close().catch(() => undefined); }
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function artifactCandidates(receipt: OperationReceipt): ReceiptArtifact[] {
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

function sameLocalPath(left: string, right: string): boolean {
  if (hasProtocolScheme(left) || hasProtocolScheme(right)) return false;
  return resolve(left) === resolve(right);
}

function createReviewBundleReceipt(input: {
  packageId: string;
  createdAt: string;
  htmlPath: string;
  receiptPath: string;
  inputHashes: Record<string, string>;
  receiptCount: number;
  copiedArtifacts: ReviewBundleCopiedArtifact[];
  omittedArtifacts: ReviewBundleOmittedArtifact[];
  qualityGateCount: number;
  failedQualityGateCount: number;
  title?: string;
}): OperationReceipt {
  const artifacts: ReceiptArtifact[] = [
    { role: "review_html_bundle", path: input.htmlPath, status: "available", mediaType: "text/html", primary: true },
    { role: "review_html_bundle_receipt", path: input.receiptPath, status: "available", mediaType: "application/json" },
    ...input.copiedArtifacts.map((artifact): ReceiptArtifact => ({
      role: "review_artifact",
      path: artifact.path,
      status: "available",
      ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
      ...(artifact.primary ? { primary: artifact.primary } : {}),
      label: `${artifact.operation} ${artifact.role}`
    }))
  ];
  const hash = canonicalJsonSha256({
    packageId: input.packageId,
    receiptIds: [...Object.keys(input.inputHashes)].sort(compareCodeUnits),
    copied: input.copiedArtifacts.map((artifact) => artifact.sha256),
    // Joined into the identity only when present: a clean bundle keeps the id it had before
    // omissions existed, while a bundle that had to withhold an artifact must not impersonate
    // the identity of its complete counterpart.
    ...(input.omittedArtifacts.length > 0
      ? { omitted: input.omittedArtifacts.map((artifact) => `${artifact.reason}:${artifact.role}:${artifact.sourceName}`) }
      : {}),
    title: input.title ?? ""
  }).slice(0, 16);
  return {
    schema: "shellx-motion/receipt@1",
    id: `review-html-bundle-${input.packageId}-${hash}`,
    operation: "review.html.bundle",
    status: "passed",
    packageId: input.packageId,
    inputHashes: input.inputHashes,
    createdAt: input.createdAt,
    lane: "review",
    output: {
      htmlPath: input.htmlPath,
      receiptPath: input.receiptPath,
      packageId: input.packageId,
      receiptCount: input.receiptCount,
      copiedArtifactCount: input.copiedArtifacts.length,
      omittedArtifactCount: input.omittedArtifacts.length,
      // The omission list rides in output (not artifacts[]) because ReceiptArtifact entries need
      // a path, and the only honest paths here are host paths the portable receipt must not leak.
      ...(input.omittedArtifacts.length > 0 ? { omittedArtifacts: input.omittedArtifacts } : {}),
      qualityGateCount: input.qualityGateCount,
      failedQualityGateCount: input.failedQualityGateCount
    },
    artifacts,
    warnings: []
  };
}

async function reviewBundleInputHashes(pkg: MotionPackage | undefined, receipts: ReviewBundleReceiptEntry[]): Promise<Record<string, string>> {
  const inputHashes: Record<string, string> = {};
  if (pkg) {
    inputHashes["manifest.json"] = await hashFile(resolvePackageAsset(pkg, "manifest.json"));
    inputHashes[pkg.manifest.motion] = await hashFile(resolvePackageAsset(pkg, pkg.manifest.motion));
    if (pkg.manifest.template) inputHashes[pkg.manifest.template] = await hashFile(resolvePackageAsset(pkg, pkg.manifest.template));
  }
  for (const entry of receipts) {
    if (entry.path) inputHashes[`receipt:${entry.relativePath ?? basename(entry.path)}`] = await hashFile(entry.path);
  }
  return inputHashes;
}

function reviewReceiptRelativePath(root: string, path: string): string {
  return relative(root, path).split(/[/\\]+/).join("/");
}

function packageSummary(pkg: MotionPackage): Record<string, unknown> {
  const timeline = inspectMotionTimeline(pkg.motion);
  return {
    id: pkg.manifest.id,
    name: pkg.manifest.name,
    sourceApp: pkg.manifest.sourceApp,
    motionId: pkg.motion.id,
    durationMs: pkg.motion.durationMs,
    fps: pkg.motion.fps,
    width: pkg.motion.width,
    height: pkg.motion.height,
    layerCount: pkg.motion.layers.length,
    assetCount: pkg.motion.assets.length,
    trackCount: timeline.trackCount,
    sceneCount: timeline.sceneCount,
    markerCount: timeline.markerCount
  };
}

function renderReviewHtml(input: {
  title: string;
  createdAt: string;
  package?: Record<string, unknown>;
  receipts: ReviewBundleReceiptEntry[];
  copiedArtifacts: ReviewBundleCopiedArtifact[];
  omittedArtifacts: ReviewBundleOmittedArtifact[];
}): string {
  const statusCounts = countBy(input.receipts, (entry) => entry.receipt.status);
  const packageName = typeof input.package?.name === "string" ? input.package.name : undefined;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #18202f; background: #f6f7f9; }
    body { margin: 0; }
    main { max-width: 1120px; margin: 0 auto; padding: 32px 24px 48px; }
    header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; border-bottom: 1px solid #d8dde6; padding-bottom: 20px; }
    h1 { margin: 0 0 8px; font-size: 30px; line-height: 1.1; }
    h2 { margin: 32px 0 12px; font-size: 18px; }
    .muted { color: #657085; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .metric, table, .artifact { background: #fff; border: 1px solid #dfe4ec; border-radius: 8px; }
    .metric { padding: 14px; }
    .metric strong { display: block; font-size: 22px; }
    table { width: 100%; border-collapse: collapse; overflow: hidden; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e8edf4; vertical-align: top; }
    th { font-size: 12px; text-transform: uppercase; color: #596579; background: #f9fafc; }
    tr:last-child td { border-bottom: 0; }
    .status { display: inline-block; border-radius: 999px; padding: 2px 8px; font-size: 12px; background: #eef2f7; }
    .status-passed { background: #e4f7e9; color: #176b34; }
    .status-warning { background: #fff4d6; color: #765006; }
    .status-failed { background: #fde7e7; color: #9a1c1c; }
    .quality { min-width: 190px; }
    .quality-detail { margin-top: 4px; }
    .quality-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 12px; }
    .artifacts { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
    .artifact { padding: 12px; }
    .artifact video, .artifact img { width: 100%; max-height: 320px; object-fit: contain; background: #0f172a; border-radius: 6px; }
    a { color: #195cc8; }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>${escapeHtml(input.title)}</h1>
      ${packageName ? `<div class="muted">${escapeHtml(packageName)}</div>` : ""}
    </div>
    <div class="muted">Generated ${escapeHtml(input.createdAt)}</div>
  </header>
  <section>
    <h2>Summary</h2>
    <div class="grid">
      ${metric("Receipts", String(input.receipts.length))}
      ${metric("Artifacts", String(input.copiedArtifacts.length))}
      ${input.omittedArtifacts.length > 0 ? metric("Omitted", String(input.omittedArtifacts.length)) : ""}
      ${metric("Passed", String(statusCounts.passed ?? 0))}
      ${metric("Warnings", String(statusCounts.warning ?? 0))}
      ${metric("Failed", String(statusCounts.failed ?? 0))}
    </div>
  </section>
  ${input.package ? packageSection(input.package) : ""}
  <section>
    <h2>Receipts</h2>
    <table>
      <thead><tr><th>ID</th><th>Operation</th><th>Status</th><th>Lane</th><th>Warnings</th><th>Artifacts</th><th>Quality Gate</th></tr></thead>
      <tbody>
        ${input.receipts.map((entry) => receiptRow(entry)).join("\n")}
      </tbody>
    </table>
  </section>
  <section>
    <h2>Review Artifacts</h2>
    <div class="artifacts">
      ${[...input.copiedArtifacts.map(artifactCard), ...input.omittedArtifacts.map(omittedArtifactCard)].join("\n") || '<p class="muted">No available receipt artifacts were copied.</p>'}
    </div>
  </section>
</main>
</body>
</html>
`;
}

function packageSection(pkg: Record<string, unknown>): string {
  return `<section>
    <h2>Package</h2>
    <div class="grid">
      ${metric("Package", String(pkg.id ?? ""))}
      ${metric("Motion", String(pkg.motionId ?? ""))}
      ${metric("Size", `${pkg.width ?? 0}x${pkg.height ?? 0}`)}
      ${metric("Duration", `${pkg.durationMs ?? 0} ms`)}
      ${metric("Layers", String(pkg.layerCount ?? 0))}
      ${metric("Scenes", String(pkg.sceneCount ?? 0))}
    </div>
  </section>`;
}

function receiptRow(entry: ReviewBundleReceiptEntry): string {
  const receipt = entry.receipt;
  return `<tr>
    <td>${escapeHtml(receipt.id)}</td>
    <td>${escapeHtml(receipt.operation)}</td>
    <td><span class="status status-${escapeHtml(receipt.status)}">${escapeHtml(receipt.status)}</span></td>
    <td>${escapeHtml(receipt.lane)}</td>
    <td>${escapeHtml(String(receipt.warnings.length))}</td>
    <td>${escapeHtml(String(artifactCandidates(receipt).length))}</td>
    ${qualityGateCell(receipt)}
  </tr>`;
}

function qualityGateCell(receipt: OperationReceipt): string {
  const summary = receiptQualityGateSummary(receipt);
  if (!summary) return '<td class="quality muted">Not configured</td>';
  const status = summary.status ?? "configured";
  const details: string[] = [];
  if (summary.path) details.push(`<div class="muted quality-detail">${escapeHtml(displayPathLabel(summary.path))}</div>`);
  if (summary.receiptId) details.push(`<div class="muted quality-detail">Check: ${escapeHtml(summary.receiptId)}</div>`);
  if (!summary.receiptId && summary.hostReceiptPath) details.push(`<div class="muted quality-detail">Check: ${escapeHtml(displayPathLabel(summary.hostReceiptPath))}</div>`);
  if (summary.rows?.length) details.push(`<div class="muted quality-detail">${escapeHtml(qualityRowCounts(summary.rows))}</div>`);
  if (summary.code) details.push(`<div class="quality-detail quality-code">${escapeHtml(summary.code)}</div>`);
  if (summary.message) details.push(`<div class="muted quality-detail">${escapeHtml(summary.message)}</div>`);
  const rowErrors = (summary.rows ?? [])
    .filter((row) => row.code || row.message)
    .slice(0, 3)
    .map((row) => qualityRowIssue(row));
  for (const issue of rowErrors) details.push(`<div class="muted quality-detail">${escapeHtml(issue)}</div>`);
  return `<td class="quality">${statusPill(status)}${details.join("")}</td>`;
}

function statusPill(status: string): string {
  return `<span class="status status-${escapeAttribute(safeToken(status))}">${escapeHtml(status)}</span>`;
}

function receiptQualityGateSummary(receipt: OperationReceipt): ReviewQualityGateSummary | undefined {
  const output = recordOf(receipt.output);
  if (!output) return undefined;
  const summary: ReviewQualityGateSummary = {};
  const path = readStringField(output, "qualityManifestPath") ?? readStringField(output, "qualityManifestAppliedPath");
  if (path) summary.path = path;
  assignQualityCheckSummary(summary, recordOf(output.qualityCheck));
  if (Array.isArray(output.jobs)) {
    const rows = output.jobs
      .map((job) => qualityGateRowSummary(recordOf(job)))
      .filter((row): row is ReviewQualityGateRowSummary => row !== undefined);
    if (rows.length > 0) summary.rows = rows;
  }
  if (!summary.status && summary.rows?.length) summary.status = deriveQualityRowsStatus(summary.rows);
  return hasQualityGateSummary(summary) ? summary : undefined;
}

function qualityGateRowSummary(job: Record<string, unknown> | null): ReviewQualityGateRowSummary | undefined {
  if (!job) return undefined;
  const row: ReviewQualityGateRowSummary = {};
  const rowId = readStringField(job, "rowId");
  const packageId = readStringField(job, "packageId");
  const path = readStringField(job, "qualityManifestAppliedPath") ?? readStringField(job, "qualityManifestPath");
  if (rowId) row.rowId = rowId;
  if (packageId) row.packageId = packageId;
  if (path) row.path = path;
  assignQualityCheckSummary(row, recordOf(job.qualityCheck));
  return hasQualityGateRowSummary(row) ? row : undefined;
}

function assignQualityCheckSummary(target: ReviewQualityGateSummary | ReviewQualityGateRowSummary, qualityCheck: Record<string, unknown> | null): void {
  if (!qualityCheck) return;
  const error = recordOf(qualityCheck.error);
  const status = readStringField(qualityCheck, "status") ?? readBooleanQualityStatus(qualityCheck.ok);
  const receiptId = readStringField(qualityCheck, "receiptId");
  const hostReceiptPath = readStringField(qualityCheck, "hostReceiptPath");
  const code = readStringField(qualityCheck, "code") ?? readStringField(error, "code");
  const message = readStringField(qualityCheck, "message") ?? readStringField(error, "message");
  if (status) target.status = status;
  if (receiptId) target.receiptId = receiptId;
  if (hostReceiptPath) target.hostReceiptPath = hostReceiptPath;
  if (code) target.code = code;
  if (message) target.message = message;
}

function readBooleanQualityStatus(value: unknown): string | undefined {
  if (value === true) return "passed";
  if (value === false) return "failed";
  return undefined;
}

function hasQualityGateSummary(summary: ReviewQualityGateSummary): boolean {
  return Boolean(summary.path || summary.status || summary.receiptId || summary.hostReceiptPath || summary.code || summary.message || summary.rows?.length);
}

function isFailedQualityGateSummary(summary: ReviewQualityGateSummary): boolean {
  return summary.status === "failed" || Boolean(summary.rows?.some((row) => row.status === "failed"));
}

function hasQualityGateRowSummary(row: ReviewQualityGateRowSummary): boolean {
  return Boolean(row.path || row.status || row.receiptId || row.hostReceiptPath || row.code || row.message);
}

function deriveQualityRowsStatus(rows: ReviewQualityGateRowSummary[]): string | undefined {
  const statuses = rows.map((row) => row.status).filter((status): status is string => Boolean(status));
  if (statuses.length === 0) return undefined;
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "warning")) return "warning";
  if (statuses.every((status) => status === "passed")) return "passed";
  if (statuses.every((status) => status === "not_run")) return "not_run";
  return "configured";
}

function qualityRowCounts(rows: ReviewQualityGateRowSummary[]): string {
  const statuses = rows.map((row) => row.status).filter((status): status is string => Boolean(status));
  const parts = [`${rows.length} ${rows.length === 1 ? "row" : "rows"}`];
  const ordered = ["passed", "warning", "failed", "not_run"];
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  for (const status of ordered) {
    const count = counts.get(status);
    if (count) parts.push(`${count} ${status}`);
    counts.delete(status);
  }
  for (const status of [...counts.keys()].sort()) {
    const count = counts.get(status);
    if (count) parts.push(`${count} ${status}`);
  }
  return parts.join(", ");
}

function qualityRowIssue(row: ReviewQualityGateRowSummary): string {
  const label = row.rowId ?? row.packageId ?? "row";
  return [label, row.code, row.message].filter((part): part is string => Boolean(part)).join(": ");
}

function displayPathLabel(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? path;
}

function artifactCard(artifact: ReviewBundleCopiedArtifact): string {
  const href = escapeAttribute(artifact.relativePath);
  const preview = artifact.mediaType?.startsWith("video/")
    ? `<video controls src="${href}"></video>`
    : artifact.mediaType?.startsWith("image/")
      ? `<img src="${href}" alt="">`
      : "";
  return `<article class="artifact">
    ${preview}
    <h3>${escapeHtml(artifact.role)}</h3>
    <p class="muted">${escapeHtml(artifact.operation)} / ${escapeHtml(artifact.sourceName)}</p>
    <p><a href="${href}">Open artifact</a></p>
  </article>`;
}

/**
 * Renders a withheld artifact as a visible card with no link and no preview. Showing only the
 * receipt-declared file name (never the host path) keeps the shared bundle free of host layout
 * while still telling the reviewer that evidence was withheld and why — see
 * ReviewBundleOmittedArtifact for the disclosure rationale.
 */
function omittedArtifactCard(artifact: ReviewBundleOmittedArtifact): string {
  return `<article class="artifact">
    <h3>${escapeHtml(artifact.role)}</h3>
    <p class="muted">${escapeHtml(artifact.operation)} / ${escapeHtml(artifact.sourceName)}</p>
    <p class="muted">${escapeHtml(omittedReasonLabel(artifact.reason))}</p>
  </article>`;
}

function omittedReasonLabel(reason: ReviewBundleOmittedArtifact["reason"]): string {
  switch (reason) {
    case "outside_approved_roots":
      return "Omitted: file sits outside the approved artifact roots.";
    case "declared_unavailable":
      return "Omitted: the receipt declared this artifact as not available.";
    case "non_local_path":
      return "Omitted: the receipt named a URL rather than a local file.";
    case "missing_path":
      return "Omitted: the receipt declared no artifact path.";
    default:
      return "Omitted: source file could not be read.";
  }
}

function metric(label: string, value: string): string {
  return `<div class="metric"><span class="muted">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
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

function readStringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readReceiptStatus(value: unknown): OperationReceipt["status"] | null {
  return value === "passed" || value === "failed" || value === "warning" || value === "not_run" ? value : null;
}

function countBy<T extends string>(items: ReviewBundleReceiptEntry[], selector: (item: ReviewBundleReceiptEntry) => T): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const item of items) {
    const key = selector(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

function hasProtocolScheme(path: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(path)) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path);
}

function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function safeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-") || "artifact";
}

function mediaTypeForPath(path: string): string | undefined {
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character] ?? character);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
