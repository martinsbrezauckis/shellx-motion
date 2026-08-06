/**
 * Contract tests for the fetched-HTML → Markdown cleanup.
 *
 * The previous implementation is kept below as an equivalence oracle: it is the chain of lazy
 * nested regexes that shipped every imported source document, and the rewrite is only worth having
 * if it produces the same Markdown. The oracle is only ever run on the small corpus — it is the
 * quadratic code being replaced, so the adversarial fixtures at the bottom would hang it.
 */
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./source-html-markdown";

/** Wall-clock ceiling for the adversarial fixtures. The oracle needed 14.7 s for the 815 KB one. */
const ADVERSARIAL_BUDGET_MS = 2_000;

/** The pre-rewrite implementation, verbatim, used only as an equivalence oracle on small inputs. */
function legacyHtmlToMarkdown(html: string): string {
  const inlineHtml = (fragment: string): string => fragment.replace(/<[^>]+>/g, " ");
  const decodeHtmlEntities = (value: string): string => value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'");
  const stripHtml = (fragment: string): string => decodeHtmlEntities(fragment).replace(/\s+/g, " ").trim();
  return html
    .replace(/<(script|style|noscript|svg|head|nav|footer|form|iframe)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, inner) => `\n\n${"#".repeat(Number(level))} ${stripHtml(inlineHtml(inner))}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match, inner) => `\n- ${stripHtml(inlineHtml(inner))}`)
    .replace(/<(p|div|section|article|main|tr|ul|ol|blockquote)[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|tr|li|ul|ol|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, inner) => {
      const text = stripHtml(inlineHtml(inner));
      return text ? `[${text}](${href})` : "";
    })
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((line) => decodeHtmlEntities(line).replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
 * Fragments chosen to hit every branch of the chain plus the quirks it must keep: `<li` matching
 * without a word boundary, the *last* `href` in a tag winning, entities, comments, and tags whose
 * terminator is missing.
 */
const FUZZ_FRAGMENTS = [
  "<p>Body copy.</p>", "<div class=\"x\">", "</div>", "<h1>Title</h1>", "<h3 id=\"s\">Sub</h3>",
  "<h2>open", "</h2>", "<ul>", "<li>Item</li>", "<li class='c'>Second", "</li>", "</ul>",
  "<a href=\"https://example.com/a\">Link</a>", "<a data-href=\"x\" href='https://example.com/b'>B</a>",
  "<a href=\"https://example.com/c\">", "</a>", "<a>", "<link rel=\"stylesheet\">",
  "<script>var x = 1;</script>", "<script>unterminated", "<style>.a{}</style>",
  "<!-- comment -->", "<!-- open", "<br>", "<br/>", "<br />", "<svg><path/></svg>",
  "Plain text ", "&amp; &lt;tag&gt; &nbsp;&#39;", "<blockquote>Quote</blockquote>",
  "<tr><td>cell</td></tr>", "<b>bold</b>", "<iframe src=\"y\"></iframe>", "\n", "  ", "<"
];

/** Build a deterministic corpus of small HTML documents. */
function fuzzCorpus(count: number): string[] {
  const random = makeRandom(0xc0ffee);
  const documents: string[] = [];
  for (let doc = 0; doc < count; doc += 1) {
    const pieces = 1 + Math.floor(random() * 18);
    let html = "";
    for (let piece = 0; piece < pieces; piece += 1) {
      html += FUZZ_FRAGMENTS[Math.floor(random() * FUZZ_FRAGMENTS.length)] ?? "";
    }
    documents.push(html);
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

describe("fetched HTML to Markdown", () => {
  it("converts a realistic article the same way the previous implementation did", () => {
    const html = [
      "<!doctype html><html><head><title>T</title><style>.a{color:red}</style></head>",
      "<body><nav><a href=\"/skip\">skip</a></nav>",
      "<main><h1>Motion &amp; agents</h1><p>First paragraph with a <a href=\"https://example.com/doc\">doc link</a>.</p>",
      "<h2>Steps</h2><ul><li>Install</li><li>Render <b>fast</b></li></ul>",
      "<!-- hidden --><blockquote>Quoted line</blockquote><br>Trailing.</main>",
      "<footer><a href=\"/legal\">legal</a></footer></body></html>"
    ].join("");
    const markdown = htmlToMarkdown(html);
    expect(markdown).toBe(legacyHtmlToMarkdown(html));
    expect(markdown).toContain("# Motion & agents");
    expect(markdown).toContain("[doc link](https://example.com/doc)");
    expect(markdown).toContain("- Install");
    expect(markdown).not.toContain("skip");
    expect(markdown).not.toContain("legal");
  });

  it("matches the previous implementation across a deterministic fuzz corpus", () => {
    for (const html of fuzzCorpus(500)) {
      expect(htmlToMarkdown(html), html).toBe(legacyHtmlToMarkdown(html));
    }
  });

  it("keeps the previous quirks: bare <li>, last href wins, unterminated tags survive", () => {
    const cases = [
      "<link rel=\"stylesheet\">text</li>",
      "<a href=\"first\" href='second'>label</a>",
      "<a href=\"only\">   </a>",
      "<h7>not a heading</h7>",
      "<script>never closed<p>after",
      "<!-- never closed <p>after",
      "<H2 CLASS=\"x\">Upper</H2>"
    ];
    for (const html of cases) {
      expect(htmlToMarkdown(html), html).toBe(legacyHtmlToMarkdown(html));
    }
  });

  it("converts 815 KB of never-closed list items without stalling", () => {
    // 14.7 s before the rewrite: every `<li>` re-scanned the rest of the document for a `</li>`.
    const bomb = `<html><body><ul>${"<li>x".repeat(163_000)}</ul></body></html>`;
    expect(bomb.length).toBeGreaterThan(800_000);
    const markdown = expectWithin(ADVERSARIAL_BUDGET_MS, () => htmlToMarkdown(bomb));
    expect(markdown).toBe("x".repeat(163_000));
  });

  it("converts 795 KB of never-closed anchors and list items without stalling", () => {
    // 1.2 s before the rewrite for this shape; the same document with denser openers took 14.7 s.
    const units = Array.from({ length: 12_000 }, (_, index) =>
      `<li class="row r${index}"><a href="https://example.com/${index}">item ${index}`);
    const bomb = `<html><body><ul>${units.join("")}</ul></body></html>`;
    expect(bomb.length).toBeGreaterThan(700_000);
    const markdown = expectWithin(ADVERSARIAL_BUDGET_MS, () => htmlToMarkdown(bomb));
    expect(markdown).toContain("item 11999");
  });

  it("converts 800 KB of never-closed <script> and comment openers without stalling", () => {
    // This fixture found a second quadratic path during the rewrite: the trailing `/<[^>]+>/g` tag
    // stripper re-scanned to the end of the document for every `<` once the document ran out of
    // `>` (8.75 s on the 400 KB comment run alone), and `/<(p|div|…)[^>]*>/gi` did the same at
    // 18.0 s. Both are bounded scans now.
    const bomb = `${"<script>".repeat(50_000)}${"<!--".repeat(100_000)}`;
    expect(bomb.length).toBeGreaterThan(700_000);
    const markdown = expectWithin(ADVERSARIAL_BUDGET_MS, () => htmlToMarkdown(bomb));
    // Unterminated `<script>` openings are stripped as bare tags; `<!--` never reaches a `-->` or a
    // `>`, so it survives verbatim — exactly what the previous chain produced.
    expect(markdown).toBe("<!--".repeat(100_000));
  });

  it("converts 400 KB of never-closed block openings without stalling", () => {
    // `/<(p|div|section|…)[^>]*>/gi` took 18.0 s on this input.
    const bomb = "<p".repeat(200_000);
    const markdown = expectWithin(ADVERSARIAL_BUDGET_MS, () => htmlToMarkdown(bomb));
    expect(markdown).toBe(bomb);
  });
});

/**
 * The anchor pass must stay linear on ORDINARY documents, not only on adversarial ones.
 *
 * `nextQuoteIndex` once called `indexOf` for both
 * quote characters and minimised afterwards. A document with no apostrophe in it — the common case
 * for link-heavy HTML — made the second call scan to the end of the document once per `href`
 * candidate. The bounded rewrite was therefore quadratic where the lazy regex it replaced had been
 * linear, and 38x slower at 1.6 MB while growing 4x per doubling.
 *
 * The lesson is the reason this test measures growth rather than absolute time: a rewrite that
 * removes catastrophic backtracking can still introduce a quadratic, and the module header's claim
 * that "cost is linear in html.length for every input shape" was believed rather than checked.
 */
describe("anchor pass cost", () => {
  const timeFor = (unit: string, count: number): number => {
    const html = unit.repeat(count);
    const started = performance.now();
    htmlToMarkdown(html);
    return performance.now() - started;
  };

  it("grows linearly on apostrophe-free link-heavy HTML", () => {
    const unit = '<a href="https://example.com/page">link</a>\n';
    timeFor(unit, 4_000);
    const small = Math.max(timeFor(unit, 10_000), 1);
    const large = timeFor(unit, 40_000);
    // 4x the input. Linear lands near 4x; the quadratic this replaced was ~16x. A generous ceiling
    // keeps the test stable under load while still failing the defect by a wide margin.
    expect(large).toBeLessThan(small * 9);
  });

  it("grows linearly on an empty-href run, the worst candidate density", () => {
    const unit = '<a href="">x</a>';
    timeFor(unit, 8_000);
    const small = Math.max(timeFor(unit, 20_000), 1);
    const large = timeFor(unit, 80_000);
    expect(large).toBeLessThan(small * 9);
  });
});
