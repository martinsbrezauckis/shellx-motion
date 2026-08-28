import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitBoundedPackageTree, publishAdmittedPackageTree } from "./bounded-package-copy";

const tempDirs: string[] = [];
const TREE_ENTRY_LIMIT = 3;
const testLimits = {
  maxFileBytes: 64,
  maxFiles: TREE_ENTRY_LIMIT,
  maxPathDepth: 4,
  maxAggregateBytes: 64,
  maxConcurrentReads: 1
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("bounded package-tree admission", () => {
  it("counts empty directories against the tree-entry budget before any publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-tree-entry-overflow-"));
    tempDirs.push(root);
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source);
    await Promise.all(Array.from({ length: TREE_ENTRY_LIMIT + 1 }, (_, index) => mkdir(join(source, `empty-${index}`))));

    await expect(admitBoundedPackageTree(source, { label: "test package", limits: testLimits }))
      .rejects.toThrow(`${TREE_ENTRY_LIMIT}-entry package-tree limit`);
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts and publishes the exact entry boundary without counting the package root", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-tree-entry-boundary-"));
    tempDirs.push(root);
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source);
    await Promise.all(Array.from({ length: TREE_ENTRY_LIMIT }, (_, index) => mkdir(join(source, `empty-${index}`))));

    const tree = await admitBoundedPackageTree(source, { label: "test package", limits: testLimits });
    expect(tree.evidence).toMatchObject({ entryCount: TREE_ENTRY_LIMIT, fileCount: 0 });
    expect(tree.evidence.entries).toHaveLength(TREE_ENTRY_LIMIT + 1);
    expect(tree.evidence.entries).toContainEqual({ path: "", kind: "directory" });

    await publishAdmittedPackageTree(tree, destination);
    expect((await readdir(destination)).sort()).toEqual(["empty-0", "empty-1", "empty-2"]);
  });
});
