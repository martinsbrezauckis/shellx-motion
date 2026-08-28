import { lstatSync, realpathSync } from "node:fs";
import { win32 } from "node:path";

export type WindowsSystemExecutable = "powershell" | "taskkill";

/**
 * The Object Manager's fixed link to the installed Windows system directory.
 * Environment values and PATH cannot establish authority over an OS helper.
 */
const WINDOWS_SYSTEM_ROOT = String.raw`\\?\GLOBALROOT\SystemRoot`;

/** Pure candidate projection retained for cross-platform contract tests. */
export function windowsSystemExecutableCandidate(helper: WindowsSystemExecutable): string {
  return helper === "powershell"
    ? win32.join(WINDOWS_SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : win32.join(WINDOWS_SYSTEM_ROOT, "System32", "taskkill.exe");
}

/** Resolve one canonical OS-owned helper without consulting cwd, PATH, SystemRoot, or WINDIR. */
export function resolveWindowsSystemExecutable(helper: WindowsSystemExecutable): string {
  if (process.platform !== "win32") throw new Error("Windows system executable resolution requires Windows.");
  const rootFacts = lstatSync(WINDOWS_SYSTEM_ROOT);
  const root = realpathSync.native(WINDOWS_SYSTEM_ROOT);
  const canonicalRootFacts = lstatSync(root);
  if (!win32.isAbsolute(root)
    || !rootFacts.isDirectory()
    || rootFacts.isSymbolicLink()
    || !canonicalRootFacts.isDirectory()
    || canonicalRootFacts.isSymbolicLink()
    || rootFacts.dev !== canonicalRootFacts.dev
    || rootFacts.ino !== canonicalRootFacts.ino) {
    throw new Error("The canonical Windows system root is unavailable.");
  }

  const candidate = windowsSystemExecutableCandidate(helper);
  const original = lstatSync(candidate);
  if (!original.isFile() || original.isSymbolicLink()) {
    throw new Error("The trusted Windows system executable is unavailable.");
  }
  // Node's legacy JavaScript realpath walker cannot traverse GLOBALROOT, but the native variant
  // asks Windows for the final DOS path of this exact Object Manager-selected file.
  const canonical = realpathSync.native(candidate);
  const facts = lstatSync(canonical);
  const relative = win32.relative(root, canonical);
  if (!win32.isAbsolute(canonical)
    || !relative
    || relative === ".."
    || relative.startsWith(`..${win32.sep}`)
    || win32.isAbsolute(relative)
    || !facts.isFile()
    || facts.isSymbolicLink()
    || original.dev !== facts.dev
    || original.ino !== facts.ino) {
    throw new Error("The Windows system executable escaped the canonical system root.");
  }
  return canonical;
}
