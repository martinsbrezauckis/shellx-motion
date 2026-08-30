import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { assertPackageEditClosedInventoryAvailable, packageEditClosedInventoryPlatformCapability } from "./package-edit-closed-inventory.js";
import { commitPackageEdit } from "./package-edit-transaction.js";

const fault = vi.hoisted(() => ({
  armAfterSnapshot: false,
  injectBeforeStageSnapshot: undefined as number | undefined,
  injected: false,
  stageSnapshots: 0,
  writeFile: undefined as undefined | typeof import("node:fs/promises").writeFile
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fault.writeFile = actual.writeFile;
  return actual;
});

vi.mock("./package-edit-tree-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./package-edit-tree-snapshot.js")>();
  const path = await import("node:path");
  return {
    ...actual,
    snapshotPackageEditTree: async (root: string, options?: Parameters<typeof actual.snapshotPackageEditTree>[1]) => {
      const isStagedPackage = path.basename(root) === "package" && path.basename(path.dirname(root)).includes(".shellx-edit-");
      if (isStagedPackage) {
        fault.stageSnapshots += 1;
        if (fault.injectBeforeStageSnapshot === fault.stageSnapshots) {
          fault.injectBeforeStageSnapshot = undefined;
          fault.injected = true;
          await fault.writeFile!(path.join(root, "motion.json"), "injected-post-validation-race\n", "utf8");
        }
      }
      const snapshot = await actual.snapshotPackageEditTree(root, options);
      if (fault.armAfterSnapshot && isStagedPackage) {
        fault.armAfterSnapshot = false;
        fault.injected = true;
        await fault.writeFile!(path.join(root, "motion.json"), "injected-post-stage-race\n", "utf8");
      }
      return snapshot;
    },
  };
});

afterEach(() => {
  fault.armAfterSnapshot = false;
  fault.injectBeforeStageSnapshot = undefined;
  fault.injected = false;
  fault.stageSnapshots = 0;
});

describe("package edit portable post-stage integrity", () => {
  it("refuses a same-UID mutation injected after the final checkpoint and before installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-edit-portable-post-stage-race-"));
    const source = join(root, "source");
    const output = join(root, "output");
    try {
      await writePackage(source);
      const authority = await createTrustedWorkspaceAnchor(root);
      await expect(withTrustedWorkspaceAnchor(authority, async () => await commitPackageEdit({
        sourceRoot: source,
        outputRoot: output,
        edit: async (stagedRoot) => await writeFile(join(stagedRoot, "motion.json"), "edited\n", "utf8"),
        beforeCommit: async () => { fault.armAfterSnapshot = true; },
      }))).rejects.toMatchObject({ code: "source_changed" });
      expect(fault.injected).toBe(true);
      await expect(readdir(output)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(source, "motion.json"), "utf8")).toContain("motion_package_edit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a mutation between validation and the pre-beforeCommit stage snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-edit-portable-post-validation-race-"));
    const source = join(root, "source");
    const output = join(root, "output");
    let beforeCommitCalls = 0;
    try {
      await writePackage(source);
      const authority = await createTrustedWorkspaceAnchor(root);
      // Generic staging observes the staged package three times before the checkpoint: copy,
      // after edit, and after validation.  Inject immediately before the fourth observation,
      // which occurs after output claim but before beforeCommit can run.
      fault.injectBeforeStageSnapshot = 4;
      await expect(withTrustedWorkspaceAnchor(authority, async () => await commitPackageEdit({
        sourceRoot: source,
        outputRoot: output,
        edit: async (stagedRoot) => await writeFile(join(stagedRoot, "motion.json"), "edited\n", "utf8"),
        beforeCommit: async () => { beforeCommitCalls += 1; },
      }))).rejects.toMatchObject({ code: "source_changed" });
      expect(fault.injected).toBe(true);
      expect(beforeCommitCalls).toBe(0);
      await expect(readdir(output)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(source, "motion.json"), "utf8")).toContain("motion_package_edit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("labels Linux closed inventory separately from portable Windows and macOS rechecks", () => {
    expect(packageEditClosedInventoryPlatformCapability("linux")).toEqual({ available: true, proof: "linux-descriptor-relative" });
    for (const platform of ["win32", "darwin"] as const) {
      expect(packageEditClosedInventoryPlatformCapability(platform)).toEqual({ available: false, refusal: "native_descriptor_or_dacl_proof_required" });
      expect(() => assertPackageEditClosedInventoryAvailable(platform)).toThrow(/Windows and macOS are refused/u);
    }
  });
});

async function writePackage(root: string): Promise<void> {
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({ schema: "shellx-motion/package-manifest@1", id: "pkg_package_edit", name: "Package edit transaction", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["native"], hosts: ["motion"] } })}\n`, "utf8");
  await writeFile(join(root, "motion.json"), `${JSON.stringify({ schema: "shellx-motion/motion@1", id: "motion_package_edit", name: "Package edit transaction", durationMs: 1000, fps: 30, width: 64, height: 36, layers: [{ id: "shape", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, transform: { x: 0, y: 0, width: 16, height: 16, scale: 1, rotation: 0, opacity: 1 } }], assets: [], provenance: { sourceApp: "test", createdBy: "test" } })}\n`, "utf8");
}
