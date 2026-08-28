import { join, resolve } from "node:path";
import {
  hashBuffer,
  loadMotionPackage,
  loadedPackageInputHashes,
  type MotionLayer,
  type MotionPackage,
  type OperationReceipt,
  type ReceiptArtifact
} from "@shellx-motion/core";
import {
  HTML_SNIPPET_FILE,
  HTML_SNIPPET_RECEIPT_FILE,
  SUPPORTED_LAYER_TYPES,
  type HtmlSnippetExportOptions,
  type HtmlSnippetExportResult,
  type HtmlSnippetLossinessFinding
} from "./html-snippet-types.js";
import { assertNotInsidePackage, mediaSource } from "./html-snippet-export-media.js";
import { hasExternalStylesheetLink } from "./html-snippet-import-markup.js";
import { HtmlSnippetOutputTransaction } from "./html-snippet-output-transaction.js";
import {
  cssColor,
  cssNumber,
  escapeAttr,
  escapeCssIdentifier,
  escapeHtml,
  normalizeHtmlAssetRef,
  numberAttr,
  readNumber,
  readRecord,
  readString,
  scanCssFunctions
} from "./html-snippet-shared.js";

export type {
  HtmlSnippetExportOptions,
  HtmlSnippetExportResult,
  HtmlSnippetImportOptions,
  HtmlSnippetImportResult,
  HtmlSnippetLossinessFinding
} from "./html-snippet-types.js";
export { importHtmlSnippetToMotionPackage } from "./html-snippet-import.js";

export async function writeHtmlSnippetExport(options: HtmlSnippetExportOptions): Promise<HtmlSnippetExportResult> {
  const pkg = await loadMotionPackage(options.packageRoot);
  const outDir = resolve(options.outDir);
  assertNotInsidePackage(pkg.root, outDir);
  const htmlPath = join(outDir, HTML_SNIPPET_FILE);
  const receiptPath = join(outDir, HTML_SNIPPET_RECEIPT_FILE);
  const inputHashes = loadedPackageInputHashes(pkg);
  if (!inputHashes?.["manifest.json"] || !inputHashes[pkg.manifest.motion]) {
    throw new Error("HTML snippet export requires loader-owned snapshot hashes for manifest.json and the Motion document.");
  }
  let transaction: HtmlSnippetOutputTransaction | undefined;
  try {
    transaction = await HtmlSnippetOutputTransaction.acquire(outDir);
    const { html, exportedLayerCount, lossiness } = await renderHtmlSnippet(pkg);
    const htmlBytes = Buffer.from(html, "utf8");
    const htmlSha256 = hashBuffer(htmlBytes);
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
      inputHashes: { ...inputHashes },
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
        lossiness: { unsupported: lossiness }
      },
      artifacts,
      warnings
    };
    await transaction.writeFile(HTML_SNIPPET_FILE, htmlBytes);
    await transaction.writeFile(HTML_SNIPPET_RECEIPT_FILE, jsonBytes(receipt));
    await transaction.publish();
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
  } catch (error) {
    await transaction?.abort().catch(() => undefined);
    throw error;
  }
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
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
    lossiness.push(...htmlExportLayerLossiness(layer));
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
      "  <main class=\"shellx-motion-composition\"",
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
    return `    <img class="shellx-motion-layer shellx-motion-media" ${attrs} alt="" src="${escapeAttr(await mediaSource(pkg, layer))}" style="${escapeAttr(style)}">`;
  }
  if (layer.type === "video") {
    return `    <video class="shellx-motion-layer shellx-motion-media" ${attrs} src="${escapeAttr(await mediaSource(pkg, layer))}" muted playsinline preload="auto" style="${escapeAttr(style)}"></video>`;
  }
  return "";
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
  const transforms = [scale !== undefined ? `scale(${scale})` : "", rotation !== undefined ? `rotate(${rotation}deg)` : ""].filter(Boolean);
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
    : layer.type === "shape" ? new Set(["fill", "radius", "borderRadius"]) : new Set<string>();
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

/** Internal scanner access pinned by differential tests; it is not a supported package API. */
export const __boundedScanTestAccess = { hasExternalStylesheetLink, scanCssFunctions };
