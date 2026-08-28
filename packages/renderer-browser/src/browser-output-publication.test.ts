import { lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDerivedOutputPublication } from "@shellx-motion/core";
import { publishBrowserOutput } from "./browser-output-publication.js";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

// Directory publication identity and symbolic-link semantics are qualified only on the explicit
// Node 24 qualified Linux GPU-host fixture, alongside Core's final-output publication proof.
const publicationFixtureRoot = process.env.MOTION_QUALIFIED_LINUX_GPU_PUBLICATION_ROOT;
const describeQualifiedLinuxGpuPublication = process.env.MOTION_QUALIFIED_LINUX_GPU_PUBLICATION_FIXTURE === "1" && process.versions.node.startsWith("24.") && publicationFixtureRoot ? describe : describe.skip;

async function scratch(): Promise<string> {
  const root = publicationFixtureRoot
    ? await mkdtemp(join(resolve(publicationFixtureRoot), "browser-output-publication-"))
    : await mkdtemp(join(tmpdir(), "browser-output-publication-"));
  roots.push(root);
  return root;
}

describeQualifiedLinuxGpuPublication("browser private directory output publication", () => {
  it("admits only a strict private-stage child, verifies its bytes, and refuses symlinked descendants", async ({ skip }) => {
    const root = await scratch();
    const publication = await acquireDerivedOutputPublication({ outputPath: join(root, "capture"), kind: "directory" });
    const framePath = join(publication.stagingPath, "samples", "frame.png");

    await expect(publishBrowserOutput(publication.stagingPath, Buffer.from("not a child"), publication))
      .rejects.toThrow(/strict child/i);
    await expect(publishBrowserOutput(join(root, "outside.png"), Buffer.from("outside"), publication))
      .rejects.toThrow(/strict child/i);
    await expect(publishBrowserOutput(framePath, Buffer.from("verified frame"), publication))
      .resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(readFile(framePath, "utf8")).resolves.toBe("verified frame");
    await expect(publication.verifyDirectory(["samples/frame.png"])).resolves.toMatchObject({ entryCount: 1 });

    const outside = await scratch();
    try {
      await symlink(outside, join(publication.stagingPath, "redirect"), "dir");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        skip("The standard Windows test account cannot create directory symbolic links.");
        return;
      }
      throw error;
    }
    await expect(publishBrowserOutput(join(publication.stagingPath, "redirect", "escape.png"), Buffer.from("escape"), publication))
      .rejects.toThrow(/symlinked|canonical/i);
    await expect(readFile(join(outside, "escape.png"))).rejects.toMatchObject({ code: "ENOENT" });

    await publication.abort();
  });

  it("keeps primary file output exact and admits HTML only below its Core-created companion root", async () => {
    const root = await scratch();
    const publication = await acquireDerivedOutputPublication({ outputPath: join(root, "preview.png"), kind: "file" });

    await expect(publishBrowserOutput(join(root, "other.png"), Buffer.from("wrong leaf"), publication))
      .rejects.toThrow(/Core-created companion root/i);
    await expect(publishBrowserOutput(publication.stagingPath, Buffer.from("exact leaf"), publication))
      .resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(publication.verifyFile()).resolves.toMatchObject({ byteLength: Buffer.byteLength("exact leaf") });
    const companionRoot = await publication.createPrivateCompanionDirectory("browser-capture-html");
    const artifactPath = join(companionRoot, "prepared.html");
    await expect(publishBrowserOutput(artifactPath, Buffer.from("<html>private companion</html>"), publication))
      .resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(readFile(artifactPath, "utf8")).resolves.toBe("<html>private companion</html>");
    await publication.abort();
    await expect(lstat(companionRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
