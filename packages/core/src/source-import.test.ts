import { describe, expect, it } from "vitest";
import {
  assertPublicSourceUrl,
  buildScriptedVideoFromSourceImport,
  buildSourceImportDocument,
  extractSourceUrls,
  fetchSourceDocument,
  inferSourceImportKind,
  loadSchema,
  validateDocument
} from "./index";

const PUBLIC_RESOLVER = async () => [{ address: "93.184.216.34", family: 4 as const }];

describe("source import helpers", () => {
  it("extracts distinct public source URLs from prompt text in order", () => {
    expect(extractSourceUrls("make a video from https://example.com/a?x=1, then https://github.com/nexu-io/html-video and https://example.com/a?x=1")).toEqual([
      "https://example.com/a?x=1",
      "https://github.com/nexu-io/html-video"
    ]);
  });

  it("rejects localhost and private-network source URLs before fetch", () => {
    expect(() => assertPublicSourceUrl("http://localhost:3000/article")).toThrow("refusing to fetch local host: localhost");
    expect(() => assertPublicSourceUrl("http://127.0.0.1/article")).toThrow("refusing to fetch private IP: 127.0.0.1");
    expect(() => assertPublicSourceUrl("file:///tmp/article.html")).toThrow("only http(s) URLs are allowed");
  });

  it("rejects direct non-public IP source URLs before fetch", () => {
    expect(() => assertPublicSourceUrl("http://[::1]/article")).toThrow("refusing to fetch private IP");
    expect(() => assertPublicSourceUrl("http://[fc00::1]/article")).toThrow("refusing to fetch private IP");
    expect(() => assertPublicSourceUrl("http://[fe80::1]/article")).toThrow("refusing to fetch private IP");
    expect(() => assertPublicSourceUrl("http://100.64.0.1/article")).toThrow("refusing to fetch private IP: 100.64.0.1");
    expect(() => assertPublicSourceUrl("http://198.18.0.1/article")).toThrow("refusing to fetch private IP: 198.18.0.1");
    expect(() => assertPublicSourceUrl("http://224.0.0.1/article")).toThrow("refusing to fetch private IP: 224.0.0.1");
  });

  it("classifies SVG source URLs as adapter imports before generic article imports", () => {
    expect(inferSourceImportKind("https://example.com/hero/path-animation.svg")).toBe("svg");
    expect(inferSourceImportKind("https://github.com/nexu-io/html-video")).toBe("repo");
    expect(inferSourceImportKind("https://example.com/articles/motion")).toBe("article");
  });

  it("builds deterministic Markdown source documents with truncation evidence", () => {
    const imported = buildSourceImportDocument({
      url: "https://example.com/article",
      title: "Example Article",
      kind: "article",
      markdown: "Alpha\n\nBeta\n\nGamma",
      maxChars: 12
    });

    expect(imported).toMatchObject({
      url: "https://example.com/article",
      title: "Example Article",
      kind: "article",
      truncated: true,
      markdown: "# Example Article\n\nSource: https://example.com/article\nKind: article\n\nAlpha\n\nBeta\n"
    });
    expect(imported.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fetches GitHub repository links as deterministic source Markdown through an injected fetcher", async () => {
    const requestedUrls: string[] = [];
    const fetched = await fetchSourceDocument("https://github.com/nexu-io/html-video", {
      resolver: PUBLIC_RESOLVER,
      fetcher: async (url) => {
        requestedUrls.push(url);
        if (url === "https://api.github.com/repos/nexu-io/html-video") {
          return sourceFetchResponse(JSON.stringify({
            full_name: "nexu-io/html-video",
            description: "HTML becomes video on your laptop",
            language: "TypeScript",
            stargazers_count: 42,
            topics: ["video", "agents"],
            license: { spdx_id: "Apache-2.0" },
            homepage: "https://open-design.ai"
          }), "application/json");
        }
        if (url === "https://api.github.com/repos/nexu-io/html-video/readme") {
          return sourceFetchResponse("HTML becomes video.\n\nUse local agents and MP4 export.", "text/markdown");
        }
        if (url === "https://api.github.com/repos/nexu-io/html-video/contents") {
          return sourceFetchResponse(JSON.stringify([
            { name: "packages", type: "dir" },
            { name: "README.md", type: "file" }
          ]), "application/json");
        }
        return sourceFetchResponse("missing", "text/plain", 404, "Not Found");
      }
    });

    expect(fetched).toMatchObject({
      title: "nexu-io/html-video",
      kind: "repo"
    });
    expect(fetched.markdown).toContain("> HTML becomes video on your laptop");
    expect(fetched.markdown).toContain("- Language: TypeScript");
    expect(fetched.markdown).toContain("- License: Apache-2.0");
    expect(fetched.markdown).toContain("## Top-level structure");
    expect(fetched.markdown).toContain("- packages/");
    expect(fetched.markdown).toContain("## README");
    expect(fetched.markdown).toContain("Use local agents and MP4 export.");
    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/nexu-io/html-video",
      "https://api.github.com/repos/nexu-io/html-video/readme",
      "https://api.github.com/repos/nexu-io/html-video/contents"
    ]);
  });

  it("converts fetched HTML article content to Markdown source text", async () => {
    const fetched = await fetchSourceDocument("https://example.com/articles/motion", {
      resolver: PUBLIC_RESOLVER,
      fetcher: async () => sourceFetchResponse([
        "<!doctype html><html><head><style>.hidden{}</style></head><body>",
        "<nav>Skip me</nav>",
        "<article><h1>Motion Notes</h1><p>Promptable <a href=\"https://example.com/cut\">Cut handoff</a>.</p><ul><li>Receipts</li></ul></article>",
        "</body></html>"
      ].join(""), "text/html")
    });

    expect(fetched).not.toHaveProperty("kind");
    expect(fetched).not.toHaveProperty("title");
    expect(fetched.markdown).toContain("# Motion Notes");
    expect(fetched.markdown).toContain("[Cut handoff](https://example.com/cut)");
    expect(fetched.markdown).toContain("- Receipts");
    expect(fetched.markdown).not.toContain("Skip me");
  });

  it("rejects private source fetch URLs before invoking the fetcher", async () => {
    const requestedUrls: string[] = [];

    await expect(fetchSourceDocument("http://127.0.0.1/article", {
      fetcher: async (url) => {
        requestedUrls.push(url);
        return sourceFetchResponse("should not fetch", "text/plain");
      }
    })).rejects.toThrow("refusing to fetch private IP: 127.0.0.1");
    expect(requestedUrls).toEqual([]);
  });

  it("passes a timeout abort signal to source fetchers", async () => {
    const inits: unknown[] = [];

    await fetchSourceDocument("https://example.com/articles/motion", {
      resolver: PUBLIC_RESOLVER,
      fetcher: async (_url, init) => {
        inits.push(init);
        return sourceFetchResponse("Motion source", "text/plain");
      }
    });

    expect(inits).toHaveLength(1);
    expect(inits[0]).toEqual(expect.objectContaining({
      signal: expect.objectContaining({ aborted: false }),
      redirect: "manual",
      resolvedAddress: { address: "93.184.216.34", family: 4 },
      maxBytes: 2 * 1024 * 1024
    }));
  });

  it("rejects private and mixed DNS answers before invoking the source transport", async () => {
    const requestedUrls: string[] = [];
    const fetcher = async (url: string) => {
      requestedUrls.push(url);
      return sourceFetchResponse("should not fetch", "text/plain");
    };

    await expect(fetchSourceDocument("https://private-dns.example/article", {
      resolver: async () => [{ address: "127.0.0.1", family: 4 }],
      fetcher
    })).rejects.toThrow("private IP: 127.0.0.1");
    await expect(fetchSourceDocument("https://mixed-dns.example/article", {
      resolver: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 }
      ],
      fetcher
    })).rejects.toThrow("private IP: 169.254.169.254");
    expect(requestedUrls).toEqual([]);
  });

  it("manually revalidates every redirect and blocks public-to-private redirect targets", async () => {
    const requestedUrls: string[] = [];
    await expect(fetchSourceDocument("https://public.example/article", {
      resolver: PUBLIC_RESOLVER,
      fetcher: async (url) => {
        requestedUrls.push(url);
        return sourceFetchResponse("", "text/plain", 302, "Found", "http://127.0.0.1/admin");
      }
    })).rejects.toThrow("private IP: 127.0.0.1");
    expect(requestedUrls).toEqual(["https://public.example/article"]);

    await expect(fetchSourceDocument("https://public.example/article", {
      resolver: PUBLIC_RESOLVER,
      fetcher: async () => sourceFetchResponse("", "text/plain", 302, "Found", "http://public.example/insecure")
    })).rejects.toThrow("HTTPS-to-HTTP redirect downgrade");
  });

  it("re-resolves same-origin redirects to catch DNS rebinding", async () => {
    let resolutionCount = 0;
    const requestedUrls: string[] = [];
    await expect(fetchSourceDocument("https://rebind.example/start", {
      resolver: async () => {
        resolutionCount += 1;
        return resolutionCount === 1
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "10.0.0.8", family: 4 }];
      },
      fetcher: async (url) => {
        requestedUrls.push(url);
        return sourceFetchResponse("", "text/plain", 302, "Found", "/next");
      }
    })).rejects.toThrow("private IP: 10.0.0.8");
    expect(requestedUrls).toEqual(["https://rebind.example/start"]);
  });

  it("caps redirect hops, response bytes, and accepted content types", async () => {
    await expect(fetchSourceDocument("https://loop.example/start", {
      resolver: PUBLIC_RESOLVER,
      maxRedirects: 1,
      fetcher: async (_url) => sourceFetchResponse("", "text/plain", 302, "Found", "/next")
    })).rejects.toThrow("exceeded 1 redirects");

    await expect(fetchSourceDocument("https://large.example/article", {
      resolver: PUBLIC_RESOLVER,
      maxBytes: 8,
      fetcher: async () => sourceFetchResponse("more than eight bytes", "text/plain")
    })).rejects.toThrow("exceeds 8 bytes");

    await expect(fetchSourceDocument("https://binary.example/archive", {
      resolver: PUBLIC_RESOLVER,
      fetcher: async () => sourceFetchResponse("binary", "application/octet-stream")
    })).rejects.toThrow("unsupported content type: application/octet-stream");
  });

  it("bounds concurrent source import transports", async () => {
    let active = 0;
    let peak = 0;
    let releaseTransports: (() => void) | undefined;
    const transportGate = new Promise<void>((resolvePromise) => {
      releaseTransports = resolvePromise;
    });
    const calls = Array.from({ length: 6 }, (_, index) => fetchSourceDocument(`https://source-${index}.example/article`, {
      resolver: PUBLIC_RESOLVER,
      fetcher: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await transportGate;
        active -= 1;
        return sourceFetchResponse("Motion source", "text/plain");
      }
    }));

    for (let attempt = 0; attempt < 20 && active < 4; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    }
    expect(active).toBe(4);
    releaseTransports?.();
    await Promise.all(calls);
    expect(peak).toBe(4);
  });

  it("lowers imported source Markdown into deterministic scripted-video frames", async () => {
    const imported = buildSourceImportDocument({
      url: "https://example.com/articles/motion",
      title: "Motion Launch Notes",
      kind: "article",
      markdown: [
        "## Problem",
        "Teams need deterministic video exports from promptable source material.",
        "",
        "## ShellX Motion",
        "Motion keeps ShellX-owned packages and receipts as the durable state.",
        "",
        "## Cut handoff",
        "Scripted-video JSON can go directly to Cut without Canvas."
      ].join("\n")
    });

    const scripted = buildScriptedVideoFromSourceImport(imported, {
      maxFrames: 3,
      frameDurationMs: 2400,
      width: 1280,
      height: 720,
      fps: 30
    });

    expect(scripted).toMatchObject({
      schema: "shellx-motion/scripted-video@1",
      id: "source_motion_launch_notes",
      name: "Motion Launch Notes",
      sourceApp: "shellx-motion",
      workflow: "source-to-scripted-video",
      intent: "source_to_storyboard",
      review: { status: "needs-review", required: true },
      width: 1280,
      height: 720,
      fps: 30,
      frames: [
        expect.objectContaining({
          id: "source-001",
          title: "Problem",
          body: "Teams need deterministic video exports from promptable source material.",
          caption: "Source: example.com",
          durationMs: 2400,
          sourceRefs: [
            expect.objectContaining({
              type: "article",
              title: "Motion Launch Notes",
              url: "https://example.com/articles/motion"
            })
          ],
          tags: ["source", "article", "needs-review"]
        }),
        expect.objectContaining({ id: "source-002", title: "ShellX Motion" }),
        expect.objectContaining({ id: "source-003", title: "Cut handoff" })
      ]
    });
    expect(scripted.frames).toHaveLength(3);
    expect(await validateDocument(await loadSchema("scriptedVideo"), scripted)).toEqual({ ok: true });
  });

  /**
   * Adversarial performance fixtures for the fetched-HTML lane.
   *
   * `fetchSourceDocument` accepts up to 2 MiB of response body from a URL a prompt supplied, so the
   * page author picks the input shape. Before the bounded rewrite the shapes below blocked the
   * event loop for the times noted; the budget is loose enough not to flake on a busy machine and
   * far below every one of them.
   */
  describe("adversarial fetched HTML", () => {
    const BUDGET_MS = 2_000;

    async function fetchWithin(html: string): Promise<string> {
      const started = process.hrtime.bigint();
      const fetched = await fetchSourceDocument("https://public.example/article", {
        resolver: PUBLIC_RESOLVER,
        fetcher: async () => sourceFetchResponse(html, "text/html; charset=utf-8")
      });
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      expect(elapsedMs, `completed in ${elapsedMs.toFixed(1)} ms, budget ${BUDGET_MS} ms`).toBeLessThan(BUDGET_MS);
      return fetched.markdown;
    }

    it("imports 815 KB of never-closed list items without stalling", async () => {
      // 14.7 s before the bounded rewrite.
      const html = `<html><body><ul>${"<li>x".repeat(163_000)}</ul></body></html>`;
      expect(html.length).toBeGreaterThan(800_000);
      expect(await fetchWithin(html)).toBe("x".repeat(163_000));
    });

    it("imports 795 KB of never-closed anchors inside never-closed list items without stalling", async () => {
      // 1.2 s before the bounded rewrite for this shape.
      const units = Array.from({ length: 12_000 }, (_, index) =>
        `<li class="row r${index}"><a href="https://example.com/${index}">item ${index}`);
      const markdown = await fetchWithin(`<html><body><ul>${units.join("")}</ul></body></html>`);
      expect(markdown).toContain("item 11999");
    });

    it("imports 800 KB of never-closed script and comment openers without stalling", async () => {
      // The trailing tag stripper needed 8.75 s on the comment run alone.
      const html = `${"<script>".repeat(50_000)}${"<!--".repeat(100_000)}`;
      expect(await fetchWithin(html)).toBe("<!--".repeat(100_000));
    });
  });

  it("bounds source-to-scripted-video planner inputs", () => {
    const imported = buildSourceImportDocument({
      url: "https://example.com/article",
      title: "Bounds",
      markdown: "Alpha"
    });

    expect(() => buildScriptedVideoFromSourceImport(imported, { maxFrames: 0 })).toThrow("maxFrames must be an integer between 1 and 12.");
    expect(() => buildScriptedVideoFromSourceImport(imported, { frameDurationMs: 50 })).toThrow("frameDurationMs must be between 500 and 30000.");
  });
});

function sourceFetchResponse(text: string, contentType: string, status = 200, statusText = "OK", location?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === "content-type") return contentType;
        if (name.toLowerCase() === "location") return location ?? null;
        return null;
      }
    },
    text: async () => text
  };
}
