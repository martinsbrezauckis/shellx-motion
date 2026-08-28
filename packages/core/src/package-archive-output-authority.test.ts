import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMotionPackage } from "./package";
import { extractMotionPackageArchive, writeMotionPackageArchive } from "./package-archive";

const fixtureRoot = resolve("../../fixtures/packages/lower-third");

describe("package archive extraction output authority", () => {
  it.skipIf(process.platform === "win32")("refuses an unsafe package parent before it stages extraction", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-archive-unsafe-output-parent-"));
    const archivePath = join(root, "package.shellxmotion");
    const unsafeParent = join(root, "unsafe");
    const packageRoot = join(unsafeParent, "package");
    try {
      await writeMotionPackageArchive({ packageRoot: fixtureRoot, archivePath });
      await mkdir(unsafeParent, { mode: 0o777 });
      await chmod(unsafeParent, 0o777);

      await expect(extractMotionPackageArchive({ archivePath, packageRoot })).rejects.toThrow(/topology is unsafe|writable/i);

      await expect(lstat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(unsafeParent)).toEqual([]);
      await expectNoPrivatePublicationState(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("refuses a receipt symbolic link without touching its target or publishing a package", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-archive-receipt-symlink-"));
    const archivePath = join(root, "package.shellxmotion");
    const packageRoot = join(root, "package");
    const receiptPath = join(root, "extract.receipt.json");
    const receiptTarget = join(root, "caller-receipt.json");
    try {
      await writeMotionPackageArchive({ packageRoot: fixtureRoot, archivePath });
      await writeFile(receiptTarget, "caller-owned receipt", "utf8");
      await symlink(receiptTarget, receiptPath, "file");

      await expect(extractMotionPackageArchive({ archivePath, packageRoot, receiptPath })).rejects.toThrow(/already exists/i);

      await expect(readFile(receiptTarget, "utf8")).resolves.toBe("caller-owned receipt");
      await expect(lstat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expectNoPrivatePublicationState(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a committed package when receipt publication loses its reserved destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-archive-receipt-retarget-"));
    const archivePath = join(root, "package.shellxmotion");
    const packageRoot = join(root, "package");
    const receiptPath = join(root, "extract.receipt.json");
    try {
      await writeMotionPackageArchive({ packageRoot: fixtureRoot, archivePath });

      await expect(extractMotionPackageArchive({ archivePath, packageRoot, receiptPath }, {
        afterPackagePublished: async () => {
          await mkdir(receiptPath, { mode: 0o700 });
          await writeFile(join(receiptPath, "caller-marker.txt"), "caller replacement", "utf8");
        }
      })).rejects.toThrow();

      await expect(loadMotionPackage(packageRoot)).resolves.toMatchObject({ manifest: { id: "pkg_lower_third" } });
      await expect(readFile(join(receiptPath, "caller-marker.txt"), "utf8")).resolves.toBe("caller replacement");
      await expectNoPrivatePublicationState(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function expectNoPrivatePublicationState(parent: string): Promise<void> {
  expect((await readdir(parent)).filter((name) => name.startsWith(".shellx-motion-stage-") || name.startsWith(".shellx-motion-final-"))).toEqual([]);
}
