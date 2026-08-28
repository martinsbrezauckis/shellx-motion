import type { MotionDocument, MotionLayer, PackageManifest } from "@shellx-motion/core";
import {
  MAX_HTML_LAYER_COUNT,
  SUPPORTED_LAYER_TYPES,
  type HtmlComposition,
  type HtmlLayerElement,
  type HtmlSnippetLossinessFinding,
  type ParsedHtmlLayer,
  type ParsedHtmlSnippet
} from "./html-snippet-types.js";
import {
  boundedHtmlId,
  boundedHtmlText,
  cleanRecord,
  collapseWhitespace,
  decodeHtml,
  normalizeHtmlAssetRef,
  readCssColor,
  readCssNumber,
  readCssTimeMs,
  readCssTransform,
  readNumberAttr,
  readPositiveAttr,
  readStringAttr,
  readTextAlign,
  slugId,
  stripTags,
  uniqueStrings
} from "./html-snippet-shared.js";
import { hasExternalStylesheetLink, readHtmlComposition, readHtmlLayerElements } from "./html-snippet-import-markup.js";

export function parseHtmlSnippet(html: string, options: { createdBy: string }): ParsedHtmlSnippet {
  const composition = readHtmlComposition(html);
  const layerElements = readHtmlLayerElements(composition.mainInner);
  if (layerElements.length > MAX_HTML_LAYER_COUNT) throw new Error("HTML snippet import exceeds the 1000-layer limit.");
  const layers: MotionLayer[] = [];
  const lossiness: HtmlSnippetLossinessFinding[] = htmlDocumentLossiness(html, composition);
  const assetRefs: string[] = [];

  for (const element of layerElements) {
    const parsed = htmlElementToMotionLayer(element);
    lossiness.push(...parsed.lossiness);
    if (!parsed.layer) continue;
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
    readStringAttr(composition.mainAttrs, "data-composition-id") ?? `motion_html_${slugId(composition.title)}`,
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
  const manifest: PackageManifest = {
    schema: "shellx-motion/package-manifest@1",
    id: packageId,
    name: boundedHtmlText(composition.title, 256, "title"),
    motion: "motion.json",
    assets: uniqueStrings(assetRefs),
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
  const layer: MotionLayer = { id, type, startMs, durationMs, transform: readLayerTransform(element.style) };

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
    return { layer, assetRef, lossiness };
  }
  return { layer, lossiness };
}

function readLayerTransform(style: Record<string, string>): MotionLayer["transform"] {
  const cssTransform = readCssTransform(style.transform);
  return cleanRecord({
    x: readCssNumber(style.left),
    y: readCssNumber(style.top),
    width: readCssNumber(style.width),
    height: readCssNumber(style.height),
    opacity: readNumberAttr(style, "opacity"),
    scale: cssTransform.scale,
    rotation: cssTransform.rotation
  });
}

function readTextLayerStyle(style: Record<string, string>): Record<string, unknown> {
  return cleanRecord({
    color: readCssColor(style.color),
    fontSize: readCssNumber(style["font-size"]),
    fontWeight: readNumberAttr(style, "font-weight"),
    textAlign: readTextAlign(style["text-align"])
  });
}

function readShapeLayerStyle(style: Record<string, string>, radius: number | undefined): Record<string, unknown> {
  return cleanRecord({ fill: readCssColor(style.background) ?? readCssColor(style["background-color"]), radius });
}

function readShapeKind(style: Record<string, string>): { kind: string; radius?: number } {
  const radius = style["border-radius"];
  if (radius?.trim() === "50%") return { kind: "ellipse" };
  const numericRadius = readCssNumber(radius);
  return numericRadius && numericRadius > 0 ? { kind: "rounded-rect", radius: numericRadius } : { kind: "rect" };
}

function inferLayerType(tagName: string): string {
  if (tagName === "img") return "image";
  if (tagName === "video") return "video";
  return "text";
}

function htmlDocumentLossiness(html: string, composition: HtmlComposition): HtmlSnippetLossinessFinding[] {
  const findings: HtmlSnippetLossinessFinding[] = [];
  const add = (feature: string, reason: string, path = "html"): void => {
    findings.push({ path, layerId: "composition", feature, reason });
  };
  if (/<script\b/i.test(html)) add("html.script.discarded", "HTML scripts are never executed or imported into Motion.");
  if (/<style\b/i.test(html)) add("html.stylesheet.discarded", "Stylesheet rules are not evaluated; only bounded inline declarations are imported.");
  if (hasExternalStylesheetLink(html)) add("html.externalStylesheet.discarded", "External stylesheets are not fetched or evaluated during HTML import.");
  if (/\son[a-z0-9_-]+\s*=/i.test(html)) add("html.eventHandler.discarded", "Inline event handlers are never executed or imported into Motion.");
  const allowedCompositionStyle = new Set(["width", "height", "background", "background-color"]);
  for (const property of Object.keys(composition.mainStyle)) {
    if (allowedCompositionStyle.has(property)) continue;
    add("html.composition.css", `Composition CSS property ${property} is not represented by the bounded importer.`, `html.composition.style.${property}`);
  }
  return findings;
}

function htmlImportLayerLossiness(element: HtmlLayerElement, layerId: string, type: string): HtmlSnippetLossinessFinding[] {
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

function maxLayerEndMs(layers: MotionLayer[]): number | undefined {
  return layers.length === 0 ? undefined : Math.max(...layers.map((layer) => layer.startMs + layer.durationMs));
}
