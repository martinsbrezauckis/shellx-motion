/**
 * Absolute, host-owned executables for Workbench desktop actions.
 *
 * Workbench children retain a filtered version of the server environment so they can reach a
 * desktop session.  That environment still carries PATH, which is not authority to choose a
 * helper executable: a caller that can influence PATH must not select what the server runs.
 *
 * Every entry below therefore names a small set of OS-owned absolute locations.  Resolution
 * validates the chosen regular file immediately before returning it; callers execute only that
 * absolute value and fail closed when no trusted system helper is available.
 */
import { lstat, realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { untrustedExecutableFileReason } from "@shellx-motion/core";

export type WorkbenchSystemExecutable =
  | "browser-opener"
  | "file-reveal"
  | "windows-powershell"
  | "windows-whoami"
  | "macos-osascript"
  | "linux-zenity"
  | "linux-kdialog";

export class WorkbenchSystemExecutableUnavailableError extends Error {
  constructor() {
    super("A trusted system desktop helper is unavailable.");
    this.name = "WorkbenchSystemExecutableUnavailableError";
  }
}

export interface WorkbenchSystemExecutableOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
}

/**
 * The Object Manager's fixed link to the installed Windows system directory.
 *
 * `SystemRoot` and `WINDIR` are process environment values, so they cannot establish authority
 * over a helper executable.  `GLOBALROOT\\SystemRoot` is resolved by Windows itself, remains
 * portable across non-default Windows installations, and is revalidated before use below.
 */
const WINDOWS_SYSTEM_ROOT = String.raw`\\?\GLOBALROOT\SystemRoot`;

/**
 * Return only absolute OS locations for one fixed Workbench helper.  PATH is deliberately not an
 * input to the selection rule, even though callers may include it in `environment` for child I/O.
 * Exported for platform-contract tests; production should use {@link resolveWorkbenchSystemExecutable}.
 */
export function workbenchSystemExecutableCandidates(
  helper: WorkbenchSystemExecutable,
  options: WorkbenchSystemExecutableOptions = {}
): readonly string[] {
  const platform = options.platform ?? process.platform;
  switch (helper) {
    case "browser-opener":
    case "file-reveal":
      if (platform === "win32") return windowsSystemExecutableCandidates("explorer.exe");
      if (platform === "darwin") return ["/usr/bin/open"];
      if (platform === "linux") return ["/usr/bin/xdg-open", "/bin/xdg-open"];
      return [];
    case "windows-powershell":
      return platform === "win32"
        ? windowsSystemExecutableCandidates("System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        : [];
    case "windows-whoami":
      return platform === "win32" ? windowsSystemExecutableCandidates("System32", "whoami.exe") : [];
    case "macos-osascript":
      return platform === "darwin" ? ["/usr/bin/osascript"] : [];
    case "linux-zenity":
      return platform === "linux" ? ["/usr/bin/zenity", "/bin/zenity"] : [];
    case "linux-kdialog":
      return platform === "linux" ? ["/usr/bin/kdialog", "/bin/kdialog"] : [];
  }
}

/** Resolve and revalidate one absolute Workbench system executable, never searching PATH. */
export async function resolveWorkbenchSystemExecutable(
  helper: WorkbenchSystemExecutable,
  options: WorkbenchSystemExecutableOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  for (const candidate of workbenchSystemExecutableCandidates(helper, options)) {
    try {
      const windowsSystemRoot = platform === "win32" ? await resolveWindowsSystemRoot() : undefined;
      return await resolveTrustedWorkbenchSystemExecutable(candidate, platform, windowsSystemRoot);
    } catch {
      // Try the next explicitly trusted system location.  Do not fall back to PATH.
    }
  }
  throw new WorkbenchSystemExecutableUnavailableError();
}

function windowsSystemExecutableCandidates(...segments: string[]): string[] {
  return [win32.join(WINDOWS_SYSTEM_ROOT, ...segments)];
}

async function resolveWindowsSystemRoot(): Promise<string> {
  const root = await realpath(WINDOWS_SYSTEM_ROOT);
  if (!win32.isAbsolute(root)) throw new WorkbenchSystemExecutableUnavailableError();
  const facts = await lstat(root);
  if (!facts.isDirectory() || facts.isSymbolicLink()) throw new WorkbenchSystemExecutableUnavailableError();
  return root;
}

async function resolveTrustedWorkbenchSystemExecutable(
  executable: string,
  platform: NodeJS.Platform,
  windowsSystemRoot?: string
): Promise<string> {
  const path = platform === "win32" ? win32 : posix;
  if (!path.isAbsolute(executable)) throw new WorkbenchSystemExecutableUnavailableError();
  if (platform === "win32" && win32.extname(executable).toLowerCase() !== ".exe") {
    throw new WorkbenchSystemExecutableUnavailableError();
  }
  const original = await lstat(executable);
  if (!original.isFile() || original.isSymbolicLink()) throw new WorkbenchSystemExecutableUnavailableError();
  const canonical = await realpath(executable);
  if (platform === "win32") {
    if (!windowsSystemRoot || !isWithinWindowsSystemRoot(canonical, windowsSystemRoot)) {
      throw new WorkbenchSystemExecutableUnavailableError();
    }
    return canonical;
  }
  if (canonical !== executable || untrustedExecutableFileReason(executable)) {
    throw new WorkbenchSystemExecutableUnavailableError();
  }
  return canonical;
}

function isWithinWindowsSystemRoot(candidate: string, root: string): boolean {
  const relative = win32.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith("..\\") && relative !== ".." && !win32.isAbsolute(relative);
}
