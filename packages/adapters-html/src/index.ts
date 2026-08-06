import { createWriteStream, constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, extname, join, posix, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import {
  asciiLowerCase,
  ForwardIndex,
  hashBuffer,
  hashFile,
  isMarkupWordCharCode,
  loadMotionPackage,
  loadSchema,
  type MotionDocument,
  resolvePackageAsset,
  type MotionLayer,
  type MotionPackage,
  type OperationReceipt,
  type PackageManifest,
  type ReceiptArtifact,
  replaceMarkupTags,
  scanMarkupAttributes,
  scanMarkupOpenTags,
  scanMarkupTagPairs,
  validateDocument
} from "@shellx-motion/core";

export interface HtmlSnippetExportOptions {
  packageRoot: string;
  outDir: string;
  createdAt?: string;
}

export interface HtmlSnippetLossinessFinding {
  path: string;
  layerId: string;
  feature: string;
  reason: string;
}

export interface HtmlSnippetExportResult {
  ok: true;
  packageId: string;
  htmlPath: string;
  receiptPath: string;
  receipt: OperationReceipt;
  htmlSha256: string;
  layerCount: number;
  exportedLayerCount: number;
  unsupportedFeatureCount: number;
  artifacts: ReceiptArtifact[];
  warnings: string[];
}

export interface HtmlSnippetImportOptions {
  htmlPath: string;
  packageDir: string;
  createdAt?: string;
  createdBy?: string;
}

export interface HtmlSnippetImportResult {
  ok: true;
  packageDir: string;
  packageId: string;
  manifestPath: string;
  motionPath: string;
  receiptPath: string;
  receipt: OperationReceipt;
  layerCount: number;
  warningCount: number;
  stagedAssetCount: number;
  stagedAssets: Array<{ path: string; sha256: string; size: number }>;
  artifacts: ReceiptArtifact[];
  warnings: string[];
}

interface ParsedHtmlSnippet {
  manifest: PackageManifest;
  motion: MotionDocument;
  lossiness: HtmlSnippetLossinessFinding[];
}

interface ParsedHtmlLayer {
  layer: MotionLayer | null;
  assetRef?: string;
  lossiness: HtmlSnippetLossinessFinding[];
}

interface HtmlComposition {
  htmlAttrs: Record<string, string>;
  mainAttrs: Record<string, string>;
  mainInner: string;
  title: string;
  mainStyle: Record<string, string>;
}

interface HtmlLayerElement {
  tagName: string;
  attrs: Record<string, string>;
  innerHtml: string;
  style: Record<string, string>;
}

const HTML_SNIPPET_FILE = "index.html";
const HTML_SNIPPET_RECEIPT_FILE = "html-snippet-export.receipt.json";
const HTML_SNIPPET_IMPORT_RECEIPT_FILE = "html-snippet-import.receipt.json";
const MOTION_PACKAGE_MEDIA_TYPE = "application/vnd.shellx.motion.package";
const SUPPORTED_LAYER_TYPES = new Set(["text", "caption", "shape", "image", "video"]);
const MAX_HTML_SNIPPET_BYTES = 8 * 1024 * 1024;
const MAX_HTML_LAYER_COUNT = 1_000;
const MAX_HTML_ASSET_BYTES = 256 * 1024 * 1024;
const MAX_HTML_TOTAL_ASSET_BYTES = 512 * 1024 * 1024;
const IMAGE_ASSET_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const VIDEO_ASSET_EXTENSIONS = new Set([".mp4", ".webm"]);

export async function writeHtmlSnippetExport(options: HtmlSnippetExportOptions): Promise<HtmlSnippetExportResult> {
  const pkg = await loadMotionPackage(options.packageRoot);
  const outDir = resolve(options.outDir);
  assertNotInsidePackage(pkg.root, outDir);
  await assertEmptyOrCreate(outDir);

  const { html, exportedLayerCount, lossiness } = await renderHtmlSnippet(pkg);
  const htmlPath = join(outDir, HTML_SNIPPET_FILE);
  const receiptPath = join(outDir, HTML_SNIPPET_RECEIPT_FILE);
  await writeFile(htmlPath, html, "utf8");
  const htmlSha256 = hashBuffer(Buffer.from(html, "utf8"));
  const warnings = lossiness.map((finding) => `${finding.path}: ${finding.reason}`);
  const artifacts: ReceiptArtifact[] = [
    { role: "html_snippet", path: htmlPath, status: "available", mediaType: "text/html", primary: true },
    { role: "html_snippet_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
  ];
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1",
    id: `html-snippet-export-${pkg.manifest.id}-${htmlSha256.slice(0, 16)}`,
    operation: "html.snippet.export",
    status: lossiness.length > 0 ? "warning" : "passed",
    packageId: pkg.manifest.id,
    inputHashes: {
      "manifest.json": await hashFile(resolve(pkg.root, "manifest.json")),
      [pkg.manifest.motion]: await hashFile(resolvePackageAsset(pkg, pkg.manifest.motion))
    },
    createdAt: options.createdAt ?? new Date().toISOString(),
    lane: "html",
    output: {
      htmlPath,
      htmlSha256,
      width: pkg.motion.width,
      height: pkg.motion.height,
      durationMs: pkg.motion.durationMs,
      layerCount: pkg.motion.layers.length,
      exportedLayerCount,
      lossiness: {
        unsupported: lossiness
      }
    },
    artifacts,
    warnings
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  return {
    ok: true,
    packageId: pkg.manifest.id,
    htmlPath,
    receiptPath,
    receipt,
    htmlSha256,
    layerCount: pkg.motion.layers.length,
    exportedLayerCount,
    unsupportedFeatureCount: lossiness.length,
    artifacts,
    warnings
  };
}

export async function importHtmlSnippetToMotionPackage(options: HtmlSnippetImportOptions): Promise<HtmlSnippetImportResult> {
  const htmlPath = resolve(options.htmlPath);
  const packageDir = resolve(options.packageDir);
  await assertEmptyOrCreatePackageDir(packageDir);

  const htmlInfo = await stat(htmlPath);
  if (!htmlInfo.isFile()) throw new Error("HTML snippet import requires a regular HTML file.");
  if (htmlInfo.size > MAX_HTML_SNIPPET_BYTES) throw new Error("HTML snippet import source exceeds the 8 MiB limit.");
  const html = await readFile(htmlPath, "utf8");
  const imported = parseHtmlSnippet(html, {
    createdBy: options.createdBy ?? "html-adapter"
  });
  const validation = await validateDocument(await loadSchema("motion"), imported.motion);
  if (!validation.ok) {
    const summary = validation.errors.slice(0, 8).map((error) => `${error.path}: ${error.message}`).join(", ");
    throw new Error(`HTML snippet import produced an invalid Motion document: ${summary}.`);
  }
  const stagedAssets = await stageHtmlSnippetAssets({
    htmlPath,
    packageDir,
    assetRefs: imported.manifest.assets
  });
  const manifestPath = join(packageDir, "manifest.json");
  const motionPath = join(packageDir, imported.manifest.motion);
  const receiptPath = join(packageDir, "receipts", HTML_SNIPPET_IMPORT_RECEIPT_FILE);
  const artifacts: ReceiptArtifact[] = [
    { role: "motion_package", path: packageDir, status: "available", mediaType: MOTION_PACKAGE_MEDIA_TYPE, primary: true },
    { role: "html_snippet_import_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
  ];
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1",
    id: `html-snippet-import-${imported.manifest.id}`,
    operation: "html.snippet.import",
    status: imported.lossiness.length > 0 ? "warning" : "passed",
    packageId: imported.manifest.id,
    inputHashes: {
      [htmlPath]: await hashFile(htmlPath),
      ...Object.fromEntries(stagedAssets.map((asset) => [asset.path, asset.sha256]))
    },
    createdAt: options.createdAt ?? new Date().toISOString(),
    lane: "html",
    output: {
      htmlPath,
      motionPath,
      layerCount: imported.motion.layers.length,
      warningCount: imported.lossiness.length,
      stagedAssets,
      lossiness: { unsupported: imported.lossiness }
    },
    artifacts,
    warnings: imported.lossiness.map((finding) => `${finding.path}: ${finding.reason}`)
  };

  await mkdir(join(packageDir, "receipts"), { recursive: true });
  await writeJson(manifestPath, imported.manifest);
  await writeJson(motionPath, imported.motion);
  await writeJson(receiptPath, receipt);
  await loadMotionPackage(packageDir);

  return {
    ok: true,
    packageDir,
    packageId: imported.manifest.id,
    manifestPath,
    motionPath,
    receiptPath,
    receipt,
    layerCount: imported.motion.layers.length,
    warningCount: imported.lossiness.length,
    stagedAssetCount: stagedAssets.length,
    stagedAssets,
    artifacts,
    warnings: receipt.warnings
  };
}

async function renderHtmlSnippet(pkg: MotionPackage): Promise<{ html: string; exportedLayerCount: number; lossiness: HtmlSnippetLossinessFinding[] }> {
  const lossiness: HtmlSnippetLossinessFinding[] = [];
  const exported: string[] = [];
  for (const layer of pkg.motion.layers) {
    if (!SUPPORTED_LAYER_TYPES.has(layer.type)) {
      lossiness.push({
        path: `motion.layers.${layer.id}`,
        layerId: layer.id,
        feature: `layer.type.${layer.type}`,
        reason: `HTML snippet export does not embed ${layer.type} layers yet.`
      });
      continue;
    }
    const layerLossiness = htmlExportLayerLossiness(layer);
    lossiness.push(...layerLossiness);
    if (layer.visible === false || (layer as unknown as Record<string, unknown>).enabled === false) continue;
    if ((layer.type === "image" || layer.type === "video") && !htmlExportMediaSource(layer)) continue;
    exported.push(await renderLayer(pkg, layer));
  }

  const title = escapeHtml(pkg.motion.name);
  const background = cssColor(readString(pkg.motion.background) ?? "#000000");
  const html = [
    "<!doctype html>",
    `<html lang="en" data-shellx-motion-schema="shellx-motion/html-snippet@1" data-shellx-motion-package-id="${escapeAttr(pkg.manifest.id)}">`,
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `  <title>${title}</title>`,
    "  <style>",
    "    html, body { margin: 0; min-height: 100%; background: #111; }",
    "    body { display: grid; place-items: center; }",
    "    .shellx-motion-composition { position: relative; overflow: hidden; isolation: isolate; }",
    "    .shellx-motion-layer { position: absolute; box-sizing: border-box; overflow: hidden; }",
    "    .shellx-motion-text { white-space: pre-wrap; line-height: 1.1; }",
    "    .shellx-motion-media { width: 100%; height: 100%; object-fit: cover; display: block; }",
    "  </style>",
    "</head>",
    "<body>",
    [
      `  <main class="shellx-motion-composition"`,
      `    data-composition-id="${escapeAttr(pkg.motion.id)}"`,
      "    data-start=\"0\"",
      `    data-duration="${numberAttr(pkg.motion.durationMs)}"`,
      `    style="width: ${cssNumber(pkg.motion.width)}px; height: ${cssNumber(pkg.motion.height)}px; background: ${background};">`
    ].join("\n"),
    ...exported,
    "  </main>",
    "</body>",
    "</html>",
    ""
  ].join("\n");

  return { html, exportedLayerCount: exported.length, lossiness };
}

async function renderLayer(pkg: MotionPackage, layer: MotionLayer): Promise<string> {
  const attrs = [
    `data-layer-id="${escapeAttr(layer.id)}"`,
    `data-layer-type="${escapeAttr(layer.type)}"`,
    `data-start="${numberAttr(layer.startMs)}"`,
    `data-duration="${numberAttr(layer.durationMs)}"`
  ].join(" ");
  const style = baseLayerStyle(layer);

  if (layer.type === "text" || layer.type === "caption") {
    return `    <div class="shellx-motion-layer shellx-motion-text" ${attrs} style="${escapeAttr(`${style} ${textStyle(layer)}`)}">${escapeHtml(readString(layer.text) ?? "")}</div>`;
  }

  if (layer.type === "shape") {
    return `    <div class="shellx-motion-layer shellx-motion-shape" ${attrs} style="${escapeAttr(`${style} ${shapeStyle(layer)}`)}"></div>`;
  }

  if (layer.type === "image") {
    const source = await mediaSource(pkg, layer);
    return `    <img class="shellx-motion-layer shellx-motion-media" ${attrs} alt="" src="${escapeAttr(source)}" style="${escapeAttr(style)}">`;
  }

  if (layer.type === "video") {
    const source = await mediaSource(pkg, layer);
    return `    <video class="shellx-motion-layer shellx-motion-media" ${attrs} src="${escapeAttr(source)}" muted playsinline preload="auto" style="${escapeAttr(style)}"></video>`;
  }

  return "";
}

function parseHtmlSnippet(html: string, options: { createdBy: string }): ParsedHtmlSnippet {
  const composition = readHtmlComposition(html);
  const layerElements = readHtmlLayerElements(composition.mainInner);
  if (layerElements.length > MAX_HTML_LAYER_COUNT) throw new Error("HTML snippet import exceeds the 1000-layer limit.");
  const layers: MotionLayer[] = [];
  const lossiness: HtmlSnippetLossinessFinding[] = htmlDocumentLossiness(html, composition);
  const assetRefs: string[] = [];

  for (const element of layerElements) {
    const parsed = htmlElementToMotionLayer(element);
    lossiness.push(...parsed.lossiness);
    if (!parsed.layer) {
      continue;
    }
    layers.push(parsed.layer);
    if (parsed.assetRef) assetRefs.push(parsed.assetRef);
  }

  const packageId = boundedHtmlId(
    readStringAttr(composition.htmlAttrs, "data-shellx-motion-package-id")
      ?? readStringAttr(composition.mainAttrs, "data-shellx-motion-package-id")
      ?? `pkg_html_${slugId(composition.title)}`,
    "package id"
  );
  const motionId = boundedHtmlId(
    readStringAttr(composition.mainAttrs, "data-composition-id")
      ?? `motion_html_${slugId(composition.title)}`,
    "composition id"
  );
  const durationMs = readPositiveAttr(composition.mainAttrs, "data-duration") ?? maxLayerEndMs(layers) ?? 1000;
  const fps = readPositiveAttr(composition.mainAttrs, "data-fps") ?? 30;
  const width = readCssNumber(composition.mainStyle.width) ?? 1920;
  const height = readCssNumber(composition.mainStyle.height) ?? 1080;
  const background = readCssColor(composition.mainStyle.background) ?? readCssColor(composition.mainStyle["background-color"]);
  const sourceSchema = readStringAttr(composition.htmlAttrs, "data-shellx-motion-schema")
    ?? readStringAttr(composition.mainAttrs, "data-shellx-motion-schema")
    ?? "shellx-motion/html-snippet@1";
  const assets = uniqueStrings(assetRefs);
  const manifest: PackageManifest = {
    schema: "shellx-motion/package-manifest@1",
    id: packageId,
    name: boundedHtmlText(composition.title, 256, "title"),
    motion: "motion.json",
    assets,
    sourceApp: "html-snippet",
    compatibility: {
      lanes: ["html", "browser", "ffmpeg"],
      hosts: ["shellx-motion", "shellx-canvas", "shellx-cut"]
    },
    workflow: "html-snippet-import"
  };
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1",
    id: motionId,
    name: boundedHtmlText(composition.title, 256, "title"),
    durationMs,
    fps,
    width,
    height,
    ...(background ? { background } : {}),
    layers,
    assets: [],
    provenance: {
      sourceApp: "html-snippet",
      createdBy: boundedHtmlText(options.createdBy, 128, "createdBy"),
      workflow: "html-snippet-import",
      sourceSchema: boundedHtmlText(sourceSchema, 128, "source schema")
    }
  };
  return { manifest, motion, lossiness };
}

function readHtmlComposition(html: string): HtmlComposition {
  const htmlAttrs = parseAttributes(findHtmlAttrs(html) ?? "");
  const main = findMainComposition(html);
  if (!main) {
    throw new Error("HTML snippet import requires a <main> composition with data-composition-id or data-shellx-motion-schema metadata.");
  }
  const mainAttrs = parseAttributes(main.attrs);
  const hasCompositionMetadata = Boolean(
    readStringAttr(mainAttrs, "data-composition-id")
      ?? readStringAttr(mainAttrs, "data-shellx-motion-schema")
      ?? readStringAttr(htmlAttrs, "data-shellx-motion-schema")
  );
  if (!hasCompositionMetadata) {
    throw new Error("HTML snippet import requires a <main> composition with data-composition-id or data-shellx-motion-schema metadata.");
  }
  return {
    htmlAttrs,
    mainAttrs,
    mainInner: main.innerHtml,
    title: readTitle(html) ?? readStringAttr(mainAttrs, "data-composition-id") ?? "HTML Snippet",
    mainStyle: parseStyle(readStringAttr(mainAttrs, "style") ?? "")
  };
}

/**
 * First `<main …>…</main>` block, or null.
 *
 * Uses the bounded pair scanner instead of `/<main\b([^>]*)>([\s\S]*?)<\/main>/i`: the lazy inner
 * group made an unterminated `<main` re-scan the whole 8 MiB-permitted document. Same span, same
 * captures — the attribute text still runs to the first `>` with no quote awareness.
 */
function findMainComposition(html: string): { attrs: string; innerHtml: string } | null {
  const [pair] = scanMarkupTagPairs(html, "main");
  return pair ? { attrs: pair.attrText, innerHtml: pair.innerText } : null;
}

/**
 * Attribute text of the first `<html …>` tag, or null.
 *
 * `/<html\b([^>]*)>/i` took 28.6 s on 800 KB of `<html` openers with no `>`: the greedy class ran to
 * the end and backtracked for every opener. The bounded scan drops a self-closing `/`, which the
 * caller cannot observe — it only feeds the result to {@link parseAttributes}.
 */
function findHtmlAttrs(html: string): string | null {
  const [tag] = scanMarkupOpenTags(html, "html");
  return tag === undefined ? null : tag.attrText;
}

function readTitle(html: string): string | undefined {
  const [pair] = scanMarkupTagPairs(html, "title");
  return pair === undefined ? undefined : collapseWhitespace(decodeHtml(stripTags(pair.innerText)));
}

/**
 * Locate every element that carries a `data-layer-id` attribute.
 *
 * Replaces a two-branch regex whose inner `([\s\S]*?)<\/\1>` re-scanned the rest of the document for
 * every candidate element: 819 KB of `<b data-layer-id="a">` with no close tags blocked the event
 * loop for 3.07 s, and the importer accepts up to 8 MiB. This walks the document once and resolves
 * each `data-layer-id` occurrence once, so an import stays linear in the file size.
 *
 * Preserved from the old regex: the greedy attribute prefix picks the *last* `data-layer-id` in an
 * opening tag; the closing tag is matched case-sensitively against the exact opening name; an
 * element with no closing tag is still imported with empty inner HTML. Deliberately not preserved:
 * the old pattern could also match a truncated tag name (`<a-data-layer-id="x">` yielded the tag
 * name `a-`), which is unreachable for well-formed markup and produced garbage layer types.
 */
function readHtmlLayerElements(html: string): HtmlLayerElement[] {
  const lower = asciiLowerCase(html);
  const lowerIndex = new ForwardIndex(lower);
  const rawIndex = new ForwardIndex(html);
  const candidates = layerIdCandidates(html, lower, lowerIndex);
  const elements: HtmlLayerElement[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = lowerIndex.find("<", cursor);
    if (start < 0) break;
    const opening = readLayerOpenTag(html, lowerIndex, candidates, start);
    if (!opening) {
      cursor = start + 1;
      continue;
    }
    const closer = `</${opening.tagName}>`;
    const closeStart = rawIndex.find(closer, opening.bodyStart);
    const attrs = parseAttributes(opening.attrText);
    if (opening.attrText) {
      elements.push({
        tagName: opening.tagName.toLowerCase(),
        attrs,
        innerHtml: closeStart < 0 ? "" : html.slice(opening.bodyStart, closeStart),
        style: parseStyle(readStringAttr(attrs, "style") ?? "")
      });
    }
    cursor = closeStart < 0 ? opening.bodyStart : closeStart + closer.length;
  }
  return elements;
}

/** A resolved `data-layer-id="…"` occurrence and where the opening tag holding it ends. */
interface LayerIdCandidate {
  /** Index of the `d` in `data-layer-id`. */
  at: number;
  /** Index just past the `>` that ends the opening tag, or -1 when the tag is never terminated. */
  bodyStart: number;
  /** Slot of the nearest usable candidate at or before this one, so lookup never walks the list. */
  previousUsable: number;
}

/** `[a-zA-Z]` — the characters an HTML tag name may start with. */
function isTagNameStart(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/** `[\w:-]` — the characters an HTML tag name may continue with. */
function isTagNameRest(code: number): boolean {
  return isMarkupWordCharCode(code) || code === 0x3a || code === 0x2d;
}

/**
 * Resolve every `\bdata-layer-id\s*=\s*("…"|'…')` occurrence in the document, once.
 *
 * Doing this up front is what keeps the scan linear: without it, a document packed with `<b` openers
 * would rediscover the same attributes from every opener.
 */
function layerIdCandidates(html: string, lower: string, index: ForwardIndex): LayerIdCandidate[] {
  const candidates: LayerIdCandidate[] = [];
  let at = lower.indexOf("data-layer-id");
  while (at >= 0) {
    if (at === 0 || !isMarkupWordCharCode(html.charCodeAt(at - 1))) {
      const bodyStart = layerIdTagBodyStart(html, index, at + "data-layer-id".length);
      const previousUsable = bodyStart >= 0
        ? candidates.length
        : candidates[candidates.length - 1]?.previousUsable ?? -1;
      candidates.push({ at, bodyStart, previousUsable });
    }
    at = lower.indexOf("data-layer-id", at + 1);
  }
  return candidates;
}

/** Parse `\s*=\s*("…"|'…')` after a `data-layer-id` name and return the enclosing tag's body start. */
function layerIdTagBodyStart(html: string, index: ForwardIndex, from: number): number {
  let scan = from;
  while (scan < html.length && isHtmlSpaceCode(html.charCodeAt(scan))) scan += 1;
  if (html[scan] !== "=") return -1;
  scan += 1;
  while (scan < html.length && isHtmlSpaceCode(html.charCodeAt(scan))) scan += 1;
  const quote = html[scan];
  if (quote !== "\"" && quote !== "'") return -1;
  const valueEnd = html.indexOf(quote, scan + 1);
  if (valueEnd < 0) return -1;
  const tagEnd = index.find(">", valueEnd + 1);
  return tagEnd < 0 ? -1 : tagEnd + 1;
}

/** ASCII whitespace plus the code points JavaScript's `\s` accepts. */
function isHtmlSpaceCode(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 || code === 0xfeff
    || code === 0x1680 || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;
}

/** Opening tag accepted by {@link readHtmlLayerElements}. */
interface LayerOpenTag {
  tagName: string;
  attrText: string;
  bodyStart: number;
}

/** Read the `<name …data-layer-id="…"…>` opening tag at `start`, or null when it does not match. */
function readLayerOpenTag(
  html: string,
  index: ForwardIndex,
  candidates: LayerIdCandidate[],
  start: number
): LayerOpenTag | null {
  if (!isTagNameStart(html.charCodeAt(start + 1))) return null;
  let nameEnd = start + 2;
  while (nameEnd < html.length && isTagNameRest(html.charCodeAt(nameEnd))) nameEnd += 1;
  // `\b` after the captured name: a run ending in `:` or `-` has its boundary before those.
  while (nameEnd > start + 2 && !isMarkupWordCharCode(html.charCodeAt(nameEnd - 1))) nameEnd -= 1;
  const tagEnd = index.find(">", nameEnd);
  if (tagEnd < 0) return null;
  const slot = lastCandidateBefore(candidates, tagEnd);
  const usable = slot < 0 ? -1 : (candidates[slot] as LayerIdCandidate).previousUsable;
  const candidate = usable < 0 ? undefined : candidates[usable];
  if (!candidate || candidate.at < nameEnd) return null;
  return {
    tagName: html.slice(start + 1, nameEnd),
    attrText: html.slice(nameEnd, candidate.bodyStart - 1),
    bodyStart: candidate.bodyStart
  };
}

/** Slot of the last candidate strictly before `limit`, or -1. */
function lastCandidateBefore(candidates: LayerIdCandidate[], limit: number): number {
  let low = 0;
  let high = candidates.length - 1;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((candidates[mid] as LayerIdCandidate).at < limit) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function htmlElementToMotionLayer(element: HtmlLayerElement): ParsedHtmlLayer {
  const id = boundedHtmlId(readStringAttr(element.attrs, "data-layer-id") ?? slugId(element.tagName), "layer id");
  const type = readStringAttr(element.attrs, "data-layer-type") ?? inferLayerType(element.tagName);
  if (!SUPPORTED_LAYER_TYPES.has(type)) {
    return {
      layer: null,
      lossiness: [{
        path: `html.layers.${id}`,
        layerId: id,
        feature: `layer.type.${type}`,
        reason: `HTML snippet import does not map ${type} layers yet.`
      }]
    };
  }
  const lossiness = htmlImportLayerLossiness(element, id, type);
  if (lossiness.some((finding) => finding.feature.startsWith("html.tag."))) return { layer: null, lossiness };

  const startMs = readNumberAttr(element.attrs, "data-start") ?? readCssTimeMs(element.style["animation-delay"]) ?? 0;
  const durationMs = readPositiveAttr(element.attrs, "data-duration") ?? readCssTimeMs(element.style["animation-duration"]) ?? 1000;
  const layer: MotionLayer = {
    id,
    type,
    startMs,
    durationMs,
    transform: readLayerTransform(element.style)
  };

  if (type === "text" || type === "caption") {
    layer.text = collapseWhitespace(decodeHtml(stripTags(element.innerHtml)));
    const style = readTextLayerStyle(element.style);
    if (Object.keys(style).length > 0) layer.style = style;
  }

  if (type === "shape") {
    const shape = readShapeKind(element.style);
    layer.shape = shape.kind;
    const style = readShapeLayerStyle(element.style, shape.radius);
    if (Object.keys(style).length > 0) layer.style = style;
  }

  if (type === "image" || type === "video") {
    const source = readStringAttr(element.attrs, "src");
    const assetRef = source ? normalizeHtmlAssetRef(source, type) : null;
    if (!source || !assetRef) {
      lossiness.push({
        path: `html.layers.${id}.src`,
        layerId: id,
        feature: "media.source.local-package",
        reason: !source
          ? "HTML media import requires a package-relative src value."
          : "HTML media import refuses remote, executable, data/blob, traversal, query/hash, and unsupported-extension src values."
      });
      return { layer: null, lossiness };
    }
    layer.source = assetRef;
    return {
      layer,
      assetRef,
      lossiness
    };
  }

  return { layer, lossiness };
}

function baseLayerStyle(layer: MotionLayer): string {
  const transform = layer.transform ?? {};
  const x = readNumber(transform.x) ?? 0;
  const y = readNumber(transform.y) ?? 0;
  const width = readNumber(transform.width) ?? readNumber(layer.width) ?? readNumber(layer.style?.width);
  const height = readNumber(transform.height) ?? readNumber(layer.height) ?? readNumber(layer.style?.height);
  const opacity = readNumber(transform.opacity) ?? readNumber(layer.opacity);
  const scale = readNumber(transform.scale);
  const rotation = readNumber(transform.rotation);
  const transforms = [
    scale !== undefined ? `scale(${scale})` : "",
    rotation !== undefined ? `rotate(${rotation}deg)` : ""
  ].filter(Boolean);
  return [
    `left: ${cssNumber(x)}px;`,
    `top: ${cssNumber(y)}px;`,
    width !== undefined ? `width: ${cssNumber(width)}px;` : "",
    height !== undefined ? `height: ${cssNumber(height)}px;` : "",
    opacity !== undefined ? `opacity: ${cssNumber(opacity)};` : "",
    transforms.length > 0 ? `transform: ${transforms.join(" ")};` : "",
    `animation-delay: ${cssNumber(layer.startMs)}ms;`,
    `animation-duration: ${cssNumber(layer.durationMs)}ms;`
  ].filter(Boolean).join(" ");
}

function readLayerTransform(style: Record<string, string>): MotionLayer["transform"] {
  const cssTransform = readCssTransform(style.transform);
  return cleanRecord({
    x: readCssNumber(style.left),
    y: readCssNumber(style.top),
    width: readCssNumber(style.width),
    height: readCssNumber(style.height),
    opacity: readNumberString(style.opacity),
    scale: cssTransform.scale,
    rotation: cssTransform.rotation
  });
}

function readTextLayerStyle(style: Record<string, string>): Record<string, unknown> {
  return cleanRecord({
    color: readCssColor(style.color),
    fontSize: readCssNumber(style["font-size"]),
    fontWeight: readNumberString(style["font-weight"]),
    textAlign: readTextAlign(style["text-align"])
  });
}

function readShapeLayerStyle(style: Record<string, string>, radius: number | undefined): Record<string, unknown> {
  return cleanRecord({
    fill: readCssColor(style.background) ?? readCssColor(style["background-color"]),
    radius
  });
}

function readShapeKind(style: Record<string, string>): { kind: string; radius?: number } {
  const radius = style["border-radius"];
  if (radius?.trim() === "50%") return { kind: "ellipse" };
  const numericRadius = readCssNumber(radius);
  return numericRadius && numericRadius > 0
    ? { kind: "rounded-rect", radius: numericRadius }
    : { kind: "rect" };
}

function inferLayerType(tagName: string): string {
  if (tagName === "img") return "image";
  if (tagName === "video") return "video";
  return "text";
}

function htmlExportLayerLossiness(layer: MotionLayer): HtmlSnippetLossinessFinding[] {
  const findings: HtmlSnippetLossinessFinding[] = [];
  const record = layer as unknown as Record<string, unknown>;
  if ((layer.type === "image" || layer.type === "video") && !htmlExportMediaSource(layer)) {
    findings.push({
      path: `motion.layers.${layer.id}.source`,
      layerId: layer.id,
      feature: "media.source.local-package",
      reason: "HTML snippet export embeds only bounded package-relative image/video sources with supported extensions."
    });
  }
  for (const property of [
    "keyframes", "effects", "gradient", "emitter", "shader", "scene3d", "environment", "mask", "matte",
    "crop", "transitions", "textFit", "depth", "fit", "trimStartMs", "trimEndMs", "playbackRate", "loop",
    "blendMode", "trackId", "visible", "enabled"
  ]) {
    const isHiddenState = (property === "visible" || property === "enabled") && record[property] === false;
    if (!isHiddenState && !hasMeaningfulValue(record[property], property === "blendMode" ? "normal" : undefined)) continue;
    findings.push({
      path: `motion.layers.${layer.id}.${property}`,
      layerId: layer.id,
      feature: `layer.${property}`,
      reason: `HTML snippet export does not preserve ${property}; the receipt records this visual or timing loss.`
    });
  }
  const transform = readRecord(layer.transform);
  for (const property of Object.keys(transform)) {
    if (["x", "y", "width", "height", "opacity", "scale", "rotation"].includes(property)) continue;
    findings.push({
      path: `motion.layers.${layer.id}.transform.${property}`,
      layerId: layer.id,
      feature: `transform.${property}`,
      reason: `HTML snippet export does not preserve transform.${property}.`
    });
  }
  const style = readRecord(layer.style);
  const allowedStyle = layer.type === "text" || layer.type === "caption"
    ? new Set(["color", "fontSize", "fontWeight", "textAlign", "width"])
    : layer.type === "shape"
      ? new Set(["fill", "radius", "borderRadius"])
      : new Set<string>();
  for (const property of Object.keys(style)) {
    if (allowedStyle.has(property)) continue;
    findings.push({
      path: `motion.layers.${layer.id}.style.${property}`,
      layerId: layer.id,
      feature: `style.${property}`,
      reason: `HTML snippet export does not preserve style.${property}.`
    });
  }
  return findings;
}

function htmlExportMediaSource(layer: MotionLayer): string | null {
  if (layer.type !== "image" && layer.type !== "video") return null;
  const source = readString(layer.source) ?? readString(layer.src) ?? readString(layer.assetRef);
  return source ? normalizeHtmlAssetRef(source, layer.type) : null;
}

function htmlDocumentLossiness(html: string, composition: HtmlComposition): HtmlSnippetLossinessFinding[] {
  const findings: HtmlSnippetLossinessFinding[] = [];
  const add = (feature: string, reason: string, path = "html"): void => {
    findings.push({ path, layerId: "composition", feature, reason });
  };
  if (/<script\b/i.test(html)) add("html.script.discarded", "HTML scripts are never executed or imported into Motion.");
  if (/<style\b/i.test(html)) add("html.stylesheet.discarded", "Stylesheet rules are not evaluated; only bounded inline declarations are imported.");
  if (hasExternalStylesheetLink(html)) {
    add("html.externalStylesheet.discarded", "External stylesheets are not fetched or evaluated during HTML import.");
  }
  if (/\son[a-z0-9_-]+\s*=/i.test(html)) add("html.eventHandler.discarded", "Inline event handlers are never executed or imported into Motion.");
  const allowedCompositionStyle = new Set(["width", "height", "background", "background-color"]);
  for (const property of Object.keys(composition.mainStyle)) {
    if (allowedCompositionStyle.has(property)) continue;
    add("html.composition.css", `Composition CSS property ${property} is not represented by the bounded importer.`, `html.composition.style.${property}`);
  }
  return findings;
}

/**
 * True when the document contains a `<link … rel=…stylesheet…>`.
 *
 * Replaces `/<link\b[^>]*\brel\s*=\s*(?:["'][^"']*stylesheet|stylesheet\b)/i.test(html)`. The
 * `[^>]*\brel` prefix made the engine re-walk each opening tag from every `<link` inside it: 800 KB
 * of `<link` repeated took 31.0 s to answer `false`. Here the `rel=` hits are enumerated once and
 * each `<link` opener is charged only for finding its own `>`.
 *
 * Equivalent by construction: the old `[^>]*` could only reach a `rel=` that has no `>` in front of
 * it, which is exactly "the hit starts at or before the opener's first `>`". Openers that share one
 * `>` share one check because the earliest of them has the widest reach.
 */
function hasExternalStylesheetLink(html: string): boolean {
  const lower = asciiLowerCase(html);
  const relStylesheet = /\brel\s*=\s*(?:["'][^"']*stylesheet|stylesheet\b)/gi;
  const relHits: number[] = [];
  let hit = relStylesheet.exec(html);
  while (hit) {
    relHits.push(hit.index);
    hit = relStylesheet.exec(html);
  }
  if (relHits.length === 0) return false;
  let cursor = 0;
  let nextHit = 0;
  while (cursor < html.length) {
    const opener = lower.indexOf("<link", cursor);
    if (opener < 0) return false;
    const attrStart = opener + 5;
    if (isMarkupWordCharCode(html.charCodeAt(attrStart))) {
      cursor = opener + 1;
      continue;
    }
    const tagEnd = html.indexOf(">", attrStart);
    const reach = tagEnd < 0 ? html.length : tagEnd;
    while (nextHit < relHits.length && (relHits[nextHit] as number) < attrStart) nextHit += 1;
    if (nextHit < relHits.length && (relHits[nextHit] as number) <= reach) return true;
    cursor = reach + 1;
  }
  return false;
}

function htmlImportLayerLossiness(
  element: HtmlLayerElement,
  layerId: string,
  type: string
): HtmlSnippetLossinessFinding[] {
  const findings: HtmlSnippetLossinessFinding[] = [];
  const unsafeTag = new Set(["script", "style", "link", "iframe", "object", "embed"]);
  if (unsafeTag.has(element.tagName)) {
    findings.push({
      path: `html.layers.${layerId}`,
      layerId,
      feature: `html.tag.${element.tagName}.discarded`,
      reason: `HTML ${element.tagName} elements are never executed or mapped to Motion layers.`
    });
  }
  const allowed = new Set(["left", "top", "width", "height", "opacity", "transform", "animation-delay", "animation-duration"]);
  if (type === "text" || type === "caption") {
    for (const property of ["color", "font-size", "font-weight", "text-align"]) allowed.add(property);
  } else if (type === "shape") {
    for (const property of ["background", "background-color", "border-radius"]) allowed.add(property);
  }
  for (const property of Object.keys(element.style)) {
    if (allowed.has(property)) continue;
    findings.push({
      path: `html.layers.${layerId}.style.${property}`,
      layerId,
      feature: `css.${property}.discarded`,
      reason: `Inline CSS property ${property} is outside the bounded HTML-to-Motion mapping.`
    });
  }
  const parsedTransform = readCssTransform(element.style.transform);
  if (element.style.transform && !parsedTransform.valid) {
    findings.push({
      path: `html.layers.${layerId}.style.transform`,
      layerId,
      feature: "css.transform.discarded",
      reason: "Only finite scale(...) and rotate(...deg) transform functions are imported."
    });
  }
  for (const attribute of Object.keys(element.attrs)) {
    if (!/^on[a-z0-9_-]+$/i.test(attribute)) continue;
    findings.push({
      path: `html.layers.${layerId}.attributes.${attribute}`,
      layerId,
      feature: "html.eventHandler.discarded",
      reason: `Inline event handler ${attribute} is never executed or imported.`
    });
  }
  return findings;
}

function hasMeaningfulValue(value: unknown, ignoredString?: string): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.length > 0 && value !== ignoredString;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function textStyle(layer: MotionLayer): string {
  const style = layer.style ?? {};
  return [
    `color: ${cssColor(readString(style.color) ?? readString(layer.color) ?? "#ffffff")};`,
    readNumber(style.fontSize) !== undefined ? `font-size: ${cssNumber(readNumber(style.fontSize))}px;` : "",
    readNumber(style.fontWeight) !== undefined ? `font-weight: ${cssNumber(readNumber(style.fontWeight))};` : "",
    readNumber(style.width) !== undefined ? `width: ${cssNumber(readNumber(style.width))}px;` : "",
    readString(style.textAlign) ? `text-align: ${escapeCssIdentifier(readString(style.textAlign))};` : ""
  ].filter(Boolean).join(" ");
}

function shapeStyle(layer: MotionLayer): string {
  const style = layer.style ?? {};
  const shape = readString(layer.shape) ?? "rect";
  return [
    `background: ${cssColor(readString(style.fill) ?? readString(layer.fill) ?? "#ffffff")};`,
    shape === "ellipse" ? "border-radius: 50%;" : "",
    shape === "rounded-rect" ? `border-radius: ${cssNumber(readNumber(style.radius) ?? readNumber(style.borderRadius) ?? 12)}px;` : ""
  ].filter(Boolean).join(" ");
}

async function mediaSource(pkg: MotionPackage, layer: MotionLayer): Promise<string> {
  const source = readString(layer.source) ?? readString(layer.src) ?? readString(layer.assetRef);
  if (!source) return "";
  if (!normalizeHtmlAssetRef(source, layer.type)) throw new Error(`HTML snippet export requires a bounded package-relative source on layer ${layer.id}.`);
  if (!pkg.manifest.assets.includes(source)) throw new Error(`HTML snippet export media source is not declared in manifest.assets on layer ${layer.id}.`);
  const packageRoot = await realpath(pkg.root);
  const assetPath = await realpath(resolvePackageAsset(pkg, source));
  if (!pathIsInside(packageRoot, assetPath)) throw new Error(`HTML snippet export media source escapes packageRoot on layer ${layer.id}.`);
  if (extname(assetPath).toLowerCase() !== extname(source).toLowerCase()) {
    throw new Error(`HTML snippet export media source extension changes through a symlink on layer ${layer.id}.`);
  }
  const info = await stat(assetPath);
  if (!info.isFile()) throw new Error(`HTML snippet export media source must be a regular file on layer ${layer.id}.`);
  if (info.size > MAX_HTML_ASSET_BYTES) throw new Error(`HTML snippet export media source exceeds the 256 MiB limit on layer ${layer.id}.`);
  const buffer = await readFile(assetPath);
  assertSafeHtmlMediaAsset(assetPath, buffer, `HTML snippet export layer ${layer.id}`);
  return `data:${mediaTypeFor(assetPath)};base64,${buffer.toString("base64")}`;
}

async function assertEmptyOrCreate(outDir: string): Promise<void> {
  try {
    const info = await stat(outDir);
    if (!info.isDirectory()) throw new Error("HTML snippet export outDir must be a directory or absent.");
    const entries = await readdir(outDir);
    if (entries.length > 0) throw new Error("HTML snippet export outDir must be empty or absent before export.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(outDir, { recursive: true });
      return;
    }
    throw error;
  }
}

function assertNotInsidePackage(packageRoot: string, outDir: string): void {
  const root = resolve(packageRoot);
  const candidate = resolve(outDir);
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate === root || candidate.startsWith(rootWithSep)) {
    throw new Error("HTML snippet export outDir must be outside packageRoot.");
  }
}

function mediaTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webm":
      return "video/webm";
    case ".mp4":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringAttr(attrs: Record<string, string>, key: string): string | undefined {
  const value = attrs[key.toLowerCase()];
  return value && value.length > 0 ? value : undefined;
}

function readNumberAttr(attrs: Record<string, string>, key: string): number | undefined {
  return readNumberString(readStringAttr(attrs, key));
}

function readPositiveAttr(attrs: Record<string, string>, key: string): number | undefined {
  const value = readNumberAttr(attrs, key);
  return value !== undefined && value > 0 ? value : undefined;
}

function readNumberString(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readCssNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(-?\d+(?:\.\d+)?)(?:px)?$/i.exec(value.trim());
  const numberText = match?.[1];
  return numberText === undefined ? undefined : readNumberString(numberText);
}

function readCssTransform(value: string | undefined): { scale?: number; rotation?: number; valid: boolean } {
  if (!value?.trim()) return { valid: true };
  const result: { scale?: number; rotation?: number; valid: boolean } = { valid: true };
  let consumed = "";
  for (const match of scanCssFunctions(value)) {
    consumed += match.text;
    const name = match.name.toLowerCase();
    const argument = match.argument.trim();
    if (name === "scale" && result.scale === undefined) {
      const scale = readNumberString(argument);
      if (scale !== undefined && scale > 0) result.scale = scale;
      else result.valid = false;
    } else if (name === "rotate" && result.rotation === undefined) {
      const rotationText = /^(-?\d+(?:\.\d+)?)deg$/i.exec(argument)?.[1];
      const rotation = readNumberString(rotationText);
      if (rotation !== undefined) result.rotation = rotation;
      else result.valid = false;
    } else {
      result.valid = false;
    }
  }
  if (consumed.length === 0 || value.replace(/\s+/g, "") !== consumed.replace(/\s+/g, "")) result.valid = false;
  return result.valid ? result : { valid: false };
}

/** One `name(argument)` term found by {@link scanCssFunctions}. */
interface CssFunctionTerm {
  /** Whole term, as the old `match[0]` was. */
  text: string;
  /** Function name, case as written. */
  name: string;
  /** Text between the parentheses. */
  argument: string;
}

/**
 * Linear replacement for `/([a-z-]+)\(([^)]*)\)/gi` over a CSS value.
 *
 * The regex was quadratic on a long run of letters that never reaches a `(` — 400 KB of `a` in a
 * `style="transform:…"` attribute took 52.6 s, and the importer accepts an 8 MiB snippet. Skipping a
 * failed run in one step is exactly equivalent: `(` is not a name character, so the run's end is the
 * only place the `\(` could ever have matched, and every start inside the run shares that verdict.
 */
function scanCssFunctions(value: string): CssFunctionTerm[] {
  const terms: CssFunctionTerm[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    if (!isCssNameCode(value.charCodeAt(cursor))) {
      cursor += 1;
      continue;
    }
    let nameEnd = cursor;
    while (nameEnd < value.length && isCssNameCode(value.charCodeAt(nameEnd))) nameEnd += 1;
    if (value[nameEnd] !== "(") {
      cursor = nameEnd;
      continue;
    }
    const close = value.indexOf(")", nameEnd + 1);
    if (close < 0) {
      cursor = nameEnd;
      continue;
    }
    terms.push({
      text: value.slice(cursor, close + 1),
      name: value.slice(cursor, nameEnd),
      argument: value.slice(nameEnd + 1, close)
    });
    cursor = close + 1;
  }
  return terms;
}

/** `[a-z-]` under the `i` flag — the characters the old CSS function-name class accepted. */
function isCssNameCode(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || code === 0x2d;
}

function readCssTimeMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const ms = /^(-?\d+(?:\.\d+)?)ms$/i.exec(trimmed)?.[1];
  if (ms !== undefined) return readNumberString(ms);
  const seconds = /^(-?\d+(?:\.\d+)?)s$/i.exec(trimmed)?.[1];
  const parsedSeconds = seconds === undefined ? undefined : readNumberString(seconds);
  return parsedSeconds === undefined ? undefined : parsedSeconds * 1000;
}

function readCssColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return /^#[0-9a-f]{3,8}$/i.test(trimmed) || /^[a-z]+$/i.test(trimmed) ? trimmed : undefined;
}

function readTextAlign(value: string | undefined): string | undefined {
  return value && /^(left|right|center|justify|start|end)$/i.test(value.trim()) ? value.trim().toLowerCase() : undefined;
}

function numberAttr(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function cssNumber(value: number | undefined): string {
  return numberAttr(value ?? 0);
}

function cssColor(value: string): string {
  return /^#[0-9a-f]{3,8}$/i.test(value) || /^[a-z]+$/i.test(value) ? value : "#000000";
}

function escapeCssIdentifier(value: string | undefined): string {
  return value && /^[a-z-]+$/i.test(value) ? value : "left";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

/**
 * Read quoted attributes from an opening tag's attribute text.
 *
 * The regex this replaced was quadratic on a long run of attribute-name characters that never
 * reaches an `=`, which an 8 MiB snippet can supply; the bounded scanner resolves each run once.
 * Names are still lowercased and duplicates still keep the last value.
 */
function parseAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const attribute of scanMarkupAttributes(input)) {
    attrs[attribute.name.toLowerCase()] = decodeHtml(attribute.value);
  }
  return attrs;
}

function parseStyle(input: string): Record<string, string> {
  const style: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const declaration of input.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator <= 0) continue;
    const key = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (key && value) style[key] = value;
  }
  return style;
}

/** Drop tags from a text fragment. Bounded scan; `/<[^>]*>/g` was quadratic on unterminated tags. */
function stripTags(input: string): string {
  return replaceMarkupTags(input, "", true);
}

function decodeHtml(input: string): string {
  return input.replace(/&(amp|lt|gt|quot|#39);/g, (_entity, code: string) => {
    switch (code) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return "\"";
      case "#39":
        return "'";
      default:
        return `&${code};`;
    }
  });
}

function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function slugId(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || "untitled";
}

function maxLayerEndMs(layers: MotionLayer[]): number | undefined {
  if (layers.length === 0) return undefined;
  return Math.max(...layers.map((layer) => layer.startMs + layer.durationMs));
}

function normalizeHtmlAssetRef(value: string, type: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || /[\u0000-\u001f\u007f\\?#%]/.test(trimmed)) return null;
  if (trimmed.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  const normalized = posix.normalize(trimmed);
  if (normalized !== trimmed || normalized === "." || normalized.startsWith("../")) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  const extension = extname(normalized).toLowerCase();
  const allowed = type === "video" ? VIDEO_ASSET_EXTENSIONS : IMAGE_ASSET_EXTENSIONS;
  return allowed.has(extension) ? normalized : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function cleanRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedHtmlId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`HTML snippet import ${label} must be 1-128 safe id characters.`);
  }
  return value;
}

function boundedHtmlText(value: string, maxLength: number, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`HTML snippet import ${label} must be 1-${maxLength} printable characters.`);
  }
  return trimmed;
}

/**
 * Reads, validates and stages every declared snippet asset, binding each asset's staged bytes to
 * the file DESCRIPTOR that was validated rather than to its path.
 *
 * Why a descriptor, and why staging happens in the same iteration as validation:
 *
 * The previous shape validated every asset in one pass and copied them all in a second pass with
 * `copyFile(sourcePath, destination)`. `copyFile` re-resolves the path and follows symlinks, so an
 * attacker who controls the snippet directory (the whole point of importing an untrusted snippet)
 * could pass phase one with a benign in-root regular file and replace that path with a symlink to
 * any host file before phase two ran. The copy then staged host bytes into the package under an
 * approved asset name, defeating BOTH the `pathIsInside` containment check and the declared-
 * extension binding below, and the recorded size described the pre-swap file. The window spanned
 * all of phase one, so a single large asset was enough to widen it to seconds. The `.svg` branch
 * had already closed this for SVG only, by staging the exact buffer it validated; every other
 * extension was still path-copied.
 *
 * Opening the file once and streaming FROM THE DESCRIPTOR removes the second resolution entirely:
 * a post-open swap cannot change which inode the descriptor points at, so the bytes that land in
 * the package are the bytes that were size-checked and (for SVG) content-checked. `O_NOFOLLOW`
 * plus the dev/ino re-verification in {@link openValidatedSnippetAsset} closes the narrower
 * realpath->open window the same way `hashFile` in core does.
 *
 * Staging inside the same iteration is a descriptor-budget decision, not a stylistic one: holding
 * one descriptor per asset until a second pass would keep up to MAX_HTML_LAYER_COUNT (1000)
 * descriptors open at once, four times macOS's default 256-descriptor soft limit. The all-or-
 * nothing property the two-pass shape gave for free is restored explicitly instead — anything
 * already staged is removed before a failure propagates, so a rejected import still leaves the
 * package directory as empty as it was found.
 */
async function stageHtmlSnippetAssets(input: {
  htmlPath: string;
  packageDir: string;
  assetRefs: string[];
}): Promise<Array<{ path: string; sha256: string; size: number }>> {
  const sourceRoot = await realpath(dirname(input.htmlPath));
  const staged: Array<{ path: string; sha256: string; size: number }> = [];
  const written: string[] = [];
  let totalBytes = 0;
  try {
    for (const assetRef of input.assetRefs) {
      // The declared extension is the name the asset is STAGED under and the name the browser later
      // types (renderer-browser keys image/svg+xml off the on-disk `.svg` suffix). Sanitizer
      // selection therefore has to key off this declared name, never the realpath target's name.
      const declaredExtension = extname(assetRef).toLowerCase();
      const destination = resolve(input.packageDir, ...assetRef.split("/"));
      if (!pathIsInside(input.packageDir, destination)) throw new Error(`HTML snippet import asset destination escapes packageDir: ${assetRef}.`);
      const handle = await openValidatedSnippetAsset(sourceRoot, assetRef, declaredExtension);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error(`HTML snippet import asset must be a regular file: ${assetRef}.`);
        if (info.size > MAX_HTML_ASSET_BYTES) throw new Error(`HTML snippet import asset exceeds the 256 MiB limit: ${assetRef}.`);
        totalBytes += info.size;
        if (totalBytes > MAX_HTML_TOTAL_ASSET_BYTES) throw new Error("HTML snippet import assets exceed the 512 MiB total limit.");
        await mkdir(dirname(destination), { recursive: true });
        written.push(destination);
        if (declaredExtension === ".svg") {
          // Read the descriptor once, validate those bytes, write those same bytes.
          const bytes = await handle.readFile();
          assertSafeHtmlMediaAsset(assetRef, bytes, `HTML snippet import asset ${assetRef}`);
          await writeFile(destination, bytes);
          staged.push({ path: assetRef, sha256: hashBuffer(bytes), size: bytes.byteLength });
        } else {
          // Streamed rather than buffered: a single asset may be up to 256 MiB.
          staged.push({ path: assetRef, ...await stageSnippetAssetFromDescriptor(handle, destination, info.size, assetRef) });
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
    return staged;
  } catch (error) {
    await Promise.all(written.map((path) => rm(path, { force: true }).catch(() => undefined)));
    throw error;
  }
}

/**
 * Opens one declared snippet asset for staging, refusing everything that would let the opened
 * inode differ from the one the containment and extension rules were checked against.
 *
 * The order is deliberate: realpath first (so containment is judged against what the filesystem
 * actually serves, not a lexical path), then `O_NOFOLLOW` on that canonical path (so a symlink
 * swapped in after the realpath cannot be followed), then a dev/ino comparison between the opened
 * descriptor and an `lstat` of the same path (so a regular-file swap between realpath and open is
 * detected rather than staged). Mirrors the identity re-verification `hashFile` performs in core.
 *
 * Those three still leave a window, and the last step closes it: `O_NOFOLLOW` constrains only the
 * FINAL path component, so replacing a PARENT directory with a symlink between the realpath and
 * the open would have the kernel resolve the new parent and hand back a descriptor for a file
 * outside the source root — with an `lstat` of the same path agreeing, because it resolves the
 * swapped parent too. Re-resolving the declared path AFTER the open and requiring it to name the
 * same path and the same inode the descriptor holds catches that in both directions: a parent left
 * swapped fails the containment/equality check, and a parent swapped and restored fails the
 * dev/ino check, because the restored path then names the original file rather than the opened one.
 *
 * @param sourceRoot Canonical directory the snippet was read from; assets may not escape it.
 * @param assetRef Package-relative asset path exactly as the snippet declared it.
 * @param declaredExtension Lowercased extension of `assetRef`; the resolved file must match it.
 * @returns An open read descriptor for the validated file. The caller owns closing it.
 * @throws When the asset is missing, escapes `sourceRoot`, changes extension through a symlink,
 *   or is swapped between resolution and open.
 */
async function openValidatedSnippetAsset(sourceRoot: string, assetRef: string, declaredExtension: string): Promise<FileHandle> {
  const sourceCandidate = resolve(sourceRoot, ...assetRef.split("/"));
  const sourcePath = await realpath(sourceCandidate).catch(() => {
    throw new Error(`HTML snippet import asset is missing: ${assetRef}.`);
  });
  if (!pathIsInside(sourceRoot, sourcePath)) {
    throw new Error(`HTML snippet import asset escapes the source directory: ${assetRef}.`);
  }
  // Reject in-root symlinks that swap the extension. An attacker-supplied snippet directory can
  // point `foo.svg` at a differently named regular file (e.g. `payload.bin`) that still lives
  // inside sourceRoot, so realpath containment passes. Keying validation off the resolved
  // target's extension would then skip the SVG checks while hostile SVG bytes were staged under
  // the declared `.svg` name — exactly what the browser interprets as image/svg+xml. Binding the
  // resolved extension to the declared one (mirrors the export guard in `mediaSource`) closes
  // that mismatch before any content is read or staged.
  if (extname(sourcePath).toLowerCase() !== declaredExtension) {
    throw new Error(`HTML snippet import asset extension changes through a symlink: ${assetRef}.`);
  }
  const linkInfo = await lstat(sourcePath);
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) {
    throw new Error(`HTML snippet import asset must be a regular file: ${assetRef}.`);
  }
  // O_NOFOLLOW is POSIX-only; on Windows `fsConstants.O_NOFOLLOW` is undefined and the bitwise OR
  // coerces it to 0, leaving a plain read-only open. The dev/ino check below still applies there.
  const handle = await open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => {
    throw new Error(`HTML snippet import asset could not be opened: ${assetRef}.`);
  });
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== linkInfo.dev || opened.ino !== linkInfo.ino) {
      throw new Error(`HTML snippet import asset changed before it could be staged: ${assetRef}.`);
    }
    const recheckPath = await realpath(sourceCandidate);
    const recheckInfo = await lstat(recheckPath);
    if (recheckPath !== sourcePath
      || !pathIsInside(sourceRoot, recheckPath)
      || recheckInfo.dev !== opened.dev
      || recheckInfo.ino !== opened.ino) {
      throw new Error(`HTML snippet import asset changed before it could be staged: ${assetRef}.`);
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  return handle;
}

/**
 * Streams an open asset descriptor into the package and returns the digest of the bytes actually
 * written, so the manifest's sha256 and size always describe the staged file rather than a
 * separate read of the source path.
 *
 * The read starts at offset 0 explicitly because the descriptor's position may already have moved,
 * and `autoClose: false` leaves ownership of the descriptor with the caller. A length that differs
 * from the `fstat` size means the file changed underneath the descriptor mid-copy, which fails the
 * import rather than recording a size the bytes do not match — the size caps are only meaningful
 * if the measured file and the copied file are the same bytes.
 */
async function stageSnippetAssetFromDescriptor(
  handle: FileHandle,
  destination: string,
  expectedSize: number,
  assetRef: string
): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  const source = handle.createReadStream({ start: 0, autoClose: false });
  source.on("data", (chunk: string | Buffer) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    hash.update(bytes);
    size += bytes.byteLength;
  });
  await pipeline(source, createWriteStream(destination));
  if (size !== expectedSize) {
    throw new Error(`HTML snippet import asset changed while it was being staged: ${assetRef}.`);
  }
  return { sha256: hash.digest("hex"), size };
}

function assertSafeHtmlMediaAsset(path: string, buffer: Buffer, label: string): void {
  if (extname(path).toLowerCase() !== ".svg") return;
  if (buffer.byteLength > MAX_HTML_SNIPPET_BYTES) throw new Error(`${label} SVG exceeds the 8 MiB limit.`);
  const source = buffer.toString("utf8");
  if (/<(?:script|foreignObject)\b/i.test(source)
    || /\son[a-z0-9_-]+\s*=/i.test(source)
    || /@import\b/i.test(source)
    || /(?:href|xlink:href)\s*=\s*["']\s*(?!#|data:image\/(?:png|jpeg|gif|webp)[;,])/i.test(source)
    || /url\(\s*["']?\s*(?!#|data:image\/(?:png|jpeg|gif|webp)[;,])/i.test(source)) {
    throw new Error(`${label} SVG contains executable or external-reference syntax.`);
  }
}

function pathIsInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedCandidate.startsWith(rootWithSep);
}

async function assertEmptyOrCreatePackageDir(packageDir: string): Promise<void> {
  try {
    const info = await stat(packageDir);
    if (!info.isDirectory()) throw new Error("HTML snippet import packageDir must be a directory or absent.");
    const entries = await readdir(packageDir);
    if (entries.length > 0) throw new Error("HTML snippet import packageDir must be empty or absent before import.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(packageDir, { recursive: true });
      return;
    }
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
};

/**
 * Internal scans exposed for their equivalence tests.
 *
 * These two replaced regexes without an oracle proving they behave the same.
 * `hasExternalStylesheetLink` drives emitted lossiness
 * receipts, so a wrong answer changes what an import claims about itself. They are exported here
 * rather than made public API: the tests need to reach them, and nothing else should.
 */
export const __boundedScanTestAccess = { hasExternalStylesheetLink, scanCssFunctions };
