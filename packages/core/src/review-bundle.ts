import { realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { canonicalJsonSha256, compareCodeUnits } from "./canonical-json";
import { loadMotionPackage } from "./package";
import { OutputDirectoryTransaction } from "./output-directory-transaction";
import { ExistingDirectoryAuthority } from "./output-path-topology";
import {
  escapeReviewHtml as escapeHtml,
  isPathInsideOrEqual,
  publishedReviewPath,
  sameReviewInputHashes
} from "./review-bundle-helpers";
import { inspectMotionTimeline } from "./timeline-inspect";
import type { MotionPackage, OperationReceipt, ReceiptArtifact } from "./types";
import {
  boundedReviewArtifactAttributions,
  canonicalApprovedArtifactRoots,
  copyReviewArtifacts
} from "./review-bundle-artifact-admission";
import {
  artifactCandidates,
  readReviewBundleReceiptEntries,
  reviewBundleInputHashes
} from "./review-bundle-receipt-data";
import { exactReviewBundleReceiptEntries } from "./review-bundle-stable-receipts";
import {
  isFailedReviewQualityGateSummary,
  renderReviewQualityGateCell,
  reviewQualityGateSummary,
  type ReviewQualityGateSummary
} from "./review-bundle-quality-summary";
import type {
  ReviewBundleCopiedArtifact,
  ReviewBundleOmittedArtifact,
  ReviewBundleReceiptEntry,
  ReviewBundleResult,
  WriteReviewBundleInput
} from "./review-bundle-types";

export { readReviewBundleReceiptEntries } from "./review-bundle-receipt-data";
export { bindStableReviewBundleReceiptEntries } from "./review-bundle-stable-receipts";
export type {
  BoundReviewBundleReceiptEntry,
  ReviewBundleCopiedArtifact,
  ReviewBundleOmittedArtifact,
  ReviewBundleReceiptEntry,
  ReviewBundleResult,
  StableReviewBundleReceiptInput,
  WriteReviewBundleInput
} from "./review-bundle-types";

const REVIEW_BUNDLE_HTML_RELATIVE_PATH = "review-html-bundle.html";
const REVIEW_BUNDLE_RECEIPT_RELATIVE_PATH = "review-html-bundle.receipt.json";

export async function writeReviewBundle(input: WriteReviewBundleInput): Promise<ReviewBundleResult> {
  const outDir = resolve(input.outDir);
  const selectedRoots = await Promise.all([
    ...(input.packageRoot ? [{ root: input.packageRoot, authority: input.packageRootAuthority, label: "packageRoot" }] : []),
    ...(input.receiptsRoot ? [{ root: input.receiptsRoot, authority: input.receiptsRootAuthority, label: "receiptsRoot" }] : [])
  ].map(async (entry) => ({
    root: entry.root,
    label: entry.label,
    authority: entry.authority ?? await ExistingDirectoryAuthority.acquire(await realpath(resolve(entry.root)))
  })));
  const selectedRootAuthorities = selectedRoots.map((entry) => entry.authority);
  const retainedRootAuthorities = [
    ...selectedRootAuthorities,
    ...(input.artifactRootAuthorities ?? [])
  ];
  await assertSelectedReviewRoots(selectedRoots);
  await assertReviewRootAuthorities(retainedRootAuthorities);
  const pkg = input.packageRoot ? await loadMotionPackage(input.packageRoot) : undefined;
  await assertSelectedReviewRoots(selectedRoots);
  await assertReviewRootAuthorities(retainedRootAuthorities);
  if (pkg && isPathInsideOrEqual(pkg.root, outDir)) {
    throw new Error("Review HTML bundle outDir must be outside packageRoot.");
  }
  const transaction = await OutputDirectoryTransaction.create(outDir);
  try {
    const packageId = pkg?.manifest.id ?? "workspace";
    const createdAt = input.createdAt ?? new Date().toISOString();
    const receiptEntries = exactReviewBundleReceiptEntries(
      input.receipts ?? (input.receiptsRoot ? await readReviewBundleReceiptEntries(input.receiptsRoot) : [])
    );
    await assertSelectedReviewRoots(selectedRoots);
    await assertReviewRootAuthorities(retainedRootAuthorities);
    // The cap applies to every receipt-controlled review path, including an HTML-only caller that
    // elected not to copy artifacts. It is a hard publication boundary, not an omission policy.
    boundedReviewArtifactAttributions(receiptEntries);
    // Every receipt-referenced artifact path is bound to these canonical roots before it is hashed
    // or copied. Receipts arrive as JSON data from a directory the operator selected for review, so
    // a crafted receipt must not be able to point the bundler at credentials or any other readable
    // file and have it packaged into a portable bundle that leaves the machine.
    const approvedArtifactRoots = await canonicalApprovedArtifactRoots([
      pkg?.root,
      input.receiptsRoot,
      ...(input.artifactRoots ?? []),
      ...(input.artifactRootAuthorities ?? []).map((authority) => authority.path)
    ], retainedRootAuthorities);
    const stagedArtifacts = input.copyArtifacts === false
      ? { copiedArtifacts: [], omittedArtifacts: [] }
      : await copyReviewArtifacts(receiptEntries, transaction.stagingPath, approvedArtifactRoots, retainedRootAuthorities);
    const copiedArtifacts = stagedArtifacts.copiedArtifacts.map((artifact) => ({
      ...artifact,
      path: publishedReviewPath(transaction.stagingPath, outDir, artifact.path)
    }));
    const omittedArtifacts = stagedArtifacts.omittedArtifacts;
    const qualityGateSummaries = receiptEntries.map((entry) => reviewQualityGateSummary(entry.receipt)).filter((summary): summary is ReviewQualityGateSummary => summary !== undefined);
    const qualityGateCount = qualityGateSummaries.length;
    const failedQualityGateCount = qualityGateSummaries.filter(isFailedReviewQualityGateSummary).length;
    // Results are immediate local-caller data, so they keep absolute published paths. The receipt
    // is designed to leave this machine with the HTML bundle and must contain only paths inside
    // that portable bundle.
    const htmlPath = join(outDir, REVIEW_BUNDLE_HTML_RELATIVE_PATH);
    const receiptPath = join(outDir, REVIEW_BUNDLE_RECEIPT_RELATIVE_PATH);
    // These values name exactly the parsed package snapshot and receipt inputs used to compose the
    // bundle.  Immediately before publication we rehash their paths below; a late edit rejects the
    // staged bundle rather than publishing HTML from one version with a receipt for another.
    const inputHashes = await reviewBundleInputHashes(pkg, receiptEntries);
    const receipt = createReviewBundleReceipt({
      packageId,
      createdAt,
      htmlPath: REVIEW_BUNDLE_HTML_RELATIVE_PATH,
      receiptPath: REVIEW_BUNDLE_RECEIPT_RELATIVE_PATH,
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
    await transaction.assertCurrent();
    await writeFile(join(transaction.stagingPath, "review-html-bundle.html"), html, "utf8");
    // Re-open package and receipt paths only at the publication boundary.  Loader-owned package
    // digests above bind the parsed content; these live digests prove those source paths still name
    // that content when the output directory is made visible.
    const currentInputHashes = await reviewBundleInputHashes(pkg, receiptEntries, {
      useLoadedPackageHashes: false,
      useRetainedReceiptHashes: false
    });
    if (!sameReviewInputHashes(inputHashes, currentInputHashes)) {
      throw new Error("Review bundle package or receipt input changed before publication.");
    }
    await assertSelectedReviewRoots(selectedRoots);
    await assertReviewRootAuthorities(retainedRootAuthorities);
    await transaction.assertCurrent();
    await writeFile(join(transaction.stagingPath, "review-html-bundle.receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await transaction.commit();

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
  } catch (error) {
    await transaction.abort();
    throw error;
  }
}

async function assertSelectedReviewRoots(
  selected: readonly { root: string; label: string; authority: { path: string; assertCurrent(): Promise<void> } }[]
): Promise<void> {
  for (const entry of selected) {
    await entry.authority.assertCurrent();
    const current = await realpath(resolve(entry.root));
    if (resolve(current) !== resolve(entry.authority.path)) {
      throw new Error(`Review bundle ${entry.label} changed after admission; Motion left the output unpublished.`);
    }
    await entry.authority.assertCurrent();
  }
}

async function assertReviewRootAuthorities(authorities: readonly { assertCurrent(): Promise<void> }[]): Promise<void> {
  for (const authority of authorities) await authority.assertCurrent();
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
      path: artifact.relativePath,
      status: "available",
      ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
      ...(artifact.primary ? { primary: artifact.primary } : {}),
      label: `${artifact.operation} ${artifact.role}`
    }))
  ];
  const hash = canonicalJsonSha256({
    packageId: input.packageId,
    receiptIds: [...Object.keys(input.inputHashes)].sort(compareCodeUnits),
    copied: input.copiedArtifacts.map((artifact) => ({
      receiptId: artifact.receiptId,
      role: artifact.role,
      relativePath: artifact.relativePath,
      producerIdentity: artifact.producerIdentity,
      observedSha256: artifact.observedSha256,
      observedByteLength: artifact.observedByteLength,
      ...(artifact.expectedProducerSha256 ? { expectedProducerSha256: artifact.expectedProducerSha256 } : {}),
      ...(artifact.expectedProducerByteLength !== undefined ? { expectedProducerByteLength: artifact.expectedProducerByteLength } : {})
    })),
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
      // These are portable relative-path/leaf-name records, never source host paths. They preserve
      // both the receipt-producer expectation and the bytes observed while this bundle was built.
      copiedArtifactIdentities: input.copiedArtifacts.map(portableCopiedArtifactIdentity),
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

function portableCopiedArtifactIdentity(artifact: ReviewBundleCopiedArtifact): Record<string, unknown> {
  return {
    role: artifact.role,
    sourceName: artifact.sourceName,
    path: artifact.relativePath,
    receiptId: artifact.receiptId,
    operation: artifact.operation,
    producerIdentity: artifact.producerIdentity,
    observedSha256: artifact.observedSha256,
    observedByteLength: artifact.observedByteLength,
    ...(artifact.expectedProducerSha256 ? { expectedProducerSha256: artifact.expectedProducerSha256 } : {}),
    ...(artifact.expectedProducerByteLength !== undefined ? { expectedProducerByteLength: artifact.expectedProducerByteLength } : {})
  };
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
    ${renderReviewQualityGateCell(receipt)}
  </tr>`;
}

function artifactCard(artifact: ReviewBundleCopiedArtifact): string {
  const href = escapeHtml(artifact.relativePath);
  const preview = artifact.mediaType?.startsWith("video/")
    ? `<video controls src="${href}"></video>`
    : artifact.mediaType?.startsWith("image/")
      ? `<img src="${href}" alt="">`
      : "";
  return `<article class="artifact">
    ${preview}
    <h3>${escapeHtml(artifact.role)}</h3>
    <p class="muted">${escapeHtml(artifact.operation)} / ${escapeHtml(artifact.sourceName)}</p>
    <p class="muted">${artifact.producerIdentity === "producer_verified"
      ? "Producer SHA-256 verified against the streamed bundle copy."
      : "Unattested: the receipt did not bind this artifact to a producer SHA-256."}</p>
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

function countBy<T extends string>(items: ReviewBundleReceiptEntry[], selector: (item: ReviewBundleReceiptEntry) => T): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const item of items) {
    const key = selector(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
