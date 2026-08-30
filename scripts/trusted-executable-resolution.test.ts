import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, it } from "vitest";
import { resolveTrustedScriptExecutable } from "./trusted-executable-resolution.mjs";

it("refuses relative executable selection and returns one canonical absolute script tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-script-executable-"));
  const executable = join(root, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  try {
    await writeFile(executable, "fixture\n", "utf8");
    if (process.platform !== "win32") await chmod(executable, 0o755);
    expect(resolveTrustedScriptExecutable("ffmpeg", { env: { PATH: `.${delimiter}${root}` } })).toEqual({ executable: await realpath(executable), source: "path" });
    expect(() => resolveTrustedScriptExecutable("ffmpeg", { override: "./ffmpeg", env: { PATH: root } })).toThrow(/absolute executable path/);
    expect(() => resolveTrustedScriptExecutable("ffmpeg", { env: { PATH: `.${delimiter}relative` } })).toThrow(/No trusted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
