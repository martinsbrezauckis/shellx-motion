import {
  MAX_HTML_ATTRIBUTES,
  MAX_HTML_ATTRIBUTES_PER_ELEMENT,
  MAX_HTML_DECODED_STRING_CHARS,
  MAX_HTML_DECODED_STRING_CHARS_PER_ELEMENT,
  MAX_HTML_LOSSINESS_FINDINGS,
  MAX_HTML_LOSSINESS_RECEIPT_BYTES,
  MAX_HTML_STYLE_ENTRIES,
  MAX_HTML_STYLE_ENTRIES_PER_ELEMENT,
  type HtmlSnippetLossinessFinding
} from "./html-snippet-types.js";
import { decodeHtml } from "./html-snippet-shared.js";

export interface HtmlSnippetParseBudget {
  attributeEntries: number;
  decodedStringChars: number;
  styleEntries: number;
}

export interface HtmlSnippetElementBudget {
  attributeEntries: number;
  decodedStringChars: number;
  styleEntries: number;
  total: HtmlSnippetParseBudget;
}

export interface HtmlSnippetLossinessBudget {
  findingCount: number;
  receiptBytes: number;
}

export function createHtmlSnippetParseBudget(): HtmlSnippetParseBudget {
  return { attributeEntries: 0, decodedStringChars: 0, styleEntries: 0 };
}

export function beginHtmlSnippetElementBudget(total: HtmlSnippetParseBudget): HtmlSnippetElementBudget {
  return { attributeEntries: 0, decodedStringChars: 0, styleEntries: 0, total };
}

export function createHtmlSnippetLossinessBudget(): HtmlSnippetLossinessBudget {
  return { findingCount: 0, receiptBytes: 0 };
}

/**
 * Read quoted attributes with the bounded importer scanner; duplicates keep the last value.
 * Attribute slices and entity decoding are charged before they are materialized.
 */
export function parseAttributes(input: string, budget: HtmlSnippetElementBudget): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
  let cursor = 0;
  while (cursor < input.length) {
    if (!isAttributeNameStart(input.charCodeAt(cursor))) {
      cursor += 1;
      continue;
    }
    let nameEnd = cursor + 1;
    while (nameEnd < input.length && isAttributeNameRest(input.charCodeAt(nameEnd))) nameEnd += 1;
    let scan = nameEnd;
    while (scan < input.length && isHtmlSpaceCode(input.charCodeAt(scan))) scan += 1;
    if (input.charCodeAt(scan) !== 0x3d) {
      cursor = nameEnd;
      continue;
    }
    scan += 1;
    while (scan < input.length && isHtmlSpaceCode(input.charCodeAt(scan))) scan += 1;
    const quote = input[scan];
    if (quote !== "\"" && quote !== "'") {
      cursor = nameEnd;
      continue;
    }
    const valueStart = scan + 1;
    const valueEnd = input.indexOf(quote, valueStart);
    if (valueEnd < 0) {
      cursor = nameEnd;
      continue;
    }
    consumeAttributeEntry(budget);
    consumeDecodedStringChars(budget, nameEnd - cursor + valueEnd - valueStart);
    const name = input.slice(cursor, nameEnd).toLowerCase();
    attrs[name] = decodeHtml(input.slice(valueStart, valueEnd));
    cursor = valueEnd + 1;
  }
  return attrs;
}

export function parseStyle(input: string, budget: HtmlSnippetElementBudget): Record<string, string> {
  const style: Record<string, string> = Object.create(null) as Record<string, string>;
  let cursor = 0;
  while (cursor <= input.length) {
    const end = input.indexOf(";", cursor);
    const declaration = input.slice(cursor, end < 0 ? input.length : end);
    const separator = declaration.indexOf(":");
    if (separator <= 0) {
      if (end < 0) break;
      cursor = end + 1;
      continue;
    }
    const key = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (key && value) {
      consumeStyleEntry(budget);
      consumeDecodedStringChars(budget, key.length + value.length);
      style[key] = value;
    }
    if (end < 0) break;
    cursor = end + 1;
  }
  return style;
}

/** Refuse before warning strings or receipt JSON can grow beyond the interchange contract. */
export function appendHtmlSnippetLossiness(
  target: HtmlSnippetLossinessFinding[],
  findings: HtmlSnippetLossinessFinding[],
  budget: HtmlSnippetLossinessBudget
): void {
  for (const finding of findings) {
    const receiptBytes = lossinessReceiptBytes(finding);
    if (budget.findingCount >= MAX_HTML_LOSSINESS_FINDINGS) {
      throw new Error(`HTML snippet import exceeds the ${MAX_HTML_LOSSINESS_FINDINGS}-finding lossiness receipt limit.`);
    }
    if (budget.receiptBytes + receiptBytes > MAX_HTML_LOSSINESS_RECEIPT_BYTES) {
      throw new Error(`HTML snippet import lossiness receipt exceeds the ${MAX_HTML_LOSSINESS_RECEIPT_BYTES}-byte limit.`);
    }
    target.push(finding);
    budget.findingCount += 1;
    budget.receiptBytes += receiptBytes;
  }
}

function consumeAttributeEntry(budget: HtmlSnippetElementBudget): void {
  if (budget.attributeEntries >= MAX_HTML_ATTRIBUTES_PER_ELEMENT) {
    throw new Error(`HTML snippet import exceeds the ${MAX_HTML_ATTRIBUTES_PER_ELEMENT}-attribute per-element limit.`);
  }
  if (budget.total.attributeEntries >= MAX_HTML_ATTRIBUTES) {
    throw new Error(`HTML snippet import exceeds the ${MAX_HTML_ATTRIBUTES}-attribute aggregate limit.`);
  }
  budget.attributeEntries += 1;
  budget.total.attributeEntries += 1;
}

function consumeStyleEntry(budget: HtmlSnippetElementBudget): void {
  if (budget.styleEntries >= MAX_HTML_STYLE_ENTRIES_PER_ELEMENT) {
    throw new Error(`HTML snippet import exceeds the ${MAX_HTML_STYLE_ENTRIES_PER_ELEMENT}-style-entry per-element limit.`);
  }
  if (budget.total.styleEntries >= MAX_HTML_STYLE_ENTRIES) {
    throw new Error(`HTML snippet import exceeds the ${MAX_HTML_STYLE_ENTRIES}-style-entry aggregate limit.`);
  }
  budget.styleEntries += 1;
  budget.total.styleEntries += 1;
}

function consumeDecodedStringChars(budget: HtmlSnippetElementBudget, chars: number): void {
  if (budget.decodedStringChars + chars > MAX_HTML_DECODED_STRING_CHARS_PER_ELEMENT) {
    throw new Error(`HTML snippet import decoded strings exceed the ${MAX_HTML_DECODED_STRING_CHARS_PER_ELEMENT}-character per-element limit.`);
  }
  if (budget.total.decodedStringChars + chars > MAX_HTML_DECODED_STRING_CHARS) {
    throw new Error(`HTML snippet import decoded strings exceed the ${MAX_HTML_DECODED_STRING_CHARS}-character aggregate limit.`);
  }
  budget.decodedStringChars += chars;
  budget.total.decodedStringChars += chars;
}

function lossinessReceiptBytes(finding: HtmlSnippetLossinessFinding): number {
  const warning = `${finding.path}: ${finding.reason}`;
  return Buffer.byteLength(JSON.stringify(finding), "utf8") + Buffer.byteLength(JSON.stringify(warning), "utf8") + 2;
}

function isAttributeNameStart(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || code === 0x5f
    || code === 0x3a;
}

function isAttributeNameRest(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || (code >= 0x30 && code <= 0x39)
    || code === 0x5f
    || code === 0x3a
    || code === 0x2e
    || code === 0x2d;
}

function isHtmlSpaceCode(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 || code === 0xfeff
    || code === 0x1680 || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;
}
