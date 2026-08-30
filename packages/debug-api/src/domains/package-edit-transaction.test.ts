import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { commitNewPackage, commitPackageEdit, PackageEditTransactionError } from "./package-edit-transaction.js";

const faults = vi.hoisted(() => ({
  afterRename: undefined as undefined | ((from: string, to: string) => Promise<void>),
  rename: undefined as undefined | typeof import("node:fs/promises").rename,
  mkdir: undefined as undefined | typeof import("node:fs/promises").mkdir,
  writeFile: undefined as undefined | typeof import("node:fs/promises").writeFile
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  faults.rename = actual.rename;
  faults.mkdir = actual.mkdir;
  faults.writeFile = actual.writeFile;
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      await actual.rename(from, to);
      await faults.afterRename?.(from, to);
    }
  };
});

const SOURCE_MANIFEST = `${JSON.stringify({ schema: "shellx-motion/package-manifest@1", id: "pkg_package_edit", name: "Package edit transaction", motion: "motion.json", assets: ["assets/asset.bin"], sourceApp: "test", compatibility: { lanes: ["native"], hosts: ["motion"] } })}\n`;
const SOURCE_MOTION = `${JSON.stringify({ schema: "shellx-motion/motion@1", id: "motion_package_edit", name: "Package edit transaction", durationMs: 1000, fps: 30, width: 64, height: 36, layers: [{ id: "shape", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, transform: { x: 0, y: 0, width: 16, height: 16, scale: 1, rotation: 0, opacity: 1 } }], assets: [], provenance: { sourceApp: "test", createdBy: "test" } })}\n`;

async function withinTrustedRoot<T>(root: string, action: () => Promise<T>): Promise<T> {
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), action);
}

describe("package edit transaction", () => {
  it.skipIf(process.platform !== "linux")("pins the complete final staged package after edit completion and preserves the source", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-edit-closed-success-"));
    const sourceRoot = join(root, "source");
    const outputRoot = join(root, "output");
    try {
      await writePackage(sourceRoot);
      await withinTrustedRoot(root, async () => await commitPackageEdit({
        sourceRoot,
        outputRoot,
        closedInventory: "finalize-after-edit",
        edit: async (stagedRoot) => {
          await writeFile(join(stagedRoot, "motion.json"), "closed-edit\n", "utf8");
          await writeFile(join(stagedRoot, "receipt.json"), "final receipt\n", "utf8");
        }
      }));
      expect(await readFile(join(outputRoot, "motion.json"), "utf8")).toBe("closed-edit\n");
      expect(await readFile(join(outputRoot, "receipt.json"), "utf8")).toBe("final receipt\n");
      expect(await readFile(join(sourceRoot, "motion.json"), "utf8")).toBe(SOURCE_MOTION);
      await expect(readFile(join(sourceRoot, "receipt.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(root)).filter((name) => name.includes("shellx-edit"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a legacy package-edit caller on its existing transaction path unless it opts in", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-edit-legacy-"));
    const sourceRoot = join(root, "source");
    const outputRoot = join(root, "output");
    try {
      await writePackage(sourceRoot);
      const result = await withinTrustedRoot(root, async () => await commitPackageEdit({
        sourceRoot,
        outputRoot,
        edit: async (stagedRoot) => {
          await writeFile(join(stagedRoot, "motion.json"), "legacy-edit\n", "utf8");
          return { caller: "legacy" };
        }
      }));
      expect(result.editResult).toEqual({ caller: "legacy" });
      expect(await readFile(join(outputRoot, "motion.json"), "utf8")).toBe("legacy-edit\n");
      expect(await readFile(join(sourceRoot, "motion.json"), "utf8")).toBe(SOURCE_MOTION);
      expect((await readdir(root)).filter((name) => name.includes("shellx-edit"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux").each(["extra", "missing", "changed"] as const)("refuses a %s staged leaf after automatic inventory pinning without publishing", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), `shellx-motion-package-edit-closed-${kind}-`));
    const sourceRoot = join(root, "source");
    const outputRoot = join(root, "output");
    try {
      await writePackage(sourceRoot);
      await expect(withinTrustedRoot(root, async () => await commitPackageEdit({
        sourceRoot,
        outputRoot,
        closedInventory: "finalize-after-edit",
        edit: async (stagedRoot) => { await writeFile(join(stagedRoot, "motion.json"), "closed-edit\n", "utf8"); },
        beforeCommit: async (stagedRoot) => {
          if (kind === "extra") await writeFile(join(stagedRoot, "late.txt"), "late\n", "utf8");
          if (kind === "missing") await rm(join(stagedRoot, "assets", "asset.bin"));
          if (kind === "changed") await writeFile(join(stagedRoot, "motion.json"), "changed-after-pin\n", "utf8");
        }
      }))).rejects.toMatchObject({ code: "closed_inventory_changed" });
      await expect(readdir(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(sourceRoot, "motion.json"), "utf8")).toBe(SOURCE_MOTION);
      expect(await readFile(join(sourceRoot, "assets", "asset.bin"))).toEqual(Buffer.from([0, 1, 2, 3]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("refuses a staged symlink after pinning without following it or changing the source", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-edit-closed-symlink-"));
    const sourceRoot = join(root, "source");
    const outputRoot = join(root, "output");
    const outside = join(root, "outside.txt");
    try {
      await writePackage(sourceRoot);
      await writeFile(outside, "outside\n", "utf8");
      await expect(withinTrustedRoot(root, async () => await commitPackageEdit({
        sourceRoot,
        outputRoot,
        closedInventory: "finalize-after-edit",
        edit: async (stagedRoot) => { await writeFile(join(stagedRoot, "motion.json"), "closed-edit\n", "utf8"); },
        beforeCommit: async (stagedRoot) => {
          await rm(join(stagedRoot, "assets", "asset.bin"));
          await symlink(outside, join(stagedRoot, "assets", "asset.bin"), "file");
        }
      }))).rejects.toMatchObject({ code: "closed_inventory_changed" });
      await expect(readdir(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(sourceRoot, "assets", "asset.bin"))).toEqual(Buffer.from([0, 1, 2, 3]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("fails closed before output claim when the source contains a nested empty directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-edit-closed-empty-directory-"));
    const sourceRoot = join(root, "source");
    const outputRoot = join(root, "output");
    try {
      await writePackage(sourceRoot);
      await mkdir(join(sourceRoot, "assets", "empty", "nested"), { recursive: true, mode: 0o700 });
      await expect(withinTrustedRoot(root, async () => await commitPackageEdit({
        sourceRoot,
        outputRoot,
        closedInventory: "finalize-after-edit",
        edit: async (stagedRoot) => { await writeFile(join(stagedRoot, "motion.json"), "closed-edit\n", "utf8"); }
      }))).rejects.toMatchObject({ code: "closed_inventory_changed" });
      await expect(readdir(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(join(sourceRoot, "assets", "empty", "nested"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("reports typed uncertainty with the pinned inventory when a public leaf appears immediately after rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-edit-closed-extra-after-rename-"));
    const sourceRoot = join(root, "source");
    const outputRoot = join(root, "output");
    try {
      await writePackage(sourceRoot);
      faults.afterRename = async (from, to) => {
        if (to === outputRoot && from.includes(".output.shellx-edit-") && from.endsWith("/package")) {
          await faults.writeFile!(join(to, "late.txt"), "late after rename\n", "utf8");
        }
      };
      await expect(withinTrustedRoot(root, async () => await commitPackageEdit({
        sourceRoot,
        outputRoot,
        closedInventory: "finalize-after-edit",
        edit: async (stagedRoot) => { await writeFile(join(stagedRoot, "motion.json"), "closed-edit\n", "utf8"); }
      }))).rejects.toMatchObject({
        code: "publication_commit_uncertain",
        evidence: {
          publicPath: outputRoot,
          kind: "directory",
          expected: {
            entries: ["assets/asset.bin", "manifest.json", "motion.json"],
            inventory: expect.any(Array)
          }
        }
      });
      expect(await readFile(join(outputRoot, "late.txt"), "utf8")).toBe("late after rename\n");
      expect(await readFile(join(sourceRoot, "motion.json"), "utf8")).toBe(SOURCE_MOTION);
      expect((await readdir(root)).some((name) => name.includes("shellx-edit"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("reports typed uncertainty without rollback when the public package is retargeted immediately after rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-edit-closed-retarget-after-rename-"));
    const sourceRoot = join(root, "source");
    const outputRoot = join(root, "output");
    const displaced = join(root, "displaced-output");
    try {
      await writePackage(sourceRoot);
      faults.afterRename = async (from, to) => {
        if (to === outputRoot && from.includes(".output.shellx-edit-") && from.endsWith("/package")) {
          await faults.rename!(to, displaced);
          await faults.mkdir!(to, { mode: 0o700 });
          await faults.writeFile!(join(to, "competitor.txt"), "competitor\n", "utf8");
        }
      };
      await expect(withinTrustedRoot(root, async () => await commitPackageEdit({
        sourceRoot,
        outputRoot,
        closedInventory: "finalize-after-edit",
        edit: async (stagedRoot) => { await writeFile(join(stagedRoot, "motion.json"), "closed-edit\n", "utf8"); }
      }))).rejects.toMatchObject({
        code: "publication_commit_uncertain",
        evidence: { publicPath: outputRoot, kind: "directory", expected: { entries: ["assets/asset.bin", "manifest.json", "motion.json"] } }
      });
      expect(await readFile(join(displaced, "motion.json"), "utf8")).toBe("closed-edit\n");
      expect(await readFile(join(outputRoot, "competitor.txt"), "utf8")).toBe("competitor\n");
      expect(await readFile(join(sourceRoot, "motion.json"), "utf8")).toBe(SOURCE_MOTION);
      expect((await readdir(root)).some((name) => name.includes("shellx-edit"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
      expect(await readFile(join(sourceRoot, "motion.json"), "utf8")).toBe(SOURCE_MOTION);
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

      await writeFile(join(sourceRoot, "motion.json"), SOURCE_MOTION, "utf8");
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

  it("never deletes a competing replacement during edit or new-package rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-edit-competitor-"));
    const sourceRoot = join(root, "source");
    const editOutput = join(root, "edit-output");
    const newOutput = join(root, "new-output");
    try {
      await writePackage(sourceRoot);
      await expect(commitPackageEdit({
        sourceRoot,
        outputRoot: editOutput,
        edit: async (stagedRoot) => { await writeFile(join(stagedRoot, "motion.json"), "edited\n", "utf8"); },
        afterCommit: async () => {
          await rm(editOutput, { recursive: true, force: true });
          await mkdir(editOutput);
          await writeFile(join(editOutput, "competitor.txt"), "preserve-edit", "utf8");
          throw new Error("post-commit failure");
        }
      })).rejects.toMatchObject({ code: "output_changed" });
      expect(await readFile(join(editOutput, "competitor.txt"), "utf8")).toBe("preserve-edit");

      await expect(commitNewPackage({
        outputRoot: newOutput,
        build: async (stagedRoot) => { await writeFile(join(stagedRoot, "motion.json"), "new\n", "utf8"); },
        afterCommit: async () => {
          await rm(newOutput, { recursive: true, force: true });
          await mkdir(newOutput);
          await writeFile(join(newOutput, "competitor.txt"), "preserve-new", "utf8");
          throw new Error("post-commit failure");
        }
      })).rejects.toMatchObject({ code: "output_changed" });
      expect(await readFile(join(newOutput, "competitor.txt"), "utf8")).toBe("preserve-new");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses symbolic-link output parents and parent retargets before any install", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-edit-parent-"));
    const safeParent = join(root, "safe");
    const outsideParent = join(root, "outside");
    const linkedParent = join(root, "linked");
    try {
      await Promise.all([mkdir(safeParent), mkdir(outsideParent)]);
      await symlink(outsideParent, linkedParent, "dir");
      await expect(commitNewPackage({
        outputRoot: join(linkedParent, "package"),
        build: async () => { throw new Error("must not build"); }
      })).rejects.toMatchObject({ code: "unsafe_output" });
      await expect(readdir(outsideParent)).resolves.toEqual([]);

      const outputRoot = join(safeParent, "package");
      await expect(commitNewPackage({
        outputRoot,
        build: async (stagedRoot) => { await writeFile(join(stagedRoot, "motion.json"), "new\n", "utf8"); },
        beforeCommit: async () => {
          await rename(safeParent, join(root, "safe-original"));
          await symlink(outsideParent, safeParent, "dir");
        }
      })).rejects.toMatchObject({ code: "unsafe_output" });
      await expect(readdir(outsideParent)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects staged or source mutation by the final non-mutating commit checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-edit-before-commit-"));
    const authority = await createTrustedWorkspaceAnchor(root);
    try {
      const stagedSource = join(root, "staged-source");
      const stagedOutput = join(root, "staged-output");
      await writePackage(stagedSource);
      await expect(withTrustedWorkspaceAnchor(authority, async () => await commitPackageEdit({
        sourceRoot: stagedSource, outputRoot: stagedOutput,
        edit: async () => undefined,
        beforeCommit: async (stagedRoot) => await writeFile(join(stagedRoot, "motion.json"), "changed-stage\n"),
      }))).rejects.toMatchObject({ code: "source_changed" });
      await expect(readdir(stagedOutput)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(stagedSource, "motion.json"), "utf8")).toBe(SOURCE_MOTION);

      const sourceMutation = join(root, "source-mutation");
      const sourceMutationOutput = join(root, "source-mutation-output");
      await writePackage(sourceMutation);
      await expect(withTrustedWorkspaceAnchor(authority, async () => await commitPackageEdit({
        sourceRoot: sourceMutation, outputRoot: sourceMutationOutput,
        edit: async () => undefined,
        beforeCommit: async () => await writeFile(join(sourceMutation, "motion.json"), "caller-mutated-source\n"),
      }))).rejects.toMatchObject({ code: "source_changed" });
      await expect(readdir(sourceMutationOutput)).rejects.toMatchObject({ code: "ENOENT" });
      // The caller's mutation is detected, not undone: only the transaction's own staged bytes
      // are rollback-owned.
      expect(await readFile(join(sourceMutation, "motion.json"), "utf8")).toBe("caller-mutated-source\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps every shipped Motion package COW writer behind the C2 package-edit admission boundary", async () => {
    const sourceRoot = fileURLToPath(new URL("./", import.meta.url));
    const sources = await sourceFiles(sourceRoot);
    const expectedDirectPackageWriters = [
      "authoring-agent-script.ts",
      "authoring-tracking.ts",
      "revision-transaction-commit.ts",
    ];
    const expectedMotionDocumentWriters = [
      "authoring-compositing-graph.ts",
      "authoring-cutout-rig.ts",
      "authoring-keying.ts",
      "authoring-procedural.ts",
      "authoring-template-mutations.ts",
      "authoring-tracking.ts",
      "procedural-audio-envelope.ts",
      "timeline-duration-policy.ts",
      "timeline-package-edit.ts",
      "workspace-package-asset-import.ts",
      "workspace-package-patch.ts",
    ];
    const directPackageWriters = await sourceNamesWithCall(sources, /\bcommitPackageEdit\s*\(/u, "package-edit-transaction.ts");
    const motionDocumentWriters = await sourceNamesWithCall(sources, /\bcommitMotionDocumentEdit\s*\(/u, "package-edit-transaction.ts");
    const workspaceWriters = await sourceNamesWithCall(sources, /\bPackageEditWorkspace\.create\s*\(/u);

    expect(directPackageWriters).toEqual(expectedDirectPackageWriters);
    expect(motionDocumentWriters).toEqual(expectedMotionDocumentWriters);
    expect(workspaceWriters).toEqual(["package-edit-transaction.ts", "physics-bake-durable-private/physics-bake-durable-private.ts"]);

    const transactionSource = await readFile(join(sourceRoot, "package-edit-transaction.ts"), "utf8");
    expect(transactionSource.indexOf("motionLayoutGapAnimationStorePresent(sourcePackage.motion)")).toBeGreaterThan(-1);
    expect(transactionSource.indexOf("motionLayoutGapAnimationStorePresent(sourcePackage.motion)"))
      .toBeLessThan(transactionSource.indexOf("PackageEditWorkspace.create(canonicalOutput, \"edit\", {"));
    expect(transactionSource).toContain("options.layoutGapAnimationContinuation !== C2_LAYOUT_GAP_ANIMATION_CONTINUATION");
    expect(transactionSource).toContain("options.layoutGapAnimationContinuation === C2_LAYOUT_GAP_ANIMATION_CONTINUATION");
  });
});

async function sourceFiles(root: string, relativeRoot = ""): Promise<string[]> {
  const entries = await readdir(join(root, relativeRoot), { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const relativePath = join(relativeRoot, entry.name);
    if (entry.isDirectory()) return await sourceFiles(root, relativePath);
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [relativePath] : [];
  }));
  return files.flat().sort();
}

async function sourceNamesWithCall(
  sources: readonly string[],
  call: RegExp,
  excluded?: string,
): Promise<string[]> {
  const root = fileURLToPath(new URL("./", import.meta.url));
  const names = await Promise.all(sources.map(async (source) => {
    if (source === excluded) return null;
    return call.test(await readFile(join(root, source), "utf8")) ? source : null;
  }));
  return names.filter((name): name is string => name !== null).sort();
}

afterEach(() => {
  faults.afterRename = undefined;
});

async function writePackage(root: string): Promise<void> {
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "manifest.json"), SOURCE_MANIFEST, "utf8");
  await writeFile(join(root, "motion.json"), SOURCE_MOTION, "utf8");
  await writeFile(join(root, "assets", "asset.bin"), Buffer.from([0, 1, 2, 3]));
}
