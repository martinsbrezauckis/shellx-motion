import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { OutputDirectoryTransaction } from "./output-directory-transaction";

async function withinTrustedRoot(root: string, action: () => Promise<void>): Promise<void> {
  if (process.platform === "win32") return await action();
  await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), action);
}

async function testRoot(prefix: string): Promise<string> {
  return await mkdtemp(join(process.platform === "win32" ? process.cwd() : tmpdir(), prefix));
}

describe("OutputDirectoryTransaction", () => {
  it("publishes a completed private stage over an existing empty private destination", async () => {
    const root = await testRoot(".tmp-shellx-motion-output-transaction-");
    const outDir = join(root, "bundle");
    try {
      await withinTrustedRoot(root, async () => {
        await mkdir(outDir, { mode: 0o700 });
        const transaction = await OutputDirectoryTransaction.create(outDir);
        await writeFile(join(transaction.stagingPath, "review.html"), "complete", "utf8");
        await transaction.commit();

        await expect(readFile(join(outDir, "review.html"), "utf8")).resolves.toBe("complete");
        await expect(stat(transaction.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("publishes over an existing empty current-user 0755 destination", async () => {
    const root = await testRoot(".tmp-shellx-motion-output-transaction-");
    const outDir = join(root, "bundle");
    try {
      await withinTrustedRoot(root, async () => {
        await mkdir(outDir, { mode: 0o700 });
        await chmod(outDir, 0o755);
        const transaction = await OutputDirectoryTransaction.create(outDir);
        await writeFile(join(transaction.stagingPath, "review.html"), "complete", "utf8");
        await transaction.commit();

        await expect(readFile(join(outDir, "review.html"), "utf8")).resolves.toBe("complete");
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("refuses an unsafe parent without creating the public output", async () => {
    const root = await testRoot(".tmp-shellx-motion-output-transaction-unsafe-");
    const unsafeParent = join(root, "unsafe");
    const outDir = join(unsafeParent, "bundle");
    try {
      await mkdir(unsafeParent, { mode: 0o777 });
      await chmod(unsafeParent, 0o777);

      await expect(OutputDirectoryTransaction.create(outDir)).rejects.toThrow(/topology is unsafe|writable/i);
      await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a retargeted private stage instead of recursively cleaning its replacement", async () => {
    const root = await testRoot(".tmp-shellx-motion-output-transaction-retarget-");
    const outDir = join(root, "bundle");
    const retainedStage = join(root, "retained-stage");
    try {
      await withinTrustedRoot(root, async () => {
        const transaction = await OutputDirectoryTransaction.create(outDir);
        await writeFile(join(transaction.stagingPath, "complete.txt"), "complete", "utf8");
        await rename(transaction.stagingPath, retainedStage);
        await mkdir(transaction.stagingPath, { mode: 0o700 });
        await writeFile(join(transaction.stagingPath, "replacement.txt"), "caller replacement", "utf8");

        await expect(transaction.commit()).rejects.toThrow(/changed after Motion captured its identity/i);
        await transaction.abort();

        await expect(readFile(join(retainedStage, "complete.txt"), "utf8")).resolves.toBe("complete");
        await expect(readFile(join(transaction.stagingPath, "replacement.txt"), "utf8")).resolves.toBe("caller replacement");
        await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects a retargeted committed output before a dependent receipt can publish", async () => {
    const root = await testRoot(".tmp-shellx-motion-output-transaction-published-retarget-");
    const outDir = join(root, "bundle");
    const retainedOutput = join(root, "retained-output");
    try {
      await withinTrustedRoot(root, async () => {
        const transaction = await OutputDirectoryTransaction.create(outDir);
        await writeFile(join(transaction.stagingPath, "complete.txt"), "complete", "utf8");
        await transaction.commit();
        await rename(outDir, retainedOutput);
        await mkdir(outDir, { mode: 0o700 });
        await writeFile(join(outDir, "replacement.txt"), "caller replacement", "utf8");

        await expect(transaction.assertPublishedCurrent()).rejects.toMatchObject({
          code: "publication_commit_uncertain",
          evidence: { publicPath: outDir, kind: "directory" }
        });
        await transaction.abort();

        await expect(readFile(join(retainedOutput, "complete.txt"), "utf8")).resolves.toBe("complete");
        await expect(readFile(join(outDir, "replacement.txt"), "utf8")).resolves.toBe("caller replacement");
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("refuses an incomplete nested expected inventory before public rename", async () => {
    const root = resolve(await testRoot(".tmp-shellx-motion-output-transaction-flat-inventory-"));
    const outDir = join(root, "bundle");
    try {
      const authority = await createTrustedWorkspaceAnchor(root);
      await withTrustedWorkspaceAnchor(authority, async () => {
        const transaction = await OutputDirectoryTransaction.create(outDir, { requireAbsent: true });
        await expect(transaction.commit([
          { path: "nested/support-bundle.json", sha256: "0".repeat(64), byteLength: 0 }
        ])).rejects.toThrow(/unknown or missing entry/i);
        await transaction.abort();
      });
      await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "linux")("refuses a required exact closed tree before creating a stage", async () => {
    const root = await testRoot(".tmp-shellx-motion-output-transaction-closed-tree-");
    const outDir = join(root, "bundle");
    try {
      await expect(OutputDirectoryTransaction.create(outDir, { requireClosedTree: true }))
        .rejects.toThrow(/closed-tree publication requires a Linux descriptor-relative primitive/i);
      await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readdir(root)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
