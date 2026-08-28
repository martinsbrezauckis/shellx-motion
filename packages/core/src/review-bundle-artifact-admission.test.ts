import { mkdir, mkdtemp, readdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_REVIEW_BUNDLE_AGGREGATE_SOURCE_BYTES,
  MAX_REVIEW_BUNDLE_CANDIDATE_ATTRIBUTIONS,
  MAX_REVIEW_BUNDLE_DISTINCT_SOURCES,
  MAX_REVIEW_BUNDLE_SOURCE_BYTES
} from "./review-bundle-artifact-admission";
import { writeReviewBundle } from "./review-bundle";
import type { ReviewBundleReceiptEntry } from "./review-bundle-types";
import type { ReceiptArtifact } from "./types";

function reviewReceiptEntry(id: string, artifacts: ReceiptArtifact[]): ReviewBundleReceiptEntry {
  return {
    receipt: {
      schema: "shellx-motion/receipt@1",
      id,
      operation: "render.final",
      status: "passed",
      packageId: "pkg_review",
      inputHashes: {},
      createdAt: "2026-08-27T00:00:00.000Z",
      lane: "ffmpeg",
      output: {},
      artifacts,
      warnings: []
    }
  };
}

describe("review bundle artifact admission", () => {
  it("deduplicates canonical source bytes while retaining role and symlink-alias attributions", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-review-bundle-dedupe-"));
    const mediaRoot = join(tempRoot, "media");
    const mediaPath = join(mediaRoot, "final.mp4");
    const mediaAliasPath = join(tempRoot, "final-alias.mp4");
    const outDir = join(tempRoot, "bundle");
    try {
      await mkdir(mediaRoot, { mode: 0o700 });
      await writeFile(mediaPath, "one physical media file", "utf8");
      await symlink(mediaPath, mediaAliasPath);

      const result = await writeReviewBundle({
        outDir,
        artifactRoots: [mediaRoot],
        receipts: [reviewReceiptEntry("render-deduplicated", [
          { role: "rendered_media", path: mediaPath, status: "available", mediaType: "video/mp4", primary: true },
          { role: "review_proxy", path: mediaAliasPath, status: "available", mediaType: "video/mp4" }
        ])]
      });

      expect(result.copiedArtifactCount).toBe(2);
      expect(result.copiedArtifacts).toHaveLength(2);
      expect(result.copiedArtifacts.map((artifact) => artifact.role)).toEqual(["rendered_media", "review_proxy"]);
      expect(new Set(result.copiedArtifacts.map((artifact) => artifact.relativePath)).size).toBe(1);
      expect(new Set(result.copiedArtifacts.map((artifact) => artifact.path))).toEqual(new Set([join(outDir, result.copiedArtifacts[0].relativePath)]));
      expect(result.copiedArtifacts.map((artifact) => artifact.sourceName)).toEqual(["final.mp4", "final-alias.mp4"]);
      expect(await readdir(join(outDir, "artifacts"))).toHaveLength(1);
      const receiptArtifacts = result.receipt.artifacts?.filter((artifact) => artifact.role === "review_artifact") ?? [];
      expect(receiptArtifacts).toHaveLength(2);
      expect(new Set(receiptArtifacts.map((artifact) => artifact.path))).toEqual(new Set([result.copiedArtifacts[0].relativePath]));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("hard-fails an over-limit candidate attribution set without publishing a bundle", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-review-bundle-candidate-cap-"));
    const outDir = join(tempRoot, "bundle");
    try {
      const artifacts = Array.from({ length: MAX_REVIEW_BUNDLE_CANDIDATE_ATTRIBUTIONS + 1 }, (_, index) => ({
        role: `candidate_${index}`,
        path: `missing-${index}.mp4`,
        status: "available" as const
      }));
      await expect(writeReviewBundle({
        outDir,
        receipts: [reviewReceiptEntry("render-candidate-cap", artifacts)]
      })).rejects.toThrow(/candidate-attribution limit/i);
      await expect(readdir(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("enforces the candidate attribution limit for HTML-only bundles before publication", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-review-bundle-candidate-no-copy-cap-"));
    const outDir = join(tempRoot, "bundle");
    try {
      const artifacts = Array.from({ length: MAX_REVIEW_BUNDLE_CANDIDATE_ATTRIBUTIONS + 1 }, (_, index) => ({
        role: `candidate_${index}`,
        path: `missing-${index}.mp4`,
        status: "available" as const
      }));
      await expect(writeReviewBundle({
        outDir,
        copyArtifacts: false,
        receipts: [reviewReceiptEntry("render-candidate-no-copy-cap", artifacts)]
      })).rejects.toThrow(/candidate-attribution limit/i);
      await expect(readdir(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("hard-fails too many distinct sources without publishing a bundle", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-review-bundle-source-cap-"));
    const mediaRoot = join(tempRoot, "media");
    const outDir = join(tempRoot, "bundle");
    try {
      await mkdir(mediaRoot, { mode: 0o700 });
      const paths = await Promise.all(Array.from({ length: MAX_REVIEW_BUNDLE_DISTINCT_SOURCES + 1 }, async (_, index) => {
        const path = join(mediaRoot, `source-${index}.mp4`);
        await writeFile(path, String(index), "utf8");
        return path;
      }));
      await expect(writeReviewBundle({
        outDir,
        artifactRoots: [mediaRoot],
        receipts: [reviewReceiptEntry("render-source-cap", paths.map((path, index) => ({
          role: `source_${index}`,
          path,
          status: "available" as const
        })))]
      })).rejects.toThrow(/distinct-source limit/i);
      await expect(readdir(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("hard-fails a sparse source above the descriptor size cap without publishing a bundle", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-review-bundle-size-cap-"));
    const mediaRoot = join(tempRoot, "media");
    const mediaPath = join(mediaRoot, "oversize.mp4");
    const outDir = join(tempRoot, "bundle");
    try {
      await mkdir(mediaRoot, { mode: 0o700 });
      await writeFile(mediaPath, "", "utf8");
      await truncate(mediaPath, MAX_REVIEW_BUNDLE_SOURCE_BYTES + 1);
      await expect(writeReviewBundle({
        outDir,
        artifactRoots: [mediaRoot],
        receipts: [reviewReceiptEntry("render-size-cap", [{ role: "rendered_media", path: mediaPath, status: "available" }])]
      })).rejects.toThrow(/per-source limit/i);
      await expect(readdir(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("hard-fails sparse sources above the aggregate cap before publishing a bundle", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-review-bundle-aggregate-cap-"));
    const mediaRoot = join(tempRoot, "media");
    const outDir = join(tempRoot, "bundle");
    const sourceSize = Math.floor(MAX_REVIEW_BUNDLE_AGGREGATE_SOURCE_BYTES / 5) + 1;
    try {
      await mkdir(mediaRoot, { mode: 0o700 });
      const paths = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
        const path = join(mediaRoot, `aggregate-${index}.mp4`);
        await writeFile(path, "", "utf8");
        await truncate(path, sourceSize);
        return path;
      }));
      await expect(writeReviewBundle({
        outDir,
        artifactRoots: [mediaRoot],
        receipts: [reviewReceiptEntry("render-aggregate-cap", paths.map((path, index) => ({
          role: `aggregate_${index}`,
          path,
          status: "available" as const
        })))]
      })).rejects.toThrow(/aggregate limit/i);
      await expect(readdir(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("records only a portable leaf for a Windows-drive artifact path on POSIX", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-review-bundle-windows-path-"));
    const outDir = join(tempRoot, "bundle");
    const drivePath = String.raw`C:\Users\Alice\private.mp4`;
    try {
      const result = await writeReviewBundle({
        outDir,
        receipts: [reviewReceiptEntry("render-windows-path", [{ role: "rendered_media", path: drivePath, status: "available" }])]
      });
      expect(result).toMatchObject({ copiedArtifactCount: 0, omittedArtifactCount: 1 });
      expect(result.omittedArtifacts[0]).toMatchObject({ role: "rendered_media", sourceName: "private.mp4", reason: "unreadable_source" });
      expect(await readdir(outDir)).not.toContain("artifacts");
      const serializedReceipt = await readFile(result.receiptPath, "utf8");
      expect(serializedReceipt).not.toContain("C:\\Users");
      expect(serializedReceipt).not.toContain("Alice");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
