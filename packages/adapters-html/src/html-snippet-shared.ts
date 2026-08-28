import { extname, posix, resolve, sep } from "node:path";
import { replaceMarkupTags } from "@shellx-motion/core";
import {
  IMAGE_ASSET_EXTENSIONS,
  MAX_HTML_SNIPPET_BYTES,
  VIDEO_ASSET_EXTENSIONS
} from "./html-snippet-types.js";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
};

export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readStringAttr(attrs: Record<string, string>, key: string): string | undefined {
  const value = attrs[key.toLowerCase()];
  return value && value.length > 0 ? value : undefined;
}

export function readNumberAttr(attrs: Record<string, string>, key: string): number | undefined {
  return readNumberString(readStringAttr(attrs, key));
}

export function readPositiveAttr(attrs: Record<string, string>, key: string): number | undefined {
  const value = readNumberAttr(attrs, key);
  return value !== undefined && value > 0 ? value : undefined;
}

export function readNumberString(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readCssNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(-?\d+(?:\.\d+)?)(?:px)?$/i.exec(value.trim());
  const numberText = match?.[1];
  return numberText === undefined ? undefined : readNumberString(numberText);
}

export interface CssFunctionTerm {
  text: string;
  name: string;
  argument: string;
}

/** Linear replacement for `/([a-z-]+)\(([^)]*)\)/gi` over a CSS value. */
export function scanCssFunctions(value: string): CssFunctionTerm[] {
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

export function readCssTransform(value: string | undefined): { scale?: number; rotation?: number; valid: boolean } {
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

export function readCssTimeMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const ms = /^(-?\d+(?:\.\d+)?)ms$/i.exec(trimmed)?.[1];
  if (ms !== undefined) return readNumberString(ms);
  const seconds = /^(-?\d+(?:\.\d+)?)s$/i.exec(trimmed)?.[1];
  const parsedSeconds = seconds === undefined ? undefined : readNumberString(seconds);
  return parsedSeconds === undefined ? undefined : parsedSeconds * 1000;
}

export function readCssColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return /^#[0-9a-f]{3,8}$/i.test(trimmed) || /^[a-z]+$/i.test(trimmed) ? trimmed : undefined;
}

export function readTextAlign(value: string | undefined): string | undefined {
  return value && /^(left|right|center|justify|start|end)$/i.test(value.trim()) ? value.trim().toLowerCase() : undefined;
}

export function numberAttr(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

export function cssNumber(value: number | undefined): string {
  return numberAttr(value ?? 0);
}

export function cssColor(value: string): string {
  return /^#[0-9a-f]{3,8}$/i.test(value) || /^[a-z]+$/i.test(value) ? value : "#000000";
}

export function escapeCssIdentifier(value: string | undefined): string {
  return value && /^[a-z-]+$/i.test(value) ? value : "left";
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

export function escapeAttr(value: string): string {
  return escapeHtml(value);
}

export function stripTags(input: string): string {
  return replaceMarkupTags(input, "", true);
}

export function decodeHtml(input: string): string {
  return input.replace(/&(amp|lt|gt|quot|#39);/g, (_entity, code: string) => {
    switch (code) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return "\"";
      case "#39": return "'";
      default: return `&${code};`;
    }
  });
}

export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function slugId(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || "untitled";
}

export function normalizeHtmlAssetRef(value: string, type: string): string | null {
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

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function cleanRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function boundedHtmlId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`HTML snippet import ${label} must be 1-128 safe id characters.`);
  }
  return value;
}

export function boundedHtmlText(value: string, maxLength: number, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`HTML snippet import ${label} must be 1-${maxLength} printable characters.`);
  }
  return trimmed;
}

export function pathIsInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedCandidate.startsWith(rootWithSep);
}

export function mediaTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webm": return "video/webm";
    case ".mp4": return "video/mp4";
    default: return "application/octet-stream";
  }
}

export function assertSafeHtmlMediaAsset(path: string, buffer: Buffer, label: string): void {
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

function isCssNameCode(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || code === 0x2d;
}
