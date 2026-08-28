import { describe, expect, it } from "vitest";
import { lstatSync, realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { resolveWindowsSystemExecutable, windowsSystemExecutableCandidate } from "./windows-system-executable";

describe("trusted Windows system executable candidates", () => {
  it("uses fixed GLOBALROOT system locations rather than cwd, PATH, or environment roots", () => {
    expect(windowsSystemExecutableCandidate("powershell"))
      .toBe(String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`);
    expect(windowsSystemExecutableCandidate("taskkill"))
      .toBe(String.raw`\\?\GLOBALROOT\SystemRoot\System32\taskkill.exe`);
    for (const helper of ["powershell", "taskkill"] as const) {
      const candidate = windowsSystemExecutableCandidate(helper);
      expect(win32.isAbsolute(candidate)).toBe(true);
      expect(candidate.toLowerCase()).not.toContain("users\\");
    }
  });

  it.skipIf(process.platform !== "win32")("resolves canonical system helpers beneath the live Windows system root", () => {
    for (const helper of ["powershell", "taskkill"] as const) {
      const executable = resolveWindowsSystemExecutable(helper);
      const expected = realpathSync.native(windowsSystemExecutableCandidate(helper));
      expect(win32.isAbsolute(executable)).toBe(true);
      expect(lstatSync(executable).isFile()).toBe(true);
      expect(executable.toLowerCase()).toBe(expected.toLowerCase());
    }
  });

  it.skipIf(process.platform !== "win32")("ignores consistently poisoned Windows root environment variables", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "shellx-motion-fake-system-root-"));
    const fakePowerShellDir = join(fakeRoot, "System32", "WindowsPowerShell", "v1.0");
    const fakeSystem32 = join(fakeRoot, "System32");
    await mkdir(fakePowerShellDir, { recursive: true });
    await copyFile(process.execPath, join(fakePowerShellDir, "powershell.exe"));
    await copyFile(process.execPath, join(fakeSystem32, "taskkill.exe"));
    const prior = {
      SystemRoot: process.env.SystemRoot,
      SYSTEMROOT: process.env.SYSTEMROOT,
      WINDIR: process.env.WINDIR,
    };
    process.env.SystemRoot = fakeRoot;
    process.env.SYSTEMROOT = fakeRoot;
    process.env.WINDIR = fakeRoot;
    try {
      for (const helper of ["powershell", "taskkill"] as const) {
        const resolved = resolveWindowsSystemExecutable(helper);
        expect(resolved.toLowerCase()).toBe(realpathSync.native(windowsSystemExecutableCandidate(helper)).toLowerCase());
        expect(resolved.toLowerCase()).not.toContain(fakeRoot.toLowerCase());
      }
    } finally {
      for (const [name, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });
});
