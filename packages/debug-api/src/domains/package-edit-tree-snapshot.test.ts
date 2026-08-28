import { link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotPackageEditTree } from "./package-edit-tree-snapshot.js";

describe.skipIf(process.platform === "win32")("package edit tree snapshot", () => {
  it("normalizes one Windows path separator in a snapshot entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-edit-snapshot-"));
    try {
      await writeFile(join(root, "nested\\motion.json"), "motion\n", "utf8");
      const snapshot = await snapshotPackageEditTree(root);
      expect([...snapshot.entries.keys()]).toEqual(["nested/motion.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("optionally refuses multiply-linked files for portable sealed-output verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-edit-single-link-"));
    try {
      await writeFile(join(root, "motion.json"), "motion\n", "utf8");
      await link(join(root, "motion.json"), join(root, "motion-alias.json"));
      await expect(snapshotPackageEditTree(root)).resolves.toMatchObject({ files: 2 });
      await expect(snapshotPackageEditTree(root, { requireSingleLink: true })).rejects.toThrow(/single-link/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
