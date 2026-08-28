import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { commitPackageEdit } from "./package-edit-transaction.js";

const faults = vi.hoisted(() => ({ afterRename: undefined as undefined | ((from: string, to: string) => Promise<void>) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: async (from: string, to: string) => { await actual.rename(from, to); await faults.afterRename?.(from, to); } };
});

const MANIFEST = `${JSON.stringify({ schema: "shellx-motion/package-manifest@1", id: "pkg_complete_tree_uncertainty", name: "Complete tree uncertainty", motion: "motion.json", assets: ["assets/asset.bin"], sourceApp: "test", compatibility: { lanes: ["native"], hosts: ["motion"] } })}\n`;
const MOTION = `${JSON.stringify({ schema: "shellx-motion/motion@1", id: "motion_complete_tree_uncertainty", name: "Complete tree uncertainty", durationMs: 1000, fps: 30, width: 64, height: 36, layers: [{ id: "shape", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, transform: { x: 0, y: 0, width: 16, height: 16, scale: 1, rotation: 0, opacity: 1 } }], assets: [], provenance: { sourceApp: "test", createdBy: "test" } })}\n`;
const SENTINEL = createHash("sha256").update("shellx-motion:complete-tree-reopen-required@1\n").digest("hex");

describe("package edit complete-tree publication uncertainty", () => {
  it.skipIf(process.platform !== "linux")("requires domain-specific reopen when empty-directory markers are present", async () => {
    const value = await fixture(true);
    try {
      const error = await invokeUncertain(value);
      expect(error).toMatchObject({
        code: "publication_commit_uncertain",
        message: expect.stringContaining("domain-specific output-only reopen"),
        evidence: { publicPath: value.output, kind: "directory", expected: { sha256: SENTINEL, entryCount: 0, entries: [] } }
      });
      expect((error as { evidence: { expected: object } }).evidence.expected).not.toHaveProperty("inventory");
      expect(await readFile(join(value.output, "motion.json"), "utf8")).toBe("complete-tree-edit\n");
      expect(await readdir(join(value.output, "assets", "empty"))).toEqual([]);
      expect((await readdir(value.root)).some((name) => name.includes("shellx-edit"))).toBe(true);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "linux")("retains normal leaf reconciliation when complete mode observes no empty marker", async () => {
    const value = await fixture(false);
    try {
      const error = await invokeUncertain(value);
      expect(error).toMatchObject({
        code: "publication_commit_uncertain",
        evidence: { publicPath: value.output, kind: "directory", expected: { entryCount: 3, entries: ["assets/asset.bin", "manifest.json", "motion.json"], inventory: expect.any(Array) } }
      });
      expect((error as { evidence: { expected: { sha256: string } } }).evidence.expected.sha256).not.toBe(SENTINEL);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
});

async function fixture(emptyDirectory: boolean) {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-edit-complete-uncertain-"));
  const source = join(root, "source"), output = join(root, "output");
  await mkdir(join(source, "assets"), { recursive: true });
  await writeFile(join(source, "manifest.json"), MANIFEST, "utf8");
  await writeFile(join(source, "motion.json"), MOTION, "utf8");
  await writeFile(join(source, "assets", "asset.bin"), Buffer.from([0, 1, 2, 3]));
  if (emptyDirectory) await mkdir(join(source, "assets", "empty"), { mode: 0o700 });
  return { root, source, output };
}

async function invokeUncertain(value: Awaited<ReturnType<typeof fixture>>): Promise<unknown> {
  faults.afterRename = async (from, to) => {
    if (to === value.output && from.includes(".output.shellx-edit-") && from.endsWith("/package")) throw new Error("test-only complete-tree post-rename observation failure");
  };
  const authority = await createTrustedWorkspaceAnchor(value.root);
  return await withTrustedWorkspaceAnchor(authority, async () => await commitPackageEdit({
    sourceRoot: value.source,
    outputRoot: value.output,
    closedInventory: "finalize-after-edit-with-empty-directories",
    edit: async (stagedRoot) => { await writeFile(join(stagedRoot, "motion.json"), "complete-tree-edit\n", "utf8"); }
  })).catch((reason: unknown) => reason);
}

afterEach(() => { faults.afterRename = undefined; });
