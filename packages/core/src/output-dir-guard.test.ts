/**
 * Unit contract for the shared destructive-output guard.
 *
 * The frame-output, directory, and directory-entry ownership guard needs direct tests; previously the
 * only coverage was one connector suite — and every hole the regression found was in the part nobody
 * exercised. Each case below is a data-loss falsifier: it puts a real file on disk, runs the guard,
 * and asserts the bytes are still there.
 *
 * Dependencies: node fs/os/path built-ins, `./output-dir-guard`.
 */
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareFramesDir, prepareOutputDir, prepareOutputFile, refuseUnsafeOutputDirReuse } from "./output-dir-guard";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 8-byte PNG signature plus filler — enough for the guard's content check, as a real frame is. */
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]);

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shellx-motion-guard-"));
  tempDirs.push(dir);
  return dir;
}

describe("prepareFramesDir ownership", () => {
  it("refuses a caller-supplied directory holding a directory named like a frame", async () => {
    // The reproduced loss: the old rule tested NAMES only, so `000001.png` being a directory full of
    // someone's files was recursively deleted while the comment claimed content proved ownership.
    const root = await temp();
    const framesDir = join(root, "frames");
    await mkdir(join(framesDir, "000001.png"), { recursive: true });
    await writeFile(join(framesDir, "000001.png", "secret.txt"), "user data", "utf8");

    const result = await prepareFramesDir(framesDir, { force: false, callerSupplied: true });

    expect(result).toMatchObject({ ok: false, error: { code: "output_dir_not_empty", path: framesDir } });
    expect(await readFile(join(framesDir, "000001.png", "secret.txt"), "utf8")).toBe("user data");
  });

  it("refuses a file named like a frame whose bytes are not a PNG", async () => {
    const root = await temp();
    const framesDir = join(root, "frames");
    await mkdir(framesDir, { recursive: true });
    await writeFile(join(framesDir, "000002.png"), "my notes, saved with an unlucky name", "utf8");

    const result = await prepareFramesDir(framesDir, { force: false, callerSupplied: true });

    expect(result).toMatchObject({ ok: false, error: { code: "output_dir_not_empty" } });
    expect(await readFile(join(framesDir, "000002.png"), "utf8")).toContain("my notes");
  });

  it("refuses a symlink that resolves to a real PNG rather than following it", async ({ skip }) => {
    const root = await temp();
    const framesDir = join(root, "frames");
    await mkdir(framesDir, { recursive: true });
    await writeFile(join(root, "real.png"), PNG_BYTES);
    try {
      await symlink(join(root, "real.png"), join(framesDir, "000001.png"));
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        skip("The standard Windows test account cannot create symbolic links; covered on symlink-capable hosts.");
      }
      throw error;
    }

    const result = await prepareFramesDir(framesDir, { force: false, callerSupplied: true });

    expect(result).toMatchObject({ ok: false, error: { code: "output_dir_not_empty" } });
    expect(await readFile(join(root, "real.png"))).toEqual(PNG_BYTES);
  });

  it("wipes a directory holding only Motion's own PNG frames, so re-renders do not need --force", async () => {
    // The other half of the contract: the guard must be a rail, not a wall. A stale frame from a
    // longer previous render still has to go, or it would be encoded into this one.
    const root = await temp();
    const framesDir = join(root, "frames");
    await mkdir(framesDir, { recursive: true });
    await writeFile(join(framesDir, "000001.png"), PNG_BYTES);
    await writeFile(join(framesDir, "000009.png"), PNG_BYTES);
    // A crashed render's zero-length stub has no content to lose and must not become a wall.
    await writeFile(join(framesDir, "000010.png"), "");

    const result = await prepareFramesDir(framesDir, { force: false, callerSupplied: true });

    expect(result).toEqual({ ok: true });
    expect(await readdir(framesDir)).toEqual([]);
  });

  it("accepts an absent or empty directory without creating anything else", async () => {
    const root = await temp();
    const framesDir = join(root, "nested", "frames");

    expect(await prepareFramesDir(framesDir, { force: false, callerSupplied: true })).toEqual({ ok: true });
    expect((await lstat(framesDir)).isDirectory()).toBe(true);
    expect(await prepareFramesDir(framesDir, { force: false, callerSupplied: true })).toEqual({ ok: true });
  });

  it("wipes without evidence ONLY for Motion's own default scratch root", async () => {
    // `callerSupplied: false` is the single documented exception, and it is stated at the call site
    // rather than assumed: the CLI passes it only when neither --frames-dir nor a host scratch root
    // was supplied.
    const root = await temp();
    const scratch = join(root, ".scratch", "frames", "pkg_x");
    await mkdir(scratch, { recursive: true });
    await writeFile(join(scratch, "leftover.json"), "{}", "utf8");

    expect(await prepareFramesDir(scratch, { force: false, callerSupplied: false })).toEqual({ ok: true });
    expect(await readdir(scratch)).toEqual([]);
  });

  it("takes the guarded branch when callerSupplied is missing entirely", async () => {
    // Fail safe, not fail destructive: the type makes the flag required, but a JavaScript caller or a
    // stale build that omits it must NOT be handed the unguarded wipe.
    const root = await temp();
    const framesDir = join(root, "frames");
    await mkdir(framesDir, { recursive: true });
    await writeFile(join(framesDir, "notes.txt"), "user data", "utf8");

    const result = await prepareFramesDir(framesDir, { force: false } as never);

    expect(result).toMatchObject({ ok: false, error: { code: "output_dir_not_empty" } });
    expect(await readFile(join(framesDir, "notes.txt"), "utf8")).toBe("user data");
  });

  it("wipes a caller-supplied directory when --force is passed", async () => {
    const root = await temp();
    const framesDir = join(root, "frames");
    await mkdir(join(framesDir, "keep"), { recursive: true });
    await writeFile(join(framesDir, "keep", "notes.txt"), "user data", "utf8");

    expect(await prepareFramesDir(framesDir, { force: true, callerSupplied: true })).toEqual({ ok: true });
    expect(await readdir(framesDir)).toEqual([]);
  });

  it("refuses when the frames path exists and is not a directory", async () => {
    const root = await temp();
    const framesDir = join(root, "frames");
    await writeFile(framesDir, "user file", "utf8");

    expect(await prepareFramesDir(framesDir, { force: false, callerSupplied: true }))
      .toMatchObject({ ok: false, error: { code: "output_path_not_a_directory" } });
    expect(await readFile(framesDir, "utf8")).toBe("user file");
  });
});

describe("prepareOutputFile", () => {
  it("refuses an existing output file and deletes nothing", async () => {
    const root = await temp();
    const outputPath = join(root, "final.mp4");
    await writeFile(outputPath, "MY FINAL CUT", "utf8");

    const result = await prepareOutputFile(outputPath, { force: false });

    expect(result).toMatchObject({ ok: false, error: { code: "output_path_exists", path: outputPath } });
    expect(await readFile(outputPath, "utf8")).toBe("MY FINAL CUT");
  });

  it("accepts a free path", async () => {
    const root = await temp();
    expect(await prepareOutputFile(join(root, "final.mp4"), { force: false })).toEqual({ ok: true });
  });

  it("unlinks a symlink under --force instead of writing through it", async ({ skip }) => {
    const root = await temp();
    const target = join(root, "target.mp4");
    const outputPath = join(root, "link.mp4");
    await writeFile(target, "someone else's video", "utf8");
    try {
      await symlink(target, outputPath);
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        skip("The standard Windows test account cannot create symbolic links; covered on symlink-capable hosts.");
      }
      throw error;
    }

    expect(await prepareOutputFile(outputPath, { force: true })).toEqual({ ok: true });
    await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(target, "utf8")).toBe("someone else's video");
  });

  it("never deletes a directory to make room for a file, even with --force", async () => {
    const root = await temp();
    const outputPath = join(root, "final.mp4");
    await mkdir(outputPath, { recursive: true });
    await writeFile(join(outputPath, "inside.txt"), "user data", "utf8");

    expect(await prepareOutputFile(outputPath, { force: true }))
      .toMatchObject({ ok: false, error: { code: "output_path_exists" } });
    expect(await readFile(join(outputPath, "inside.txt"), "utf8")).toBe("user data");
  });
});

describe("refuseUnsafeOutputDirReuse", () => {
  it("reports the refusal without creating the directory it inspected", async () => {
    const root = await temp();
    const missing = join(root, "not-there");

    expect(await refuseUnsafeOutputDirReuse(missing)).toBeNull();
    await expect(lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });

    const populated = join(root, "populated");
    await mkdir(populated, { recursive: true });
    await writeFile(join(populated, "user.txt"), "user data", "utf8");
    expect(await refuseUnsafeOutputDirReuse(populated)).toMatchObject({ code: "output_dir_not_empty" });
    expect(await readFile(join(populated, "user.txt"), "utf8")).toBe("user data");
  });

  it("agrees with prepareOutputDir, which prepares what it accepts", async () => {
    const root = await temp();
    const outDir = join(root, "out");
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "user.txt"), "user data", "utf8");

    expect(await prepareOutputDir(outDir, { force: false })).toMatchObject({ ok: false, error: { code: "output_dir_not_empty" } });
    expect(await prepareOutputDir(outDir, { force: true })).toEqual({ ok: true });
    expect(await readdir(outDir)).toEqual([]);
  });
});
