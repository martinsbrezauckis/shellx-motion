/**
 * playwright-browser-cache.ts — what Playwright's download cache offers, and what it refuses.
 *
 * ROLE
 * ----
 * `npx playwright-core install chromium` is the install route Motion recommends first, so its cache
 * is the browser source Motion is most likely to select — and the only one whose CONTENTS an
 * attacker can influence. `browser-executable.ts` owns the resolution ORDER (pin, then cache, then
 * well-known system paths); this module owns the one step of it that enumerates directories nobody
 * on Motion's side created, and is therefore where the enumeration's three safety rules live.
 *
 * Extracted from `browser-executable.ts` so the search order and the hostile-input handling can be
 * read and changed independently: the order is a product decision, this is a security boundary.
 *
 * THE THREE RULES
 * ---------------
 *   NAME. A Playwright build directory is `chromium-<revision>` with an integer revision, and the
 *   ordering is NUMERIC. The original `sort().reverse()` compared the raw names, which is not
 *   "newest build first" as its comment claimed: `chromium-zz` > `chromium-999` > `chromium-1200`
 *   under a string comparison, so ANY directory whose name merely started with `chromium-`
 *   outranked every genuine build, permanently. A non-numeric suffix is REJECTED rather than ranked
 *   last, because ranking it last still runs it on a machine with no real build, and Playwright
 *   never produces one — whatever is sitting there was put there by someone.
 *
 *   TRUST. A numeric sort alone still runs a planted `chromium-99999`. `PLAYWRIGHT_BROWSERS_PATH`
 *   is a THIRD-PARTY variable routinely aimed at a shared CI / Docker / NFS cache, so "a directory
 *   exists in the cache" says nothing about who created it. Every root, build/layout component, and
 *   executable leaf must be canonical, controlled by this user or root, and non-group/world-writable.
 *   On win32 Node exposes no usable ACL ownership fact, so auto-discovered caches are refused
 *   instead of being called trusted. Operators can use the explicit browser pin or a fixed system
 *   installation without weakening this scanner.
 *
 *   CONTAINMENT. `existsSync` and `spawn` both follow symlinks, so a symlinked build directory runs
 *   whatever it points at. Every entry must resolve to a location still inside its cache root.
 *
 * WHY THIS IS NOT PARANOIA
 * ------------------------
 * What this scan returns is SPAWNED, and it is spawned by `shellx-motion doctor` and by
 * `motion.platform.requirements` — a `read_motion`, `mutates:false` command documented as a safe
 * read-only pre-flight. A planted `chromium-zz/chrome-linux/chrome` was demonstrated executing
 * from it.
 *
 * DEPENDENCIES / CALLERS
 * ----------------------
 * `./executable-trust`, `node:fs` / `node:path` / `node:process`. Sole caller:
 * `browser-executable.ts`.
 */
import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolvesInside, untrustedExecutableDirectoryReason, untrustedExecutableFileReason } from "./executable-trust";
import { playwrightCacheRoots } from "./playwright-cache-roots";

/**
 * Playwright's own name for a downloaded Chromium build: `chromium-<revision>`, revision an
 * integer. Anchored and digits-only on purpose — see the NAME rule in the module header.
 *
 * `chromium_headless_shell-<revision>` (an underscore) is a different product and is not matched,
 * which is the pre-existing behaviour: Motion needs a headful-capable binary.
 */
const PLAYWRIGHT_CHROMIUM_BUILD = /^chromium-(\d+)$/;

/**
 * Per-platform layouts a Playwright build directory can use.
 *
 * All of them are enumerated because which one is on disk depends on the OS and the Playwright
 * version, and the caller decides which exists.
 */
const PLAYWRIGHT_BUILD_LAYOUTS: ReadonlyArray<readonly string[]> = [
  ["chrome-linux", "chrome"],
  ["chrome-linux64", "chrome"],
  ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
  ["chrome-win", "chrome.exe"],
  ["chrome-win64", "chrome.exe"]
];

/** A cache directory the scan declined to take an executable from, and why. */
export interface MotionBrowserCacheRefusal {
  /** The directory that was skipped. Absolute, so a caller that publishes it must redact it. */
  path: string;
  /**
   * The same directory named WITHOUT a machine-private path — "the browser cache at
   * PLAYWRIGHT_BROWSERS_PATH", "chromium-zz in the Playwright cache under HOME/.cache".
   *
   * Exists because the one place this refusal has to be readable is the doctor report, and that
   * report may not republish a home directory or a username. A user who has to act on it is being
   * pointed at a directory they configured or a name they can see with `ls`, which is enough.
   */
  label: string;
  /** Sentence completing "<label> was skipped because …". Never contains a path. */
  reason: string;
}

/** One pass over Playwright's caches: what may be used, and what was declined. */
export interface PlaywrightCacheScan {
  /** Existing, trusted executable paths, in preference order. */
  candidates: string[];
  refusals: MotionBrowserCacheRefusal[];
}

/**
 * Chromium builds in Playwright's download cache, highest build number first.
 *
 * Enforces all three rules from the module header, so the candidate list every Motion surface
 * shares can never contain a directory someone else planted. An absent, unreadable or untrusted
 * cache root is not an error; it simply contributes nothing, and an untrusted one says so through
 * `refusals` rather than vanishing silently.
 */
export function scanPlaywrightBrowserCache(
  options: { platform?: NodeJS.Platform; currentUserHome?: string } = {}
): PlaywrightCacheScan {
  const candidates: string[] = [];
  const refusals: MotionBrowserCacheRefusal[] = [];
  const platform = options.platform ?? process.platform;

  for (const { path: root, label: rootLabel, trustedAncestor } of playwrightCacheRoots(options.currentUserHome)) {
    // A cache root that is simply not present on this machine — `~/Library/Caches/ms-playwright`
    // on Linux, say — is the ordinary case and must not be reported as a security refusal.
    if (!isExistingDirectory(root)) continue;
    if (platform === "win32") {
      refusals.push({
        path: root,
        label: rootLabel,
        reason: "its Windows access-control ownership cannot be verified by this runtime"
      });
      continue;
    }
    const rootReason = untrustedExecutableDirectoryReason(root, { trustedAncestor });
    if (rootReason) {
      refusals.push({ path: root, label: rootLabel, reason: rootReason });
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      // Present but unreadable (a permissions problem of our own): contributes nothing.
      continue;
    }
    const builds: Array<{ name: string; build: number }> = [];
    for (const name of entries) {
      const match = PLAYWRIGHT_CHROMIUM_BUILD.exec(name);
      const label = `${name} in ${rootLabel}`;
      if (!match) {
        // Only report entries that were TRYING to look like a Chromium build. `firefox-1466` and
        // `.links` are Playwright's own; `chromium-zz` is not.
        if (name.startsWith("chromium-")) {
          refusals.push({
            path: join(root, name),
            label,
            reason: "its name is not `chromium-<build number>`, so Playwright did not create it"
          });
        }
        continue;
      }
      const directory = join(root, name);
      if (!resolvesInside(root, directory)) {
        refusals.push({ path: directory, label, reason: "it is a link that leaves the browser cache" });
        continue;
      }
      // Ancestors are already covered by the root check above, which walked them.
      const reason = untrustedExecutableDirectoryReason(directory, { ancestors: false });
      if (reason) {
        refusals.push({ path: directory, label, reason });
        continue;
      }
      builds.push({ name, build: Number(match[1]) });
    }
    // NUMERIC and descending. `sort().reverse()` compared the names as strings, which is what let
    // `chromium-999` outrank `chromium-1200`.
    builds.sort((left, right) => right.build - left.build);
    for (const { name } of builds) {
      const buildRoot = join(root, name);
      for (const layout of PLAYWRIGHT_BUILD_LAYOUTS) {
        const executable = join(buildRoot, ...layout);
        const executableLabel = `${layout[layout.length - 1]} in ${layout.slice(0, -1).join("/")} in ${name} in ${rootLabel}`;
        let parent = buildRoot;
        let rejected = false;
        for (const component of layout.slice(0, -1)) {
          parent = join(parent, component);
          if (!isExistingDirectory(parent)) {
            rejected = true;
            break;
          }
          const parentReason = untrustedExecutableDirectoryReason(parent, { ancestors: false });
          if (parentReason) {
            refusals.push({
              path: parent,
              label: `${component} in ${name} in ${rootLabel}`,
              reason: parentReason
            });
            rejected = true;
            break;
          }
        }
        if (rejected || !pathExists(executable)) continue;
        const executableReason = untrustedExecutableFileReason(executable, { ancestors: false });
        if (executableReason) {
          refusals.push({ path: executable, label: executableLabel, reason: executableReason });
          continue;
        }
        candidates.push(executable);
      }
    }
  }

  return { candidates, refusals };
}

/** Whether a cache root is present at all, before asking whether it is trustworthy. */
function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch { return false; }
}
