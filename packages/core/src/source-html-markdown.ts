/**
 * Fetched-HTML → Markdown cleanup for the source importer.
 *
 * Lifted out of `source-import.ts` when the cleanup was rewritten to be bounded. The old version was
 * a chain of `String.replace` calls built on lazy nested regexes (`/<li[^>]*>([\s\S]*?)<\/li>/gi`
 * and friends). On a page that opens list items, headings, anchors, or `<script>` without ever
 * closing them, each opening tag made the engine re-scan the rest of the document, which is
 * quadratic: 815 KB of unclosed `<li>` blocked the event loop for 14.7 s before this rewrite, and
 * the importer accepts 2 MiB. `fetchSourceDocument` pulls that HTML from a URL a prompt supplied, so
 * the input author picked the stall length.
 *
 * The passes below use {@link replaceBoundedSpans}, which walks the document once and cannot
 * backtrack. Output is unchanged: each pass reproduces the regex it replaced, quirks included —
 * `<li` matches with no word boundary (so `<link>` is still read as a list item, as before), the
 * opening tag still ends at the first `>` with no quote awareness, and `<a>` still takes the *last*
 * `href="…"` in the tag because the old `[^>]*href=` was greedy.
 *
 * Called by: `source-import.ts` (`fetchSourceMarkdown`).
 */
import {
  asciiLowerCase,
  boundedTagBodyStart,
  replaceBoundedSpans,
  replaceMarkupTags,
  replaceNamedTagOpenings,
  type BoundedSpanRule
} from "./bounded-markup";

/** Elements whose content never survives into the imported Markdown. */
const DISCARDED_ELEMENTS = ["script", "style", "noscript", "svg", "head", "nav", "footer", "form", "iframe"];

/** Block-level openings that become a line break. Order matches the old regex alternation. */
const BLOCK_OPENINGS = ["p", "div", "section", "article", "main", "tr", "ul", "ol", "blockquote"];

/** Character codes the span rules test directly. */
const CHAR_A = 0x61;
const CHAR_H = 0x68;
const CHAR_DOUBLE_QUOTE = 0x22;
const CHAR_SINGLE_QUOTE = 0x27;

/**
 * Convert fetched HTML into the bounded Markdown subset the source importer stores.
 *
 * Structural tags become newlines, headings become ATX headings, list items become `-` bullets,
 * anchors become `[text](href)`, and everything else is stripped. Runs in a single pass per rule, so
 * cost is linear in `html.length` for every input shape.
 *
 * @param html raw response body; may be arbitrary untrusted markup
 * @returns Markdown with collapsed whitespace and at most one blank line between blocks
 */
export function htmlToMarkdown(html: string): string {
  const withoutDiscarded = replaceBoundedSpans(html, discardedElementRule());
  const withoutComments = stripHtmlComments(withoutDiscarded);
  const withHeadings = replaceBoundedSpans(withoutComments, headingRule());
  const withBullets = replaceBoundedSpans(withHeadings, listItemRule());
  const withBlocks = replaceNamedTagOpenings(withBullets, BLOCK_OPENINGS, "\n")
    .replace(/<\/(p|div|section|article|main|tr|li|ul|ol|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  return replaceMarkupTags(replaceBoundedSpans(withBlocks, anchorRule(withBlocks)), "")
    .split("\n")
    .map((line) => decodeHtmlEntities(line).replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Replica of `/<(script|style|…)[^>]*>[\s\S]*?<\/\1>/gi`.
 *
 * No name in the list is a prefix of another, so a first-match lookup picks the same alternative the
 * ordered regex alternation did.
 */
function discardedElementRule(): BoundedSpanRule {
  return {
    match: (_text, lower, start, index) => {
      const name = DISCARDED_ELEMENTS.find((candidate) => lower.startsWith(candidate, start + 1));
      if (!name) return null;
      const bodyStart = boundedTagBodyStart(index, start + 1 + name.length);
      return bodyStart < 0 ? null : { closeName: name, attrText: "", bodyStart };
    },
    render: () => ""
  };
}

/** Replica of `/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi`. */
function headingRule(): BoundedSpanRule {
  return {
    match: (_text, lower, start, index) => {
      if (lower.charCodeAt(start + 1) !== CHAR_H) return null;
      const level = lower[start + 2];
      if (level === undefined || level < "1" || level > "6") return null;
      const bodyStart = boundedTagBodyStart(index, start + 3);
      return bodyStart < 0 ? null : { closeName: `h${level}`, attrText: "", bodyStart };
    },
    render: (open, inner) => `\n\n${"#".repeat(Number(open.closeName.slice(1)))} ${stripHtml(inlineHtml(inner))}\n`
  };
}

/** Replica of `/<li[^>]*>([\s\S]*?)<\/li>/gi` — no word boundary, exactly as before. */
function listItemRule(): BoundedSpanRule {
  return {
    match: (_text, lower, start, index) => {
      if (!lower.startsWith("li", start + 1)) return null;
      const bodyStart = boundedTagBodyStart(index, start + 3);
      return bodyStart < 0 ? null : { closeName: "li", attrText: "", bodyStart };
    },
    render: (_open, inner) => `\n- ${stripHtml(inlineHtml(inner))}`
  };
}

/**
 * Replica of `/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi`.
 *
 * The old `[^>]*` before `href=` was greedy, so the *last* `href="…"` inside the opening tag won and
 * earlier ones were only retried if it failed; this reproduces that order. The href positions are
 * collected once up front instead of being rediscovered per `<a`, which keeps a document full of
 * `<a` openers linear rather than quadratic.
 */
function anchorRule(html: string): BoundedSpanRule {
  const hrefStarts = quotedHrefStarts(html, asciiLowerCase(html));
  return {
    match: (text, lower, start, index) => {
      if (lower.charCodeAt(start + 1) !== CHAR_A) return null;
      const tagEnd = index.find(">", start + 2);
      if (tagEnd < 0) return null;
      for (let slot = lastIndexAtOrBefore(hrefStarts, tagEnd - 6); slot >= 0; slot -= 1) {
        const at = hrefStarts[slot] as number;
        if (at < start + 2) break;
        const valueStart = at + 6;
        const valueEnd = nextQuoteIndex(text, valueStart);
        if (valueEnd <= valueStart) continue;
        const bodyStart = boundedTagBodyStart(index, valueEnd + 1);
        if (bodyStart < 0) continue;
        return { closeName: "a", attrText: "", bodyStart, href: text.slice(valueStart, valueEnd) };
      }
      return null;
    },
    render: (open, inner) => {
      const text = stripHtml(inlineHtml(inner));
      return text ? `[${text}](${open.href ?? ""})` : "";
    }
  };
}

/** Every `href="` / `href='` position in the document, ascending. */
function quotedHrefStarts(text: string, lower: string): number[] {
  const starts: number[] = [];
  let at = lower.indexOf("href=");
  while (at >= 0) {
    const quote = text[at + 5];
    if (quote === "\"" || quote === "'") starts.push(at);
    at = lower.indexOf("href=", at + 1);
  }
  return starts;
}

/** Slot of the last entry in an ascending array that is `<= limit`, or -1. */
function lastIndexAtOrBefore(sorted: number[], limit: number): number {
  let low = 0;
  let high = sorted.length - 1;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((sorted[mid] as number) <= limit) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * First `"` or `'` at or after `from`, or -1 — the end of a `([^"']+)` run.
 *
 * One forward scan that stops at whichever quote comes first, rather than two `indexOf` calls
 * minimised afterwards. The two-call form looked linear and was not: `indexOf` for the quote that
 * does not appear scans to the END OF THE DOCUMENT, and this runs once per `href` candidate. On
 * ordinary link-heavy HTML with no apostrophe in it — the common case, not a crafted one — that made
 * the anchor pass quadratic and 38x SLOWER at 1.6 MB than the regex this replaced, which was linear
 * here. A rewrite that removes catastrophic backtracking is not allowed to introduce a quadratic of
 * its own; measured growth is the check, not the shape of the code.
 */
function nextQuoteIndex(text: string, from: number): number {
  for (let at = from; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code === CHAR_DOUBLE_QUOTE || code === CHAR_SINGLE_QUOTE) return at;
  }
  return -1;
}

/**
 * Replica of `/<!--[\s\S]*?-->/g`.
 *
 * Stops at the first unterminated `<!--`: the regex could not have matched a later comment either,
 * because a comment that starts further right has strictly fewer terminators available.
 */
function stripHtmlComments(html: string): string {
  let out = "";
  let copiedTo = 0;
  let start = html.indexOf("<!--");
  while (start >= 0) {
    const end = html.indexOf("-->", start + 4);
    if (end < 0) break;
    out += html.slice(copiedTo, start);
    copiedTo = end + 3;
    start = html.indexOf("<!--", copiedTo);
  }
  return copiedTo === 0 ? html : out + html.slice(copiedTo);
}

/** Drop tags from an inline fragment, leaving a space where each one stood. */
function inlineHtml(html: string): string {
  return replaceMarkupTags(html, " ");
}

/** Decode entities and collapse a fragment to a single trimmed line. */
function stripHtml(html: string): string {
  return decodeHtmlEntities(html).replace(/\s+/g, " ").trim();
}

/** Decode the small entity set the importer guarantees; anything else is left verbatim. */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'");
}
