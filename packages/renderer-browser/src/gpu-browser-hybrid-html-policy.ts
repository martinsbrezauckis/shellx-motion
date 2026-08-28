import {
  scanMarkupAttributeTagPairs,
  scanMarkupAttributes,
  scanMarkupOpenTags,
} from "@shellx-motion/core";
import type { BrowserPackageFulfilledFile, BrowserPackageFulfillment } from "./browser-package-fulfillment";
import { strictGpuHybridHtmlClosureProblem } from "./gpu-browser-hybrid-html-url-closure";

export const GPU_HYBRID_HTML_POLICY_SCHEMA = "shellx-motion/gpu-hybrid-html-policy@1" as const;
const MAX_GPU_HYBRID_HTML_SOURCE_BYTES = 8 * 1024 * 1024;
const FORBIDDEN_TAGS = ["script", "iframe", "frame", "frameset", "object", "embed", "applet", "portal", "base", "link", "form", "input", "button", "select", "textarea", "option", "details", "dialog", "a", "audio", "video", "progress", "template", "marquee", "blink", "animate", "animatemotion", "animatetransform", "set"] as const;
const FORBIDDEN_DOCUMENT_TOKENS = ["@import", "@keyframes", "animation:", "animation-", "transition:", "transition-", "expression(", "-moz-binding", "behavior:"] as const;

export interface GpuHybridDataOnlyDocumentEvidence {
  readonly schema: typeof GPU_HYBRID_HTML_POLICY_SCHEMA;
  readonly policy: "strict-data-only-html";
  readonly source: string;
  readonly sourceSha256: string;
  readonly byteLength: number;
}

/**
 * Segmented delivery cannot retain authority over the package root between
 * ranges.  Its HTML source is therefore one frozen primary document rather
 * than a lazy closure of package files.  The caller must run the ordinary
 * strict-data-only admission first; this adds the snapshot-closure rule.
 */
export function gpuSegmentedHybridSelfContainedHtmlProblem(html: string): string | null {
  if (scanMarkupAttributeTagPairs(html, "data-composition-src").length > 0) {
    return "data-composition-src is not admitted for a frozen segmented hybrid source";
  }
  return strictGpuHybridHtmlClosureProblem(html);
}

/** Bounded, primary-document-only admission used before the durable store opens. */
export async function admitGpuSegmentedHybridSelfContainedDocument(input: {
  readonly source: string;
  readonly sourcePath: string;
  readonly fulfillment: BrowserPackageFulfillment;
}): Promise<GpuHybridDataOnlyDocumentEvidence & { readonly bytes: Buffer }> {
  const file = await input.fulfillment.readPath(input.sourcePath, "GPU segmented hybrid data-only HTML");
  const admitted = gpuHybridDataOnlyDocumentEvidence(input.source, file);
  const html = file.bytes.toString("utf8");
  const problem = gpuSegmentedHybridSelfContainedHtmlProblem(html);
  if (problem) throw new Error(`GPU segmented hybrid strict data-only HTML refusal: ${problem}`);
  return Object.freeze({ ...admitted, bytes: Buffer.from(file.bytes) });
}

/**
 * Admits one static UTF-8 document through the session's immutable package
 * fulfillment cache. The cached bytes are later supplied to Chromium, so this
 * policy never inspects one pathname and render another replacement.
 */
export async function admitGpuHybridDataOnlyDocument(input: {
  readonly source: string;
  readonly sourcePath: string;
  readonly fulfillment: BrowserPackageFulfillment;
}): Promise<GpuHybridDataOnlyDocumentEvidence> {
  const file = await input.fulfillment.readPath(input.sourcePath, "GPU hybrid data-only HTML");
  return gpuHybridDataOnlyDocumentEvidence(input.source, file);
}

function gpuHybridDataOnlyDocumentEvidence(source: string, file: BrowserPackageFulfilledFile): GpuHybridDataOnlyDocumentEvidence {
  if (file.byteLength < 1 || file.byteLength > MAX_GPU_HYBRID_HTML_SOURCE_BYTES) {
    throw new Error("GPU hybrid HTML source must be a non-empty UTF-8 document no larger than 8 MiB.");
  }
  const html = file.bytes.toString("utf8");
  if (!Buffer.from(html, "utf8").equals(file.bytes)) {
    throw new Error("GPU hybrid HTML source must be canonical UTF-8.");
  }
  const refusal = gpuHybridDataOnlyRefusal(html);
  if (refusal) throw new Error(`GPU hybrid strict data-only HTML refusal: ${refusal}`);
  return Object.freeze({
    schema: GPU_HYBRID_HTML_POLICY_SCHEMA,
    policy: "strict-data-only-html",
    source,
    sourceSha256: file.sha256,
    byteLength: file.byteLength,
  });
}

function gpuHybridDataOnlyRefusal(html: string): string | null {
  if (scanMarkupAttributeTagPairs(html, "data-composition-src").length > 0) {
    return "data-composition-src is not admitted";
  }
  if (scanMarkupOpenTags(html, "style").length > 0) return "<style> is not admitted";
  for (const tag of FORBIDDEN_TAGS) {
    if (scanMarkupOpenTags(html, tag).length > 0) return `<${tag}> is not admitted`;
  }
  const lower = html.toLowerCase();
  if (FORBIDDEN_DOCUMENT_TOKENS.some((token) => lower.includes(token))) {
    return "CSS executable or temporal behavior is not admitted";
  }
  if (hasEventHandlerAssignment(lower)) return "event-handler attributes are not admitted";
  if (hasForbiddenBooleanAttribute(lower)) return "interactive document attributes are not admitted";
  // Keep the established quoted-attribute checks intact. URL closure below
  // deliberately has a stricter policy-local tokenizer for unquoted forms.
  for (const attribute of scanMarkupAttributes(html)) {
    const name = attribute.name.toLowerCase();
    if (name === "style") return "style attributes are not admitted";
    if (name === "srcdoc" || name === "contenteditable" || name === "autofocus" || name === "popover") {
      return `${name} is not admitted`;
    }
    if ((name === "href" || name === "src" || name === "action" || name === "formaction") && attribute.value.includes("&")) {
      return "entity-encoded navigable URLs are not admitted";
    }
  }
  const closureProblem = strictGpuHybridHtmlClosureProblem(html);
  if (closureProblem) return closureProblem;
  if (scanMarkupOpenTags(html, "meta").length > 0) return "<meta> is not admitted";
  return null;
}

/** Deliberately fail closed for quoted and unquoted `on*=` HTML attributes. */
function hasEventHandlerAssignment(lower: string): boolean {
  for (let cursor = 0; cursor < lower.length;) {
    const start = lower.indexOf("on", cursor);
    if (start < 0) return false;
    const before = start === 0 ? "" : lower[start - 1];
    if (start > 0 && !/[\s</]/.test(before)) { cursor = start + 2; continue; }
    let end = start + 2;
    while (end < lower.length && /[a-z0-9:_-]/.test(lower[end])) end += 1;
    let equals = end;
    while (equals < lower.length && /\s/.test(lower[equals])) equals += 1;
    if (end > start + 2 && lower[equals] === "=") return true;
    cursor = start + 2;
  }
  return false;
}

function hasForbiddenBooleanAttribute(lower: string): boolean {
  return ["contenteditable", "autofocus", "popover", "srcdoc"].some((name) => hasAttributeName(lower, name));
}

function hasAttributeName(lower: string, name: string): boolean {
  let cursor = 0;
  while (cursor < lower.length) {
    const start = lower.indexOf(name, cursor);
    if (start < 0) return false;
    if (isAttributeBoundary(lower, start - 1) && isAttributeBoundary(lower, start + name.length)) return true;
    cursor = start + name.length;
  }
  return false;
}

function isAttributeBoundary(text: string, index: number): boolean {
  return index < 0 || /[\s<>=/]/.test(text[index]);
}
