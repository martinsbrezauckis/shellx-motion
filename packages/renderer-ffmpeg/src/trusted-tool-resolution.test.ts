import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { expect, it } from "vitest";
import { probeMotionTool, resolveMotionToolLocation } from "./index";

it("ignores relative PATH entries and refuses relative FFmpeg overrides", async () => {
  const toolRoot = await mkdtemp(join(tmpdir(), "shellx-motion-trusted-ffmpeg-"));
  const executable = join(toolRoot, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  await writeFile(executable, "test executable\n", "utf8");
  if (process.platform !== "win32") await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  try {
    delete process.env.LOCALAPPDATA;
    process.env.PATH = `.${delimiter}relative-tools${delimiter}${toolRoot}`;
    expect(resolveMotionToolLocation("ffmpeg")).toMatchObject({ executable: await realpath(executable), source: "path" });

    process.env.SHELLX_MOTION_FFMPEG = "./ffmpeg";
    const relativeOverride = resolveMotionToolLocation("ffmpeg");
    expect(relativeOverride.problem).toMatch(/absolute executable path/);
    expect(isAbsolute(relativeOverride.executable)).toBe(true);
  } finally {
    delete process.env.SHELLX_MOTION_FFMPEG;
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(toolRoot, { recursive: true, force: true });
  }
});

it("reports an absent default PATH tool as missing while retaining invalid overrides as broken", async () => {
  const previousPath = process.env.PATH;
  const previousOverride = process.env.SHELLX_MOTION_FFMPEG;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  try {
    delete process.env.LOCALAPPDATA;
    delete process.env.SHELLX_MOTION_FFMPEG;
    process.env.PATH = process.platform === "win32" ? String.raw`C:\shellx-motion-empty-path` : "/shellx-motion-empty-path";
    expect(resolveMotionToolLocation("ffmpeg")).toMatchObject({ source: "path" });
    expect(resolveMotionToolLocation("ffmpeg")).not.toHaveProperty("problem");
    await expect(probeMotionTool("ffmpeg", async () => {
      throw new Error("spawn ENOENT");
    })).resolves.toMatchObject({ status: "missing", source: "path" });

    process.env.SHELLX_MOTION_FFMPEG = process.platform === "win32"
      ? String.raw`C:\shellx-motion-missing\ffmpeg.exe`
      : "/shellx-motion-missing/ffmpeg";
    await expect(probeMotionTool("ffmpeg")).resolves.toMatchObject({ status: "broken", source: "override" });
  } finally {
    if (previousOverride === undefined) delete process.env.SHELLX_MOTION_FFMPEG;
    else process.env.SHELLX_MOTION_FFMPEG = previousOverride;
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
