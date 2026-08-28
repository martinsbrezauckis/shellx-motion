import { describe, expect, it } from "vitest";
import { parseHtmlSnippet } from "./html-snippet-import-parse";

describe("HTML snippet import bounds", () => {
  it("keeps an ordinary maximum-size layer list and its lossiness semantics", () => {
    const html = snippet(Array.from({ length: 1_000 }, (_, index) => layer(index)).join(""));

    const parsed = parseHtmlSnippet(html, { createdBy: "bounds-test" });

    expect(parsed.motion.layers).toHaveLength(1_000);
    expect(parsed.motion.layers[0]?.id).toBe("layer_0");
    expect(parsed.motion.layers[999]?.id).toBe("layer_999");
    expect(parsed.lossiness).toEqual([]);
  });

  it("preserves ordinary metadata mapping and duplicate-attribute semantics within the new budgets", () => {
    const html = `<!doctype html><html><head><title>Legitimate</title></head><body>
<main data-composition-id="motion_legitimate" data-duration="1600" style="width:320px;height:180px;background:#112233">
  <div data-layer-id="first" data-layer-id="title" data-layer-type="text" data-start="100" data-duration="900" style="left:12px;top:24px;color:#ffffff;font-size:32px">Hello &amp; Motion</div>
</main></body></html>`;

    const parsed = parseHtmlSnippet(html, { createdBy: "bounds-test" });

    expect(parsed.motion).toMatchObject({
      id: "motion_legitimate",
      durationMs: 1600,
      width: 320,
      height: 180,
      background: "#112233",
      layers: [{
        id: "title",
        type: "text",
        text: "Hello & Motion",
        startMs: 100,
        durationMs: 900,
        transform: { x: 12, y: 24 },
        style: { color: "#ffffff", fontSize: 32 }
      }]
    });
    expect(parsed.lossiness).toEqual([]);
  });

  it("stops candidate scanning at the 1001st layer candidate", () => {
    const html = snippet(Array.from({ length: 1_001 }, (_, index) => layer(index)).join(""));

    expect(() => parseHtmlSnippet(html, { createdBy: "bounds-test" }))
      .toThrow("HTML snippet import exceeds the 1000-layer limit.");
  });

  it("refuses per-element attribute, style, and decoded-string work before mapping", () => {
    const attributes = Array.from({ length: 63 }, (_, index) => `data-extra-${index}="${index}"`).join(" ");
    expect(() => parseHtmlSnippet(snippet(layer(0, attributes)), { createdBy: "bounds-test" }))
      .toThrow("HTML snippet import exceeds the 64-attribute per-element limit.");

    const style = Array.from({ length: 65 }, (_, index) => `x${index}:0`).join(";");
    expect(() => parseHtmlSnippet(snippet(layer(0, `style="${style}"`)), { createdBy: "bounds-test" }))
      .toThrow("HTML snippet import exceeds the 64-style-entry per-element limit.");

    expect(() => parseHtmlSnippet(snippet(layer(0, `data-note="${"a".repeat(65_536)}"`)), { createdBy: "bounds-test" }))
      .toThrow("HTML snippet import decoded strings exceed the 65536-character per-element limit.");
  });

  it("refuses a 400 KB CSS transform value before decoded-string work can grow", () => {
    // 57.4 s before the bounded scanner: `/([a-z-]+)\(([^)]*)\)/gi` re-tried the letter run per offset.
    const style = `transform:${"a".repeat(400_000)}`;
    const html = snippet(`<div data-layer-id="only" data-layer-type="text" style="${style}">hi</div>`);

    expect(html.length).toBeGreaterThan(400_000);
    expect(() => parseHtmlSnippet(html, { createdBy: "bounds-test" }))
      .toThrow("HTML snippet import decoded strings exceed the 65536-character per-element limit.");
  });

  it("refuses lossiness before diagnostic strings can materialize an oversized receipt", () => {
    const style = `unsupported-${"x".repeat(4_000)}:0`;
    const html = snippet(Array.from({ length: 100 }, (_, index) => layer(index, `style="${style}"`)).join(""));

    expect(() => parseHtmlSnippet(html, { createdBy: "bounds-test" }))
      .toThrow("HTML snippet import lossiness receipt exceeds the 786432-byte limit.");
  });

  it("refuses excessive lossiness finding counts independently of metadata budgets", () => {
    const style = Array.from({ length: 64 }, (_, index) => `unsupported-${index}:0`).join(";");
    const html = snippet(Array.from({ length: 33 }, (_, index) => layer(index, `style="${style}"`)).join(""));

    expect(() => parseHtmlSnippet(html, { createdBy: "bounds-test" }))
      .toThrow("HTML snippet import exceeds the 2048-finding lossiness receipt limit.");
  });
});

function snippet(body: string): string {
  return `<!doctype html><html><head><title>Bounds</title></head><body><main data-composition-id="motion_bounds">${body}</main></body></html>`;
}

function layer(index: number, extra = ""): string {
  return `<div data-layer-id="layer_${index}" data-layer-type="shape" ${extra}></div>`;
}
