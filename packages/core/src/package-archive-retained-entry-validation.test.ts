import { cp, lstat, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { loadMotionPackage } from "./package";
import { extractMotionPackageArchive, writeMotionPackageArchive } from "./package-archive";

const fixtureRoot = fileURLToPath(new URL("../../../fixtures/packages/lower-third", import.meta.url));
const editableFixtureRoot = fileURLToPath(new URL("../../../fixtures/packages/editable-lower-third", import.meta.url));

describe("package archive retained-entry validation", () => {
  it("binds the receipt identity to the retained archive manifest after a source replacement", async () => {
    const tempRoot = await testRoot("shellx-motion-package-archive-identity-race-");
    const packageRoot = join(tempRoot, "package");
    const replacementRoot = join(tempRoot, "replacement");
    const displacedRoot = join(tempRoot, "displaced");
    const archivePath = join(tempRoot, "exports", "replaced.shellxmotion");
    const extractedRoot = join(tempRoot, "extracted");
    try {
      await cp(fixtureRoot, packageRoot, { recursive: true });
      await cp(fixtureRoot, replacementRoot, { recursive: true });
      const replacementManifest = JSON.parse(await readFile(join(replacementRoot, "manifest.json"), "utf8"));
      replacementManifest.id = "pkg_replacement";
      await writeFile(join(replacementRoot, "manifest.json"), `${JSON.stringify(replacementManifest, null, 2)}\n`, "utf8");

      const workspace = await createTrustedWorkspaceAnchor(tempRoot);
      const { archived, extracted } = await withTrustedWorkspaceAnchor(workspace, async () => {
        await expect(loadMotionPackage(replacementRoot)).resolves.toMatchObject({ manifest: { id: "pkg_replacement" } });
        const archived = await writeMotionPackageArchive({ packageRoot, archivePath, createdAt: "2026-08-29T08:00:00.000Z" }, {
          afterPackageLoaded: async () => await replacePackageRoot(packageRoot, replacementRoot, displacedRoot)
        });
        const extracted = await extractMotionPackageArchive({ archivePath, packageRoot: extractedRoot });
        return { archived, extracted };
      });
      const receipt = JSON.parse(await readFile(archived.receiptPath, "utf8"));

      expect(archived.packageId).toBe("pkg_replacement");
      expect(archived.receipt.packageId).toBe("pkg_replacement");
      expect(extracted.packageId).toBe("pkg_replacement");
      expect(receipt.packageId).toBe("pkg_replacement");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("refuses a source replacement whose retained manifest loses its Motion document", async () => {
    const tempRoot = await testRoot("shellx-motion-package-archive-retained-package-race-");
    const packageRoot = join(tempRoot, "package");
    const replacementRoot = join(tempRoot, "replacement");
    const displacedRoot = join(tempRoot, "displaced");
    const archivePath = join(tempRoot, "exports", "invalid-replacement.shellxmotion");
    try {
      await cp(fixtureRoot, packageRoot, { recursive: true });
      await cp(fixtureRoot, replacementRoot, { recursive: true });
      await unlink(join(replacementRoot, "motion.json"));

      await expectArchiveRefusal(packageRoot, replacementRoot, displacedRoot, archivePath, tempRoot, "Motion document is absent from retained package archive: motion.json");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("refuses a source replacement whose retained manifest loses its declared template", async () => {
    const tempRoot = await testRoot("shellx-motion-package-archive-retained-template-race-");
    const packageRoot = join(tempRoot, "package");
    const replacementRoot = join(tempRoot, "replacement");
    const displacedRoot = join(tempRoot, "displaced");
    const archivePath = join(tempRoot, "exports", "invalid-template-replacement.shellxmotion");
    try {
      await cp(editableFixtureRoot, packageRoot, { recursive: true });
      await cp(editableFixtureRoot, replacementRoot, { recursive: true });
      await unlink(join(replacementRoot, "template.json"));

      await expectArchiveRefusal(packageRoot, replacementRoot, displacedRoot, archivePath, tempRoot, "Template document is absent from retained package archive: template.json");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

async function expectArchiveRefusal(
  packageRoot: string,
  replacementRoot: string,
  displacedRoot: string,
  archivePath: string,
  workspaceRoot: string,
  message: string
): Promise<void> {
  const workspace = await createTrustedWorkspaceAnchor(workspaceRoot);
  await withTrustedWorkspaceAnchor(workspace, async () => {
    await expect(writeMotionPackageArchive({ packageRoot, archivePath }, {
      afterPackageLoaded: async () => await replacePackageRoot(packageRoot, replacementRoot, displacedRoot)
    })).rejects.toThrow(message);
  });
  await expect(lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(`${archivePath}.receipt.json`)).rejects.toMatchObject({ code: "ENOENT" });
}

async function replacePackageRoot(packageRoot: string, replacementRoot: string, displacedRoot: string): Promise<void> {
  await rename(packageRoot, displacedRoot);
  await rename(replacementRoot, packageRoot);
}

async function testRoot(prefix: string): Promise<string> {
  return await mkdtemp(join(process.platform === "win32" ? process.cwd() : tmpdir(), prefix));
}
