import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { copyReviewArtifacts } from "./review-bundle-artifact-admission";
import { writeReviewBundle } from "./review-bundle";
import type { ReviewBundleReceiptEntry } from "./review-bundle-types";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function outputReceipt(id: string, output: Record<string, unknown>): ReviewBundleReceiptEntry {
  return {
    receipt: {
      schema: "shellx-motion/receipt@1",
      id,
      operation: "render.final",
      status: "passed",
      packageId: "pkg_review",
      inputHashes: {},
      createdAt: "2026-08-30T00:00:00.000Z",
      lane: "ffmpeg",
      output,
      warnings: []
    }
  };
}

async function inTrustedWorkspace(test: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-review-artifact-binding-"));
  const anchor = await createTrustedWorkspaceAnchor(root);
  try {
    await withTrustedWorkspaceAnchor(anchor, async () => await test(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("review bundle producer artifact binding", () => {
  it("persists matching producer and streamed identities for a digest-bound output", async () => {
    await inTrustedWorkspace(async (root) => {
      const mediaRoot = join(root, "media");
      const mediaPath = join(mediaRoot, "verified.mp4");
      const outDir = join(root, "bundle");
      const bytes = "renderer-authenticated-media";
      await mkdir(mediaRoot, { mode: 0o700 });
      await writeFile(mediaPath, bytes, "utf8");

      const result = await writeReviewBundle({
        outDir,
        artifactRoots: [mediaRoot],
        receipts: [outputReceipt("render-producer-verified", {
          path: mediaPath,
          sha256: sha256(bytes),
          byteLength: Buffer.byteLength(bytes)
        })]
      });
      const [copied] = result.copiedArtifacts;
      expect(copied).toMatchObject({
        producerIdentity: "producer_verified",
        expectedProducerSha256: sha256(bytes),
        expectedProducerByteLength: Buffer.byteLength(bytes),
        observedSha256: sha256(bytes),
        observedByteLength: Buffer.byteLength(bytes)
      });

      const portableReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as {
        output: { copiedArtifactIdentities: Array<Record<string, unknown>> };
      };
      expect(portableReceipt.output.copiedArtifactIdentities).toEqual([expect.objectContaining({
        producerIdentity: "producer_verified",
        expectedProducerSha256: sha256(bytes),
        expectedProducerByteLength: Buffer.byteLength(bytes),
        observedSha256: sha256(bytes),
        observedByteLength: Buffer.byteLength(bytes)
      })]);
      expect(await readFile(result.htmlPath, "utf8")).toContain("Producer SHA-256 verified against the streamed bundle copy.");
    });
  });

  it("refuses a replacement made after a digest-bound render receipt", async () => {
    await inTrustedWorkspace(async (root) => {
      const mediaRoot = join(root, "media");
      const mediaPath = join(mediaRoot, "final.mp4");
      const outDir = join(root, "bundle");
      const renderedBytes = "renderer-authenticated-media";
      const replacementBytes = "attacker-replaced-media!!!!!";
      expect(replacementBytes).toHaveLength(renderedBytes.length);
      await mkdir(mediaRoot, { mode: 0o700 });
      await writeFile(mediaPath, renderedBytes, "utf8");
      // This represents a valid receipt retained before an attacker changes the still-approved path.
      await writeFile(mediaPath, replacementBytes, "utf8");

      await expect(writeReviewBundle({
        outDir,
        artifactRoots: [mediaRoot],
        receipts: [outputReceipt("render-replaced-after-receipt", {
          path: mediaPath,
          sha256: sha256(renderedBytes),
          byteLength: Buffer.byteLength(renderedBytes)
        })]
      })).rejects.toThrow(/producer SHA-256/i);
      await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("refuses conflicting producer identities for different attributions of one canonical source", async () => {
    await inTrustedWorkspace(async (root) => {
      const mediaRoot = join(root, "media");
      const mediaPath = join(mediaRoot, "final.mp4");
      const outDir = join(root, "bundle");
      const bytes = "single renderer output";
      await mkdir(mediaRoot, { mode: 0o700 });
      await writeFile(mediaPath, bytes, "utf8");

      await expect(writeReviewBundle({
        outDir,
        artifactRoots: [mediaRoot],
        receipts: [
          outputReceipt("render-first-attribution", { path: mediaPath, sha256: sha256(bytes), byteLength: Buffer.byteLength(bytes) }),
          outputReceipt("render-conflicting-attribution", { path: mediaPath, sha256: "f".repeat(64), byteLength: Buffer.byteLength(bytes) })
        ]
      })).rejects.toThrow(/conflict on the producer SHA-256/i);
      await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("copies a legacy output with missing producer digest only as explicitly unattested evidence", async () => {
    await inTrustedWorkspace(async (root) => {
      const mediaRoot = join(root, "media");
      const mediaPath = join(mediaRoot, "legacy.mp4");
      const outDir = join(root, "bundle");
      const bytes = "legacy renderer output";
      await mkdir(mediaRoot, { mode: 0o700 });
      await writeFile(mediaPath, bytes, "utf8");

      const result = await writeReviewBundle({
        outDir,
        artifactRoots: [mediaRoot],
        receipts: [outputReceipt("render-legacy-unattested", { path: mediaPath })]
      });
      const [copied] = result.copiedArtifacts;
      expect(copied).toMatchObject({
        producerIdentity: "unattested",
        sha256: sha256(bytes),
        observedSha256: sha256(bytes),
        observedByteLength: Buffer.byteLength(bytes)
      });
      expect(copied).not.toHaveProperty("expectedProducerSha256");
      expect(copied).not.toHaveProperty("expectedProducerByteLength");

      const portableReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as {
        output: { copiedArtifactIdentities: Array<Record<string, unknown>> };
      };
      expect(portableReceipt.output.copiedArtifactIdentities).toEqual([expect.objectContaining({
        producerIdentity: "unattested",
        observedSha256: sha256(bytes),
        observedByteLength: Buffer.byteLength(bytes)
      })]);
      expect(portableReceipt.output.copiedArtifactIdentities[0]).not.toHaveProperty("expectedProducerSha256");
      expect(await readFile(result.htmlPath, "utf8")).toContain("Unattested: the receipt did not bind this artifact to a producer SHA-256.");
    });
  });

  it("rejects a same-inode same-size mutation after streaming the source", async () => {
    await inTrustedWorkspace(async (root) => {
      const mediaRoot = join(root, "media");
      const mediaPath = join(mediaRoot, "same-inode.mp4");
      const outDir = join(root, "bundle");
      const renderedBytes = "original bytes";
      const replacementBytes = "replaced bytes";
      expect(replacementBytes).toHaveLength(renderedBytes.length);
      await mkdir(mediaRoot, { mode: 0o700 });
      await writeFile(mediaPath, renderedBytes, "utf8");
      const beforeMutation = await stat(mediaPath);
      let mutationApplied = false;

      await expect(copyReviewArtifacts(
        [outputReceipt("render-same-inode-mutation", { path: mediaPath })],
        outDir,
        [mediaRoot],
        [],
        {
          // This runs after the retained descriptor streamed the original bytes but before its
          // post-stream stat. The write preserves dev/ino/size; the explicit future mtime makes
          // the secondary metadata mutation deterministic on coarse-timestamp filesystems.
          afterSourceStreamBeforeStat: async (sourcePath) => {
            expect(sourcePath).toBe(mediaPath);
            await writeFile(sourcePath, replacementBytes, "utf8");
            const future = new Date(Date.now() + 5_000);
            await utimes(sourcePath, future, future);
            const afterMutation = await stat(sourcePath);
            expect(afterMutation.dev).toBe(beforeMutation.dev);
            expect(afterMutation.ino).toBe(beforeMutation.ino);
            expect(afterMutation.size).toBe(beforeMutation.size);
            expect(afterMutation.mtimeMs).not.toBe(beforeMutation.mtimeMs);
            mutationApplied = true;
          }
        }
      )).rejects.toThrow(/changed while it was copied/i);
      expect(mutationApplied).toBe(true);
    });
  });
});
