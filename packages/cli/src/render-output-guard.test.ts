/**
 * CLI regression suite for destructive-output ownership and replacement behavior on the
 * `render` encode lane: the frame-output ownership invariant (`--frames-dir` recursively deleted a caller's files), the directory-entry ownership invariant (a
 * DIRECTORY named like a frame was deleted too) and the file-output ownership invariant (an existing `--out` FILE was silently
 * overwritten while `--out` as a directory was guarded).
 *
 * Every case is a falsifier first and a regression test second: it writes real bytes to disk, runs
 * the real CLI entry point, and asserts the bytes are still there. The matching "no wall" cases are
 * just as load-bearing — a guard that refuses the normal re-render would be reverted within a day,
 * so the suite pins both halves.
 *
 * Lives in its own file rather than in `main.test.ts` to keep that file under the module-size gate.
 *
 * Dependencies: `./main` (`runCli`), `./main.fixtures-packages`, node fs/os/path built-ins.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeTinyNativePackage } from "./main.fixtures-packages";
import { runCli as runCliRaw, type RunCliOptions } from "./main";

const runCli = (argv: string[], options: RunCliOptions = {}) => runCliRaw(argv, { trustedLocalTier: true, ...options });

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A stub FFmpeg that answers the health/encoder probes and writes a plausible MP4. */
const ffmpegRunner: RunCliOptions["ffmpegRunner"] = async (command) => {
  if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
  if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
  const outputPath = command.args.at(-1) as string;
  await writeFile(outputPath, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisomrendered", "ascii")]));
  return { exitCode: 0, stdout: "", stderr: "" };
};

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shellx-motion-render-guard-"));
  created.push(dir);
  return dir;
}

/** `render --keep-frames` over the tiny native package, into `outputPath`. */
function renderArgs(packageRoot: string, outputPath: string, framesDir?: string, force = false): string[] {
  return [
    "render", packageRoot, "--lane", "ffmpeg", "--frame-lane", "native", "--preset", "mp4-h264",
    "--out", outputPath, "--keep-frames",
    ...(framesDir ? ["--frames-dir", framesDir] : []),
    ...(force ? ["--force"] : [])
  ];
}

describe("render encode lane output ownership", () => {
  it("never deletes a caller's files under --frames-dir, and says why", async () => {
    // Reproduced before the fix: `--frames-dir $F` with `$F/<packageId>/thesis.txt` present left the
    // file GONE, because the encode lane opened with an unguarded
    // `rm(framesDir, { recursive: true, force: true })` justified by a comment claiming Motion owned
    // the path. `--frames-dir` is chosen by the caller; the comment was the only thing guarding it.
    const packageRoot = await writeTinyNativePackage();
    const root = await workspace();
    created.push(packageRoot);
    const framesRoot = join(root, "my-frames");
    await mkdir(join(framesRoot, "pkg_cli_ffmpeg_sequence"), { recursive: true, mode: 0o700 });
    await writeFile(join(framesRoot, "pkg_cli_ffmpeg_sequence", "thesis.txt"), "MY THESIS", "utf8");

    const result = await runCli(renderArgs(packageRoot, join(root, "out.mp4"), framesRoot), { ffmpegRunner });

    expect(result).toMatchObject({
      ok: false,
      command: "render",
      lane: "ffmpeg",
      error: { code: "output_dir_not_empty", path: join(framesRoot, "pkg_cli_ffmpeg_sequence") }
    });
    expect(await readFile(join(framesRoot, "pkg_cli_ffmpeg_sequence", "thesis.txt"), "utf8")).toBe("MY THESIS");
  });

  it("never recursively deletes a directory named like a frame", async () => {
    const packageRoot = await writeTinyNativePackage();
    const root = await workspace();
    created.push(packageRoot);
    const framesRoot = join(root, "my-frames");
    await mkdir(join(framesRoot, "pkg_cli_ffmpeg_sequence", "000001.png"), { recursive: true, mode: 0o700 });
    await writeFile(join(framesRoot, "pkg_cli_ffmpeg_sequence", "000001.png", "secret.txt"), "user data", "utf8");

    const result = await runCli(renderArgs(packageRoot, join(root, "out.mp4"), framesRoot), { ffmpegRunner });

    expect(result).toMatchObject({ ok: false, error: { code: "output_dir_not_empty" } });
    expect(await readFile(join(framesRoot, "pkg_cli_ffmpeg_sequence", "000001.png", "secret.txt"), "utf8")).toBe("user data");
  });

  it("does not infer ownership from Motion-shaped files in a caller's --frames-dir", async () => {
    const packageRoot = await writeTinyNativePackage();
    const root = await workspace();
    created.push(packageRoot);
    const framesRoot = join(root, "my-frames");

    const first = await runCli(renderArgs(packageRoot, join(root, "a.mp4"), framesRoot), { ffmpegRunner });
    const framePath = join(framesRoot, "pkg_cli_ffmpeg_sequence", "000001.png");
    const frameAfterFirst = await readFile(framePath);
    const second = await runCli(renderArgs(packageRoot, join(root, "b.mp4"), framesRoot), { ffmpegRunner });

    expect(first).toMatchObject({ ok: true, command: "render", lane: "ffmpeg" });
    expect(second).toMatchObject({ ok: false, command: "render", lane: "ffmpeg", error: { code: "output_dir_not_empty" } });
    expect(await readFile(framePath)).toEqual(frameAfterFirst);
  });

  it("publishes distinct receipt sidecars when one package renders to two new final outputs", async () => {
    const packageRoot = await writeTinyNativePackage();
    const root = await workspace();
    created.push(packageRoot);
    const firstOutput = join(root, "take-one.mp4");
    const secondOutput = join(root, "take-two.mp4");

    const first = await runCli(renderArgs(packageRoot, firstOutput, join(root, "frames-one")), { ffmpegRunner });
    const second = await runCli(renderArgs(packageRoot, secondOutput, join(root, "frames-two")), { ffmpegRunner });

    expect(first).toMatchObject({
      ok: true,
      outputPath: firstOutput,
      receiptPath: join(root, "take-one.mp4.receipt.json")
    });
    expect(second).toMatchObject({
      ok: true,
      outputPath: secondOutput,
      receiptPath: join(root, "take-two.mp4.receipt.json")
    });
    await expect(readFile(join(root, "take-one.mp4.receipt.json"), "utf8")).resolves.toContain("take-one.mp4");
    await expect(readFile(join(root, "take-two.mp4.receipt.json"), "utf8")).resolves.toContain("take-two.mp4");
  });

  it("wipes a caller's --frames-dir only when --force is passed", async () => {
    const packageRoot = await writeTinyNativePackage();
    const root = await workspace();
    created.push(packageRoot);
    const framesRoot = join(root, "my-frames");
    await mkdir(join(framesRoot, "pkg_cli_ffmpeg_sequence"), { recursive: true, mode: 0o700 });
    await writeFile(join(framesRoot, "pkg_cli_ffmpeg_sequence", "notes.txt"), "user data", "utf8");

    const result = await runCli(renderArgs(packageRoot, join(root, "out.mp4"), framesRoot, true), { ffmpegRunner });

    expect(result).toMatchObject({ ok: true, command: "render", lane: "ffmpeg" });
    await expect(readFile(join(framesRoot, "pkg_cli_ffmpeg_sequence", "notes.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses and preserves an existing --out file before drawing frames", async () => {
    const packageRoot = await writeTinyNativePackage();
    const root = await workspace();
    created.push(packageRoot);
    const outputPath = join(root, "final.mp4");
    await writeFile(outputPath, "MY FINAL CUT", "utf8");

    const result = await runCli(renderArgs(packageRoot, outputPath, join(root, "frames")), { ffmpegRunner });

    expect(result).toMatchObject({
      ok: false,
      command: "render",
      lane: "ffmpeg",
      error: {
        code: "derived_output_exists",
        artifact: "media_output",
        path: outputPath,
        message: `Render media output already exists at ${outputPath}; it was preserved rather than overwritten.`
      }
    });
    expect(await readFile(outputPath, "utf8")).toBe("MY FINAL CUT");
    // The refusal lands before any frame is drawn, so a wasted render never happens either.
    await expect(readdir(join(root, "frames"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("names a colliding receipt sidecar without blaming a new media output", async () => {
    const packageRoot = await writeTinyNativePackage();
    const root = await workspace();
    created.push(packageRoot);
    const outputPath = join(root, "new-take.mp4");
    const receiptPath = `${outputPath}.receipt.json`;
    await writeFile(receiptPath, "RECEIPT FROM ANOTHER TAKE", "utf8");

    const result = await runCli(renderArgs(packageRoot, outputPath, join(root, "frames")), { ffmpegRunner });

    expect(result).toMatchObject({
      ok: false,
      command: "render",
      lane: "ffmpeg",
      outputPath,
      receiptPath,
      error: {
        code: "derived_output_exists",
        artifact: "receipt_sidecar",
        path: receiptPath,
        message: `Render receipt sidecar already exists at ${receiptPath}; it was preserved rather than overwritten.`
      }
    });
    await expect(readFile(receiptPath, "utf8")).resolves.toBe("RECEIPT FROM ANOTHER TAKE");
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("overwrites an existing --out FILE when --force is passed", async () => {
    const packageRoot = await writeTinyNativePackage();
    const root = await workspace();
    created.push(packageRoot);
    const outputPath = join(root, "final.mp4");
    await writeFile(outputPath, "MY FINAL CUT", "utf8");

    const result = await runCli(renderArgs(packageRoot, outputPath, join(root, "frames"), true), { ffmpegRunner });

    expect(result).toMatchObject({ ok: true, command: "render", lane: "ffmpeg" });
    expect((await readFile(outputPath)).subarray(4, 8).toString("ascii")).toBe("ftyp");
  });

  it("treats an embedder's scratch root as caller-supplied and preserves its frames", async () => {
    const packageRoot = await writeTinyNativePackage();
    const root = await workspace();
    created.push(packageRoot);
    const scratchRoot = join(root, "scratch");

    const first = await runCli(renderArgs(packageRoot, join(root, "a.mp4")), { ffmpegRunner, scratchRoot });
    const framePath = join(scratchRoot, "pkg_cli_ffmpeg_sequence", "000001.png");
    const frameAfterFirst = await readFile(framePath);
    const second = await runCli(renderArgs(packageRoot, join(root, "b.mp4")), { ffmpegRunner, scratchRoot });

    expect(first).toMatchObject({ ok: true, lane: "ffmpeg" });
    expect(second).toMatchObject({ ok: false, lane: "ffmpeg", error: { code: "output_dir_not_empty" } });
    expect(await readFile(framePath)).toEqual(frameAfterFirst);
  });
});
