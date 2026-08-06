import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

export interface MotionUserAccessPaths {
  root: string;
  tokenFile: string;
  portFile: string;
  /**
   * Where receipts land when nobody said otherwise. Its existence is what makes the Debug API's
   * caller-supplied `receiptsRoot` fence enforceable rather than fail-closed-on-everything: a fence
   * needs a trusted side, and before this the shipped server configured no receipt root at all, so a
   * caller's root was not merely preferred over the host's -- it was the only one there was.
   */
  receiptsRoot: string;
}

export function motionUserAccessPaths(root = join(homedir(), ".shellx-motion")): MotionUserAccessPaths {
  return {
    root,
    tokenFile: join(root, "access.token"),
    portFile: join(root, "server.port"),
    receiptsRoot: join(root, "receipts")
  };
}

/**
 * Create the default receipt store, 0700 like everything else under the access root, and return it.
 *
 * Separate from {@link readOrCreatePersistentCapabilityFile} because receipts are needed on every
 * start, including the ephemeral-token path where no persistent access file is ever written.
 */
export async function ensureMotionReceiptsRoot(
  paths: MotionUserAccessPaths = motionUserAccessPaths()
): Promise<string> {
  await securePrivateDirectory(paths.root);
  await securePrivateDirectory(paths.receiptsRoot);
  return paths.receiptsRoot;
}

export async function readOrCreatePersistentCapabilityFile(
  paths: MotionUserAccessPaths = motionUserAccessPaths()
): Promise<{ token: string; tokenFile: string; created: boolean }> {
  await securePrivateDirectory(paths.root);
  const existing = await readCapabilityIfPresent(paths.tokenFile);
  if (existing) return { token: existing, tokenFile: paths.tokenFile, created: false };

  const token = randomBytes(32).toString("base64url");
  try {
    await writeFile(paths.tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
    const raced = await readCapabilityIfPresent(paths.tokenFile);
    if (!raced) throw new Error("Motion access-key creation raced but no valid key became available.");
    return { token: raced, tokenFile: paths.tokenFile, created: false };
  }
  await securePrivateFile(paths.tokenFile);
  return { token, tokenFile: paths.tokenFile, created: true };
}

export async function writeMotionServerPort(paths: MotionUserAccessPaths, port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Motion server port publication requires a bound TCP port.");
  }
  await securePrivateDirectory(paths.root);
  try {
    const existing = await lstat(paths.portFile);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error("Motion server-port state must be a private regular file, not a link or directory.");
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  await writeFile(paths.portFile, `${port}\n`, { encoding: "utf8", mode: 0o600 });
  await securePrivateFile(paths.portFile);
}

export async function clearMotionServerPort(paths: MotionUserAccessPaths, expectedPort: number): Promise<void> {
  try {
    const current = Number((await readFile(paths.portFile, "utf8")).trim());
    if (current === expectedPort) await rm(paths.portFile, { force: true });
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

export async function writeEphemeralCapabilityFile(capabilityToken: string): Promise<{ tokenRoot: string; tokenFile: string }> {
  assertCapabilityToken(capabilityToken);
  const tokenRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-"));
  const tokenFile = join(tokenRoot, "capability-token");
  try {
    await securePrivateDirectory(tokenRoot);
    await writeFile(tokenFile, `${capabilityToken}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await securePrivateFile(tokenFile);
    return { tokenRoot, tokenFile };
  } catch (error) {
    await rm(tokenRoot, { recursive: true, force: true });
    throw error;
  }
}

async function readCapabilityIfPresent(path: string): Promise<string | null> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Motion access key must be a private regular file, not a link or directory.");
    }
    const token = (await readFile(path, "utf8")).trim();
    assertCapabilityToken(token);
    await securePrivateFile(path);
    return token;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function assertCapabilityToken(token: string): void {
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error("Motion access keys must contain at least 32 URL-safe characters.");
  }
}

async function securePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Motion access storage must be a private directory, not a link or file.");
  }
  if (process.platform === "win32") {
    const userSid = await currentWindowsUserSid();
    await restrictWindowsCapabilityPath(path, userSid, true);
  } else {
    await chmod(path, 0o700);
  }
}

async function securePrivateFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Motion access storage contains a non-regular file.");
  }
  if (process.platform === "win32") {
    const userSid = await currentWindowsUserSid();
    await restrictWindowsCapabilityPath(path, userSid, false);
  } else {
    await chmod(path, 0o600);
  }
}

async function currentWindowsUserSid(): Promise<string> {
  const { stdout } = await execFileAsync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true
  });
  const sid = stdout.match(/S-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new Error("Unable to resolve the current Windows user SID for access-key ACL hardening.");
  return sid;
}

async function restrictWindowsCapabilityPath(path: string, userSid: string, directory: boolean): Promise<void> {
  // Set-Acl can try to write audit-control metadata and require SeSecurityPrivilege.
  // Apply a newly constructed access-only descriptor through DirectoryInfo/FileInfo
  // instead: it replaces inherited and explicit DACL entries atomically while leaving
  // owner/audit metadata alone, so a reused path cannot retain a foreign explicit ACE.
  const securityType = directory ? "DirectorySecurity" : "FileSecurity";
  const itemType = directory ? "DirectoryInfo" : "FileInfo";
  const inheritance = directory ? "ContainerInherit,ObjectInherit" : "None";
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$sid = New-Object Security.Principal.SecurityIdentifier($env:SHELLX_MOTION_ACL_SID)",
    `$security = New-Object Security.AccessControl.${securityType}`,
    "$security.SetAccessRuleProtection($true, $false)",
    `$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', '${inheritance}', 'None', 'Allow')`,
    "$security.AddAccessRule($rule) | Out-Null",
    `$item = New-Object IO.${itemType}($env:SHELLX_MOTION_ACL_PATH)`,
    "$item.SetAccessControl($security)"
  ].join("; ");
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 32 * 1024,
    env: {
      ...process.env,
      SHELLX_MOTION_ACL_PATH: path,
      SHELLX_MOTION_ACL_SID: userSid
    }
  });
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isFileExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
