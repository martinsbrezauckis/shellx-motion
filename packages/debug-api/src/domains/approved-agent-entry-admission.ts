/**
 * Admission policy for the one host-attested approved-agent entry.
 *
 * The entry remains ordinary inline browser code, but its provenance must never silently grow
 * when it reads package data. Parse its classic script blocks before minting an authority and
 * inject a CSP that permits only those exact bodies while disabling eval, function constructors,
 * WebAssembly compilation, workers, frames, and network reads at execution time.
 */
import { createHash } from "node:crypto";
import { parse } from "@babel/parser";

interface InlineScriptBlock {
  attributes: string;
  body: string;
}

const FORBIDDEN_CODE_IDENTIFIERS = new Set([
  "eval", "Function", "AsyncFunction", "GeneratorFunction", "WebAssembly", "Worker",
  "SharedWorker", "importScripts", "DOMParser", "Reflect",
]);

const FORBIDDEN_CODE_PROPERTIES = new Set([
  "constructor", "eval", "Function", "WebAssembly", "defaultView", "srcdoc", "innerHTML",
  "outerHTML", "insertAdjacentHTML", "write", "writeln", "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors", "getPrototypeOf", "setPrototypeOf", "defineProperty", "defineProperties",
]);

const GLOBAL_OBJECT_IDENTIFIERS = new Set(["globalThis", "window", "self", "top", "parent", "frames"]);
const RAW_TEXT_TAGS = new Set(["style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "plaintext"]);

export function secureApprovedAgentEntryHtml(html: string): { html: string } | { error: string } {
  if (html.includes("\0")) return { error: "motion.package.script.author html must not contain NUL bytes." };
  const scripts = collectInlineScriptBlocks(html);
  if ("error" in scripts) return scripts;
  for (const script of scripts.blocks) {
    const type = scriptType(script.attributes);
    if (type === "external" || type === "module" || type === "inert") {
      return { error: "motion.package.script.author html permits only classic inline scripts; src, module, and inert script blocks are refused." };
    }
    let parsed: unknown;
    try {
      parsed = parse(script.body, { sourceType: "script" });
    } catch {
      return { error: "motion.package.script.author html contains an inline script that Chromium cannot parse as a classic script." };
    }
    const forbidden = forbiddenAgentScriptConstruct(parsed);
    if (forbidden) {
      return { error: `motion.package.script.author html must not use ${forbidden}; approved entries cannot construct, load, or reinterpret secondary code.` };
    }
  }
  if (/<\/?(?:iframe|frame|object|embed)\b/i.test(html)
    || /\bdata-composition-src\s*=/i.test(html)
    || /(?:\s|\/)on[a-z0-9:_-]+\s*=/i.test(html)
    || /\b(?:java|vb)script\s*:/i.test(html)
    || /<meta\b[^>]*\bhttp-equiv\s*=\s*(?:(["'])(?:content-security-policy|refresh)\1|(?:content-security-policy|refresh)(?=\s|\/?>))/i.test(html)) {
    return { error: "motion.package.script.author html must not declare a secondary document, composition source, or its own Content-Security-Policy." };
  }
  const hashes = scripts.blocks
    .filter((script) => scriptType(script.attributes) === "classic")
    .map((script) => cspHash(script.body));
  const scriptSource = hashes.length > 0 ? [...new Set(hashes)].sort().join(" ") : "'none'";
  const policy = [
    "default-src 'none'", "base-uri 'none'", "object-src 'none'", `script-src ${scriptSource}`,
    "worker-src 'none'", "frame-src 'none'", "child-src 'none'", "connect-src 'none'", "form-action 'none'",
    "img-src file: data: blob:", "media-src file: data: blob:", "font-src file: data:", "style-src 'unsafe-inline' file: data:",
    "require-trusted-types-for 'script'",
  ].join("; ");
  return { html: injectApprovedEntryCspMeta(html, `<meta http-equiv="Content-Security-Policy" content="${policy}">`) };
}

function cspHash(scriptBody: string): string {
  // HTML tokenization changes CRLF and lone CR into LF before Chromium observes Script.text.
  // Hash that exact executable text, while the attestation continues to hash the original file.
  const browserText = scriptBody.replace(/\r\n?/g, "\n");
  return `'sha256-${createHash("sha256").update(browserText, "utf8").digest("base64")}'`;
}

function collectInlineScriptBlocks(html: string): { blocks: InlineScriptBlock[] } | { error: string } {
  const blocks: InlineScriptBlock[] = [];
  let offset = 0;
  while (offset < html.length) {
    if (html.startsWith("<!--", offset)) {
      const end = html.indexOf("-->", offset + 4);
      offset = end < 0 ? html.length : end + 3;
      continue;
    }
    const tag = openHtmlTagAt(html, offset);
    if (!tag) {
      offset += 1;
      continue;
    }
    offset = tag.end;
    if (!tag.closing && RAW_TEXT_TAGS.has(tag.name)) {
      if (tag.name === "plaintext") return { blocks };
      const close = findClosingHtmlTag(html, offset, tag.name);
      offset = close ? close.end : html.length;
      continue;
    }
    if (tag.closing || tag.name !== "script") continue;
    const close = findClosingHtmlTag(html, offset, "script");
    if (!close) return { error: "motion.package.script.author html contains an unterminated inline script." };
    blocks.push({ attributes: tag.attributes, body: html.slice(offset, close.start) });
    offset = close.end;
  }
  return { blocks };
}

function openHtmlTagAt(html: string, start: number): { name: string; attributes: string; closing: boolean; end: number } | null {
  if (html[start] !== "<") return null;
  const match = /^<\s*(\/)?\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(html.slice(start));
  if (!match) return null;
  const name = match[2]!.toLowerCase();
  let index = start + match[0].length;
  let quote: string | undefined;
  for (; index < html.length; index += 1) {
    const character = html[index]!;
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") {
      return { name, attributes: html.slice(start + match[0].length, index), closing: match[1] === "/", end: index + 1 };
    }
  }
  return null;
}

function findClosingHtmlTag(html: string, start: number, name: string): { start: number; end: number } | null {
  const lower = html.toLowerCase();
  let offset = start;
  while (offset < html.length) {
    const candidate = lower.indexOf(`</${name}`, offset);
    if (candidate < 0) return null;
    const tag = openHtmlTagAt(html, candidate);
    if (tag?.closing && tag.name === name) return { start: candidate, end: tag.end };
    offset = candidate + 2;
  }
  return null;
}

function scriptType(attributes: string): "classic" | "inert" | "external" | "module" {
  // The HTML tokenizer accepts a solidus before an attribute name in start tags,
  // so treat `<script /src=...>` as an external script too.
  if (/(?:^|\s|\/)(?:src|href|xlink:href)(?:\s|=|\/|$)/i.test(attributes)) return "external";
  const type = /(?:^|\s|\/)type\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i.exec(attributes);
  if (!type) return "classic";
  const value = (type[2] ?? type[3] ?? "").trim().toLowerCase();
  if (value === "module") return "module";
  return value === "" || /^(?:application|text)\/(?:javascript|ecmascript|x-javascript)$/.test(value) ? "classic" : "inert";
}

function forbiddenAgentScriptConstruct(value: unknown): string | undefined {
  const seen = new Set<object>();
  const visit = (node: unknown): string | undefined => {
    if (!node || typeof node !== "object") return undefined;
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) {
        const result = visit(child);
        if (result) return result;
      }
      return undefined;
    }
    const record = node as Record<string, unknown>;
    if (record.type === "Identifier" && typeof record.name === "string" && FORBIDDEN_CODE_IDENTIFIERS.has(record.name)) return record.name;
    if (record.type === "Import") return "dynamic import";
    if ((record.type === "MemberExpression" || record.type === "OptionalMemberExpression") && forbiddenMemberExpression(record)) return "reflective or generated code access";
    if ((record.type === "CallExpression" || record.type === "OptionalCallExpression") && stringTimerCall(record)) return "string timer code";
    if ((record.type === "CallExpression" || record.type === "OptionalCallExpression") && dynamicElementConstruction(record)) return "dynamic executable element construction";
    for (const [key, child] of Object.entries(record)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "comments") continue;
      const result = visit(child);
      if (result) return result;
    }
    return undefined;
  };
  return visit(value);
}

function forbiddenMemberExpression(node: Record<string, unknown>): boolean {
  const property = staticMemberProperty(node);
  if (property && FORBIDDEN_CODE_PROPERTIES.has(property)) return true;
  if (node.computed !== true) return false;
  const object = node.object as Record<string, unknown> | undefined;
  return object?.type === "ThisExpression"
    || (object?.type === "Identifier" && typeof object.name === "string" && GLOBAL_OBJECT_IDENTIFIERS.has(object.name));
}

function staticMemberProperty(node: Record<string, unknown>): string | undefined {
  const property = node.property as Record<string, unknown> | undefined;
  if (!property) return undefined;
  if (node.computed !== true && property.type === "Identifier" && typeof property.name === "string") return property.name;
  if (node.computed === true && property.type === "StringLiteral" && typeof property.value === "string") return property.value;
  return undefined;
}

function stringTimerCall(node: Record<string, unknown>): boolean {
  const callee = node.callee as Record<string, unknown> | undefined;
  if (callee?.type !== "Identifier" || (callee.name !== "setTimeout" && callee.name !== "setInterval")) return false;
  const first = Array.isArray(node.arguments) ? node.arguments[0] as Record<string, unknown> | undefined : undefined;
  return first?.type === "StringLiteral" || first?.type === "TemplateLiteral" || first?.type === "BinaryExpression";
}

function dynamicElementConstruction(node: Record<string, unknown>): boolean {
  const callee = node.callee as Record<string, unknown> | undefined;
  const property = callee && staticMemberProperty(callee);
  if (property !== "createElement" && property !== "createElementNS") return false;
  const index = property === "createElementNS" ? 1 : 0;
  const argument = Array.isArray(node.arguments) ? node.arguments[index] as Record<string, unknown> | undefined : undefined;
  if (argument?.type !== "StringLiteral" || typeof argument.value !== "string") return true;
  return /^(?:script|iframe|frame|object|embed)$/i.test(argument.value);
}

function injectApprovedEntryCspMeta(html: string, meta: string): string {
  // The host-owned document begins before every caller byte. Inserting at a caller-controlled
  // <head> would be unsafe: malformed input can put an executable script before a later head.
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}
