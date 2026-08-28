import { link, mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { BoundedResourceBudget, readBoundedStableFile, readBudgetedStableFile } from "./stable-file-read";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("stable-file single-link admission", () => {
  it.skipIf(process.platform === "win32")("preserves legacy hardlink reads unless the caller explicitly requires one link", async () => {
    const root = await scratch();
    const source = join(root, "source.bin");
    await writeFile(source, "shared bytes", "utf8");
    await link(source, join(root, "second-name.bin"));
    await withinWorkspace(root, async () => {
      const legacy = await readBoundedStableFile(source, {
        label: "legacy hardlink read",
        maxBytes: 1024,
        withinRoot: root,
      });
      expect(legacy.bytes).toEqual(Buffer.from("shared bytes"));
      expect(legacy.identity).toBeUndefined();

      await expect(readBoundedStableFile(source, {
        label: "single-link hardlink read",
        maxBytes: 1024,
        withinRoot: root,
        requireSingleLink: true,
        captureIdentity: true,
      })).rejects.toThrow(/single-link regular file/i);
    });
  });

  it("returns opened identity facts only when the caller explicitly requests them", async () => {
    const root = await scratch();
    const source = join(root, "source.bin");
    await writeFile(source, "one owner", "utf8");
    await withinWorkspace(root, async () => {
      const legacy = await readBoundedStableFile(source, { label: "legacy identity", maxBytes: 1024, withinRoot: root });
      const captured = await readBoundedStableFile(source, { label: "captured identity", maxBytes: 1024, withinRoot: root, captureIdentity: true });
      expect(legacy.identity).toBeUndefined();
      expect(captured.identity).toMatchObject({ nlink: 1, byteLength: Buffer.byteLength("one owner") });
    });
  });

  it("rejects post-reservation growth before a budgeted read allocates its byte buffer", async () => {
    const root = await scratch();
    const source = join(root, "source.bin");
    await writeFile(source, "one", "utf8");
    const budget = new BoundedResourceBudget({ maxFileBytes: 1024, maxFiles: 1, maxPathDepth: 4, maxAggregateBytes: 1024, maxConcurrentReads: 1 }, "test budget");
    const allocation = vi.spyOn(Buffer, "allocUnsafe");

    try {
      await withinWorkspace(root, async () => {
        await expect(readBudgetedStableFile(source, {
          label: "budgeted growth",
          budget,
          withinRoot: root,
          afterPreflight: async () => await truncate(source, 512),
        })).rejects.toThrow(/changed after metadata preflight/i);
      });
      expect(allocation).not.toHaveBeenCalled();
      expect(budget.snapshot()).toEqual({ fileCount: 1, aggregateBytes: 3, activeReads: 0 });
    } finally {
      allocation.mockRestore();
    }
  });
});

async function scratch(): Promise<string> {
  const projectScratch = resolve("../../.scratch");
  await mkdir(projectScratch, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(projectScratch, "stable-file-single-link-"));
  roots.push(root);
  return root;
}

async function withinWorkspace<T>(root: string, action: () => Promise<T>): Promise<T> {
  if (process.platform === "win32") return await action();
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), action);
}
