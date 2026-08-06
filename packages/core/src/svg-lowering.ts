import { diagnoseAdapterImport, type AdapterDiagnosticInput, type AdapterDiagnosticResult } from "./adapter-diagnostics";
import { hashBuffer } from "./receipts";
import { validateMotionPathData } from "./path-contract";
import type { MotionDocument, MotionLayer, OperationReceipt } from "./types";

const MAX_SVG_BYTES = 16 * 1024 * 1024;
const MAX_SVG_NODES = 10_000;
const MAX_SVG_DEPTH = 32;
const MAX_SVG_ATTRIBUTES = 64;
const MAX_SVG_ATTRIBUTE_BYTES = 1024 * 1024;

export interface SvgLoweringResult {
  schema: "shellx-motion/adapter-lowering@1";
  adapterId: "adapter.svg";
  source: { path: string; sha256: string };
  motion: MotionDocument;
  diagnostics: AdapterDiagnosticResult;
  receipt: OperationReceipt;
}

interface SvgNode {
  name: "svg" | "g" | "path";
  attrs: Record<string, string>;
  children: SvgNode[];
}

export function lowerStaticSvgToMotion(input: AdapterDiagnosticInput & { createdBy?: string }): SvgLoweringResult {
  const diagnostics = diagnoseAdapterImport({ ...input, adapterId: "adapter.svg" });
  if (diagnostics.unsupportedFeatures.length > 0) {
    throw new Error(`SVG lowering refused unsupported features: ${summarizeFeatures(diagnostics.unsupportedFeatures)}.`);
  }
  const unacceptedWarnings = diagnostics.warningFeatures.filter((item) => item.feature !== "svg.path.curve");
  if (unacceptedWarnings.length > 0) {
    throw new Error(`SVG lowering refused unproven features: ${summarizeFeatures(unacceptedWarnings)}.`);
  }
  const root = parseStaticSvg(input.sourceText);
  const viewBox = parseViewBox(root.attrs.viewBox);
  const width = positiveSvgLength(root.attrs.width) ?? viewBox?.width;
  const height = positiveSvgLength(root.attrs.height) ?? viewBox?.height;
  if (!width || !height) throw new Error("SVG lowering requires positive width/height or a positive viewBox.");
  const effectiveViewBox = viewBox ?? { x: 0, y: 0, width, height };
  const paths = flattenSvgPaths(root);
  if (paths.length === 0) throw new Error("SVG lowering requires at least one visible path.");
  const durationMs = 1000;
  const layerIds = new Set<string>();
  const layers: MotionLayer[] = paths.map((node, index) => {
    const id = uniqueSvgLayerId(node.attrs.id, index, layerIds);
    const path = validateMotionPathData(node.attrs.d, `SVG path ${id}`);
    const opacity = boundedOpacity(node.attrs.opacity);
    return {
      id,
      name: node.attrs.id?.trim() || `SVG Path ${index + 1}`,
      type: "shape",
      shape: "path",
      "x-path": path,
      "x-path-viewBox": `${formatNumber(effectiveViewBox.x)} ${formatNumber(effectiveViewBox.y)} ${formatNumber(effectiveViewBox.width)} ${formatNumber(effectiveViewBox.height)}`,
      startMs: 0,
      durationMs,
      transform: { x: 0, y: 0, width, height, opacity, scale: 1, rotation: 0 },
      style: {
        fill: svgPaint(node.attrs.fill, "#000000"),
        stroke: svgPaint(node.attrs.stroke, "transparent"),
        strokeWidth: nonNegativeSvgLength(node.attrs["stroke-width"]) ?? 0,
        strokeLinecap: svgStrokeLinecap(node.attrs["stroke-linecap"])
      }
    };
  });
  const sourceSha256 = hashBuffer(Buffer.from(input.sourceText, "utf8"));
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1",
    id: `motion_svg_${sourceSha256.slice(0, 16)}`,
    name: root.attrs["aria-label"]?.trim().slice(0, 128) || root.attrs.id?.trim().slice(0, 128) || "SVG Import",
    durationMs,
    fps: 30,
    width,
    height,
    background: "#00000000",
    layers,
    assets: [],
    provenance: {
      sourceApp: "svg",
      createdBy: boundedCreatedBy(input.createdBy),
      sourceSchema: "svg-static-path"
    }
  };
  const motionSha256 = hashBuffer(Buffer.from(`${JSON.stringify(motion, null, 2)}\n`, "utf8"));
  const warnings = diagnostics.warningFeatures.map((item) => item.reason);
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1",
    id: `adapter-lowering-svg-${motionSha256.slice(0, 16)}`,
    operation: "adapter.lower",
    status: warnings.length > 0 ? "warning" : "passed",
    packageId: input.normalizedPackagePath,
    inputHashes: { source: sourceSha256 },
    createdAt: input.createdAt ?? new Date().toISOString(),
    lane: "adapter",
    output: {
      adapterId: "adapter.svg",
      format: "svg",
      motionId: motion.id,
      motionSha256,
      layerCount: layers.length,
      lossiness: diagnostics.lossiness,
      acceptedWarningFeatures: diagnostics.warningFeatures.map((item) => ({ path: item.path, feature: item.feature }))
    },
    warnings
  };
  return {
    schema: "shellx-motion/adapter-lowering@1",
    adapterId: "adapter.svg",
    source: { path: input.sourcePath, sha256: sourceSha256 },
    motion,
    diagnostics,
    receipt
  };
}

function parseStaticSvg(source: string): SvgNode {
  if (Buffer.byteLength(source, "utf8") > MAX_SVG_BYTES) throw new Error("SVG source exceeds the 16 MiB lowering limit.");
  if (/<!DOCTYPE|<!ENTITY|<\?|<!\[CDATA\[/i.test(source)) throw new Error("SVG lowering refuses DTD, entity, processing-instruction, and CDATA syntax.");
  const stack: SvgNode[] = [];
  let root: SvgNode | null = null;
  let index = 0;
  let nodes = 0;
  while (index < source.length) {
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      if (end < 0) throw new Error("SVG lowering found an unterminated comment.");
      index = end + 3;
      continue;
    }
    if (source[index] !== "<") {
      const end = source.indexOf("<", index);
      const text = source.slice(index, end < 0 ? source.length : end);
      if (text.trim()) throw new Error("SVG lowering refuses text content outside implemented elements.");
      index = end < 0 ? source.length : end;
      continue;
    }
    const end = findSvgTagEnd(source, index + 1);
    const raw = source.slice(index + 1, end).trim();
    if (!raw || raw.startsWith("!")) throw new Error("SVG lowering found unsupported markup.");
    const closing = raw.startsWith("/");
    const selfClosing = raw.endsWith("/");
    const body = raw.slice(closing ? 1 : 0, selfClosing ? -1 : undefined).trim();
    const nameMatch = /^([A-Za-z][A-Za-z0-9_.:-]*)/.exec(body);
    if (!nameMatch) throw new Error("SVG lowering found an invalid element name.");
    const name = nameMatch[1].toLowerCase();
    if (name !== "svg" && name !== "g" && name !== "path") throw new Error(`SVG lowering does not implement element <${name}>.`);
    if (closing) {
      if (body.slice(nameMatch[0].length).trim()) throw new Error("SVG closing tags cannot contain attributes.");
      const current = stack.pop();
      if (!current || current.name !== name) throw new Error(`SVG lowering found a mismatched closing tag </${name}>.`);
    } else {
      nodes += 1;
      if (nodes > MAX_SVG_NODES) throw new Error(`SVG lowering exceeds the ${MAX_SVG_NODES}-node limit.`);
      if (stack.length >= MAX_SVG_DEPTH) throw new Error(`SVG lowering exceeds the depth-${MAX_SVG_DEPTH} limit.`);
      const attrs = parseSvgAttributes(body.slice(nameMatch[0].length));
      validateSvgElementAttributes(name, attrs);
      const node: SvgNode = { name, attrs, children: [] };
      if (stack.length === 0) {
        if (root) throw new Error("SVG lowering requires exactly one root element.");
        if (name !== "svg") throw new Error("SVG lowering root element must be <svg>.");
        root = node;
      } else {
        if (name === "svg") throw new Error("SVG lowering refuses nested <svg> elements.");
        if (stack[stack.length - 1].name === "path") throw new Error("SVG path elements cannot contain child elements.");
        stack[stack.length - 1].children.push(node);
      }
      if (!selfClosing) stack.push(node);
    }
    index = end + 1;
  }
  if (stack.length > 0) throw new Error("SVG lowering found unclosed elements.");
  if (!root) throw new Error("SVG lowering requires an <svg> root.");
  return root;
}

function findSvgTagEnd(source: string, start: number): number {
  let quote: string | null = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  throw new Error("SVG lowering found an unterminated tag.");
}

function parseSvgAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let index = 0;
  let count = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (index >= source.length) break;
    const nameMatch = /^([A-Za-z_:][A-Za-z0-9_.:-]*)/.exec(source.slice(index));
    if (!nameMatch) throw new Error("SVG lowering requires quoted, well-formed attributes.");
    const name = nameMatch[1];
    index += name.length;
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (source[index] !== "=") throw new Error(`SVG attribute ${name} requires a value.`);
    index += 1;
    while (/\s/.test(source[index] ?? "")) index += 1;
    const quote = source[index];
    if (quote !== "\"" && quote !== "'") throw new Error(`SVG attribute ${name} must use quotes.`);
    const end = source.indexOf(quote, index + 1);
    if (end < 0) throw new Error(`SVG attribute ${name} is unterminated.`);
    const value = source.slice(index + 1, end);
    if (Buffer.byteLength(value, "utf8") > MAX_SVG_ATTRIBUTE_BYTES) throw new Error(`SVG attribute ${name} exceeds the 1 MiB limit.`);
    if (Object.hasOwn(attrs, name)) throw new Error(`SVG lowering refuses duplicate attribute ${name}.`);
    attrs[name] = decodeSafeSvgEntities(value);
    count += 1;
    if (count > MAX_SVG_ATTRIBUTES) throw new Error(`SVG element exceeds the ${MAX_SVG_ATTRIBUTES}-attribute limit.`);
    index = end + 1;
  }
  return attrs;
}

function validateSvgElementAttributes(name: string, attrs: Record<string, string>): void {
  const common = new Set(["id", "opacity"]);
  const allowed = name === "svg"
    ? new Set(["id", "width", "height", "viewBox", "xmlns", "aria-label"])
    : name === "g"
      ? new Set(["id", "opacity"])
      : new Set(["id", "d", "fill", "stroke", "stroke-width", "stroke-linecap", "opacity"]);
  for (const [key, value] of Object.entries(attrs)) {
    const lower = key.toLowerCase();
    if (lower.startsWith("on") || lower === "href" || lower.endsWith(":href") || /url\s*\(/i.test(value)) {
      throw new Error(`SVG lowering refuses executable or referenced attribute ${key}.`);
    }
    if (!allowed.has(key) && !common.has(key)) throw new Error(`SVG lowering does not implement attribute ${key} on <${name}>.`);
  }
  if (name === "path" && !attrs.d) throw new Error("SVG path elements require d data.");
}

function decodeSafeSvgEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'" })[entity] ?? entity)
    .replace(/&[^;\s]{1,64};/g, () => { throw new Error("SVG lowering refuses custom or numeric entity references."); });
}

function flattenSvgPaths(root: SvgNode): SvgNode[] {
  const paths: SvgNode[] = [];
  const visit = (node: SvgNode, parentOpacity: number): void => {
    const opacity = parentOpacity * boundedOpacity(node.attrs.opacity);
    for (const child of node.children) {
      if (child.name === "path") paths.push({ ...child, attrs: { ...child.attrs, opacity: String(opacity * boundedOpacity(child.attrs.opacity)) } });
      else visit(child, opacity);
    }
  };
  visit(root, 1);
  return paths;
}

function parseViewBox(value: string | undefined): { x: number; y: number; width: number; height: number } | null {
  if (!value) return null;
  const values = value.trim().split(/[\s,]+/).map(Number);
  if (values.length !== 4 || values.some((item) => !Number.isFinite(item)) || values[2] <= 0 || values[3] <= 0) throw new Error("SVG viewBox must contain four finite values with positive width and height.");
  return { x: values[0], y: values[1], width: values[2], height: values[3] };
}

function positiveSvgLength(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(value.trim());
  const number = match ? Number(match[1]) : NaN;
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegativeSvgLength(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(value.trim());
  const number = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(number) || number < 0) throw new Error("SVG stroke width must be a non-negative pixel length.");
  return number;
}

function boundedOpacity(value: string | undefined): number {
  if (value === undefined) return 1;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error("SVG opacity must be between 0 and 1.");
  return number;
}

function svgPaint(value: string | undefined, fallback: string): string {
  const paint = value?.trim() || fallback;
  if (paint === "none") return "transparent";
  if (/^(?:#[a-f0-9]{3,8}|transparent|currentColor)$/i.test(paint)) return paint;
  throw new Error(`SVG lowering does not implement paint value ${paint}.`);
}

function svgStrokeLinecap(value: string | undefined): "butt" | "round" | "square" {
  if (!value || value === "butt") return "butt";
  if (value === "round" || value === "square") return value;
  throw new Error(`SVG lowering does not implement stroke-linecap ${value}.`);
}

function uniqueSvgLayerId(value: string | undefined, index: number, seen: Set<string>): string {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || `svg-path-${index + 1}`;
  if (seen.has(normalized)) throw new Error(`SVG lowering produced duplicate Motion layer id ${normalized}.`);
  seen.add(normalized);
  return normalized;
}

function boundedCreatedBy(value: string | undefined): string {
  const createdBy = value?.trim() || "svg-adapter";
  if (createdBy.length > 128 || /[\u0000-\u001f\u007f]/.test(createdBy)) throw new Error("SVG lowering createdBy must be at most 128 printable characters.");
  return createdBy;
}

function summarizeFeatures(features: AdapterDiagnosticResult["unsupportedFeatures"]): string {
  const shown = features.slice(0, 25).map((item) => `${item.path}:${item.feature}`);
  return `${shown.join(", ")}${features.length > shown.length ? `, plus ${features.length - shown.length} more` : ""}`;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(4)).toString();
}
