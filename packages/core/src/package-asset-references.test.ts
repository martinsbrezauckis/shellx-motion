import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMotionPackage } from "./package";
import { validatePackageAssetReferences } from "./package-asset-references";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";

describe("package asset references", () => {
  it("reports stable pointers for missing manifest, Motion asset, and layer references", async () => {
    const root = await fixtureRoot({
      manifestAssets: ["assets/missing-manifest.bin"],
      motionAssets: [{ id: "font", type: "font", family: "Fixture", source: { path: "assets/missing-font.woff2", mimeType: "font/woff2" } }],
      layers: [{ id: "image", type: "image", startMs: 0, durationMs: 1000, assetRef: "assets/missing-layer.png" }],
    });
    const validation = await withinWorkspace(root, async () => await validatePackageAssetReferences(await loadMotionPackage(root)));

    expect(validation).toEqual(expect.objectContaining({ ok: false, problems: [
      { path: "/manifest/assets/0", ref: "assets/missing-manifest.bin", code: "missing" },
      { path: "/motion/assets/0/source/path", ref: "assets/missing-font.woff2", code: "missing" },
      { path: "/motion/layers/0/assetRef", ref: "assets/missing-layer.png", code: "missing" },
    ] }));
  });

  it("refuses a declared symlink even when it points inside the package", async () => {
    const root = await fixtureRoot({ manifestAssets: ["assets/linked.bin"] });
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "real.bin"), "asset", "utf8");
    try {
      await symlink(join(root, "assets", "real.bin"), join(root, "assets", "linked.bin"), "file");
    } catch {
      return;
    }
    const validation = await withinWorkspace(root, async () => await validatePackageAssetReferences(await loadMotionPackage(root)));
    expect(validation.problems).toEqual([{ path: "/manifest/assets/0", ref: "assets/linked.bin", code: "symlink" }]);
  });

  it("refuses a reference whose intermediate directory escapes through a symlink", async () => {
    const root = await fixtureRoot({ manifestAssets: ["assets/linked/outside.bin"] });
    const outside = await mkdtemp(join(tmpdir(), "shellx-motion-package-refs-outside-"));
    await mkdir(join(root, "assets"));
    await writeFile(join(outside, "outside.bin"), "asset", "utf8");
    try {
      await symlink(outside, join(root, "assets", "linked"), "dir");
    } catch {
      await rm(outside, { recursive: true, force: true });
      return;
    }
    try {
      const validation = await withinWorkspace(root, async () => await validatePackageAssetReferences(await loadMotionPackage(root)));
      expect(validation.problems).toEqual([{ path: "/manifest/assets/0", ref: "assets/linked/outside.bin", code: "outside_package" }]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

async function fixtureRoot(input: { manifestAssets?: string[]; motionAssets?: unknown[]; layers?: unknown[] } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-refs-"));
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1", id: "pkg_asset_refs", name: "Asset refs", motion: "motion.json",
    assets: input.manifestAssets ?? [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] },
  })}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1", id: "motion_asset_refs", name: "Asset refs", durationMs: 1_000, fps: 30,
    width: 100, height: 100, layers: input.layers ?? [], assets: input.motionAssets ?? [], provenance: { sourceApp: "test", createdBy: "test" },
  })}\n`);
  return root;
}

async function withinWorkspace<T>(root: string, action: () => Promise<T>): Promise<T> {
  if (process.platform === "win32") return await action();
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), action);
}
