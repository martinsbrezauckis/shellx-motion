/** Native Windows DACL regression coverage. These tests deliberately create only owned fixtures. */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { prepareOutputDir, refuseUnsafeOutputDirReuse } from "./output-dir-guard";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function ownedFixture(): Promise<string> {
  const profile = process.env.USERPROFILE;
  if (!profile) throw new Error("Native Windows test account did not expose USERPROFILE.");
  const root = join(profile, `.shellx-motion-output-acl-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  tempDirs.push(root);
  return root;
}

async function setFixtureDacl(path: string, mode: "private" | "foreign-inherit"): Promise<void> {
  await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", FIXTURE_DACL_SCRIPT], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    env: { ...process.env, SHELLX_MOTION_OUTPUT_ACL_FIXTURE: path, SHELLX_MOTION_OUTPUT_ACL_MODE: mode }
  });
}

describe.skipIf(process.platform !== "win32")("native Windows output DACL admission", () => {
  it("accepts a normal current-user-owned output parent with CREATOR OWNER inheritance", async () => {
    const root = await ownedFixture();
    await setFixtureDacl(root, "private");
    const out = join(root, "out");

    expect(await prepareOutputDir(out, { force: false })).toEqual({ ok: true });
    expect((await lstat(out)).isDirectory()).toBe(true);
  });

  it("refuses a foreign inherit-only child writer without touching the sentinel or destination", async () => {
    const root = await ownedFixture();
    const unsafeParent = join(root, "unsafe-parent");
    const out = join(unsafeParent, "out");
    const sentinel = join(root, "sentinel.txt");
    await mkdir(unsafeParent);
    await setFixtureDacl(root, "private");
    await setFixtureDacl(unsafeParent, "foreign-inherit");
    await writeFile(sentinel, "preserve this sentinel", "utf8");

    expect(await refuseUnsafeOutputDirReuse(out))
      .toMatchObject({ code: "output_path_unsafe_parent", path: unsafeParent });
    expect(await prepareOutputDir(out, { force: false }))
      .toMatchObject({ ok: false, error: { code: "output_path_unsafe_parent", path: unsafeParent } });
    await expect(lstat(out)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(sentinel, "utf8")).toBe("preserve this sentinel");
  });

  it("refuses an existing empty foreign-writable output leaf without replacing it", async () => {
    const root = await ownedFixture();
    const out = join(root, "unsafe-empty");
    const sentinel = join(root, "sentinel.txt");
    await mkdir(out);
    await setFixtureDacl(root, "private");
    await setFixtureDacl(out, "foreign-inherit");
    await writeFile(sentinel, "preserve this sentinel", "utf8");
    const before = await lstat(out);

    expect(await refuseUnsafeOutputDirReuse(out))
      .toMatchObject({ code: "output_path_unsafe_parent", path: out });
    expect(await prepareOutputDir(out, { force: false }))
      .toMatchObject({ ok: false, error: { code: "output_path_unsafe_parent", path: out } });
    const after = await lstat(out);
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    expect(await readFile(sentinel, "utf8")).toBe("preserve this sentinel");
  });
});

const FIXTURE_DACL_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$path=$env:SHELLX_MOTION_OUTPUT_ACL_FIXTURE",
  "$mode=$env:SHELLX_MOTION_OUTPUT_ACL_MODE",
  "$directory=Get-Item -LiteralPath $path -Force",
  "$security=New-Object Security.AccessControl.DirectorySecurity",
  "$security.SetAccessRuleProtection($true,$false)",
  "$me=[Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$security.SetOwner($me)",
  "$inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit",
  "$none=[Security.AccessControl.PropagationFlags]::None",
  "$allow=[Security.AccessControl.AccessControlType]::Allow",
  "$full=[Security.AccessControl.FileSystemRights]::FullControl",
  "foreach($sid in @($me,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))){$security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,$full,$inherit,$none,$allow)))}",
  "if($mode -eq 'private'){$creator=[Security.Principal.SecurityIdentifier]::new('S-1-3-0');$io=[Security.AccessControl.PropagationFlags]::InheritOnly;$security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($creator,$full,$inherit,$io,$allow)))}",
  "if($mode -eq 'foreign-inherit'){$foreign=[Security.Principal.SecurityIdentifier]::new('S-1-5-11');$io=[Security.AccessControl.PropagationFlags]::InheritOnly;$security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($foreign,[Security.AccessControl.FileSystemRights]::Modify,$inherit,$io,$allow)))}",
  "$directory.SetAccessControl($security)"
].join("; ");
