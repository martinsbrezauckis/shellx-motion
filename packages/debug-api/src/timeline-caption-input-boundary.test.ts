import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index.js";

const PACKAGE_ROOT = resolve("../../fixtures/packages/keyframed-lower-third");

describe("caption import input boundary", () => {
  it("refuses paths outside approved authoring roots without leaking file content", async () => {
    const approvedRoot = await mkdtemp(join(tmpdir(), "shellx-motion-caption-approved-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-caption-private-"));
    const captionsPath = join(outsideRoot, "private.txt");
    const sentinelText = "CAPTION_IMPORT_MUST_NOT_LEAK";
    await writeFile(captionsPath, sentinelText, "utf8");
    const outDir = join(approvedRoot, "output");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.caption.import",
        { packageRoot: PACKAGE_ROOT, outDir, captionsPath, format: "plain" },
        { tier: "edit_motion", authoringInputRoots: [approvedRoot] },
      );
      expect(result).toMatchObject({ ok: false, error: { code: "timeline_caption_import_failed" } });
      expect(JSON.stringify(result)).not.toContain(sentinelText);
      await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(approvedRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("refuses symlinked source leaves without publishing output", async () => {
    const approvedRoot = await mkdtemp(join(tmpdir(), "shellx-motion-caption-symlink-approved-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-caption-symlink-private-"));
    const privatePath = join(outsideRoot, "private.srt");
    await writeFile(privatePath, "1\n00:00:00,000 --> 00:00:01,000\nPRIVATE", "utf8");
    const captionsPath = join(approvedRoot, "captions.srt");
    await symlink(privatePath, captionsPath, "file");
    const outDir = join(approvedRoot, "output");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.caption.import",
        { packageRoot: PACKAGE_ROOT, outDir, captionsPath, format: "srt" },
        { tier: "edit_motion", authoringInputRoots: [approvedRoot] },
      );
      expect(result).toMatchObject({ ok: false, error: { code: "timeline_caption_import_failed" } });
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
      await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(approvedRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
