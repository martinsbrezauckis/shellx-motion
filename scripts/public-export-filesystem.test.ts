import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertSafePublicExportReceipt,
  defaultPublicExportTarget,
  publicExportSourceKind,
  safePublicExportTarget
} from "./public-export-filesystem.mjs";

const roots: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "..");
const exporterPath = join(repositoryRoot, "scripts/build-public-export.mjs");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  // macOS exposes its temporary root through `/var -> /private/var`. Canonicalize the trusted
  // fixture parent so the test exercises its own target symlinks rather than that host alias.
  const root = await mkdtemp(join(await realpath(tmpdir()), "shellx-motion-public-export-paths-"));
  roots.push(root);
  const repository = join(root, "implementation");
  await mkdir(repository);
  return { root, repository };
}

describe("public export filesystem boundary", () => {
  it("derives the configured sibling only for the canonical checkout", () => {
    const canonical = resolve("/srv/shellx-motion");
    const linked = join(canonical, ".worktrees", "audit");
    const commonDirectory = join(canonical, ".git");
    expect(defaultPublicExportTarget(
      canonical,
      "shellx-motion-public-export",
      commonDirectory
    )).toBe(resolve("/srv/shellx-motion-public-export"));
    expect(() => defaultPublicExportTarget(
      linked,
      "shellx-motion-public-export",
      commonDirectory
    )).toThrow("linked worktree requires an explicit --out");
    expect(() => defaultPublicExportTarget(
      canonical,
      "shellx-motion-public-export",
      undefined
    )).toThrow("unverified checkout requires an explicit --out");
  });

  it("accepts a disjoint sibling and rejects the source, its descendants, and its ancestors", async () => {
    const { root, repository } = await fixture();
    await expect(safePublicExportTarget(repository, join(root, "public"))).resolves.toBe(join(root, "public"));
    await expect(safePublicExportTarget(repository, repository)).rejects.toThrow("disjoint");
    await expect(safePublicExportTarget(repository, join(repository, "public"))).rejects.toThrow("disjoint");
    await expect(safePublicExportTarget(repository, root)).rejects.toThrow("disjoint");
  });

  it.skipIf(process.platform === "win32")("rejects symlinked target prefixes and source entries", async () => {
    const { root, repository } = await fixture();
    const outside = join(root, "outside");
    const alias = join(root, "alias");
    await mkdir(join(outside, "public"), { recursive: true });
    await symlink(outside, alias, "dir");
    await expect(safePublicExportTarget(repository, join(alias, "public"))).rejects.toThrow("symbolic-link");

    const source = join(repository, "linked.txt");
    await writeFile(join(outside, "private.txt"), "private\n");
    await symlink(join(outside, "private.txt"), source, "file");
    await expect(publicExportSourceKind(source)).rejects.toThrow("symbolic link");
  });

  it("refuses a receipt sidecar that is not a regular file", async () => {
    const { root } = await fixture();
    const target = join(root, "public");
    const receipt = join(root, "public.EXPORT_RECEIPT.json");
    await mkdir(receipt);
    await expect(assertSafePublicExportReceipt(target)).rejects.toThrow("regular non-symlink");
  });

  it.skipIf(!existsSync(exporterPath))("wires the disjoint-target refusal into the source-only exporter before check mode", () => {
    const result = spawnSync(process.execPath, [
      exporterPath,
      "--out", join(repositoryRoot, "unsafe-export"), "--check"
    ], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be disjoint from the implementation tree");
  });

  it.skipIf(!existsSync(exporterPath))("refuses an implicit target from this linked worktree", () => {
    const commonDirectory = spawnSync("git", [
      "-C", repositoryRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"
    ], { encoding: "utf8" }).stdout.trim();
    if (resolve(commonDirectory) === join(repositoryRoot, ".git")) return;
    const result = spawnSync(process.execPath, [exporterPath, "--check"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("linked worktree requires an explicit --out");
  });
});
