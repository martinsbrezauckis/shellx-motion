import {
  asciiLowerCase,
  ForwardIndex,
  isMarkupWordCharCode,
  scanMarkupOpenTags,
  scanMarkupTagPairs
} from "@shellx-motion/core";
import { MAX_HTML_LAYER_COUNT, type HtmlComposition, type HtmlLayerElement } from "./html-snippet-types.js";
import {
  collapseWhitespace,
  decodeHtml,
  readStringAttr,
  stripTags
} from "./html-snippet-shared.js";
import {
  beginHtmlSnippetElementBudget,
  parseAttributes,
  parseStyle,
  type HtmlSnippetParseBudget
} from "./html-snippet-import-bounds.js";

export function readHtmlComposition(html: string, budget: HtmlSnippetParseBudget): HtmlComposition {
  const htmlAttrs = parseAttributes(findHtmlAttrs(html) ?? "", beginHtmlSnippetElementBudget(budget));
  const main = findMainComposition(html);
  if (!main) throw new Error("HTML snippet import requires a <main> composition with data-composition-id or data-shellx-motion-schema metadata.");
  const mainBudget = beginHtmlSnippetElementBudget(budget);
  const mainAttrs = parseAttributes(main.attrs, mainBudget);
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
    mainStyle: parseStyle(readStringAttr(mainAttrs, "style") ?? "", mainBudget)
  };
}

function findMainComposition(html: string): { attrs: string; innerHtml: string } | null {
  const [pair] = scanMarkupTagPairs(html, "main");
  return pair ? { attrs: pair.attrText, innerHtml: pair.innerText } : null;
}

function findHtmlAttrs(html: string): string | null {
  const [tag] = scanMarkupOpenTags(html, "html");
  return tag === undefined ? null : tag.attrText;
}

function readTitle(html: string): string | undefined {
  const [pair] = scanMarkupTagPairs(html, "title");
  return pair === undefined ? undefined : collapseWhitespace(decodeHtml(stripTags(pair.innerText)));
}

/** Locate every element with `data-layer-id`, preserving the bounded scanner's historical quirks. */
export function readHtmlLayerElements(html: string, budget: HtmlSnippetParseBudget): HtmlLayerElement[] {
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
    const elementBudget = beginHtmlSnippetElementBudget(budget);
    const attrs = parseAttributes(opening.attrText, elementBudget);
    if (opening.attrText) {
      elements.push({
        tagName: opening.tagName.toLowerCase(),
        attrs,
        innerHtml: closeStart < 0 ? "" : html.slice(opening.bodyStart, closeStart),
        style: parseStyle(readStringAttr(attrs, "style") ?? "", elementBudget)
      });
    }
    cursor = closeStart < 0 ? opening.bodyStart : closeStart + closer.length;
  }
  return elements;
}

interface LayerIdCandidate {
  at: number;
  bodyStart: number;
  previousUsable: number;
}

function isTagNameStart(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isTagNameRest(code: number): boolean {
  return isMarkupWordCharCode(code) || code === 0x3a || code === 0x2d;
}

function layerIdCandidates(html: string, lower: string, index: ForwardIndex): LayerIdCandidate[] {
  const candidates: LayerIdCandidate[] = [];
  let at = lower.indexOf("data-layer-id");
  while (at >= 0) {
    if (at === 0 || !isMarkupWordCharCode(html.charCodeAt(at - 1))) {
      const bodyStart = layerIdTagBodyStart(html, index, at + "data-layer-id".length);
      const previousUsable = bodyStart >= 0 ? candidates.length : candidates[candidates.length - 1]?.previousUsable ?? -1;
      if (candidates.length >= MAX_HTML_LAYER_COUNT) {
        throw new Error("HTML snippet import exceeds the 1000-layer limit.");
      }
      candidates.push({ at, bodyStart, previousUsable });
    }
    at = lower.indexOf("data-layer-id", at + 1);
  }
  return candidates;
}

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

function isHtmlSpaceCode(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 || code === 0xfeff
    || code === 0x1680 || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;
}

interface LayerOpenTag {
  tagName: string;
  attrText: string;
  bodyStart: number;
}

function readLayerOpenTag(
  html: string,
  index: ForwardIndex,
  candidates: LayerIdCandidate[],
  start: number
): LayerOpenTag | null {
  if (!isTagNameStart(html.charCodeAt(start + 1))) return null;
  let nameEnd = start + 2;
  while (nameEnd < html.length && isTagNameRest(html.charCodeAt(nameEnd))) nameEnd += 1;
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

/** True when the document contains a `<link … rel=…stylesheet…>`. */
export function hasExternalStylesheetLink(html: string): boolean {
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
