import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitNewPackage, commitPackageEdit, PackageEditTransactionError } from "./package-edit-transaction.js";

describe("package edit transaction", () => {
  it("installs an edited package atomically from a verified private staging copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-edit-success-"));
    const sourceRoot = join(root, "source");
    const outputRoot = join(root, "output");
    try {
      await writePackage(sourceRoot);
      const result = await commitPackageEdit({
        sourceRoot,
        outputRoot,
        edit: async (stagedRoot) => {
          await writeFile(join(stagedRoot, "motion.json"), "edited\n", "utf8");
          return { changed: true };
        },
        validate: async (stagedRoot) => {
          expect(await readFile(join(stagedRoot, "motion.json"), "utf8")).toBe("edited\n");
        },
        afterCommit: async (installedRoot) => {
          expect(installedRoot).toBe(outputRoot);
          return "committed";
        }
      });
      expect(result).toEqual({ outputRoot, editResult: { changed: true }, afterCommitResult: "committed" });
      expect(await readFile(join(outputRoot, "motion.json"), "utf8")).toBe("edited\n");
      expect(await readFile(join(sourceRoot, "motion.json"), "utf8")).toBe("source-motion\n");
      expect((await readdir(root)).filter((name) => name.includes("shellx-edit"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores a pre-existing empty destination when post-commit work fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-edit-rollback-"));
    const sourceRoot = join(root, "source");
    const outputRoot = join(root, "output");
    try {
      await writePackage(sourceRoot);
      await mkdir(outputRoot);
      await expect(commitPackageEdit({
        sourceRoot,
        outputRoot,
        edit: async (stagedRoot) => {
          await writeFile(join(stagedRoot, "motion.json"), "edited\n", "utf8");
        },
        afterCommit: async () => { throw new Error("receipt persistence failed"); }
      })).rejects.toThrow("receipt persistence failed");
      expect(await readdir(outputRoot)).toEqual([]);
      expect((await readdir(root)).filter((name) => name.includes("shellx-edit"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves an absent destination absent when editing or source-stability checks fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-edit-failure-"));
    const sourceRoot = join(root, "source");
    const outputRoot = join(root, "output");
    try {
      await writePackage(sourceRoot);
      await expect(commitPackageEdit({
        sourceRoot,
        outputRoot,
        edit: async () => { throw new Error("edit failed"); }
      })).rejects.toThrow("edit failed");
      await expect(readFile(join(outputRoot, "motion.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      await expect(commitPackageEdit({
        sourceRoot,
        outputRoot,
        edit: async (stagedRoot) => {
          await writeFile(join(stagedRoot, "motion.json"), "edited\n", "utf8");
          await writeFile(join(sourceRoot, "motion.json"), "source-changed\n", "utf8");
        }
      })).rejects.toMatchObject({ code: "source_changed" });
      await expect(readFile(join(outputRoot, "motion.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      await writeFile(join(sourceRoot, "motion.json"), "source-motion\n", "utf8");
      await expect(commitPackageEdit({
        sourceRoot,
        outputRoot,
        edit: async () => { await mkdir(outputRoot); }
      })).rejects.toMatchObject({ code: "output_changed" });
      expect(await readdir(outputRoot)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects overlapping, non-empty, and symbolic-link package boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-edit-boundary-"));
    const sourceRoot = join(root, "source");
    const nonEmptyOutput = join(root, "non-empty");
    try {
      await writePackage(sourceRoot);
      await mkdir(nonEmptyOutput);
      await writeFile(join(nonEmptyOutput, "keep.txt"), "keep", "utf8");
      await expect(commitPackageEdit({
        sourceRoot,
        outputRoot: join(sourceRoot, "nested"),
        edit: async () => {}
      })).rejects.toMatchObject({ code: "unsafe_output" });
      await expect(commitPackageEdit({
        sourceRoot,
        outputRoot: nonEmptyOutput,
        edit: async () => {}
      })).rejects.toMatchObject({ code: "output_not_empty" });
      if (process.platform !== "win32") {
        await symlink(join(sourceRoot, "motion.json"), join(sourceRoot, "linked.json"), "file");
        await expect(commitPackageEdit({
          sourceRoot,
          outputRoot: join(root, "symlink-output"),
          edit: async () => {}
        })).rejects.toBeInstanceOf(PackageEditTransactionError);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("atomically installs a brand-new bounded package through an exclusive destination claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-new-package-success-"));
    const outputRoot = join(root, "output");
    try {
      const result = await commitNewPackage({
        outputRoot,
        build: async (stagedRoot) => {
          await writeFile(join(stagedRoot, "manifest.json"), "manifest\n", "utf8");
          await writeFile(join(stagedRoot, "motion.json"), "motion\n", "utf8");
          return { packageId: "pkg_new" };
        },
        validate: async (stagedRoot) => {
          expect(await readFile(join(stagedRoot, "motion.json"), "utf8")).toBe("motion\n");
        },
        afterCommit: async (installedRoot) => {
          expect(installedRoot).toBe(outputRoot);
          return "installed";
        }
      });
      expect(result).toEqual({ outputRoot, editResult: { packageId: "pkg_new" }, afterCommitResult: "installed" });
      expect(await readFile(join(outputRoot, "manifest.json"), "utf8")).toBe("manifest\n");
      expect((await readdir(root)).filter((name) => name.includes("shellx-new"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls a new package back to the exact absent or empty pre-commit state", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-new-package-rollback-"));
    const absentOutput = join(root, "absent-output");
    const emptyOutput = join(root, "empty-output");
    try {
      await expect(commitNewPackage({
        outputRoot: absentOutput,
        build: async (stagedRoot) => { await writeFile(join(stagedRoot, "motion.json"), "motion\n", "utf8"); },
        afterCommit: async () => { throw new Error("receipt failed"); }
      })).rejects.toThrow("receipt failed");
      await expect(readdir(absentOutput)).rejects.toMatchObject({ code: "ENOENT" });

      await mkdir(emptyOutput);
      await expect(commitNewPackage({
        outputRoot: emptyOutput,
        build: async (stagedRoot) => { await writeFile(join(stagedRoot, "motion.json"), "motion\n", "utf8"); },
        afterCommit: async () => { throw new Error("receipt failed"); }
      })).rejects.toThrow("receipt failed");
      expect(await readdir(emptyOutput)).toEqual([]);
      expect((await readdir(root)).filter((name) => name.includes("shellx-new"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects new-package destination races and staged symlinks without partial output", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-new-package-race-"));
    const racedOutput = join(root, "raced-output");
    try {
      await expect(commitNewPackage({
        outputRoot: racedOutput,
        build: async (stagedRoot) => { await writeFile(join(stagedRoot, "motion.json"), "motion\n", "utf8"); },
        beforeCommit: async () => {
          await mkdir(racedOutput);
          await writeFile(join(racedOutput, "attacker.txt"), "keep", "utf8");
        }
      })).rejects.toMatchObject({ code: "output_changed" });
      expect(await readFile(join(racedOutput, "attacker.txt"), "utf8")).toBe("keep");

      if (process.platform !== "win32") {
        const symlinkOutput = join(root, "symlink-output");
        await expect(commitNewPackage({
          outputRoot: symlinkOutput,
          build: async (stagedRoot) => {
            await writeFile(join(stagedRoot, "motion.json"), "motion\n", "utf8");
            await symlink(join(stagedRoot, "motion.json"), join(stagedRoot, "linked.json"), "file");
          }
        })).rejects.toMatchObject({ code: "unsupported_source_entry" });
        await expect(readdir(symlinkOutput)).rejects.toMatchObject({ code: "ENOENT" });
      }

      const mutatedOutput = join(root, "mutated-output");
      await expect(commitNewPackage({
        outputRoot: mutatedOutput,
        build: async (stagedRoot) => { await writeFile(join(stagedRoot, "motion.json"), "motion\n", "utf8"); },
        validate: async (stagedRoot) => { await writeFile(join(stagedRoot, "motion.json"), "changed\n", "utf8"); }
      })).rejects.toMatchObject({ code: "source_changed" });
      await expect(readdir(mutatedOutput)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writePackage(root: string): Promise<void> {
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "manifest.json"), "source-manifest\n", "utf8");
  await writeFile(join(root, "motion.json"), "source-motion\n", "utf8");
  await writeFile(join(root, "assets", "asset.bin"), Buffer.from([0, 1, 2, 3]));
}
