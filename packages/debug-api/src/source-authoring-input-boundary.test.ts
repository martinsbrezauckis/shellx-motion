import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSourceImportDocument, hashBuffer, type OperationReceipt } from "@shellx-motion/core";
import { dispatchDebugCommand } from "./index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("source authoring input boundary", () => {
  it("fails closed when remote source authoring has no host output roots", async () => {
    const approvedRoot = await tempDir("missing-output-roots");
    const sourcePath = join(approvedRoot, "source.md");
    const outDir = join(approvedRoot, "output");
    await writeFile(sourcePath, sourceMarkdown("Approved source body"), "utf8");

    const result = await dispatchDebugCommand(
      "motion.source.to_scripted_video",
      { sourcePath, outDir, maxFrames: 1 },
      { tier: "write_local", authoringInputRoots: [approvedRoot] },
    );

    expect(result).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  const refusesOutsideRoot = async (command: "motion.source.to_scripted_video" | "motion.connector.source_to_cut", code: "source_storyboard_failed" | "invalid_args") => {
    const approvedRoot = await tempDir("approved");
    const outsideRoot = await tempDir("outside");
    const sourcePath = join(outsideRoot, "source.md");
    const outDir = join(approvedRoot, "output");
    const sentinelText = "SOURCE_IMPORT_MUST_NOT_LEAK";
    await writeFile(sourcePath, sourceMarkdown(sentinelText), "utf8");

    const result = await dispatchDebugCommand(
      command,
      { sourcePath, outDir, maxFrames: 1 },
      { tier: "write_local", authoringInputRoots: [approvedRoot], authoringOutputRoots: [approvedRoot] },
    );

    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(JSON.stringify(result)).not.toContain(sentinelText);
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  };

  it.each([["motion.source.to_scripted_video", "source_storyboard_failed"]] as const)(
    "refuses outside-root Markdown for %s without leaking or publishing",
    refusesOutsideRoot,
  );
  it.runIf(process.platform === "linux").each([["motion.connector.source_to_cut", "invalid_args"]] as const)(
    "refuses outside-root Markdown for %s without leaking or publishing",
    refusesOutsideRoot,
  );

  const refusesSymlinkedSource = async (command: "motion.source.to_scripted_video" | "motion.connector.source_to_cut", code: "source_storyboard_failed" | "invalid_args") => {
    const approvedRoot = await tempDir("symlink-approved");
    const outsideRoot = await tempDir("symlink-outside");
    const outsidePath = join(outsideRoot, "source.md");
    const sourcePath = join(approvedRoot, "source.md");
    const outDir = join(approvedRoot, "output");
    await writeFile(outsidePath, sourceMarkdown("SYMLINK_SOURCE_MUST_NOT_LEAK"), "utf8");
    await symlink(outsidePath, sourcePath, "file");

    const result = await dispatchDebugCommand(
      command,
      { sourcePath, outDir, maxFrames: 1 },
      { tier: "write_local", authoringInputRoots: [approvedRoot], authoringOutputRoots: [approvedRoot] },
    );

    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(JSON.stringify(result)).not.toContain("SYMLINK_SOURCE_MUST_NOT_LEAK");
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  };

  it.each([["motion.source.to_scripted_video", "source_storyboard_failed"]] as const)(
    "refuses symlinked Markdown for %s without publishing",
    refusesSymlinkedSource,
  );
  it.runIf(process.platform === "linux").each([["motion.connector.source_to_cut", "invalid_args"]] as const)(
    "refuses symlinked Markdown for %s without publishing",
    refusesSymlinkedSource,
  );

  it("hashes the exact approved bytes used to build a storyboard", async () => {
    const approvedRoot = await tempDir("success");
    const sourcePath = join(approvedRoot, "source.md");
    const outDir = join(approvedRoot, "output");
    const bytes = Buffer.from(sourceMarkdown("Approved source body"), "utf8");
    await writeFile(sourcePath, bytes);

    const result = await dispatchDebugCommand(
      "motion.source.to_scripted_video",
      { sourcePath, outDir, maxFrames: 1 },
      { tier: "write_local", authoringInputRoots: [approvedRoot], authoringOutputRoots: [approvedRoot] },
    );

    expect(result).toMatchObject({ ok: true });
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "source-storyboard.receipt.json"), "utf8")) as OperationReceipt;
    expect(receipt.inputHashes.sourceMarkdown).toBe(hashBuffer(bytes));
  });

  it.skipIf(process.platform === "win32")("refuses a prebound output symlink without publishing through it", async () => {
    const approvedRoot = await tempDir("output-symlink-approved");
    const outsideRoot = await tempDir("output-symlink-outside");
    const sourcePath = join(approvedRoot, "source.md");
    const outDir = join(approvedRoot, "output");
    await writeFile(sourcePath, sourceMarkdown("Approved source body"), "utf8");
    await symlink(outsideRoot, outDir, "dir");

    const result = await dispatchDebugCommand(
      "motion.source.to_scripted_video",
      { sourcePath, outDir, maxFrames: 1 },
      { tier: "write_local", authoringInputRoots: [approvedRoot], authoringOutputRoots: [approvedRoot] },
    );

    expect(result).toMatchObject({ ok: false });
    await expect(stat(join(outsideRoot, "scripted-video.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function tempDir(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `shellx-motion-source-boundary-${label}-`));
  tempDirs.push(path);
  return path;
}

function sourceMarkdown(body: string): string {
  return buildSourceImportDocument({
    url: "https://example.com/source",
    title: "Approved Source",
    kind: "article",
    markdown: `## Section\n${body}`,
  }).markdown;
}
