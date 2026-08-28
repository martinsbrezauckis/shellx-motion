/** Outcome tests for secure, atomic SVG-to-Motion package installation. */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hashBuffer, inspectPngBuffer, loadMotionPackage } from "@shellx-motion/core";
import { renderMotionBrowserFrame } from "@shellx-motion/renderer-browser";
import { writeStaticSvgPackage } from "./authoring-svg-package.js";

const fixturePath = resolve("../../fixtures/imports/svg-static-path/input.svg");

describe("atomic SVG package authoring", () => {
  it("preserves source bytes and installs one hash-converged portable package", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-svg-package-"));
    const outputRoot = join(root, "packages", "svg-import");
    try {
      await mkdir(dirname(outputRoot), { recursive: true, mode: 0o700 });
      const result = await writeStaticSvgPackage({
        sourcePath: fixturePath,
        outputRoot,
        inputRoots: [dirname(fixturePath)],
        outputRoots: [root],
        createdBy: "adapter-package-test",
        createdAt: "2026-07-12T06:30:00.000Z"
      });
      const sourceBytes = await readFile(fixturePath);
      const preservedBytes = await readFile(result.sourcePath);
      const diagnosticsReceipt = JSON.parse(await readFile(result.diagnosticsReceiptPath, "utf8")) as Record<string, any>;
      const loweringReceipt = JSON.parse(await readFile(result.loweringReceiptPath, "utf8")) as Record<string, any>;
      const manifestText = await readFile(result.manifestPath, "utf8");
      const reopened = await loadMotionPackage(result.packageRoot);
      const render = await renderMotionBrowserFrame(reopened, { atMs: 0, outDir: join(root, "render") });
      const quality = inspectPngBuffer(await readFile(render.output.path));

      expect(preservedBytes.equals(sourceBytes)).toBe(true);
      expect(result.sourceSha256).toBe(hashBuffer(sourceBytes));
      expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.motionSha256).toBe(loweringReceipt.output.motionSha256);
      expect(reopened.manifest.id).toBe(`pkg_svg_${result.sourceSha256.slice(0, 16)}`);
      expect(reopened.motion.provenance).toMatchObject({ sourceApp: "svg", createdBy: "adapter-package-test" });
      expect(diagnosticsReceipt).toMatchObject({
        operation: "adapter.diagnostics",
        packageId: reopened.manifest.id,
        inputHashes: { source: result.sourceSha256 },
        output: { source: { path: "source/input.svg", sha256: result.sourceSha256 } }
      });
      expect(loweringReceipt).toMatchObject({
        operation: "adapter.lower",
        packageId: reopened.manifest.id,
        inputHashes: { source: result.sourceSha256 },
        output: { motionId: reopened.motion.id, motionSha256: result.motionSha256 }
      });
      expect(manifestText).not.toContain(fixturePath);
      expect(JSON.stringify(diagnosticsReceipt)).not.toContain(fixturePath);
      expect(quality.ok).toBe(true);
      if (quality.ok) {
        expect(quality.blank).toBe(false);
        expect(quality.edges.pixels).toBeGreaterThan(500);
      }
      if (process.platform !== "win32") {
        expect((await stat(result.motionPath)).mode & 0o777).toBe(0o600);
        expect((await stat(result.packageRoot)).mode & 0o077).toBe(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects path escapes, source symlinks, and source mutation without creating output", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-svg-package-security-"));
    const inputRoot = join(root, "input");
    const outputBase = join(root, "output");
    const sourcePath = join(inputRoot, "input.svg");
    try {
      await mkdir(inputRoot);
      await mkdir(outputBase);
      await writeFile(sourcePath, await readFile(fixturePath));
      await expect(writeStaticSvgPackage({
        sourcePath,
        outputRoot: join(root, "escaped", "package"),
        inputRoots: [inputRoot],
        outputRoots: [outputBase]
      })).rejects.toThrow("approved output root");

      const mutatedOutput = join(outputBase, "mutated");
      await expect(writeStaticSvgPackage({
        sourcePath,
        outputRoot: mutatedOutput,
        inputRoots: [inputRoot],
        outputRoots: [outputBase],
        beforeSourceStabilityCheck: async () => { await writeFile(sourcePath, "<svg width=\"1\" height=\"1\"></svg>\n", "utf8"); }
      })).rejects.toThrow("changed while it was being read");
      await expect(readdir(mutatedOutput)).rejects.toMatchObject({ code: "ENOENT" });

      if (process.platform !== "win32") {
        await writeFile(sourcePath, await readFile(fixturePath));
        const linkedPath = join(inputRoot, "linked.svg");
        await symlink(sourcePath, linkedPath, "file");
        await expect(writeStaticSvgPackage({
          sourcePath: linkedPath,
          outputRoot: join(outputBase, "linked"),
          inputRoots: [inputRoot],
          outputRoots: [outputBase]
        })).rejects.toMatchObject({ code: "ELOOP" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back absent and empty destinations when host receipt persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-svg-package-rollback-"));
    const outputRoot = join(root, "package");
    try {
      await expect(writeStaticSvgPackage({
        sourcePath: fixturePath,
        outputRoot,
        inputRoots: [dirname(fixturePath)],
        outputRoots: [root],
        afterCommit: async () => { throw new Error("host receipt persistence failed"); }
      })).rejects.toThrow("host receipt persistence failed");
      await expect(readdir(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });

      await mkdir(outputRoot);
      await expect(writeStaticSvgPackage({
        sourcePath: fixturePath,
        outputRoot,
        inputRoots: [dirname(fixturePath)],
        outputRoots: [root],
        afterCommit: async () => { throw new Error("host receipt persistence failed"); }
      })).rejects.toThrow("host receipt persistence failed");
      expect(await readdir(outputRoot)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back when a host callback mutates installed package bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-svg-package-host-mutation-"));
    const outputRoot = join(root, "package");
    try {
      await expect(writeStaticSvgPackage({
        sourcePath: fixturePath,
        outputRoot,
        inputRoots: [dirname(fixturePath)],
        outputRoots: [root],
        afterCommit: async (installedRoot) => {
          await writeFile(join(installedRoot, "motion.json"), "{}\n", "utf8");
          return join(root, "host-receipt.json");
        }
      })).rejects.toThrow();
      await expect(readdir(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an approved output parent replaced by a symlink during source validation", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-svg-package-root-race-"));
    const approvedRoot = join(root, "approved");
    const pivot = join(approvedRoot, "pivot");
    const displacedPivot = join(approvedRoot, "pivot-original");
    const outsideRoot = join(root, "outside");
    const outputRoot = join(pivot, "package");
    try {
      await mkdir(pivot, { recursive: true });
      await mkdir(outsideRoot);
      await expect(writeStaticSvgPackage({
        sourcePath: fixturePath,
        outputRoot,
        inputRoots: [dirname(fixturePath)],
        outputRoots: [approvedRoot],
        beforeSourceStabilityCheck: async () => {
          await rename(pivot, displacedPivot);
          await symlink(outsideRoot, pivot, "dir");
        }
      })).rejects.toThrow("approved output root");
      expect(await readdir(outsideRoot)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
