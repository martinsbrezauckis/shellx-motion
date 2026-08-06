/**
 * Contract tests for the bounded markup scanners.
 *
 * Two jobs:
 *
 * 1. **Equivalence.** Each scanner replaced a regex that shipped adapter output and receipts, so the
 *    original regexes are kept here as oracles and both are run over a corpus of hand-written and
 *    fuzzed documents. The corpus is deliberately small — the oracles are the quadratic/cubic
 *    patterns being replaced, so feeding them the adversarial fixtures below would hang the suite.
 *
 * 2. **Adversarial performance.** The fixtures reproduce the shapes that blocked the event loop
 *    before the rewrite, with the measured "before" wall-clock recorded next to each bound. The
 *    bounds are loose (a loaded CI box is allowed to be 30× slower than this machine) but still fail
 *    by more than an order of magnitude at the times the old code took.
 */
import { describe, expect, it } from "vitest";
import { removeFirstMarkupAttribute, scanMarkupAttributeTagPairs, scanMarkupAttributes, scanMarkupOpenTags, scanMarkupTagPairs } from "./bounded-markup";

/** Wall-clock ceiling for every adversarial fixture. Old code needed 3 s – 68 s for these. */
const ADVERSARIAL_BUDGET_MS = 2_000;

/** Original `/<name\b([\s\S]*?)(?:\/>|>)/gi` behaviour, kept as the equivalence oracle. */
function regexOpenTags(text: string, name: string): Array<{ start: number; end: number; attrText: string }> {
  const pattern = new RegExp(`<${name}\\b([\\s\\S]*?)(?:\\/>|>)`, "gi");
  return [...text.matchAll(pattern)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    attrText: match[1] ?? ""
  }));
}

/** Original `/<name\b([\s\S]*?)>([\s\S]*?)<\/name>/gi` behaviour, kept as the equivalence oracle. */
function regexTagPairs(text: string, name: string): Array<{ start: number; end: number; attrText: string; innerText: string }> {
  const pattern = new RegExp(`<${name}\\b([\\s\\S]*?)>([\\s\\S]*?)<\\/${name}>`, "gi");
  return [...text.matchAll(pattern)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    attrText: match[1] ?? "",
    innerText: match[2] ?? ""
  }));
}

/** Original attribute regex, kept as the equivalence oracle. */
function regexAttributes(text: string): Array<{ name: string; value: string }> {
  const pattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  return [...text.matchAll(pattern)].map((match) => ({
    name: match[1] ?? "",
    value: match[2] ?? match[3] ?? ""
  }));
}

/** Attribute the renderer's composition-source scan looks for. */
const ATTR = "data-composition-src";

/**
 * Original
 * `/<([A-Za-z][\w:-]*)\b([^>]*\bdata-composition-src\s*=\s*(["'])([^"']+)\3[^>]*)>([\s\S]*?)<\/\1>/gi`
 * behaviour, kept as the equivalence oracle.
 */
function regexAttributeTagPairs(text: string): Array<{
  start: number; end: number; tagName: string; attrText: string; quote: string; value: string;
}> {
  const pattern = /<([A-Za-z][\w:-]*)\b([^>]*\bdata-composition-src\s*=\s*(["'])([^"']+)\3[^>]*)>([\s\S]*?)<\/\1>/gi;
  return [...text.matchAll(pattern)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    tagName: match[1] ?? "",
    attrText: match[2] ?? "",
    quote: match[3] ?? "",
    value: match[4] ?? ""
  }));
}

/** Fragments chosen to hit every branch of the attributed-pair backtracking. */
const ATTRIBUTE_FUZZ_FRAGMENTS = [
  "<", ">", "/", "=", "\"", "'", " ", "\t", "\n", "-", ":", "_", ".", "a", "A", "b", "Z", "0", "9",
  "div", "DIV", "a-b", "a-", "a:", "<div ", "</div>", "</DIV>", "</a>", "</a->", "</a-b>",
  "<a", "<a-b ", "<a- ", "<A-B ", "</A-B>",
  ATTR, ATTR.toUpperCase(), "Data-Composition-Src", `x${ATTR}`,
  `${ATTR}="x"`, `${ATTR}='y'`, `${ATTR}=z`, `${ATTR} = "q"`, `${ATTR}=""`,
  `${ATTR}="a>b"`, `${ATTR}='a"b'`, `${ATTR}="`, "text", "<!--", "-->", "\u00e4", "\u0130"
];

/** Build a deterministic corpus for the attributed-pair oracle comparison. */
function attributeFuzzCorpus(count: number): string[] {
  const random = makeRandom(0xc0ffee);
  const documents: string[] = [];
  for (let doc = 0; doc < count; doc += 1) {
    const pieces = 2 + Math.floor(random() * 14);
    let text = "";
    for (let piece = 0; piece < pieces; piece += 1) {
      text += ATTRIBUTE_FUZZ_FRAGMENTS[Math.floor(random() * ATTRIBUTE_FUZZ_FRAGMENTS.length)] ?? "";
    }
    documents.push(text);
  }
  return documents;
}

/** Deterministic PRNG so a fuzz failure is reproducible from the seed alone. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * Fragments chosen to hit the quirks the scanners must preserve: missing terminators, `>` inside a
 * quoted value, mixed case, self-closing forms, unquoted attributes, and names that only differ by
 * a trailing word character (`<pathx`), which the `\b` must reject.
 */
const FUZZ_FRAGMENTS = [
  "<path d=\"M0 0\">", "</path>", "<path", "<path/>", "<PATH ID='p1'/>", "<pathx d=\"1\">",
  "<path d=\"a>b\" stroke=\"#fff\">", "<animate attributeName=\"d\"/>", "<animate", "</PATH>",
  "<filter id=\"f\">", "</filter>", "<mask/>", "<mask id=\"m\"></mask>",
  " id = 'x' ", "attr=", "no-quotes=value", "a.b:c=\"1\"", "dup=\"1\" dup=\"2\"",
  "----", "===", "\"", "'", ">", "<", "text", " ", "\n", "/>", "</path", "<path>"
];

/** Build a deterministic corpus of small malformed-and-valid documents. */
function fuzzCorpus(count: number): string[] {
  const random = makeRandom(0x5eed);
  const documents: string[] = [];
  for (let doc = 0; doc < count; doc += 1) {
    const pieces = 1 + Math.floor(random() * 24);
    let text = "";
    for (let piece = 0; piece < pieces; piece += 1) {
      text += FUZZ_FRAGMENTS[Math.floor(random() * FUZZ_FRAGMENTS.length)] ?? "";
    }
    documents.push(text);
  }
  return documents;
}

/** Run `call` and fail with the measured time if it exceeds `budgetMs`. */
function expectWithin<T>(budgetMs: number, call: () => T): T {
  const started = process.hrtime.bigint();
  const result = call();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  expect(elapsedMs, `completed in ${elapsedMs.toFixed(1)} ms, budget ${budgetMs} ms`).toBeLessThan(budgetMs);
  return result;
}

describe("bounded markup scanners", () => {
  it("matches the original open-tag regex on hand-written edge cases", () => {
    const cases = [
      "<svg><path d=\"M0 0\"/><path d=\"M1 1\"></path></svg>",
      "<PATH D='x'><path>",
      "<pathx d=\"1\"><path-y a=\"2\">",
      "<path d=\"a>b\">tail",
      "<path <path >",
      "<path",
      "",
      "no tags here"
    ];
    for (const text of cases) {
      expect(scanMarkupOpenTags(text, "path"), text).toEqual(regexOpenTags(text, "path"));
    }
  });

  it("matches the original tag-pair regex on hand-written edge cases", () => {
    const cases = [
      "<path a=\"1\">inner</path>",
      "<path>one</path><path>two</path>",
      "<path>outer<path>inner</path></path>",
      "<PATH>x</path>",
      "<path>unterminated",
      "<path>a</path><path>b",
      "<pathx>a</pathx>",
      "<path d=\"a>b\">c</path>"
    ];
    for (const text of cases) {
      expect(scanMarkupTagPairs(text, "path"), text).toEqual(regexTagPairs(text, "path"));
    }
  });

  it("matches the original attribute regex on hand-written edge cases", () => {
    const cases = [
      " id=\"one\" d='M0 0' stroke-width=\"2\"",
      " a.b:c_d=\"1\" _x = \t 'y' ",
      " bare novalue= broken=\"unterminated",
      " dup=\"1\" dup=\"2\"",
      " ab=c=\"x\"",
      " weird=\"a'b\" other='c\"d'",
      "",
      "aaaaaaaaaa"
    ];
    for (const text of cases) {
      expect(scanMarkupAttributes(text), text).toEqual(regexAttributes(text));
    }
  });

  it("matches the original regexes across a deterministic fuzz corpus", () => {
    for (const text of fuzzCorpus(400)) {
      expect(scanMarkupOpenTags(text, "path"), text).toEqual(regexOpenTags(text, "path"));
      expect(scanMarkupOpenTags(text, "animate"), text).toEqual(regexOpenTags(text, "animate"));
      expect(scanMarkupTagPairs(text, "path"), text).toEqual(regexTagPairs(text, "path"));
      expect(scanMarkupAttributes(text), text).toEqual(regexAttributes(text));
    }
  });

  it("scans 40 KB of never-closed <path> tags without stalling", () => {
    // `/<path\b([\s\S]*?)>([\s\S]*?)<\/path>/gi` needed 68.4 s for this exact input: it re-tried
    // every `>` for every start and then re-scanned to the end looking for a terminator.
    const bomb = `<svg>${"<path>".repeat(6_800)}`;
    expect(bomb.length).toBeGreaterThan(40_000);
    const pairs = expectWithin(ADVERSARIAL_BUDGET_MS, () => scanMarkupTagPairs(bomb, "path"));
    expect(pairs).toEqual([]);
  });

  it("scans 40 KB of attributed but never-closed <path> tags without stalling", () => {
    // 3.06 s before the rewrite for this shape.
    const bomb = `<svg>${"<path d=\"M0 0\"><animate attributeName=\"d\"/>".repeat(980)}`;
    expect(bomb.length).toBeGreaterThan(40_000);
    const opens = expectWithin(ADVERSARIAL_BUDGET_MS, () => scanMarkupOpenTags(bomb, "path"));
    expect(opens).toHaveLength(980);
  });

  it("scans a 400 KB attribute-name run that never reaches an equals sign without stalling", () => {
    // The old attribute regex re-tried the whole run from every offset inside it: 50.9 s measured
    // for exactly this input, and an 8 MiB tag is accepted by the HTML and SVG importers.
    const bomb = "a".repeat(400_000);
    const attributes = expectWithin(ADVERSARIAL_BUDGET_MS, () => scanMarkupAttributes(bomb));
    expect(attributes).toEqual([]);
  });

  it("keeps the last value for duplicate attribute names, as the old regex loop did", () => {
    const attributes = scanMarkupAttributes(" id=\"first\" id=\"second\"");
    expect(attributes.map((attribute) => attribute.value)).toEqual(["first", "second"]);
  });

  it("matches the original attributed-pair regex on hand-written edge cases", () => {
    // Each case pins one backtracking behaviour the renderer depends on, because the captured tag
    // name and attribute value are written into a rendered artifact.
    const cases = [
      // Ordinary shapes.
      `<div ${ATTR}="a.html">body</div>`,
      `<DIV ${ATTR}='a.html'>body</div>`,
      `<div ${ATTR} = "a.html" class="x">body</div>`,
      // The `\b` after the tag name can fail, and the name group then SHORTENS: this is a match
      // named "a", not a failure, and its terminator is </a>.
      `<a- ${ATTR}="a.html">body</a>`,
      `<a-b ${ATTR}="a.html">body</a-b>`,
      // The greedy `[^>]*` prefers the RIGHTMOST attribute occurrence.
      `<div ${ATTR}=unquoted ${ATTR}="second.html">body</div>`,
      // ...but falls back leftwards when the rightmost one leaves no reachable closer.
      `<a-b \t${ATTR} = "q"A-/${ATTR}="a>b"${ATTR}="x"\n</a-b>`,
      // `[^"']+` accepts `>`, so the value may swallow the tag's apparent terminator.
      `<div ${ATTR}="a>b.html">body</div>`,
      // Mismatched quotes, empty values, and a name glued to a word char are all non-matches.
      `<div ${ATTR}='a"b'>body</div>`,
      `<div ${ATTR}="">body</div>`,
      `<div x${ATTR}="a.html">body</div>`,
      `<div ${ATTR}="a.html">unterminated`,
      "<div>no attribute</div>",
      ""
    ];
    for (const text of cases) {
      expect(scanMarkupAttributeTagPairs(text, ATTR), text).toEqual(regexAttributeTagPairs(text));
    }
  });

  it("matches the original attributed-pair regex across a deterministic fuzz corpus", () => {
    // The oracle is the quadratic pattern being replaced, so the corpus stays small and malformed
    // rather than large. A 305 000-document run of this same comparison was used during the
    // rewrite; this keeps a representative slice of it in the suite.
    for (const text of attributeFuzzCorpus(4_000)) {
      expect(scanMarkupAttributeTagPairs(text, ATTR), text).toEqual(regexAttributeTagPairs(text));
    }
  });

  it("scans 288 KB of never-closed composition-source tags without stalling", () => {
    // The replaced regex took 217.7 ms here and grew 4x per doubling — 36 KB 3.7 ms, 72 KB 13.0 ms,
    // 144 KB 51.4 ms. The bounded scan is 4.3 ms and grows ~2x.
    const bomb = `<div ${ATTR}="a.html">\n`.repeat(8_192);
    expect(bomb.length).toBeGreaterThan(288_000);
    expect(expectWithin(ADVERSARIAL_BUDGET_MS, () => scanMarkupAttributeTagPairs(bomb, ATTR))).toEqual([]);
  });

  it("scans a 199 KB attribute run that never reaches a closing bracket without stalling", () => {
    // 390.8 ms before the rewrite, from 6.1 ms at 25 KB: the greedy `[^>]*` was retried from every
    // offset inside the run. The bounded scan skips past the whole region in one step.
    const bomb = `<div ${`${ATTR}="a.html" `.repeat(6_800)}`;
    expect(bomb.length).toBeGreaterThan(199_000);
    expect(expectWithin(ADVERSARIAL_BUDGET_MS, () => scanMarkupAttributeTagPairs(bomb, ATTR))).toEqual([]);
  });

  it("matches the original attribute-removal regex, including the cases it declines", () => {
    // Kept behaviour-for-behaviour: only the FIRST occurrence goes, a leading space is required,
    // and an unterminated quoted value is left alone. 120 000 fuzz documents were compared against
    // the regex during the rewrite; these pin the branches.
    const oracle = (text: string) => text.replace(/\sdata-composition-src\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/i, "");
    const cases = [
      ` ${ATTR}="a.html" class="x"`,
      ` class="x" ${ATTR}='a.html'`,
      ` ${ATTR} = \t "a.html"`,
      ` ${ATTR}=unquoted rest`,
      ` ${ATTR}="first" ${ATTR}="second"`,
      `${ATTR}="a.html"`,
      ` x${ATTR}="a.html"`,
      ` ${ATTR}="unterminated`,
      ` ${ATTR}=`,
      ` ${ATTR}`,
      " class=\"x\"",
      ""
    ];
    for (const text of cases) {
      expect(removeFirstMarkupAttribute(text, ATTR), text).toBe(oracle(text));
    }
  });

  it("scans many word-boundary name candidates crossed with many attributes without stalling", () => {
    // Not a shape the old regex was slow on — a shape the FIRST bounded rewrite was slow on. Two
    // backtrack levels (tag-name candidates x attribute candidates) multiplied into 1091.6 ms at
    // 92 KB before both levels were resolved by binary search instead of by walking.
    const bomb = `${"<a-a-a-a-a-a-a-a ".repeat(3_200)}${`${ATTR}="v" `.repeat(1_600)}>`;
    expect(bomb.length).toBeGreaterThan(92_000);
    expect(expectWithin(ADVERSARIAL_BUDGET_MS, () => scanMarkupAttributeTagPairs(bomb, ATTR))).toEqual([]);
  });
});
