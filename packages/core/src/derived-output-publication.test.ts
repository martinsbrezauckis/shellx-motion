import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDerivedOutputPublication, DerivedOutputPublicationError } from "./derived-output-publication";
import { isCoreDerivedOutputPublication } from "./derived-output-publication-authenticity";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

const publicationFixtureRoot = process.env.MOTION_QUALIFIED_LINUX_GPU_PUBLICATION_ROOT;
const describeQualifiedLinuxGpuPublication = process.env.MOTION_QUALIFIED_LINUX_GPU_PUBLICATION_FIXTURE === "1" && process.versions.node.startsWith("24.") && publicationFixtureRoot ? describe : describe.skip;

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(resolve(publicationFixtureRoot!), "derived-output-publication-"));
  roots.push(root);
  return root;
}

async function trustedScratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "derived-output-publication-unit-"));
  roots.push(root);
  return root;
}

async function withinTrustedScratch<T>(root: string, action: () => Promise<T>): Promise<T> {
  if (process.platform === "win32") return await action();
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), action);
}

describe("derived renderer private materialization", () => {
  it.skipIf(process.platform !== "linux")("atomically replaces an admitted empty directory and preserves it on abort", async () => {
    const root = await trustedScratch();
    await withinTrustedScratch(root, async () => {
      const publishedPath = join(root, "published-sequence");
      await mkdir(publishedPath, { mode: 0o700 });
      const publication = await acquireDerivedOutputPublication({
        outputPath: publishedPath,
        kind: "directory",
        replaceEmptyDirectory: true
      });
      await writeFile(join(publication.stagingPath, "000001.png"), "frame", "utf8");
      const evidence = await publication.verifyDirectory(["000001.png"]);
      await publication.publishDirectory(evidence, ["000001.png"]);
      expect(await readFile(join(publishedPath, "000001.png"), "utf8")).toBe("frame");

      const abortedPath = join(root, "aborted-sequence");
      await mkdir(abortedPath, { mode: 0o700 });
      const aborted = await acquireDerivedOutputPublication({
        outputPath: abortedPath,
        kind: "directory",
        replaceEmptyDirectory: true
      });
      await aborted.abort();
      expect((await lstat(abortedPath)).isDirectory()).toBe(true);
    });
  });

  it("never treats a non-empty directory as an admitted placeholder", async () => {
    const root = await trustedScratch();
    await withinTrustedScratch(root, async () => {
      const outputPath = join(root, "occupied-sequence");
      await mkdir(outputPath, { mode: 0o700 });
      await writeFile(join(outputPath, "keep.txt"), "caller data", "utf8");
      await expect(acquireDerivedOutputPublication({
        outputPath,
        kind: "directory",
        replaceEmptyDirectory: true
      })).rejects.toMatchObject({ code: "derived_output_exists" });
      expect(await readFile(join(outputPath, "keep.txt"), "utf8")).toBe("caller data");
    });
  });

  it("refuses a substituted stage before descriptor truncation and leaves the replacement intact", async () => {
    const root = await trustedScratch();
    await withinTrustedScratch(root, async () => {
      const publication = await acquireDerivedOutputPublication({ outputPath: join(root, "renderer-stage.png"), kind: "file" });
      await rm(publication.stagingPath);
      await writeFile(publication.stagingPath, "competitor bytes", "utf8");

      await expect(publication.writePrivateFile(Buffer.from("renderer bytes"), {
        label: "Browser private file output",
        maxBytes: 1024
      })).rejects.toMatchObject({ code: "derived_output_stage_invalid" });
      expect(await readFile(publication.stagingPath, "utf8")).toBe("competitor bytes");
      await publication.abort();
    });
  });

  it("permits one Core-created private HTML companion and removes it with the exact reservation", async () => {
    const root = await trustedScratch();
    await withinTrustedScratch(root, async () => {
      const publication = await acquireDerivedOutputPublication({ outputPath: join(root, "preview.png"), kind: "file" });
      await publication.writePrivateFile(Buffer.from("primary"), { label: "Browser private file output", maxBytes: 1024 });
      const companionRoot = await publication.createPrivateCompanionDirectory("browser-capture-html");
      const artifactPath = join(companionRoot, "capture.html");
      await publication.writePrivateCompanionFile(artifactPath, Buffer.from("<html>capture</html>"), {
        label: "Browser private file companion output", maxBytes: 1024
      });

      expect(await readFile(artifactPath, "utf8")).toBe("<html>capture</html>");
      await publication.abort();
      await expect(lstat(companionRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

describeQualifiedLinuxGpuPublication("derived final-output publication", () => {
  it("holds one output lock, readbacks staging, and publishes a hard-link identity without clobber", async () => {
    const root = await scratch();
    const outputPath = join(root, "final.mp4");
    const first = await acquireDerivedOutputPublication({ outputPath, kind: "file" });
    expect(isCoreDerivedOutputPublication(first)).toBe(true);
    await expect(acquireDerivedOutputPublication({ outputPath, kind: "file" })).rejects.toMatchObject({ code: "derived_output_busy" });

    await writeFile(first.stagingPath, "verified final", "utf8");
    const privateRead = await first.readPrivateFile({ label: "Private renderer output", maxBytes: 1024 });
    expect(privateRead.bytes.toString("utf8")).toBe("verified final");
    expect(privateRead).toMatchObject({ byteLength: 14, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    const evidence = await first.verifyFile();
    await first.publishFile(evidence);

    expect(await readFile(outputPath, "utf8")).toBe("verified final");
    await expect(lstat(first.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(acquireDerivedOutputPublication({ outputPath, kind: "file" })).rejects.toMatchObject({ code: "derived_output_exists" });
  });

  it("retains and revokes only its exact published file identity", async () => {
    const root = await scratch();
    const outputPath = join(root, "receipt.json");
    const publication = await acquireDerivedOutputPublication({ outputPath, kind: "file" });
    await writeFile(publication.stagingPath, "paired receipt", "utf8");
    const evidence = await publication.verifyFile();

    await publication.publishFile(evidence, { retainReservation: true });
    await expect(publication.verifyPublishedFile(evidence)).resolves.toEqual(evidence);
    await publication.revokePublishedFile(evidence);

    await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(publication.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never revokes a retargeted published name", async () => {
    const root = await scratch();
    const outputPath = join(root, "receipt.json");
    const publication = await acquireDerivedOutputPublication({ outputPath, kind: "file" });
    await writeFile(publication.stagingPath, "paired receipt", "utf8");
    const evidence = await publication.verifyFile();

    await publication.publishFile(evidence, { retainReservation: true });
    await rm(outputPath);
    await writeFile(outputPath, "competitor receipt", "utf8");

    await expect(publication.revokePublishedFile(evidence)).rejects.toMatchObject({ code: "derived_output_stage_invalid" });
    expect(await readFile(outputPath, "utf8")).toBe("competitor receipt");
  });

  it("refuses existing regular files, directory targets, and symlinks without deleting their bytes", async () => {
    const root = await scratch();
    const file = join(root, "keep.mp4");
    const directory = join(root, "keep-dir.mp4");
    const target = join(root, "real.mp4");
    const linked = join(root, "linked.mp4");
    await writeFile(file, "preserve file", "utf8");
    await mkdir(directory);
    await writeFile(target, "preserve target", "utf8");
    await symlink(target, linked);

    for (const outputPath of [file, directory, linked]) {
      await expect(acquireDerivedOutputPublication({ outputPath, kind: "file" })).rejects.toMatchObject({ code: "derived_output_exists" });
    }
    expect(await readFile(file, "utf8")).toBe("preserve file");
    expect(await readFile(target, "utf8")).toBe("preserve target");
    expect((await lstat(directory)).isDirectory()).toBe(true);
  });

  it("permits explicit file force only after verified staging and never replaces a directory", async () => {
    const root = await scratch();
    const outputPath = join(root, "replace.mp4");
    await writeFile(outputPath, "old final", "utf8");
    const publication = await acquireDerivedOutputPublication({ outputPath, kind: "file", force: true });
    await writeFile(publication.stagingPath, "new final", "utf8");
    await publication.publishFile(await publication.verifyFile());
    expect(await readFile(outputPath, "utf8")).toBe("new final");

    const directoryTarget = join(root, "directory.mp4");
    await mkdir(directoryTarget);
    await expect(acquireDerivedOutputPublication({ outputPath: directoryTarget, kind: "file", force: true })).rejects.toMatchObject({ code: "derived_output_exists" });
  });

  it("rejects swapped staging and cleans a failed private stage so the target can be retried", async () => {
    const root = await scratch();
    const outputPath = join(root, "retry.mp4");
    const publication = await acquireDerivedOutputPublication({ outputPath, kind: "file" });
    await writeFile(publication.stagingPath, "readback bytes", "utf8");
    const evidence = await publication.verifyFile();
    await writeFile(publication.stagingPath, "swapped bytes", "utf8");
    await expect(publication.publishFile(evidence)).rejects.toMatchObject({ code: "derived_output_stage_invalid" });
    await publication.abort();
    await expect(lstat(publication.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    const retry = await acquireDerivedOutputPublication({ outputPath, kind: "file" });
    await retry.abort();
  });

  it("keeps an image sequence private until its exact closed inventory has been hashed and published", async () => {
    const root = await scratch();
    const outputPath = join(root, "sequence");
    const publication = await acquireDerivedOutputPublication({ outputPath, kind: "directory" });
    await writeFile(join(publication.stagingPath, "000001.png"), "frame one", "utf8");
    await writeFile(join(publication.stagingPath, "000002.png"), "frame two", "utf8");
    const evidence = await publication.verifyDirectory(["000001.png", "000002.png"]);
    await publication.publishDirectory(evidence, ["000001.png", "000002.png"]);
    expect(await readFile(join(outputPath, "000002.png"), "utf8")).toBe("frame two");

    const unknown = await acquireDerivedOutputPublication({ outputPath: join(root, "unknown"), kind: "directory" });
    await writeFile(join(unknown.stagingPath, "000001.png"), "frame", "utf8");
    await writeFile(join(unknown.stagingPath, "user-note.txt"), "do not publish", "utf8");
    await expect(unknown.verifyDirectory(["000001.png"])).rejects.toMatchObject({ code: "derived_output_stage_invalid" });
    await unknown.abort();
  });

  it("publishes a closed nested directory inventory with normalized relative paths", async () => {
    const root = await scratch();
    const outputPath = join(root, "nested");
    const publication = await acquireDerivedOutputPublication({ outputPath, kind: "directory" });
    await mkdir(join(publication.stagingPath, "assets", "frames"), { recursive: true });
    await mkdir(join(publication.stagingPath, "receipts"), { recursive: true });
    await writeFile(join(publication.stagingPath, "assets", "frames", "000001.png"), "frame one", "utf8");
    await writeFile(join(publication.stagingPath, "receipts", "render.json"), "{\"ok\":true}\n", "utf8");
    const inventory = ["assets/frames/000001.png", "receipts/render.json"];

    const evidence = await publication.verifyDirectory(inventory);
    await publication.publishDirectory(evidence, inventory);

    expect(await readFile(join(outputPath, "assets", "frames", "000001.png"), "utf8")).toBe("frame one");
    expect(await readFile(join(outputPath, "receipts", "render.json"), "utf8")).toBe("{\"ok\":true}\n");
  });

  it("refuses a symlinked output parent before it stages outside the declared root", async ({ skip }) => {
    const root = await scratch();
    const outside = await scratch();
    const linkedParent = join(root, "linked-parent");
    try {
      await symlink(outside, linkedParent, "dir");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        skip("The standard Windows test account cannot create directory symbolic links.");
        return;
      }
      throw error;
    }
    await expect(acquireDerivedOutputPublication({ outputPath: join(linkedParent, "final.mp4"), kind: "file" }))
      .rejects.toMatchObject({ code: "derived_output_unsafe_parent" } satisfies Partial<DerivedOutputPublicationError>);
    await expect(lstat(join(outside, "final.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a POSIX shared-writable parent before it creates a reservation or stage", async ({ skip }) => {
    if (process.platform === "win32") {
      skip("Windows ACL authority is not represented by Node uid/mode fields.");
      return;
    }
    const root = await scratch();
    const sharedParent = join(root, "shared");
    await mkdir(sharedParent, { mode: 0o700 });
    await chmod(sharedParent, 0o777);

    await expect(acquireDerivedOutputPublication({ outputPath: join(sharedParent, "final.mp4"), kind: "file" }))
      .rejects.toMatchObject({ code: "derived_output_unsafe_parent" } satisfies Partial<DerivedOutputPublicationError>);
    expect(await lstat(sharedParent)).toMatchObject({ mode: expect.any(Number) });
    await expect(lstat(join(sharedParent, "final.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds the private file stage identity so a same-byte substitute cannot publish", async () => {
    const root = await scratch();
    const outputPath = join(root, "stage-substitution.mp4");
    const publication = await acquireDerivedOutputPublication({ outputPath, kind: "file" });
    await writeFile(publication.stagingPath, "verified final", "utf8");
    const evidence = await publication.verifyFile();
    await rm(publication.stagingPath);
    await writeFile(publication.stagingPath, "verified final", "utf8");

    await expect(publication.publishFile(evidence)).rejects.toMatchObject({ code: "derived_output_stage_invalid" });
    await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(publication.stagingPath, "utf8")).toBe("verified final");
  });

  it("refuses a substituted renderer stage before descriptor truncation can clobber the replacement", async () => {
    const root = await scratch();
    const publication = await acquireDerivedOutputPublication({ outputPath: join(root, "renderer-stage.png"), kind: "file" });
    await rm(publication.stagingPath);
    await writeFile(publication.stagingPath, "competitor bytes", "utf8");

    await expect(publication.writePrivateFile(Buffer.from("renderer bytes"), {
      label: "Browser private file output",
      maxBytes: 1024
    })).rejects.toMatchObject({ code: "derived_output_stage_invalid" });
    expect(await readFile(publication.stagingPath, "utf8")).toBe("competitor bytes");
    await publication.abort();
  });

  it("refuses an ancestor retarget before it reads or publishes the old private stage", async () => {
    const root = await scratch();
    const parent = join(root, "parent");
    const outputPath = join(parent, "retargeted.mp4");
    const publication = await acquireDerivedOutputPublication({ outputPath, kind: "file" });
    const stageRelativePath = relative(parent, publication.stagingPath);
    await writeFile(publication.stagingPath, "verified final", "utf8");
    const evidence = await publication.verifyFile();
    const movedParent = join(root, "parent-moved");
    await rename(parent, movedParent);
    await mkdir(parent, { mode: 0o700 });
    await writeFile(join(parent, "retargeted.mp4"), "competitor final", "utf8");

    await expect(publication.publishFile(evidence)).rejects.toMatchObject({ code: "derived_output_unsafe_parent" });
    expect(await readFile(join(parent, "retargeted.mp4"), "utf8")).toBe("competitor final");
    expect(await readFile(join(movedParent, stageRelativePath), "utf8")).toBe("verified final");
  });

  it("preserves a competitor that replaced the forced destination after acquisition", async () => {
    const root = await scratch();
    const outputPath = join(root, "forced-replacement.mp4");
    await writeFile(outputPath, "old final", "utf8");
    const publication = await acquireDerivedOutputPublication({ outputPath, kind: "file", force: true });
    await writeFile(publication.stagingPath, "new final", "utf8");
    const evidence = await publication.verifyFile();
    await rm(outputPath);
    await writeFile(outputPath, "competitor final", "utf8");

    await expect(publication.publishFile(evidence)).rejects.toMatchObject({ code: "derived_output_exists" });
    expect(await readFile(outputPath, "utf8")).toBe("competitor final");
  });

  it("leaves a substituted private stage intact instead of deleting a competitor during abort", async () => {
    const root = await scratch();
    const publication = await acquireDerivedOutputPublication({ outputPath: join(root, "abort-substitution.mp4"), kind: "file" });
    await rm(publication.stagingPath);
    await writeFile(publication.stagingPath, "competitor bytes", "utf8");

    await publication.abort();

    expect(await readFile(publication.stagingPath, "utf8")).toBe("competitor bytes");
  });
});
