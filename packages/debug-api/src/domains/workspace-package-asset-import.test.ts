import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_PACKAGE_ASSET_IMPORT_BYTES, loadMotionPackage } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { dispatchWorkspaceCommand } from "./workspace.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("motion.package.asset.import", () => {
  it("copies an approved external regular file into an ordinary package revision and records deterministic facts", async () => {
    const root = await packageRoot();
    const sourcePath = join(root, "incoming-hero.bin");
    const outputRoot = join(root, "revision");
    await writeFile(sourcePath, "hero bytes\n", "utf8");

    const result = await withinWorkspace(root, async () => await dispatchWorkspaceCommand("motion.package.asset.import", {
      packageRoot: join(root, "source"),
      outDir: outputRoot,
      assetPath: sourcePath,
      assetRef: "assets/imports/hero.bin",
      createdBy: "test",
      createdAt: "2026-08-26T00:00:00.000Z",
    }, services(root)));

    expect(result).toMatchObject({
      ok: true,
      visibleState: { operation: "package.asset.import", panel: "assets", assetRef: "assets/imports/hero.bin" },
      result: {
        packageDir: outputRoot,
        assetRef: "assets/imports/hero.bin",
        assetByteLength: 11,
        receipt: { operation: "package.asset.import", createdAt: "2026-08-26T00:00:00.000Z", inputHashes: { asset: expect.stringMatching(/^[a-f0-9]{64}$/) } },
      },
    });
    const manifest = JSON.parse(await readFile(join(outputRoot, "manifest.json"), "utf8")) as { assets: string[] };
    expect(manifest.assets).toEqual(["assets/imports/hero.bin"]);
    await expect(readFile(join(outputRoot, "assets", "imports", "hero.bin"), "utf8")).resolves.toBe("hero bytes\n");
    await expect(readFile(join(outputRoot, "receipts", "package-asset-import.receipt.json"), "utf8")).resolves.toContain("package.asset.import");
  });

  it("refuses a non-assets target spelling and leaves no output package", async () => {
    const root = await packageRoot();
    const sourcePath = join(root, "incoming.bin");
    const outputRoot = join(root, "revision");
    await writeFile(sourcePath, "source", "utf8");

    const result = await withinWorkspace(root, async () => await dispatchWorkspaceCommand("motion.package.asset.import", {
      packageRoot: join(root, "source"), outDir: outputRoot, assetPath: sourcePath, assetRef: "../outside.bin",
    }, services(root)));

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("portable package-local assets/") } });
    await expect(readdir(root)).resolves.not.toContain("revision");
  });

  it("refuses an existing source-package target instead of replacing it", async () => {
    const root = await packageRoot({ assets: ["assets/existing.bin"] });
    const sourcePath = join(root, "incoming.bin");
    const outputRoot = join(root, "revision");
    await mkdir(join(root, "source", "assets"), { recursive: true });
    await writeFile(join(root, "source", "assets", "existing.bin"), "original", "utf8");
    await writeFile(sourcePath, "replacement", "utf8");

    const result = await withinWorkspace(root, async () => await dispatchWorkspaceCommand("motion.package.asset.import", {
      packageRoot: join(root, "source"), outDir: outputRoot, assetPath: sourcePath, assetRef: "assets/existing.bin",
    }, services(root)));

    expect(result).toMatchObject({ ok: false, error: { code: "package_asset_import_failed", message: expect.stringContaining("target already exists") } });
    await expect(readdir(root)).resolves.not.toContain("revision");
  });

  it("refuses an oversize sparse source before reading it or creating an output package", async () => {
    const root = await packageRoot();
    const sourcePath = join(root, "oversize-source.bin");
    const outputRoot = join(root, "revision");
    await writeFile(sourcePath, "", "utf8");
    await truncate(sourcePath, MAX_PACKAGE_ASSET_IMPORT_BYTES + 1);

    const result = await withinWorkspace(root, async () => await dispatchWorkspaceCommand("motion.package.asset.import", {
      packageRoot: join(root, "source"), outDir: outputRoot, assetPath: sourcePath, assetRef: "assets/oversize.bin",
    }, services(root)));

    expect(result).toMatchObject({ ok: false, error: { code: "package_asset_import_failed", message: expect.stringContaining("byte limit") } });
    expect((result as { error: { message: string } }).error.message).not.toContain(sourcePath);
    await expect(readdir(root)).resolves.not.toContain("revision");
  });
});

async function packageRoot(input: { assets?: string[] } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-asset-import-"));
  tempDirs.push(root);
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1", id: "pkg_asset_import", name: "Asset import", motion: "motion.json",
    assets: input.assets ?? [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] },
  }, null, 2)}\n`);
  await writeFile(join(source, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1", id: "motion_asset_import", name: "Asset import", durationMs: 1_000, fps: 30,
    width: 100, height: 100, layers: [], assets: [], provenance: { sourceApp: "test", createdBy: "test" },
  }, null, 2)}\n`);
  return root;
}

function services(root: string) {
  return {
    packageLoader: loadMotionPackage,
    authoringInputRoots: [root],
    authoringOutputRoots: [root],
    isUnsafePackageOutputDirectory: async () => false,
    isEmptyOrAbsentDirectory: async (path: string) => {
      try { return (await readdir(path)).length === 0; } catch (error) {
        return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
      }
    },
  };
}

async function withinWorkspace<T>(root: string, action: () => Promise<T>): Promise<T> {
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), action);
}
