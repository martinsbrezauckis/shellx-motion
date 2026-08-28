import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { githubHeadingAnchor, inspectMarkdownLinkIntegrity, inspectWorkbenchDocsReachability, markdownHeadingAnchors } from "./markdown-link-integrity.mjs";

const ownedRoots: string[] = [];

afterEach(async () => {
  await Promise.all(ownedRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-markdown-links-"));
  ownedRoots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return root;
}

describe("Markdown local-link integrity", () => {
  it("accepts relative links, GitHub-style anchors, duplicate headings, and non-file URI schemes", async () => {
    const root = await fixture({
      "README.md": [
        "# Root heading",
        "[Guide](docs/public/guide.md#motioncanvasbridge_export)",
        "[Repeated](docs/public/guide.md#repeated-1)",
        "[Self](#root-heading)",
        "[Directory](docs/public/media/)",
        "[Web](https://example.invalid/path) [Mail](mailto:docs@example.invalid) [Data](data:text/plain,ignored) [Protocol](//example.invalid/path)"
      ].join("\n"),
      "docs/public/guide.md": [
        "### `motion.canvas.bridge_export`",
        "## Repeated",
        "## Repeated"
      ].join("\n"),
      "docs/public/media/.keep": ""
    });

    expect(inspectMarkdownLinkIntegrity(root)).toEqual({ files: 2, links: 8, errors: [] });
  });

  it("reports missing local targets and Markdown heading anchors", async () => {
    const root = await fixture({
      "README.md": "[Missing](docs/public/missing.md)\n[Bad anchor](docs/public/guide.md#not-here)\n",
      "docs/public/guide.md": "# Present\n"
    });

    const report = inspectMarkdownLinkIntegrity(root);
    expect(report.errors).toEqual([
      "README.md:1 has a missing local target: docs/public/missing.md (resolved docs/public/missing.md)",
      "README.md:2 has a missing heading anchor: docs/public/guide.md#not-here (target docs/public/guide.md)"
    ]);
  });

  it("rejects unvalidated TypeScript source-line anchors in public docs while allowing stable test references", async () => {
    const root = await fixture({
      "docs/public/FEATURES.md": [
        "[Stable renderer regression](../../packages/renderer-browser/src/index.test.ts)",
        "[Stale source line](../../packages/renderer-browser/src/index.test.ts#L2188)"
      ].join("\n"),
      "packages/renderer-browser/src/index.test.ts": "export {};\n"
    });

    expect(inspectMarkdownLinkIntegrity(root)).toEqual({
      files: 1,
      links: 2,
      errors: [
        "docs/public/FEATURES.md:2 uses an unvalidated TypeScript source-line anchor: ../../packages/renderer-browser/src/index.test.ts#L2188"
      ]
    });
  });

  it("keeps the current public and skill documentation corpus link-complete", () => {
    expect(inspectMarkdownLinkIntegrity(process.cwd()).errors).toEqual([]);
  });

  it("requires indexed public Markdown targets to be reachable in the Workbench", async () => {
    const root = await fixture({
      "docs/public/index.json": JSON.stringify({
        sections: [{ pages: [{ id: "guide", file: "guide.md" }] }]
      }),
      "docs/public/guide.md": "[Missing from navigation](detail.md)\n",
      "docs/public/detail.md": "# Detail\n"
    });

    expect(inspectWorkbenchDocsReachability(root)).toEqual({
      pages: 1,
      links: 1,
      errors: ["docs/public/guide.md:1 targets a public Markdown page absent from docs/public/index.json: detail.md"]
    });
  });

  it("accepts public targets indexed for a separate audience", async () => {
    const root = await fixture({
      "docs/public/index.json": JSON.stringify({
        sections: [{ pages: [
          { id: "guide", file: "guide.md" },
          { id: "detail", file: "detail.md" },
          { id: "agent", file: "agent.md", audience: "agent" }
        ] }]
      }),
      "docs/public/guide.md": "[Detail](detail.md)\n[Agent](agent.md)\n",
      "docs/public/detail.md": "# Detail\n",
      "docs/public/agent.md": "# Agent\n"
    });

    expect(inspectWorkbenchDocsReachability(root)).toEqual({ pages: 3, links: 2, errors: [] });
  });

  it("preserves underscores and duplicate suffixes, excluding fenced examples, in GitHub-style anchors", () => {
    expect(githubHeadingAnchor("`motion.canvas.bridge_export`")).toBe("motioncanvasbridge_export");
    expect(markdownHeadingAnchors("# Same\n# Same\n```md\n# Example only\n```\n")).toEqual(new Set(["same", "same-1"]));
  });
});
