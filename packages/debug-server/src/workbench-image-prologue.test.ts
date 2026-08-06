/**
 * The SVG poster prologue check: same decision as the regex it replaced, without the blow-up.
 *
 * The prologue was once matched with
 *
 *   /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i
 *
 * whose outer `*` wraps a lazy body that can span several comments. A document that never opens an
 * `<svg>` forced the engine through every partition of the comment run: 248 bytes of ordinary,
 * well-formed comments blocked the event loop for 55 seconds, and each additional pair of comments
 * quadrupled that. `GET /workbench/poster` reaches this before any other check, and Node is
 * single-threaded, so the caller chose how long the entire debug server stopped answering.
 *
 * Two properties are pinned here, and the second is the one that makes the first safe to trust:
 * the replacement is LINEAR, and it accepts and rejects exactly what the old pattern did.
 */
import { describe, expect, it } from "vitest";
import { startsWithSvgDocument } from "./workbench-image";

/** The exact pattern that shipped, kept as an equivalence oracle. Never used on hostile input. */
const LEGACY_PROLOGUE = /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i;

const CASES = [
  "<svg>", "<svg ", "<svg/>", "<SVG >", "<svgx>", "<svg", "",
  " \t\n <svg>", " <svg>",
  "<?xml version=\"1.0\"?><svg>", "<?xml version=\"1.0\"?>\n<svg>", "<?XML v?><svg>",
  "<?xml no terminator <svg>",
  "<!--c--><svg>", "<!--c--> <!--d--> <svg>", "<!----><svg>",
  "<!--c-->x<svg>", "<!--unterminated <svg>", "<!-- -- > --><svg>",

  "<svg><!--c-->", "  <!--a-->\n\t<!--b-->\r\n<svg\n>",
  "<html><svg>", "not an svg at all", "<!--a--><!--b--><notsvg>",
  "<?xml?>   ", "<!--a-->", "<?xml ?><!--a--><!--b--><svg >"
];

describe("SVG poster prologue", () => {
  it("makes the same decision as the pattern it replaced", () => {
    for (const input of CASES) {
      expect(startsWithSvgDocument(input), `mismatch on ${JSON.stringify(input)}`)
        .toBe(LEGACY_PROLOGUE.test(input));
    }
  });

  // The two places the replacement deliberately differs. Named here so a future reader finds the
  // decision rather than rediscovering it as a bug.
  it("accepts several processing instructions, as the old pattern's backtracking also did", () => {
    // xml-stylesheet occurs in real SVG files; a strict one-declaration reading would reject it.
    expect(startsWithSvgDocument('<?xml version="1.0"?><?xml-stylesheet href="#s"?><svg>')).toBe(true);
    expect(LEGACY_PROLOGUE.test('<?xml version="1.0"?><?xml-stylesheet href="#s"?><svg>')).toBe(true);
  });

  it("accepts a comment before a processing instruction, which the old pattern refused", () => {
    expect(startsWithSvgDocument("<!--c--><?xml?><svg>")).toBe(true);
    expect(LEGACY_PROLOGUE.test("<!--c--><?xml?><svg>")).toBe(false);
  });

  it("agrees with the old pattern on generated comment prologues", () => {
    // Bounded to 12 comments: beyond that the ORACLE is the thing that hangs, which is the point.
    for (let comments = 0; comments <= 12; comments += 1) {
      for (const tail of ["<svg>", "<notsvg>", "x", ""]) {
        for (const gap of ["", " ", "\n\t"]) {
          const input = `${`<!--c-->${gap}`.repeat(comments)}${tail}`;
          expect(startsWithSvgDocument(input), `mismatch on ${comments} comments + ${JSON.stringify(tail)}`)
            .toBe(LEGACY_PROLOGUE.test(input));
        }
      }
    }
  });

  it("stays linear on the input that took the old pattern 55 seconds", () => {
    // Thirty comments followed by a non-SVG tag reproduce the pathological input. The bound is generous
    // on purpose — the defect was five orders of magnitude, so this cannot pass by accident.
    const hostile = `${"<!--c-->".repeat(30)}<notsvg>`;
    const started = performance.now();
    expect(startsWithSvgDocument(hostile)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("grows linearly, not exponentially, as the comment run doubles", () => {
    const timeFor = (comments: number): number => {
      const input = `${"<!--c-->".repeat(comments)}<notsvg>`;
      const started = performance.now();
      for (let pass = 0; pass < 200; pass += 1) startsWithSvgDocument(input);
      return performance.now() - started;
    };
    timeFor(200);
    // 8x the input must not cost anything like 2^n. Exponential growth fails this by a vast margin;
    // a generous multiple keeps it stable on a loaded machine.
    expect(timeFor(1_600)).toBeLessThan(Math.max(timeFor(200), 1) * 60);
  });
});
