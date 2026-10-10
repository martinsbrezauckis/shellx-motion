import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const manualRoot = new URL("../../docs/public/site/manual/motion/", import.meta.url);
const publicModelReference = new RegExp([
  "Clau" + "de",
  "Co" + "dex",
  "Gr" + "ok",
  "Open" + "AI",
  "Anth" + "ropic",
  "x" + "AI"
].join("|"), "i");
const publicTextExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".svg", ".txt"]);

async function publicTextFiles(base: URL): Promise<Array<{ name: string; source: string }>> {
  const found: Array<{ name: string; source: string }> = [];
  const visit = async (directory: URL, prefix = ""): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      const url = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, directory);
      if (entry.isDirectory()) await visit(url, `${name}/`);
      else if (publicTextExtensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
        found.push({ name, source: await readFile(url, "utf8") });
      }
    }
  };
  await visit(base);
  return found;
}

describe("ShellX Motion online manual", () => {
  it("is bound to the release version and uses the canonical icon bytes", async () => {
    const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8")) as { version: string };
    const html = await readFile(new URL("index.html", manualRoot), "utf8");
    const publicIndex = JSON.parse(await readFile(new URL("docs/public/index.json", root), "utf8")) as { productVersion: string };
    expect(html).toContain(`data-app-version="${pkg.version}"`);
    expect(publicIndex.productVersion).toBe(pkg.version);
    expect(html).toContain(`<title>ShellX Motion Manual</title>`);
    expect(html.match(/<link rel="canonical"/g)).toHaveLength(1);
    expect(html).toContain(`<link rel="canonical" href="https://docs.theshellx.com/manual/motion/" />`);
    const canonical = await readFile(new URL("assets/brand/shellx-motion-icon.png", root));
    const manualIcon = await readFile(new URL("icon.png", manualRoot));
    expect(manualIcon.equals(canonical)).toBe(true);
  });

  it("keeps agent template references out of the human manual", async () => {
    const html = await readFile(new URL("index.html", manualRoot), "utf8");
    expect(html).not.toMatch(/data-template=|id="templates"|workbench\/gallery|<h[1-6][^>]*>\s*Templates\s*</i);
    const index = JSON.parse(await readFile(new URL("docs/public/index.json", root), "utf8")) as {
      sections: Array<{ pages: Array<{ id: string; audience?: string }> }>;
    };
    const templates = index.sections.flatMap((section) => section.pages).find((page) => page.id === "templates");
    expect(templates).toMatchObject({ audience: "agent" });
    expect(await readFile(new URL("docs/public/templates.md", root), "utf8")).toContain("# Agent template reference");
  });

  it("keeps current capability and terminal-error language free of stale revision claims", async () => {
    const [manual, features, jobStatusSource, strategy] = await Promise.all([
      readFile(new URL("index.html", manualRoot), "utf8"),
      readFile(new URL("docs/public/FEATURES.md", root), "utf8"),
      readFile(new URL("schemas/job-status.json", root), "utf8"),
      readFile(new URL("STRATEGY.md", root), "utf8")
    ]);
    const jobStatus = JSON.parse(jobStatusSource) as {
      optionalFields: Array<{ name: string; lifecycle: string[]; outcomes?: string[]; meaning: string }>;
    };
    const error = jobStatus.optionalFields.find((field) => field.name === "error");

    expect(error).toMatchObject({
      lifecycle: ["ended"],
      outcomes: ["failed"]
    });
    expect(error?.meaning).toContain("Historical failed records may lack it");
    expect(manual).toContain("a failed record carries retained error detail only when available, so historical failed records may not include it");
    expect(manual).not.toContain("failed always does");
    expect(features).toContain("Lottie/dotLottie import are bounded to the");
    expect(features).not.toContain("An earlier revision of this file called Lottie unreachable");
    expect(strategy).toContain("This strategy intentionally records durable product direction rather than mutable phase, feature,");
    expect(strategy).toContain("[`ROADMAP.md`](ROADMAP.md) is the canonical authority for current execution");
    expect(strategy).toContain("[post-v0.2.66 implementation program]");
    expect(strategy).not.toContain("## Roadmap Placement");
    expect(strategy).not.toContain("### V1: Compatibility Foundation");
  });

  it("keeps public human-facing content free of model attribution and the manual free of unsafe DOM sinks", async () => {
    const files = await Promise.all(["index.html", "motion.css", "motion.js"].map(async (name) => ({
      name,
      source: await readFile(new URL(name, manualRoot), "utf8")
    })));
    const humanSurfaces = (await Promise.all([
      publicTextFiles(new URL("docs/public/", root)),
      publicTextFiles(new URL("skill/", root)),
      // The product pack is the template content available to readers.
      publicTextFiles(new URL("templates/shellx-product-pack/", root)),
      publicTextFiles(new URL("fixtures/", root))
    ])).flat();
    humanSurfaces.push(
      { name: "README.md", source: await readFile(new URL("README.md", root), "utf8") },
      { name: "SECURITY.md", source: await readFile(new URL("SECURITY.md", root), "utf8") }
    );
    for (const file of humanSurfaces) {
      expect(file.source, file.name).not.toMatch(publicModelReference);
    }
    const js = files.find((file) => file.name === "motion.js")!.source;
    expect(js).not.toMatch(/\.innerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new Function/);
  });
});
