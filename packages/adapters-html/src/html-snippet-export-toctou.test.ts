import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  target: "",
  swap: null as (() => Promise<void>) | null
}));

/**
 * The old export path called fs.readFile after it had already accepted the pathname.  This
 * deterministic test-only interposition replaces that pathname immediately before that reopen;
 * it does not depend on scheduler timing or a large-file copy window.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: any[]) => {
      if (race.swap && String(args[0]) === race.target) {
        const swap = race.swap;
        race.swap = null;
        await swap();
      }
      return await (actual.readFile as (...readArgs: any[]) => Promise<any>)(...args);
    }
  };
});

import { writeHtmlSnippetExport } from "./index.js";

const tempDirs: string[] = [];

describe("HTML snippet export asset snapshot", () => {
  afterEach(async () => {
    race.target = "";
    race.swap = null;
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it.skipIf(process.platform === "win32")("embeds the verified in-package SVG, never an asset swapped just before a pathname reopen", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-export-toctou-package-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-export-toctou-outside-"));
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-export-toctou-out-"));
    const outDir = join(outRoot, "export");
    tempDirs.push(packageRoot, outsideRoot, outRoot);
    const sourcePath = join(packageRoot, "assets", "logo.svg");
    const outsidePath = join(outsideRoot, "logo.svg");
    const verified = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" fill="#22c55e"/></svg>';
    const escaped = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" fill="#ef4444"/></svg>';
    await mkdir(join(packageRoot, "assets"), { recursive: true, mode: 0o700 });
    await writeFile(sourcePath, verified, "utf8");
    await writeFile(outsidePath, escaped, "utf8");
    await writeFile(join(packageRoot, "manifest.json"), `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1", id: "pkg_html_export_toctou", name: "TOCTOU",
      motion: "motion.json", assets: ["assets/logo.svg"], sourceApp: "shellx-motion",
      compatibility: { lanes: ["html"], hosts: ["motion"] }
    })}\n`, "utf8");
    await writeFile(join(packageRoot, "motion.json"), `${JSON.stringify({
      schema: "shellx-motion/motion@1", id: "motion_html_export_toctou", name: "TOCTOU", durationMs: 1000,
      fps: 30, width: 1, height: 1, background: "#000000", assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" },
      layers: [{ id: "logo", type: "image", source: "assets/logo.svg", startMs: 0, durationMs: 1000,
        transform: { x: 0, y: 0, width: 1, height: 1 } }]
    })}\n`, "utf8");

    race.target = sourcePath;
    race.swap = async () => {
      await rm(sourcePath);
      await symlink(outsidePath, sourcePath);
    };

    const result = await writeHtmlSnippetExport({ packageRoot, outDir });
    const html = await readFile(result.htmlPath, "utf8");
    const verifiedUri = `data:image/svg+xml;base64,${Buffer.from(verified, "utf8").toString("base64")}`;
    const escapedUri = `data:image/svg+xml;base64,${Buffer.from(escaped, "utf8").toString("base64")}`;

    expect(html).toContain(verifiedUri);
    expect(html).not.toContain(escapedUri);
  });
});
