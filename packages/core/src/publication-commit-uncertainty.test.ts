import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  afterLink: undefined as undefined | ((from: string, to: string) => Promise<void>),
  afterRename: undefined as undefined | ((from: string, to: string) => Promise<void>),
  afterUnlink: undefined as undefined | ((path: string) => Promise<void>),
  rename: undefined as undefined | typeof import("node:fs/promises").rename,
  mkdir: undefined as undefined | typeof import("node:fs/promises").mkdir,
  rm: undefined as undefined | typeof import("node:fs/promises").rm,
  writeFile: undefined as undefined | typeof import("node:fs/promises").writeFile
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fault.rename = actual.rename;
  fault.mkdir = actual.mkdir;
  fault.rm = actual.rm;
  fault.writeFile = actual.writeFile;
  return {
    ...actual,
    link: async (from: string, to: string) => {
      await actual.link(from, to);
      await fault.afterLink?.(from, to);
    },
    rename: async (from: string, to: string) => {
      await actual.rename(from, to);
      await fault.afterRename?.(from, to);
    },
    unlink: async (path: string) => {
      await actual.unlink(path);
      await fault.afterUnlink?.(path);
    }
  };
});

import { acquireDerivedOutputPublication } from "./derived-output-publication";
import { OutputDirectoryTransaction } from "./output-directory-transaction";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { PublicationCommitUncertainError } from "./publication-commit-uncertainty";

async function withinWorkspace<T>(root: string, action: () => Promise<T>): Promise<T> {
  if (process.platform === "win32") return await action();
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), action);
}

describe("publication commit uncertainty", () => {
  it("reports a verified file as possibly committed when observation fails immediately after link", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-publication-uncertain-file-"));
    const outputPath = join(root, "final.mp4");
    const displaced = join(root, "displaced-final.mp4");
    try {
      await withinWorkspace(root, async () => {
        const publication = await acquireDerivedOutputPublication({ outputPath, kind: "file" });
        await writeFile(publication.stagingPath, "verified final", "utf8");
        const expected = await publication.verifyFile();
        fault.afterLink = async (from, to) => {
          if (from !== publication.stagingPath || to !== outputPath) return;
          await fault.rename!(outputPath, displaced);
          await fault.writeFile!(outputPath, "competitor final", "utf8");
        };

        await expect(publication.publishFile(expected)).rejects.toMatchObject({
          code: "publication_commit_uncertain",
          evidence: { publicPath: outputPath, kind: "file", expectedIdentity: expect.any(Object), expected }
        } satisfies Partial<PublicationCommitUncertainError>);
      });
      expect(await readFile(displaced, "utf8")).toBe("verified final");
      expect(await readFile(outputPath, "utf8")).toBe("competitor final");
    } finally {
      fault.afterLink = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("reports a verified directory as possibly committed when observation fails immediately after rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-publication-uncertain-directory-"));
    const outputPath = join(root, "sequence");
    const displaced = join(root, "displaced-sequence");
    try {
      await withinWorkspace(root, async () => {
        const publication = await acquireDerivedOutputPublication({ outputPath, kind: "directory" });
        await writeFile(join(publication.stagingPath, "000001.png"), "frame", "utf8");
        const expected = await publication.verifyDirectory(["000001.png"]);
        fault.afterRename = async (from, to) => {
          if (from !== publication.stagingPath || to !== outputPath) return;
          await fault.rename!(outputPath, displaced);
          await fault.mkdir!(outputPath, { mode: 0o700 });
          await fault.writeFile!(join(outputPath, "competitor.txt"), "competitor", "utf8");
        };

        await expect(publication.publishDirectory(expected, ["000001.png"])).rejects.toMatchObject({
          code: "publication_commit_uncertain",
          evidence: { publicPath: outputPath, kind: "directory", expectedIdentity: expect.any(Object), expected: { ...expected, entries: ["000001.png"] } }
        } satisfies Partial<PublicationCommitUncertainError>);
      });
      expect(await readFile(join(displaced, "000001.png"), "utf8")).toBe("frame");
      expect(await readFile(join(outputPath, "competitor.txt"), "utf8")).toBe("competitor");
    } finally {
      fault.afterRename = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a directory transaction as possibly committed after the final rename, without restoring an empty destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-output-transaction-uncertain-"));
    const outputPath = join(root, "bundle");
    const displaced = join(root, "displaced-bundle");
    try {
      await withinWorkspace(root, async () => {
        const transaction = await OutputDirectoryTransaction.create(outputPath);
        await writeFile(join(transaction.stagingPath, "complete.txt"), "complete", "utf8");
        fault.afterRename = async (from, to) => {
          if (from !== transaction.stagingPath || to !== outputPath) return;
          await fault.rename!(outputPath, displaced);
          await fault.mkdir!(outputPath, { mode: 0o700 });
          await fault.writeFile!(join(outputPath, "competitor.txt"), "competitor", "utf8");
        };

        const exactInventory = process.platform === "linux"
          ? [{ path: "complete.txt", byteLength: Buffer.byteLength("complete"), sha256: createHash("sha256").update("complete").digest("hex") }]
          : undefined;
        await expect(transaction.commit(exactInventory)).rejects.toMatchObject({
          code: "publication_commit_uncertain",
          evidence: {
            publicPath: outputPath,
            kind: "directory",
            expectedIdentity: expect.any(Object),
            expected: expect.objectContaining({
              entries: ["complete.txt"],
              ...(exactInventory ? { inventory: exactInventory } : {})
            })
          }
        } satisfies Partial<PublicationCommitUncertainError>);
        await transaction.abort();
      });
      expect(await readFile(join(displaced, "complete.txt"), "utf8")).toBe("complete");
      expect(await readFile(join(outputPath, "competitor.txt"), "utf8")).toBe("competitor");
    } finally {
      fault.afterRename = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a committed directory as possibly committed when its dependent postcheck loses the published identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-output-transaction-postcheck-"));
    const outputPath = join(root, "bundle");
    const displaced = join(root, "displaced-bundle");
    try {
      await withinWorkspace(root, async () => {
        const transaction = await OutputDirectoryTransaction.create(outputPath);
        await writeFile(join(transaction.stagingPath, "complete.txt"), "complete", "utf8");
        await transaction.commit();
        await fault.rename!(outputPath, displaced);
        await fault.mkdir!(outputPath, { mode: 0o700 });
        await fault.writeFile!(join(outputPath, "competitor.txt"), "competitor", "utf8");

        await expect(transaction.assertPublishedCurrent()).rejects.toMatchObject({
          code: "publication_commit_uncertain",
          evidence: {
            publicPath: outputPath,
            kind: "directory",
            expectedIdentity: expect.any(Object),
            expected: expect.objectContaining({ entries: ["complete.txt"] })
          }
        } satisfies Partial<PublicationCommitUncertainError>);
      });
      expect(await readFile(join(displaced, "complete.txt"), "utf8")).toBe("complete");
      expect(await readFile(join(outputPath, "competitor.txt"), "utf8")).toBe("competitor");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not imply force preserved an old file when failure follows its removal before the final link", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-force-publication-"));
    const outputPath = join(root, "final.mp4");
    try {
      await withinWorkspace(root, async () => {
        await writeFile(outputPath, "old final", "utf8");
        const publication = await acquireDerivedOutputPublication({ outputPath, kind: "file", force: true });
        await writeFile(publication.stagingPath, "verified final", "utf8");
        const expected = await publication.verifyFile();
        fault.afterUnlink = async (path) => {
          if (path !== outputPath) return;
          await fault.rm!(publication.stagingPath);
          await fault.writeFile!(publication.stagingPath, "competitor stage", "utf8");
        };

        await expect(publication.publishFile(expected)).rejects.toMatchObject({
          code: "derived_output_publish_failed",
          message: expect.stringMatching(/after explicit force removed the previous output/i)
        });
        await expect(readFile(outputPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      });
    } finally {
      fault.afterUnlink = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });
});
