import { link, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { samePackageEditTreeIdentitySnapshot, samePackageEditTreeSnapshot, snapshotPackageEditTree } from "./package-edit-tree-snapshot.js";

describe("package edit portable tree snapshot", () => {
  it("rechecks exact stage bytes, names, and reported identities without claiming closed inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-edit-portable-snapshot-"));
    try {
      const nested = join(root, "nested");
      const motion = join(nested, "motion.json");
      const replacement = join(root, "replacement.json");
      await mkdir(nested);
      await writeFile(motion, "motion\n", "utf8");
      const original = await snapshotPackageEditTree(root);
      await writeFile(replacement, "motion\n", "utf8");
      await rm(motion);
      await rename(replacement, motion);
      const replaced = await snapshotPackageEditTree(root);

      expect(samePackageEditTreeSnapshot(original, replaced)).toBe(true);
      expect(samePackageEditTreeIdentitySnapshot(original, replaced)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("package edit POSIX tree snapshot", () => {
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
