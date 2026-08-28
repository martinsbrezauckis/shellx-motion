import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  WorkbenchSystemExecutableUnavailableError,
  resolveWorkbenchSystemExecutable,
  workbenchSystemExecutableCandidates
} from "./workbench-system-executable";

const execFileAsync = promisify(execFile);

describe("Workbench trusted system executables", () => {
  it("keeps every desktop helper on an absolute platform-owned path", () => {
    const attackerPath = "/tmp/workbench-attacker-bin";
    expect(workbenchSystemExecutableCandidates("browser-opener", {
      platform: "darwin", environment: { PATH: attackerPath }
    })).toEqual(["/usr/bin/open"]);
    expect(workbenchSystemExecutableCandidates("macos-osascript", {
      platform: "darwin", environment: { PATH: attackerPath }
    })).toEqual(["/usr/bin/osascript"]);
    expect(workbenchSystemExecutableCandidates("file-reveal", {
      platform: "linux", environment: { PATH: attackerPath }
    })).toEqual(["/usr/bin/xdg-open", "/bin/xdg-open"]);
    expect(workbenchSystemExecutableCandidates("linux-zenity", {
      platform: "linux", environment: { PATH: attackerPath }
    })).toEqual(["/usr/bin/zenity", "/bin/zenity"]);
    expect(workbenchSystemExecutableCandidates("linux-kdialog", {
      platform: "linux", environment: { PATH: attackerPath }
    })).toEqual(["/usr/bin/kdialog", "/bin/kdialog"]);
  });

  it("rejects caller-controlled Windows roots as helper authority", () => {
    const attackerPath = "C:\\attacker-bin";
    const attackerRoot = "D:\\attacker-windows";
    const environment = { SystemRoot: attackerRoot, WINDIR: attackerRoot, PATH: attackerPath };
    expect(workbenchSystemExecutableCandidates("browser-opener", { platform: "win32", environment }))
      .toEqual([String.raw`\\?\GLOBALROOT\SystemRoot\explorer.exe`]);
    expect(workbenchSystemExecutableCandidates("windows-powershell", { platform: "win32", environment }))
      .toEqual([String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`]);
    expect(workbenchSystemExecutableCandidates("windows-whoami", { platform: "win32", environment }))
      .toEqual([String.raw`\\?\GLOBALROOT\SystemRoot\System32\whoami.exe`]);
    for (const helper of ["browser-opener", "windows-powershell", "windows-whoami"] as const) {
      const candidates = workbenchSystemExecutableCandidates(helper, { platform: "win32", environment });
      expect(candidates.join("\n")).not.toContain(attackerRoot);
      expect(candidates.join("\n")).not.toContain("C:\\Windows");
    }
  });

  it.skipIf(process.platform !== "win32")(
    "launches a native helper from the OS-owned root despite poisoned process roots",
    async () => {
      const previous = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH };
      process.env.SystemRoot = "D:\\attacker-windows";
      process.env.WINDIR = "D:\\attacker-windows";
      process.env.PATH = "D:\\attacker-bin";
      try {
        const executable = await resolveWorkbenchSystemExecutable("windows-whoami");
        expect(executable.toLowerCase()).toMatch(/\\system32\\whoami\.exe$/);
        expect(executable).not.toContain("attacker-windows");
        expect(executable).not.toContain("attacker-bin");
        const { stdout } = await execFileAsync(executable, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
        expect(stdout).toMatch(/S-\d+(?:-\d+)+/);
      } finally {
        if (previous.SystemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = previous.SystemRoot;
        if (previous.WINDIR === undefined) delete process.env.WINDIR;
        else process.env.WINDIR = previous.WINDIR;
        if (previous.PATH === undefined) delete process.env.PATH;
        else process.env.PATH = previous.PATH;
      }
    }
  );

  it.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/xdg-open"))(
    "rejects an executable shadow placed first in PATH instead of treating it as the opener",
    async () => {
      const shadowRoot = await mkdtemp(join(tmpdir(), "shellx-motion-workbench-path-shadow-"));
      const shadow = join(shadowRoot, "xdg-open");
      try {
        await writeFile(shadow, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
        await chmod(shadow, 0o700);
        const result = await resolveWorkbenchSystemExecutable("browser-opener", {
          platform: "linux", environment: { PATH: shadowRoot }
        }).then(
          (executable) => ({ executable }),
          (error: unknown) => ({ error })
        );
        // This host maps system files to an unprivileged UID, so it correctly fails the ownership
        // check. A normal installed host resolves the same fixed system path. Neither outcome may
        // ever select the PATH shadow.
        if ("error" in result) {
          expect(result.error).toBeInstanceOf(WorkbenchSystemExecutableUnavailableError);
        } else {
          expect(result.executable).toBe("/usr/bin/xdg-open");
          expect(result.executable).not.toBe(shadow);
        }
      } finally {
        await rm(shadowRoot, { recursive: true, force: true });
      }
    }
  );

  it("fails closed when a platform has no approved system helper", async () => {
    await expect(resolveWorkbenchSystemExecutable("browser-opener", { platform: "freebsd", environment: { PATH: "/tmp/attacker" } }))
      .rejects.toBeInstanceOf(WorkbenchSystemExecutableUnavailableError);
  });
});
