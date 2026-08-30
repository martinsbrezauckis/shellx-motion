import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashBuffer } from "@shellx-motion/core";
import { dispatchSourceAuthoringCommand } from "./authoring-source.js";

// These are real OutputDirectoryTransaction publications. Managed WSL refuses its inherited
// ancestry, so run only with the exact Node 24 qualified Linux GPU-host governed-fixture admission.
const fixtureRoot = process.env.MOTION_QUALIFIED_LINUX_GPU_PUBLICATION_ROOT;
const describeQualifiedLinuxGpu = process.env.MOTION_QUALIFIED_LINUX_GPU_PUBLICATION_FIXTURE === "1" && process.versions.node.startsWith("24.") && fixtureRoot
  ? describe
  : describe.skip;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function services(root: string) {
  return {
    authoringInputRoots: [root],
    authoringOutputRoots: [root],
    receiptsRoot: join(root, "host-receipts"),
    isEmptyOrAbsentDirectory: async () => true,
    writeText: async (path: string, value: string) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, value, "utf8");
    },
    writeJson: async (path: string, value: unknown) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
    },
    writeReceipt: async () => { throw new Error("injected host receipt observer failure after local bundle commit"); }
  };
}

describeQualifiedLinuxGpu("authoring source committed-bundle observer failures", () => {
  it("retains committed source-import artifacts when the external host receipt observer fails", async () => {
    const root = await mkdtemp(join(fixtureRoot!, "source-import-observer-"));
    roots.push(root);
    const outDir = join(root, "import");
    const result = await dispatchSourceAuthoringCommand("motion.source.import", {
      url: "https://example.com/source", outDir, markdown: "# Source\n\nBody", kind: "article"
    }, await services(root));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "source_import_receipt_observer_failed", detail: { sourceCommitted: true, publicPaths: [outDir] } },
      result: { sourceCommitted: true, outputPath: outDir, receiptPath: join(outDir, "receipts", "source-import.receipt.json") }
    });
    await expect(readFile(join(outDir, "source.md"), "utf8")).resolves.toContain("# Source");
    await expect(readFile(join(outDir, "receipts", "source-import.receipt.json"), "utf8")).resolves.toContain('"operation":"source.import"');
  });

  it("retains committed source-storyboard artifacts when the external host receipt observer fails", async () => {
    const root = await mkdtemp(join(fixtureRoot!, "source-storyboard-observer-"));
    roots.push(root);
    const sourcePath = join(root, "source.md");
    const markdown = "# Story\n\nSource: https://example.com/source\nKind: article\n\n## Beat\nA truthful test.";
    await writeFile(sourcePath, markdown, "utf8");
    const outDir = join(root, "storyboard");
    const result = await dispatchSourceAuthoringCommand("motion.source.to_scripted_video", {
      sourcePath, outDir, maxFrames: 1, frameDurationMs: 1000, width: 64, height: 64, fps: 24
    }, {
      ...(await services(root)),
      readSourceMarkdown: async () => ({ text: markdown, sha256: hashBuffer(Buffer.from(markdown, "utf8")) })
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "source_storyboard_receipt_observer_failed", detail: { sourceCommitted: true, publicPaths: [outDir] } },
      result: { sourceCommitted: true, outputPath: outDir, receiptPath: join(outDir, "receipts", "source-storyboard.receipt.json") }
    });
    await expect(readFile(join(outDir, "scripted-video.json"), "utf8")).resolves.toContain('"shellx-motion/scripted-video@1"');
    await expect(readFile(join(outDir, "receipts", "source-storyboard.receipt.json"), "utf8")).resolves.toContain('"operation":"source.to_scripted_video"');
  });
});
