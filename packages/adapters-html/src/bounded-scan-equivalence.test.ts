/**
 * Compare bounded scans with the retired regex behavior on generated adversarial input.
 * `hasExternalStylesheetLink()` affects emitted lossiness receipts, and
 * `scanCssFunctions()` must preserve the accepted parse shape.
 * Keep inputs small because the regex oracles can take quadratic time.
 */
import { describe, expect, it } from "vitest";
import { __boundedScanTestAccess } from "./index";

const { hasExternalStylesheetLink, scanCssFunctions } = __boundedScanTestAccess;

/** The retired patterns, kept only as oracles. */
const LEGACY_STYLESHEET = /<link\b[^>]*\brel\s*=\s*(?:["'][^"']*stylesheet|stylesheet\b)/i;
const LEGACY_CSS_FUNCTIONS = /([a-z-]+)\(([^)]*)\)/gi;

function legacyCssFunctions(value: string): Array<{ text: string; name: string; argument: string }> {
  LEGACY_CSS_FUNCTIONS.lastIndex = 0;
  return [...value.matchAll(LEGACY_CSS_FUNCTIONS)]
    .map((match) => ({ text: match[0], name: match[1] as string, argument: match[2] as string }));
}

/** Deterministic generator: a seeded walk, so a failure is reproducible from its index. */
function pick<T>(items: T[], seed: number): T {
  return items[Math.abs(Math.imul(seed, 2654435761)) % items.length] as T;
}

describe("hasExternalStylesheetLink matches the regex it replaced", () => {
  const FRAGMENTS = [
    "<link", "<linkx", "<link ", "<link/>", ">", " ", "\n", "\t",
    "rel=stylesheet", "rel = stylesheet", "rel=\"stylesheet\"", "rel='x stylesheet'",
    "rel=\"nofollow\"", "rel=stylesheetish", "REL=STYLESHEET", "Rel = \"alternate stylesheet\"",
    "href=\"a.css\"", "<a ", "<meta ", "stylesheet", "rel=", "=\"", "'", "\"", "<", "/>"
  ];

  it("agrees on 20000 generated documents", () => {
    let checked = 0;
    for (let seed = 0; seed < 20_000; seed += 1) {
      const parts: string[] = [];
      const length = 1 + (seed % 7);
      for (let piece = 0; piece < length; piece += 1) parts.push(pick(FRAGMENTS, seed * 31 + piece));
      const html = parts.join("");
      expect(hasExternalStylesheetLink(html), `mismatch on ${JSON.stringify(html)}`)
        .toBe(LEGACY_STYLESHEET.test(html));
      checked += 1;
    }
    expect(checked).toBe(20_000);
  });

  it("agrees on the shapes the prose argument turns on", () => {
    const CASES = [
      "<link rel=stylesheet>",
      "<link><link rel=stylesheet>",
      "<link>rel=stylesheet",                       // rel is past this opener's '>'
      "<link rel=stylesheet",                       // opener never closes
      "<linkrel=stylesheet>",                       // not a <link> tag at all
      "<link\nrel=\"stylesheet\">",
      "<link a='>' rel=stylesheet>",                // quoted '>' — both stop at the raw '>'
      "<link <link rel=stylesheet>",                // two openers sharing one '>'
      "<LINK REL=STYLESHEET>",
      "<link rel=\"alternate stylesheet\">",
      "<link rel=stylesheetx>",                     // \b must reject the longer word
      ""
    ];
    for (const html of CASES) {
      expect(hasExternalStylesheetLink(html), `mismatch on ${JSON.stringify(html)}`)
        .toBe(LEGACY_STYLESHEET.test(html));
    }
  });
});

describe("scanCssFunctions matches the regex it replaced", () => {
  const FRAGMENTS = [
    "translate", "rotate", "url", "a", "-webkit-thing", "AB", "(", ")", "()", "(a)",
    "translate(", "10px", ",", " ", "#id", "'q'", "\"q\"", "()()", "((", "))", "-", "--var",
    "calc(1 + 2)", "var(--x)", "url(a(b))", "rgb(0,0,0)", "9", "%", ";"
  ];

  it("agrees on 20000 generated values", () => {
    for (let seed = 0; seed < 20_000; seed += 1) {
      const parts: string[] = [];
      const length = 1 + (seed % 8);
      for (let piece = 0; piece < length; piece += 1) parts.push(pick(FRAGMENTS, seed * 17 + piece));
      const value = parts.join("");
      expect(scanCssFunctions(value), `mismatch on ${JSON.stringify(value)}`)
        .toEqual(legacyCssFunctions(value));
    }
  });

  it("agrees on nesting, unclosed parens and digit boundaries", () => {
    const CASES = [
      "translate(10px)", "url(a(b))", "calc(1 + var(--x))", "abc(def", "((()))",
      "a()b()", "-webkit-transform(1)", "TRANSLATE(1)", "x9(1)", "9x(1)", "--v(1)",
      "rotate( 45deg )", "()", "(", ")", "", "no-functions-here", "a(b)c(d)e("
    ];
    for (const value of CASES) {
      expect(scanCssFunctions(value), `mismatch on ${JSON.stringify(value)}`)
        .toEqual(legacyCssFunctions(value));
    }
  });
});
