/**
 * Host-derived Playwright cache locations and their available trust boundary.
 *
 * The default cache is below HOME, but HOME itself is caller-controlled. Only an absolute HOME
 * that exactly matches the operating system account record can be used as a positive boundary;
 * PLAYWRIGHT_BROWSERS_PATH and LOCALAPPDATA always retain the complete ancestor trust walk.
 */
import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface PlaywrightCacheRoot {
  path: string;
  label: string;
  trustedAncestor?: string;
}

/**
 * Return cache roots in Playwright's documented precedence with report-safe labels.
 *
 * Every cache component below `trustedAncestor` must still pass the ordinary canonical-path,
 * ownership, and mode checks. This boundary only avoids treating a remapped outer mount as a
 * reason to ignore the current account's default cache.
 */
export function playwrightCacheRoots(currentUserHome = accountHomeDirectory()): PlaywrightCacheRoot[] {
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const home = process.env.HOME;
  const localAppData = process.env.LOCALAPPDATA;
  const normalizedHome = home && isAbsolute(home) ? resolve(home) : undefined;
  const trustedHome = normalizedHome !== undefined && normalizedHome === currentUserHome
    ? normalizedHome
    : undefined;
  const roots = [
    browsersPath && browsersPath !== "0"
      ? { path: browsersPath, label: "the browser cache at PLAYWRIGHT_BROWSERS_PATH" }
      : null,
    normalizedHome
      ? { path: join(normalizedHome, ".cache", "ms-playwright"), label: "the Playwright cache under HOME/.cache", trustedAncestor: trustedHome }
      : null,
    normalizedHome
      ? { path: join(normalizedHome, "Library", "Caches", "ms-playwright"), label: "the Playwright cache under HOME/Library/Caches", trustedAncestor: trustedHome }
      : null,
    localAppData ? { path: join(localAppData, "ms-playwright"), label: "the Playwright cache under LOCALAPPDATA" } : null
  ].filter((root): root is PlaywrightCacheRoot => root !== null);
  // `PLAYWRIGHT_BROWSERS_PATH` may point at a default location; do not enumerate it twice.
  const seen = new Set<string>();
  return roots.filter((root) => (seen.has(root.path) ? false : (seen.add(root.path), true)));
}

function accountHomeDirectory(): string | undefined {
  try {
    const home = userInfo().homedir;
    return home && isAbsolute(home) ? resolve(home) : undefined;
  } catch {
    return undefined;
  }
}
