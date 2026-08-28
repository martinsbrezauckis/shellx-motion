import { classifyGpuImageResource, decodePngRgba } from "@shellx-motion/core";

type StrictGpuHybridUrlAttributeName = "href" | "src" | "srcset" | "action" | "formaction" | "xlink:href" | "background";

interface StrictGpuHybridUrlAttribute {
  readonly name: StrictGpuHybridUrlAttributeName;
  readonly value: string;
}

/**
 * One policy-local tokenization and classification closure for ordinary and
 * segmented strict GPU HTML. The shared markup scanner intentionally accepts
 * quoted values only, so changing it would widen unrelated parser contracts.
 */
export function strictGpuHybridHtmlClosureProblem(html: string): string | null {
  const tokenized = tokenizeStrictGpuHybridUrlAttributes(html);
  if (!tokenized.ok) return tokenized.problem;
  for (const attribute of tokenized.attributes) {
    if (attribute.name === "srcset" || attribute.name === "action" || attribute.name === "formaction") {
      return `${attribute.name} is not admitted in a strict GPU hybrid document`;
    }
    const allowsFragment = attribute.name === "href" || attribute.name === "xlink:href";
    if (!isSelfContainedUrl(attribute.value, allowsFragment)) {
      return `${attribute.name} must be ${allowsFragment ? "a fragment or " : ""}a verified static PNG/JPEG data:image source in a strict GPU hybrid document`;
    }
  }
  const styleProblem = embeddedCssUrlProblem(html);
  return styleProblem ? "CSS url() must be an embedded data:image source in a strict GPU hybrid document" : null;
}

function tokenizeStrictGpuHybridUrlAttributes(html: string):
  | { readonly ok: true; readonly attributes: readonly StrictGpuHybridUrlAttribute[] }
  | { readonly ok: false; readonly problem: string } {
  const attributes: StrictGpuHybridUrlAttribute[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const open = html.indexOf("<", cursor);
    if (open < 0 || open + 1 >= html.length) break;
    cursor = open + 1;
    if (html.startsWith("!--", cursor)) {
      const close = html.indexOf("-->", cursor + 3);
      if (close < 0) break;
      cursor = close + 3;
      continue;
    }
    if (html[cursor] === "/" || html[cursor] === "!" || html[cursor] === "?") {
      const close = html.indexOf(">", cursor + 1);
      if (close < 0) break;
      cursor = close + 1;
      continue;
    }
    if (!isStrictGpuHtmlTagNameStart(html.charCodeAt(cursor))) continue;
    cursor += 1;
    while (cursor < html.length && isStrictGpuHtmlTagNamePart(html.charCodeAt(cursor))) cursor += 1;

    let sawUrlAttribute = false;
    let closed = false;
    while (cursor < html.length) {
      while (cursor < html.length && isStrictGpuHtmlSpace(html.charCodeAt(cursor))) cursor += 1;
      if (cursor >= html.length) break;
      if (html[cursor] === ">") {
        cursor += 1;
        closed = true;
        break;
      }
      if (html[cursor] === "/" && html[cursor + 1] === ">") {
        cursor += 2;
        closed = true;
        break;
      }
      const nameStart = cursor;
      while (cursor < html.length && isStrictGpuHtmlAttributeNamePart(html.charCodeAt(cursor))) cursor += 1;
      if (nameStart === cursor) {
        if (sawUrlAttribute) return { ok: false, problem: "a URL attribute has a malformed strict GPU hybrid HTML form" };
        cursor += 1;
        continue;
      }
      const name = html.slice(nameStart, cursor).toLowerCase();
      const urlName = strictGpuHybridUrlAttributeName(name);
      while (cursor < html.length && isStrictGpuHtmlSpace(html.charCodeAt(cursor))) cursor += 1;
      if (html[cursor] !== "=") {
        if (urlName) return { ok: false, problem: `${urlName} is not admitted without a value` };
        continue;
      }
      cursor += 1;
      while (cursor < html.length && isStrictGpuHtmlSpace(html.charCodeAt(cursor))) cursor += 1;
      if (cursor >= html.length) {
        if (urlName) return { ok: false, problem: `${urlName} has an unterminated value` };
        break;
      }

      let value: string;
      const quote = html[cursor];
      if (quote === "\"" || quote === "'") {
        const valueStart = ++cursor;
        while (cursor < html.length && html[cursor] !== quote) cursor += 1;
        if (cursor >= html.length) {
          if (urlName) return { ok: false, problem: `${urlName} has an unterminated quoted value` };
          break;
        }
        value = html.slice(valueStart, cursor);
        cursor += 1;
      } else {
        const valueStart = cursor;
        while (cursor < html.length && !isStrictGpuHtmlSpace(html.charCodeAt(cursor)) && html[cursor] !== ">") {
          if (isStrictGpuHtmlUnquotedValueForbidden(html[cursor])) {
            if (urlName) return { ok: false, problem: `${urlName} has a malformed unquoted value` };
            break;
          }
          cursor += 1;
        }
        value = html.slice(valueStart, cursor);
      }
      if (urlName) {
        sawUrlAttribute = true;
        attributes.push({ name: urlName, value });
      }
    }
    if (!closed && sawUrlAttribute) return { ok: false, problem: "a URL attribute appears in an unterminated strict GPU hybrid HTML tag" };
  }
  return { ok: true, attributes };
}

function strictGpuHybridUrlAttributeName(name: string): StrictGpuHybridUrlAttributeName | undefined {
  return name === "href" || name === "src" || name === "srcset" || name === "action" || name === "formaction" || name === "xlink:href" || name === "background"
    ? name
    : undefined;
}

function isStrictGpuHtmlTagNameStart(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isStrictGpuHtmlTagNamePart(code: number): boolean {
  return isStrictGpuHtmlTagNameStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x3a || code === 0x2d || code === 0x5f;
}

function isStrictGpuHtmlAttributeNamePart(code: number): boolean {
  return !isStrictGpuHtmlSpace(code) && code !== 0x22 && code !== 0x27 && code !== 0x3e && code !== 0x2f && code !== 0x3d && code !== 0x3c && code !== 0x60;
}

function isStrictGpuHtmlSpace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

function isStrictGpuHtmlUnquotedValueForbidden(value: string): boolean {
  return value === "\"" || value === "'" || value === "=" || value === "<" || value === "`";
}

function isSelfContainedUrl(raw: string, allowFragment: boolean): boolean {
  const value = raw.trim();
  if (!value) return false;
  if (allowFragment && value.startsWith("#")) return true;
  return verifiedStaticDataImage(value);
}

/**
 * The strict hybrid lane never delegates data-image classification to a live
 * browser. Canonical base64 prevents alternate spellings; PNG gets both the
 * Core decode and an explicit APNG chunk refusal, while JPEG gets Core's
 * bounded static raster classification.
 */
function verifiedStaticDataImage(value: string): boolean {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const encoded = match[2]!;
  if (encoded.length % 4 !== 0) return false;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, "base64");
  } catch {
    return false;
  }
  // Buffer is intentionally re-encoded, so malformed/non-canonical padding
  // and ignored base64 junk cannot select different browser bytes.
  if (bytes.byteLength < 1 || bytes.toString("base64") !== encoded) return false;
  const mimeType = `image/${match[1]}` as "image/png" | "image/jpeg";
  try {
    classifyGpuImageResource(bytes, mimeType);
    if (mimeType === "image/png") {
      if (hasApngControlChunk(bytes)) return false;
      decodePngRgba(bytes);
    }
    return true;
  } catch {
    return false;
  }
}

function hasApngControlChunk(png: Buffer): boolean {
  if (png.byteLength < 8) return true;
  let offset = 8;
  while (offset < png.byteLength) {
    if (offset + 12 > png.byteLength) return true;
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > png.byteLength) return true;
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "acTL" || type === "fcTL" || type === "fdAT") return true;
    offset = end;
    if (type === "IEND") return offset !== png.byteLength;
  }
  return true;
}

function embeddedCssUrlProblem(html: string): boolean {
  const lower = html.toLowerCase();
  let cursor = 0;
  while (true) {
    const start = lower.indexOf("url(", cursor);
    if (start < 0) return false;
    const end = lower.indexOf(")", start + 4);
    // The strict source cap is 8 MiB.  A missing/huge URL token is never an
    // admissible embedded image and must not trigger unbounded parsing.
    if (end < 0 || end - start > 4 * 1024 * 1024) return true;
    let value = html.slice(start + 4, end).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!isSelfContainedUrl(value, false)) return true;
    cursor = end + 1;
  }
}
