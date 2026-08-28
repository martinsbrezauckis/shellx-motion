import { lstat, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishPackageArchiveOutputs } from "./package-archive-output-publication";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-archive-output-"));
  roots.push(root);
  return root;
}

describe("package archive output publication", () => {
  it("preserves a non-cooperating replacement when receipt publication fails after the archive", async () => {
    const root = await scratch();
    const archivePath = join(root, "archive.shellxmotion");
    const receiptPath = `${archivePath}.receipt.json`;

    await expect(publishPackageArchiveOutputs({
      archivePath,
      receiptPath,
      archiveBytes: Buffer.from("archive bytes", "utf8"),
      receiptJson: "{\"status\":\"passed\"}\n"
    }, {
      afterArchivePublished: async () => {
        // Model a replacement after the archive's successful link but before a former rollback's
        // lstat/unlink pair. The cleanup path must touch only its private stage and lock.
        await unlink(archivePath);
        await writeFile(archivePath, "non-cooperating replacement", "utf8");
        throw new Error("injected receipt publication failure");
      }
    })).rejects.toMatchObject({
      code: "package_archive_receipt_publish_failed",
      message: "Package archive was published, but its receipt could not be published."
    });

    await expect(readFile(archivePath, "utf8")).resolves.toBe("non-cooperating replacement");
    await expect(lstat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).filter((name) => name.startsWith(".shellx-motion-final-"))).toEqual([]);
  });
});
