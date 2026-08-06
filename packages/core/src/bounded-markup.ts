/**
 * Bounded, linear-time markup scanning primitives.
 *
 * ## Why this module exists
 *
 * Three Motion entry points parsed markup with lazy nested regexes of the shape
 * `/<tag\b([\s\S]*?)>([\s\S]*?)<\/tag>/gi`. That shape is a denial-of-service primitive: when a
 * document opens tags it never closes, the engine re-scans the rest of the document once per
 * candidate `>` and once per candidate start, which is quadratic and — for the SVG pair scan, where
 * both the `>` and the start position are re-tried — cubic. Measured on this repository before this
 * module existed:
 *
 * | path                                            | adversarial input                     | blocked for |
 * | ----------------------------------------------- | ------------------------------------- | ----------- |
 * | `adapter-diagnostics` SVG animate scan           | 42 KB of unclosed `<path …>`          | 3.06 s      |
 * | `adapter-diagnostics` SVG animate scan           | 41 KB of unclosed `<path>`            | 68.4 s      |
 * | `source-import` fetched-HTML → Markdown cleanup  | 815 KB of unclosed `<li>`             | 14.7 s      |
 * | `adapters-html` layer element scan               | 819 KB of unclosed `data-layer-id` divs| 3.07 s     |
 *
 * Motion renders untrusted packages and imports fetched HTML, so those are event-loop stalls whose
 * length an input author chooses. A size cap alone does not fix them: every input above is far
 * inside the limits those callers already enforce (8 MiB for HTML/SVG, 2 MiB for a fetched source).
 *
 * ## What these primitives guarantee
 *
 * Every scan here is a single forward pass. There is no backtracking to amplify, so cost is linear
 * in the input length regardless of shape. Repeated "is there another `</li>` after here" questions
 * go through {@link ForwardIndex}, which remembers that a needle is exhausted so a document with a
 * hundred thousand unclosed tags pays for one failed search rather than a hundred thousand.
 *
 * ## Fidelity
 *
 * These functions reproduce the *old regex* semantics, quirks included, rather than a correct HTML
 * parser: the opening tag ends at the first `>` with no quote awareness, close tags are matched as
 * the bare literal `</name>`, duplicate attributes keep the last value. That is deliberate — the
 * callers have published receipts and fixtures built on the old behaviour, and the point of this
 * change is to remove the stall, not to re-cut adapter output. Case-insensitivity is ASCII-only,
 * which is exact: a non-`u` regex with `/i` never folds a non-ASCII code point onto an ASCII one
 * (Canonicalize returns the original when the uppercased form drops below U+0080).
 *
 * Consumers: `adapter-diagnostics.ts` (SVG), `source-import.ts` (fetched HTML → Markdown),
 * `@shellx-motion/adapters-html` (snippet import).
 */

/** `/` — the self-closing marker dropped from an opening tag's attribute text. */
const CHAR_SLASH = 0x2f;

/**
 * ASCII-only lowercase copy of `text`.
 *
 * Length-preserving by construction (each `A`–`Z` maps to exactly one code unit), so an index into
 * the result is the same index into the original. `String.prototype.toLowerCase` is not usable here:
 * it can change length (`U+0130` becomes two code units) and would desynchronise every offset.
 */
export function asciiLowerCase(text: string): string {
  return text.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

/** True for the characters JavaScript's `\w` / `\b` treat as word characters. */
export function isMarkupWordCharCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || code === 0x5f;
}

/**
 * Forward `indexOf` with two memos, both of which turn a repeated long scan into O(1).
 *
 * Callers scan left to right, so:
 *
 * - once a needle has no occurrence at or after some offset it has none at any later offset either,
 *   which turns "document with 160 000 unclosed `<li>`" from 160 000 full-length scans into one;
 * - a hit at `at` found from `from` proves there is no occurrence in `[from, at)`, so any later
 *   query starting inside that window answers `at` without touching the string. This is what keeps
 *   "200 000 `<a` openers sharing one distant `>`" linear instead of quadratic.
 *
 * Queries that go backwards past a memo window (which the scanners do issue, e.g. when resolving
 * attribute candidates out of order) fall through to a real search and stay correct.
 */
export class ForwardIndex {
  private readonly exhaustedFrom = new Map<string, number>();
  private readonly lastHit = new Map<string, { from: number; at: number }>();

  constructor(private readonly haystack: string) {}

  /** Index of `needle` at or after `from`, or -1. */
  find(needle: string, from: number): number {
    const bound = this.exhaustedFrom.get(needle);
    if (bound !== undefined && from >= bound) return -1;
    const hit = this.lastHit.get(needle);
    if (hit && from >= hit.from && from <= hit.at) return hit.at;
    const at = this.haystack.indexOf(needle, from);
    if (at < 0) this.exhaustedFrom.set(needle, from);
    else this.lastHit.set(needle, { from, at });
    return at;
  }
}

/** One `<name …>` opening tag located by {@link scanMarkupOpenTags}. */
export interface MarkupOpenTag {
  /** Index of the `<`. */
  start: number;
  /** Index just past the `>`. */
  end: number;
  /** Text between the tag name and the terminator, excluding a self-closing `/`. */
  attrText: string;
}

/** One `<name …>…</name>` pair located by {@link scanMarkupTagPairs}. */
export interface MarkupTagPair {
  /** Index of the `<`. */
  start: number;
  /** Index just past the closing `</name>`. */
  end: number;
  /** Text between the tag name and the opening tag's `>`, self-closing `/` included. */
  attrText: string;
  /** Text between the opening tag's `>` and the closing `</name>`. */
  innerText: string;
}

/**
 * Linear replacement for `/<name\b([\s\S]*?)(?:\/>|>)/gi` (and the equivalent `(?:>|\/>)` ordering,
 * which selects the same span because the lazy group stops at the earliest terminator either way).
 *
 * @param text  document to scan
 * @param name  lowercase tag name, no regex metacharacters
 * @returns every non-overlapping opening tag, in document order
 */
export function scanMarkupOpenTags(text: string, name: string): MarkupOpenTag[] {
  const lower = asciiLowerCase(text);
  const index = new ForwardIndex(lower);
  const opener = `<${name}`;
  const tags: MarkupOpenTag[] = [];
  let cursor = 0;
  while (cursor <= text.length) {
    const start = index.find(opener, cursor);
    if (start < 0) break;
    const attrStart = start + opener.length;
    if (isMarkupWordCharCode(text.charCodeAt(attrStart))) {
      cursor = start + 1;
      continue;
    }
    const tagEnd = index.find(">", attrStart);
    if (tagEnd < 0) break;
    const selfClosing = tagEnd > attrStart && text.charCodeAt(tagEnd - 1) === CHAR_SLASH;
    tags.push({
      start,
      end: tagEnd + 1,
      attrText: text.slice(attrStart, selfClosing ? tagEnd - 1 : tagEnd)
    });
    cursor = tagEnd + 1;
  }
  return tags;
}

/**
 * Linear replacement for `/<name\b([\s\S]*?)>([\s\S]*?)<\/name>/gi`.
 *
 * The old regex could not do better than this even with backtracking: widening the first lazy group
 * past the first `>` only moves the `</name>` search forward, so if no terminator follows the first
 * `>` none follows a later one either, and no later start can rescue it. The scan therefore stops at
 * the first unterminated opener exactly where the regex engine gave up.
 *
 * @param text  document to scan
 * @param name  lowercase tag name, no regex metacharacters
 * @returns every non-overlapping pair, in document order
 */
export function scanMarkupTagPairs(text: string, name: string): MarkupTagPair[] {
  const lower = asciiLowerCase(text);
  const index = new ForwardIndex(lower);
  const opener = `<${name}`;
  const closer = `</${name}>`;
  const pairs: MarkupTagPair[] = [];
  let cursor = 0;
  while (cursor <= text.length) {
    const start = index.find(opener, cursor);
    if (start < 0) break;
    const attrStart = start + opener.length;
    if (isMarkupWordCharCode(text.charCodeAt(attrStart))) {
      cursor = start + 1;
      continue;
    }
    const tagEnd = index.find(">", attrStart);
    if (tagEnd < 0) break;
    const closeStart = index.find(closer, tagEnd + 1);
    if (closeStart < 0) break;
    pairs.push({
      start,
      end: closeStart + closer.length,
      attrText: text.slice(attrStart, tagEnd),
      innerText: text.slice(tagEnd + 1, closeStart)
    });
    cursor = closeStart + closer.length;
  }
  return pairs;
}

/** One `name="value"` attribute located by {@link scanMarkupAttributes}. */
export interface MarkupAttribute {
  /** Attribute name exactly as written. */
  name: string;
  /** Attribute value with the surrounding quotes removed and no entity decoding. */
  value: string;
}

/** `[A-Za-z_:]` — the characters an attribute name may start with. */
function isAttrNameStart(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || code === 0x5f
    || code === 0x3a;
}

/** `[-A-Za-z0-9_:.]` — the characters an attribute name may continue with. */
function isAttrNameRest(code: number): boolean {
  return isMarkupWordCharCode(code) || code === 0x3a || code === 0x2e || code === 0x2d;
}

/** ASCII whitespace plus the code points JavaScript's `\s` accepts. */
function isMarkupSpaceCode(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 || code === 0xfeff
    || code === 0x1680 || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;
}

/**
 * Linear replacement for `/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g`.
 *
 * The regex is quadratic on a long run of name characters that never reaches an `=`: it re-tries the
 * whole run from every offset inside it. This scan skips a failed run in one step, which is exactly
 * equivalent — neither `\s` nor `=` is a name character, so `\s*=` can only ever succeed at the end
 * of the maximal run, and every start inside the run shares that same end and that same verdict.
 *
 * @returns attributes in document order, duplicates included; callers decide how to fold them
 */
export function scanMarkupAttributes(text: string): MarkupAttribute[] {
  const attributes: MarkupAttribute[] = [];
  const length = text.length;
  let cursor = 0;
  while (cursor < length) {
    if (!isAttrNameStart(text.charCodeAt(cursor))) {
      cursor += 1;
      continue;
    }
    let nameEnd = cursor + 1;
    while (nameEnd < length && isAttrNameRest(text.charCodeAt(nameEnd))) nameEnd += 1;
    let scan = nameEnd;
    while (scan < length && isMarkupSpaceCode(text.charCodeAt(scan))) scan += 1;
    if (text.charCodeAt(scan) !== 0x3d) {
      cursor = nameEnd;
      continue;
    }
    scan += 1;
    while (scan < length && isMarkupSpaceCode(text.charCodeAt(scan))) scan += 1;
    const quote = text[scan];
    if (quote !== "\"" && quote !== "'") {
      cursor = nameEnd;
      continue;
    }
    const valueEnd = text.indexOf(quote, scan + 1);
    if (valueEnd < 0) {
      cursor = nameEnd;
      continue;
    }
    attributes.push({ name: text.slice(cursor, nameEnd), value: text.slice(scan + 1, valueEnd) });
    cursor = valueEnd + 1;
  }
  return attributes;
}

/** Opening tag a {@link BoundedSpanRule} accepted, and where its body starts. */
export interface BoundedSpanOpen {
  /** Lowercase tag name used to build the `</name>` terminator. */
  closeName: string;
  /** Text between the tag name and the opening tag's `>`. */
  attrText: string;
  /** Index just past the opening tag's `>`. */
  bodyStart: number;
  /** Optional payload the renderer needs (the `<a>` rule carries its href here). */
  href?: string;
}

/** How {@link replaceBoundedSpans} recognises and rewrites one family of `<tag>…</tag>` spans. */
export interface BoundedSpanRule {
  /**
   * Decide whether an opening tag starts at `start` (always a `<`).
   *
   * @param text   original document
   * @param lower  ASCII-lowercased copy, index-aligned with `text`
   * @param start  index of the `<`
   * @param index  shared forward-search memo; use it for every `indexOf` so failures stay O(1)
   */
  match: (text: string, lower: string, start: number, index: ForwardIndex) => BoundedSpanOpen | null;
  /** Replacement text for a matched span. */
  render: (open: BoundedSpanOpen, innerText: string) => string;
}

/**
 * Linear replacement for `/<open…>([\s\S]*?)<\/close>/gi`-shaped `String.replace` calls.
 *
 * Matches non-overlapping spans left to right and rewrites them, exactly like the global regex it
 * replaces, including its failure behaviour: an opening tag with no terminator is left in place and
 * scanning resumes at the next `<`, so a nested well-formed tag inside an unterminated one still
 * matches.
 */
export function replaceBoundedSpans(text: string, rule: BoundedSpanRule): string {
  const lower = asciiLowerCase(text);
  const index = new ForwardIndex(lower);
  let out = "";
  let copiedTo = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const start = lower.indexOf("<", cursor);
    if (start < 0) break;
    const open = rule.match(text, lower, start, index);
    if (!open) {
      cursor = start + 1;
      continue;
    }
    const closer = `</${open.closeName}>`;
    const closeStart = index.find(closer, open.bodyStart);
    if (closeStart < 0) {
      cursor = start + 1;
      continue;
    }
    out += text.slice(copiedTo, start) + rule.render(open, text.slice(open.bodyStart, closeStart));
    copiedTo = closeStart + closer.length;
    cursor = copiedTo;
  }
  return copiedTo === 0 ? text : out + text.slice(copiedTo);
}

/**
 * Resolve the `[^>]*>` tail of an opening tag: the index just past the first `>` at or after `from`.
 *
 * @returns the body start index, or -1 when the tag is never terminated
 */
export function boundedTagBodyStart(index: ForwardIndex, from: number): number {
  const tagEnd = index.find(">", from);
  return tagEnd < 0 ? -1 : tagEnd + 1;
}

/**
 * Linear replacement for `/<[^>]+>/g` (and `/<[^>]*>/g` with `allowEmpty`).
 *
 * The regex looks harmless but is quadratic on a document that opens tags it never terminates: the
 * greedy `[^>]*` runs to the end and then backtracks the whole way for every `<`. 400 KB of `<!--`
 * took 8.75 s. Scanning forward for the terminator instead makes each `<` cost one search, and a
 * document with no `>` left ends the pass immediately — the regex could not have matched later
 * either.
 *
 * @param text        markup to strip
 * @param replacement text substituted for each tag
 * @param allowEmpty  accept `<>` (the `[^>]*` form); the default `[^>]+` form requires content
 */
export function replaceMarkupTags(text: string, replacement: string, allowEmpty = false): string {
  let out = "";
  let copiedTo = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("<", cursor);
    if (start < 0) break;
    const tagEnd = text.indexOf(">", start + 1);
    if (tagEnd < 0) break;
    if (!allowEmpty && tagEnd === start + 1) {
      cursor = start + 1;
      continue;
    }
    out += text.slice(copiedTo, start) + replacement;
    copiedTo = tagEnd + 1;
    cursor = copiedTo;
  }
  return copiedTo === 0 ? text : out + text.slice(copiedTo);
}

/**
 * Linear replacement for `/<(name1|name2|…)[^>]*>/gi`.
 *
 * Same quadratic shape as {@link replaceMarkupTags} and worse in practice because the alternation is
 * retried per candidate: 400 KB of `<p` took 18.0 s. No word boundary is applied, matching the
 * regex — `<pre>` is still recognised as a `p` opening, as it was before.
 *
 * @param names lowercase names in the original alternation order; none may prefix another
 */
export function replaceNamedTagOpenings(text: string, names: readonly string[], replacement: string): string {
  const lower = asciiLowerCase(text);
  let out = "";
  let copiedTo = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const start = lower.indexOf("<", cursor);
    if (start < 0) break;
    const name = names.find((candidate) => lower.startsWith(candidate, start + 1));
    if (name === undefined) {
      cursor = start + 1;
      continue;
    }
    const tagEnd = lower.indexOf(">", start + 1 + name.length);
    if (tagEnd < 0) break;
    out += text.slice(copiedTo, start) + replacement;
    copiedTo = tagEnd + 1;
    cursor = copiedTo;
  }
  return copiedTo === 0 ? text : out + text.slice(copiedTo);
}

/** One `<name … attr="value" …>…</name>` span located by {@link scanMarkupAttributeTagPairs}. */
export interface MarkupAttributeTagPair {
  /** Index of the `<`. */
  start: number;
  /** Index just past the closing `</name>`. */
  end: number;
  /** Tag name exactly as written, after the word-boundary backtrack described below. */
  tagName: string;
  /** Text between the tag name and the opening tag's `>`, i.e. the old regex's group 2. */
  attrText: string;
  /** The quote character that delimited the attribute value. */
  quote: string;
  /** The attribute value, quotes removed and no entity decoding. */
  value: string;
}

/** `[\w:-]` — the characters a tag name may continue with in the pattern this replaces. */
function isTagNameRestCode(code: number): boolean {
  return isMarkupWordCharCode(code) || code === 0x3a || code === 0x2d;
}

/** `[A-Za-z]` — the characters a tag name may start with. */
function isAsciiLetterCode(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/** `\b` between `text[at - 1]` and `text[at]`, with out-of-range treated as a non-word char. */
function isWordBoundaryAt(text: string, at: number): boolean {
  const before = at > 0 && isMarkupWordCharCode(text.charCodeAt(at - 1));
  const after = at < text.length && isMarkupWordCharCode(text.charCodeAt(at));
  return before !== after;
}

/**
 * Attribute match found inside one opening tag: `\battr\s*=\s*(["'])([^"']+)\1` plus the `>` that
 * terminates the tag after it.
 */
interface AttributeHit {
  /** Index of the attribute name's first character. */
  start: number;
  /** Index of the `>` that ends the opening tag. */
  tagEnd: number;
  quote: string;
  value: string;
}

/**
 * Linear replacement for `/<([A-Za-z][\w:-]*)\b([^>]*\battr\s*=\s*(["'])([^"']+)\3[^>]*)>([\s\S]*?)<\/\1>/gi`.
 *
 * That shape has three amplifiers, and this repository measured all of them. The lazy body plus the
 * `\1` backreference re-scans the rest of the document once per candidate opening tag, so 36 KB of
 * unclosed `<div data-composition-src="…">` cost 3.7 ms and 288 KB cost 217.7 ms — clean quadratic
 * growth, 4x per doubling. A long attribute run that never reaches a `>` retries the greedy
 * `[^>]*` from every offset inside it: 25 KB cost 6.1 ms and 199 KB cost 390.8 ms. Motion renders
 * untrusted packages and the sibling HTML importer accepts 8 MiB, so the reachable input is two
 * orders of magnitude past those sizes.
 *
 * The scan below is a single forward pass with three memoised observations, each of which is what
 * the regex engine could have concluded but does not:
 *
 *   - No `>` at or after the tag name ends the whole scan. Every later `<` sits at a higher offset,
 *     so it has no `>` either and cannot match.
 *   - No attribute hit anywhere between the tag name and the first `>` skips PAST that `>`. A later
 *     `<` inside the same region has a strictly smaller candidate set, so it fails for the same
 *     reason. This is what removes the attribute-run curve.
 *   - A missing `</name>` is remembered per name by {@link ForwardIndex}, so a document with tens of
 *     thousands of unclosed tags pays for one failed search rather than one per tag.
 *
 * ## Fidelity
 *
 * Backtracking order is reproduced, not approximated, because the caller writes the captured tag
 * name and attribute value into a rendered artifact:
 *
 *   - The tag-name group is greedy and the `\b` after it can fail, so `<a- data-…="x">…</a>` is a
 *     match with the name `a`, not a failure. Name candidates are therefore tried longest first.
 *   - The `[^>]*` before the attribute is greedy, so the LAST viable attribute occurrence in the
 *     tag wins, not the first. Candidates are scanned right to left.
 *   - `[^"']+` accepts `>`, so a quoted value may swallow the tag's apparent terminator and the
 *     real `>` is the first one after the closing quote.
 *   - `/i` is ASCII-only case folding for the tag name, the closing tag, and the attribute name.
 *
 * @param text          document to scan
 * @param attributeName attribute that must be present, matched case-insensitively; no regex
 *                      metacharacters, and it must start with a word character so `\b` applies
 * @returns every non-overlapping span, in document order
 */
export function scanMarkupAttributeTagPairs(text: string, attributeName: string): MarkupAttributeTagPair[] {
  const lower = asciiLowerCase(text);
  const index = new ForwardIndex(lower);
  const needle = asciiLowerCase(attributeName);
  const pairs: MarkupAttributeTagPair[] = [];
  // Last occurrence of `</name>` in the document, per name. A hit can only be completed by a closer
  // that starts after the opening tag's `>`, so comparing against this answers "is there one at all"
  // in O(1) and leaves `index.find` to be called ONLY when the answer is yes — which is what keeps
  // the two nested backtrack levels below from multiplying into a quadratic.
  const lastCloser = new Map<string, number>();
  const closerEndOf = (closer: string): number => {
    let at = lastCloser.get(closer);
    if (at === undefined) {
      at = lower.lastIndexOf(closer);
      lastCloser.set(closer, at);
    }
    return at;
  };
  // Viable attribute hits of the region that ends at a given `>`, in the right-to-left order the
  // greedy `[^>]*` tries them. Cached per region because every `<` before that `>` shares it.
  let regionTagEnd = -1;
  let regionHits: AttributeHit[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const start = index.find("<", cursor);
    if (start < 0) break;
    const nameStart = start + 1;
    if (!isAsciiLetterCode(text.charCodeAt(nameStart))) {
      cursor = start + 1;
      continue;
    }
    let runEnd = nameStart + 1;
    while (runEnd < text.length && isTagNameRestCode(text.charCodeAt(runEnd))) runEnd += 1;

    // A `>` can never appear inside the name run, so the first one at or after `nameStart` is the
    // earliest terminator any name candidate could use, and it bounds where the attribute may start.
    const firstTagEnd = index.find(">", nameStart);
    if (firstTagEnd < 0) break;

    if (firstTagEnd !== regionTagEnd) {
      regionTagEnd = firstTagEnd;
      regionHits = collectAttributeHits(text, lower, needle, index, nameStart + 1, firstTagEnd);
    }

    let matched: MarkupAttributeTagPair | null = null;
    for (let attrStart = runEnd; attrStart > nameStart && !matched; attrStart -= 1) {
      if (!isWordBoundaryAt(text, attrStart)) continue;
      const tagName = text.slice(nameStart, attrStart);
      const closer = `</${asciiLowerCase(tagName)}>`;
      const closerEnd = closerEndOf(closer);
      if (closerEnd < 0) continue;
      // Two backtrack levels, resolved without walking either. `regionHits` is ordered by
      // descending `start`, so "the attribute begins at or after this name candidate" holds on a
      // PREFIX; `tagEnd` is non-increasing along the same order, so "a closer exists after this
      // tag" holds on a SUFFIX. The regex's answer — the rightmost attribute whose body can still
      // be terminated — is the first index in both, found by two binary searches.
      const viableFrom = firstHitWithCloser(regionHits, closerEnd);
      if (viableFrom >= hitCountFrom(regionHits, attrStart)) continue;
      const hit = regionHits[viableFrom]!;
      const closeStart = index.find(closer, hit.tagEnd + 1);
      if (closeStart < 0) continue;
      matched = {
        start,
        end: closeStart + closer.length,
        tagName,
        attrText: text.slice(attrStart, hit.tagEnd),
        quote: hit.quote,
        value: hit.value
      };
    }

    if (matched) {
      pairs.push(matched);
      cursor = matched.end;
      continue;
    }
    // No viable attribute anywhere between the tag name and its first `>`: every later `<` before
    // that `>` searches a subset of this window and fails for the same reason, so the scan skips
    // past it. This is what removes the attribute-run curve.
    cursor = regionHits.length > 0 ? start + 1 : firstTagEnd + 1;
  }
  return pairs;
}

/**
 * Every viable `\battr\s*=\s*(["'])([^"']+)\1` in `[from, limit)`, ordered right to left.
 *
 * Right to left because the `[^>]*` preceding the attribute in the replaced pattern is greedy, so
 * the rightmost occurrence is the one the engine reaches first.
 *
 * @param text   original document
 * @param lower  ASCII-lowercased copy, index-aligned with `text`
 * @param needle lowercase attribute name
 * @param index  shared forward-search memo
 * @param from   first offset the attribute may start at
 * @param limit  first offset it may not start at (the tag's earliest `>`)
 */
function collectAttributeHits(
  text: string,
  lower: string,
  needle: string,
  index: ForwardIndex,
  from: number,
  limit: number
): AttributeHit[] {
  const hits: AttributeHit[] = [];
  for (let at = lower.lastIndexOf(needle, limit - 1); at >= from; at = lower.lastIndexOf(needle, at - 1)) {
    const hit = readAttributeHit(text, needle, index, at);
    if (hit) hits.push(hit);
    if (at === 0) break;
  }
  return hits;
}

/**
 * Index of the first hit whose opening tag is followed by a closer, given the last closer position.
 *
 * `tagEnd` is non-increasing across `hits`, so the property holds on a suffix and is found by
 * binary search rather than by walking every hit for every tag-name candidate.
 *
 * @returns the index, or `hits.length` when no hit qualifies
 */
function firstHitWithCloser(hits: readonly AttributeHit[], closerEnd: number): number {
  let low = 0;
  let high = hits.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (hits[mid]!.tagEnd < closerEnd) high = mid;
    else low = mid + 1;
  }
  return low;
}

/**
 * Number of hits that begin at or after `attrStart`.
 *
 * `start` is strictly decreasing across `hits`, so the property holds on a prefix.
 */
function hitCountFrom(hits: readonly AttributeHit[], attrStart: number): number {
  let low = 0;
  let high = hits.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (hits[mid]!.start >= attrStart) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Read `\battr\s*=\s*(["'])([^"']+)\1` at `at`, then the `>` that ends the opening tag.
 *
 * @returns the hit, or null when the text at `at` does not complete the pattern
 */
function readAttributeHit(text: string, needle: string, index: ForwardIndex, at: number): AttributeHit | null {
  if (!isWordBoundaryAt(text, at)) return null;
  let scan = at + needle.length;
  while (scan < text.length && isMarkupSpaceCode(text.charCodeAt(scan))) scan += 1;
  if (text.charCodeAt(scan) !== 0x3d) return null;
  scan += 1;
  while (scan < text.length && isMarkupSpaceCode(text.charCodeAt(scan))) scan += 1;
  const quote = text[scan];
  if (quote !== "\"" && quote !== "'") return null;
  // `[^"']+` stops at the first quote of EITHER kind; the stopper must be the opening quote, and a
  // shorter match cannot rescue a mismatch because the character after it is still not a quote.
  let valueEnd = scan + 1;
  while (valueEnd < text.length && text[valueEnd] !== "\"" && text[valueEnd] !== "'") valueEnd += 1;
  if (valueEnd === scan + 1 || text[valueEnd] !== quote) return null;
  // The value may legally contain `>`, so the tag's terminator is the first `>` after the value.
  const tagEnd = index.find(">", valueEnd + 1);
  if (tagEnd < 0) return null;
  return { start: at, tagEnd, quote, value: text.slice(scan + 1, valueEnd) };
}

/**
 * Drop the FIRST ` name=…` attribute from an opening tag's attribute text.
 *
 * Linear replacement for ``/\sname\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/i``. The three value
 * forms, their order, the required leading whitespace, and the ASCII-only case folding are all the
 * regex's; so is removing only the first occurrence, which matters because
 * {@link scanMarkupAttributeTagPairs} captures the LAST viable one (the greedy `[^>]*` in the
 * pattern it replaces preferred the rightmost). That asymmetry is preserved deliberately — the
 * renderer's emitted HTML is hashed into a receipt, so "more sensible" here would be a behaviour
 * change, not a fix.
 *
 * @param attrText      attribute text of an opening tag
 * @param attributeName attribute to remove, matched case-insensitively; no regex metacharacters
 * @returns `attrText` without the first matching attribute, or unchanged when there is none
 */
export function removeFirstMarkupAttribute(attrText: string, attributeName: string): string {
  const lower = asciiLowerCase(attrText);
  const needle = asciiLowerCase(attributeName);
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + 1)) {
    // The regex required a leading `\s`, so an attribute glued to the previous token is not removed.
    if (at === 0 || !isMarkupSpaceCode(attrText.charCodeAt(at - 1))) continue;
    let scan = at + needle.length;
    while (scan < attrText.length && isMarkupSpaceCode(attrText.charCodeAt(scan))) scan += 1;
    if (attrText.charCodeAt(scan) !== 0x3d) continue;
    scan += 1;
    while (scan < attrText.length && isMarkupSpaceCode(attrText.charCodeAt(scan))) scan += 1;
    const quote = attrText[scan];
    let end: number;
    if (quote === "\"" || quote === "'") {
      const close = attrText.indexOf(quote, scan + 1);
      if (close < 0) continue;
      end = close + 1;
    } else {
      end = scan;
      while (end < attrText.length && !isUnquotedAttributeStopCode(attrText.charCodeAt(end))) end += 1;
      if (end === scan) continue;
    }
    return attrText.slice(0, at - 1) + attrText.slice(end);
  }
  return attrText;
}

/** ``[\s"'=<>`]`` — the characters that end an unquoted attribute value. */
function isUnquotedAttributeStopCode(code: number): boolean {
  return isMarkupSpaceCode(code) || code === 0x22 || code === 0x27 || code === 0x3d
    || code === 0x3c || code === 0x3e || code === 0x60;
}
