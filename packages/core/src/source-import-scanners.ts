import { ForwardIndex } from "./bounded-markup";

/** Linear replacement for legacy URL matching and trailing-punctuation cleanup. */
export function extractBoundedSourceUrls(text: string, max: number): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  for (let cursor = 0; cursor < text.length;) {
    const schemeLength = sourceUrlSchemeLength(text, cursor);
    if (schemeLength === 0) {
      cursor += 1;
      continue;
    }

    let scan = cursor + schemeLength;
    let trimmedEnd = scan;
    let hasBody = false;
    for (; scan < text.length && !isSourceUrlTerminator(text.charCodeAt(scan)); scan += 1) {
      hasBody = true;
      if (!isTrailingSourceUrlPunctuation(text.charCodeAt(scan))) {
        trimmedEnd = scan + 1;
      }
    }
    if (!hasBody) {
      cursor += 1;
      continue;
    }

    const url = text.slice(cursor, trimmedEnd);
    cursor = scan;
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
      if (urls.length >= max) return urls;
    }
  }

  return urls;
}

/** Preserve the existing two-pass Markdown image/link grammar without global regex scans. */
export function cleanSourceMarkdownText(value: string): string {
  return replaceMarkdownLinks(replaceMarkdownLinks(value, true), false)
    .replace(/[`*_>#]+/g, " ").replace(/\s+/g, " ").trim();
}

function sourceUrlSchemeLength(text: string, start: number): number {
  if (!asciiEqual(text.charCodeAt(start), 0x68)
    || !asciiEqual(text.charCodeAt(start + 1), 0x74)
    || !asciiEqual(text.charCodeAt(start + 2), 0x74)
    || !asciiEqual(text.charCodeAt(start + 3), 0x70)) return 0;
  let cursor = start + 4;
  if (asciiEqual(text.charCodeAt(cursor), 0x73)) cursor += 1;
  return text.charCodeAt(cursor) === 0x3a
    && text.charCodeAt(cursor + 1) === 0x2f
    && text.charCodeAt(cursor + 2) === 0x2f
    ? cursor + 3 - start
    : 0;
}

function replaceMarkdownLinks(value: string, image: boolean): string {
  const open = image ? "![" : "[";
  const index = new ForwardIndex(value);
  const parts: string[] = [];
  let copiedTo = 0;
  let cursor = 0;

  while (cursor < value.length) {
    const start = index.find(open, cursor);
    if (start < 0) break;
    const labelStart = start + open.length;
    const labelEnd = index.find("]", labelStart);
    if (labelEnd < 0) break;
    const destinationStart = labelEnd + 1;
    if (value.charCodeAt(destinationStart) !== 0x28) {
      cursor = start + 1;
      continue;
    }
    const destinationEnd = index.find(")", destinationStart + 1);
    if (destinationEnd < 0) break;
    if (destinationEnd === destinationStart + 1 || (!image && labelEnd === labelStart)) {
      cursor = start + 1;
      continue;
    }
    parts.push(value.slice(copiedTo, start), value.slice(labelStart, labelEnd));
    cursor = destinationEnd + 1;
    copiedTo = cursor;
  }

  if (parts.length === 0) return value;
  parts.push(value.slice(copiedTo));
  return parts.join("");
}

function asciiEqual(code: number, lower: number): boolean {
  return code === lower || code === lower - 0x20;
}

function isSourceUrlTerminator(code: number): boolean {
  return isSourceWhitespace(code)
    || code === 0x3c || code === 0x3e || code === 0x22 || code === 0x27 || code === 0x60
    || code === 0x29 || code === 0x5d || code === 0x7d;
}

function isTrailingSourceUrlPunctuation(code: number): boolean {
  return code === 0x2e || code === 0x2c || code === 0x3b || code === 0x3a || code === 0x21 || code === 0x3f;
}

function isSourceWhitespace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 || code === 0xfeff
    || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029
    || code === 0x202f || code === 0x205f || code === 0x3000;
}
