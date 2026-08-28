/**
 * markdown.test.ts — unit tests for the DOM-free strict Markdown renderer used by
 * the engine-room docs reader (workbench/markdown.js).
 *
 * The module ships as a browser ES module (served static from workbench/), so it
 * is imported here through a computed file URL — that keeps it typecheck-safe as
 * untyped JS while exercising the exact code the browser runs. The load-bearing
 * property under test is that hostile source (script tags, javascript: hrefs)
 * renders inert, never as live markup.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

interface MarkdownModule {
  escapeHtml: (value: string) => string;
  isSafeHref: (href: string) => boolean;
  resolveIndexedDocumentationLink: (
    href: string,
    context: { currentPageId: string; pages: Array<{ id?: unknown; file?: unknown }> }
  ) => { pageId: string; anchor: string } | null;
  renderInline: (source: string, options?: MarkdownRenderOptions) => string;
  renderMarkdown: (source: string, options?: MarkdownRenderOptions) => string;
}

interface MarkdownRenderOptions {
  headingIds?: boolean;
  documentationLinkResolver?: (href: string) => { pageId: string; anchor: string } | null;
}

let md: MarkdownModule;

beforeAll(async () => {
  const moduleUrl = new URL("../workbench/markdown.js", import.meta.url).href;
  md = (await import(moduleUrl)) as MarkdownModule;
});

describe("markdown escaping (security)", () => {
  it("renders a script tag in the source as inert escaped text, never live markup", () => {
    const html = md.renderMarkdown("Hello <script>alert(1)</script> world");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("alert(1)"); // the text survives, but only as text
  });

  it("escapes angle brackets, ampersands and quotes in headings and paragraphs", () => {
    expect(md.renderMarkdown("# A & B <c>")).toBe("<h1>A &amp; B &lt;c&gt;</h1>");
    const para = md.renderMarkdown('a "quoted" & <tag>');
    expect(para).toContain("&quot;quoted&quot;");
    expect(para).toContain("&lt;tag&gt;");
  });

  it("neutralizes an img onerror payload embedded in the source", () => {
    const html = md.renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html.toLowerCase()).not.toContain("onerror=\"alert");
  });

  it("escapes hostile content inside inline code spans", () => {
    const html = md.renderInline("`<b>bold</b>`");
    expect(html).toContain("<code>&lt;b&gt;bold&lt;/b&gt;</code>");
    expect(html).not.toContain("<b>bold</b>");
  });

  it("escapes hostile content inside fenced code blocks", () => {
    const html = md.renderMarkdown("```\n<script>x</script>\n```");
    expect(html).toContain("<pre><code>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
  });
});

describe("markdown link safety", () => {
  it("accepts http(s) and #anchor hrefs, rejects javascript/data/protocol-relative", () => {
    expect(md.isSafeHref("https://example.com")).toBe(true);
    expect(md.isSafeHref("http://example.com/x")).toBe(true);
    expect(md.isSafeHref("#section")).toBe(true);
    expect(md.isSafeHref("javascript:alert(1)")).toBe(false);
    expect(md.isSafeHref("data:text/html,x")).toBe(false);
    expect(md.isSafeHref("//evil.example")).toBe(false);
    expect(md.isSafeHref("mailto:a@b.c")).toBe(false);
  });

  it("emits safe links with target/rel and drops disallowed-scheme links to plain text", () => {
    const safe = md.renderInline("see [docs](https://example.com/docs)");
    expect(safe).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">docs</a>');

    const unsafe = md.renderInline("click [here](javascript:alert(1))");
    // The rejected link is kept as inert literal text: no <a> element and no live
    // href are emitted (the raw scheme string may still appear as visible text).
    expect(unsafe).not.toContain("<a ");
    expect(unsafe).not.toContain("href=");
    expect(unsafe).toContain("here");
  });

  it("escapes a javascript href even when smuggled with inner parens absent", () => {
    const html = md.renderInline("[x](JavaScript:void(0))");
    expect(html).not.toContain("<a ");
  });

  it("resolves only authenticated-index relative documentation pages and bounded anchors", () => {
    const pages = [
      { id: "quickstart", file: "quickstart.md" },
      { id: "rendering", file: "rendering.md" },
      { id: "host-integration", file: "guides/host-integration.md" }
    ];
    const context = { currentPageId: "quickstart", pages };

    expect(md.resolveIndexedDocumentationLink("rendering.md#choosing-a-lane", context))
      .toEqual({ pageId: "rendering", anchor: "choosing-a-lane" });
    expect(md.resolveIndexedDocumentationLink("./rendering.md", context))
      .toEqual({ pageId: "rendering", anchor: "" });
    expect(md.resolveIndexedDocumentationLink("#install-expectations", context))
      .toEqual({ pageId: "quickstart", anchor: "install-expectations" });
    expect(md.resolveIndexedDocumentationLink("../quickstart.md", {
      currentPageId: "host-integration",
      pages
    })).toEqual({ pageId: "quickstart", anchor: "" });
  });

  it("keeps arbitrary paths, URL-like values, unsafe schemes, and non-indexed pages inert", () => {
    const context = {
      currentPageId: "quickstart",
      pages: [{ id: "quickstart", file: "quickstart.md" }, { id: "rendering", file: "rendering.md" }]
    };
    for (const href of [
      "missing.md", "../../etc/passwd", "/etc/passwd", "//evil.example/docs.md", "C:\\docs\\rendering.md",
      "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "mailto:ops@example.test",
      "https://example.test/docs.md", "rendering.md?next=1", "rendering.md#bad anchor", "#"
    ]) {
      expect(md.resolveIndexedDocumentationLink(href, context), href).toBeNull();
    }
  });

  it("renders indexed Docs links as reader targets, retains protected external links, and leaves rejected links literal", () => {
    const pages = [{ id: "quickstart", file: "quickstart.md" }, { id: "rendering", file: "rendering.md" }];
    const options: MarkdownRenderOptions = {
      headingIds: true,
      documentationLinkResolver: (href) => md.resolveIndexedDocumentationLink(href, { currentPageId: "quickstart", pages })
    };
    const html = md.renderMarkdown([
      "# Quickstart",
      "## Install expectations",
      "[Rendering lanes](rendering.md#choosing-a-lane)",
      "[This section](#install-expectations)",
      "[External](https://example.test/guide)",
      "[Filesystem](../../etc/passwd)",
      "[Script](javascript:alert(1))"
    ].join("\n\n"), options);

    expect(html).toContain('<h1 id="quickstart">Quickstart</h1>');
    expect(html).toContain('<h2 id="install-expectations">Install expectations</h2>');
    expect(html).toContain('<a href="#choosing-a-lane" data-doc-page-id="rendering" data-doc-anchor="choosing-a-lane">Rendering lanes</a>');
    expect(html).toContain('<a href="#install-expectations" data-doc-page-id="quickstart" data-doc-anchor="install-expectations">This section</a>');
    expect(html).toContain('<a href="https://example.test/guide" target="_blank" rel="noopener noreferrer">External</a>');
    expect(html).toContain("[Filesystem](../../etc/passwd)");
    expect(html).toContain("[Script](javascript:alert(1))");
    expect(html).not.toContain('href="../../etc/passwd"');
    expect(html).not.toContain('href="javascript:');
    expect(md.renderMarkdown("### `motion.canvas.bridge_export`", { headingIds: true }))
      .toContain('<h3 id="motioncanvasbridge_export"><code>motion.canvas.bridge_export</code></h3>');
  });

  it("binds shipped Quickstart relative links and Rendering anchors only through the human index", async () => {
    const docsRoot = new URL("../../../docs/public/", import.meta.url);
    const index = JSON.parse(await readFile(new URL("index.json", docsRoot), "utf8")) as {
      sections: Array<{ pages: Array<{ id: string; file: string; audience?: string }> }>;
    };
    const pages = index.sections.flatMap((section) => section.pages)
      .filter((page) => page.audience !== "agent")
      .map(({ id, file }) => ({ id, file }));
    const quickstart = await readFile(new URL("quickstart.md", docsRoot), "utf8");
    const rendering = await readFile(new URL("rendering.md", docsRoot), "utf8");
    const quickstartHtml = md.renderMarkdown(quickstart, {
      headingIds: true,
      documentationLinkResolver: (href) => md.resolveIndexedDocumentationLink(href, { currentPageId: "quickstart", pages })
    });
    const renderingHtml = md.renderMarkdown(rendering, {
      headingIds: true,
      documentationLinkResolver: (href) => md.resolveIndexedDocumentationLink(href, { currentPageId: "rendering", pages })
    });

    expect(quickstartHtml).toContain('data-doc-page-id="connections"');
    expect(quickstartHtml).toContain('data-doc-page-id="rendering" data-doc-anchor="choosing-a-lane"');
    expect(quickstartHtml).toContain('data-doc-page-id="motion-validation"');
    expect(renderingHtml).toContain('<h2 id="choosing-a-lane">Choosing a lane</h2>');
  });
});

describe("markdown structural rendering", () => {
  it("renders headings h1..h6", () => {
    expect(md.renderMarkdown("### Three")).toBe("<h3>Three</h3>");
    expect(md.renderMarkdown("###### Six")).toBe("<h6>Six</h6>");
  });

  it("renders bold and italic emphasis", () => {
    expect(md.renderInline("**bold** and *italic*")).toBe("<strong>bold</strong> and <em>italic</em>");
    expect(md.renderInline("__b__ and _i_")).toContain("<strong>b</strong>");
  });

  it("renders unordered and ordered lists", () => {
    expect(md.renderMarkdown("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(md.renderMarkdown("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
  });

  it("renders a pipe table with header and body cells", () => {
    const html = md.renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<td>2</td>");
  });

  it("groups consecutive lines into a single paragraph and separates blocks on blank lines", () => {
    const html = md.renderMarkdown("line one\nline two\n\nsecond para");
    expect(html).toBe("<p>line one line two</p>\n<p>second para</p>");
  });

  it("renders fenced code with a language class when the info string is a simple token", () => {
    const html = md.renderMarkdown("```ts\nconst x = 1;\n```");
    expect(html).toContain('<pre><code class="language-ts">const x = 1;</code></pre>');
  });
});
