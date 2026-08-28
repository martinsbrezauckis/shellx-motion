import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { collectBoundedPackageArchiveEntries } from "./package-archive-write-input";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("package archive write input", () => {
  it("refuses a directory-entry flood before retaining source bytes", async () => {
    const root = await scratch();
    await writeFile(join(root, "source.bin"), "one", "utf8");
    await Promise.all(["one", "two"].map(async (name) => await mkdir(join(root, name))));
    const afterEnumeration = vi.fn(async () => undefined);
    const allocation = vi.spyOn(Buffer, "allocUnsafe");

    try {
      await withinWorkspace(root, async () => {
        await expect(collectBoundedPackageArchiveEntries(root, { maxFiles: 1, maxPathDepth: 1 }, { afterEnumeration }))
          .rejects.toThrow(/exceeds the 2-entry topology limit/);
      });
      expect(afterEnumeration).not.toHaveBeenCalled();
      expect(allocation).not.toHaveBeenCalled();
    } finally {
      allocation.mockRestore();
    }
  });

  it("refuses a grown replacement after enumeration before retaining unreserved bytes", async () => {
    const root = await scratch();
    const source = join(root, "source.bin");
    const replacement = join(root, "source.replacement");
    await writeFile(source, "one", "utf8");
    const allocation = vi.spyOn(Buffer, "allocUnsafe");

    try {
      await withinWorkspace(root, async () => {
        await expect(collectBoundedPackageArchiveEntries(root, { maxAggregateBytes: 3 }, {
          afterEnumeration: async () => {
            await writeFile(replacement, Buffer.alloc(512));
            await rename(replacement, source);
          }
        })).rejects.toThrow(/changed after metadata preflight and before it was read/i);
      });
      expect(allocation).not.toHaveBeenCalled();
    } finally {
      allocation.mockRestore();
    }
  });
});

async function scratch(): Promise<string> {
  const projectScratch = resolve("../../.scratch");
  await mkdir(projectScratch, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(projectScratch, "package-archive-write-input-"));
  roots.push(root);
  return root;
}

async function withinWorkspace<T>(root: string, action: () => Promise<T>): Promise<T> {
  if (process.platform === "win32") return await action();
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), action);
}
