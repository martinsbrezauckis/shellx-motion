/**
 * browser-executable.ts — ONE answer to "where is Chromium on this machine?", for every surface.
 *
 * ROLE
 * ----
 * Motion's default frame lane rasterizes through a real Chrome/Chromium. Motion does not ship one:
 * the dependency is `playwright-core`, which — unlike `playwright` — deliberately downloads no
 * browser. So Chromium is an external tool exactly like FFmpeg is, and it has to be discoverable by
 * two different callers:
 *
 *   - `@shellx-motion/renderer-browser`, which LAUNCHES the executable; and
 *   - `@shellx-motion/renderer-ffmpeg`'s platform-requirements probe, which REPORTS on it before
 *     any work starts (`shellx-motion doctor`, `motion.platform.requirements`).
 *
 * Those two must resolve the identical binary. A readiness probe with its own copy of the candidate
 * list is how a green pre-flight and a failing render coexist — the exact defect this module exists
 * to make structurally impossible. The list lives HERE, in core, because core is the one package
 * both of them already depend on: renderer-ffmpeg depends only on `@shellx-motion/core`, and having
 * it reach into renderer-browser (a `playwright-core` dependent) to ask a filesystem question would
 * invert the layering and drag a browser driver into the encoder's dependency closure.
 *
 * RESOLUTION ORDER (and why)
 * --------------------------
 *   1. `SHELLX_MOTION_BROWSER` — an explicit path, the same escape hatch `SHELLX_MOTION_FFMPEG`
 *      gives the encoder. It is a PIN: set and unusable, nothing else is considered.
 *   2. Playwright's browser cache, highest build number first, restricted to directories this
 *      machine's own user or root controls. `playwright-browser-cache.ts` owns that step; read its
 *      header before changing what the scan accepts.
 *   3. Well-known system installs per platform.
 *
 * WHAT THIS MODULE SELECTS GETS SPAWNED
 * -------------------------------------
 * The resolved path is executed, and it is executed by the LOWEST-privilege surface Motion has:
 * `motion.platform.requirements` is `permission: "read_motion", mutates: false`, the tier an agent
 * is told is a safe read-only pre-flight. Which is why exactly one of the three sources above is
 * gated by the trust rule, and the other two deliberately are not:
 *
 *   - THE CACHE IS GATED. Its directory NAMES are attacker-supplied, its location comes from a
 *     third-party variable (`PLAYWRIGHT_BROWSERS_PATH`) commonly aimed at a shared CI/Docker/NFS
 *     cache, and a world-writable shared cache is a SUPPORTED Playwright deployment rather than a
 *     broken machine. So "a directory exists there" says nothing about who created it.
 *
 *   - THE PIN IS NOT. An operator naming a path IS the authority. Gating it would disable the
 *     escape hatch in exactly the situation it exists for — a browser in an unusual place.
 *
 *   - {@link SYSTEM_BROWSER_CANDIDATES} IS NOT. It is a hard-coded allowlist; nobody can add an
 *     entry to it. A writable `/usr/bin` is a machine that is already lost, and a mode check there
 *     would instead produce false "no browser" reports on legitimate hosts whose uids are remapped
 *     (rootless containers).
 *
 * Existence on disk is otherwise the whole test, because it is exactly the test the launcher
 * applies. Nothing here consults PATH: a bare command name that PATH can resolve but
 * {@link findMotionBrowserExecutable} would not select would make the probe answer about a browser
 * the renderer will never launch.
 *
 * DEPENDENCIES / CALLERS
 * ----------------------
 * `./playwright-browser-cache`, `node:fs` / `node:path` / `node:process` only, so it stays usable
 * from a failure path. Primary callers: `renderer-browser`'s launcher and `renderer-ffmpeg`'s
 * `probeMotionTool`.
 */
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { scanPlaywrightBrowserCache, type MotionBrowserCacheRefusal } from "./playwright-browser-cache";
import type { MotionToolSource } from "./receipts";

export type { MotionBrowserCacheRefusal } from "./playwright-browser-cache";

/** The env var that pins an explicit Chrome/Chromium, mirroring `SHELLX_MOTION_FFMPEG`. */
export const MOTION_BROWSER_OVERRIDE_ENV_VAR = "SHELLX_MOTION_BROWSER";

/**
 * Well-known install locations, checked after an override and after Playwright's cache.
 *
 * Every entry is absolute. That is load-bearing: {@link resolveMotionBrowserExecutable} falls back
 * to the first absolute candidate when nothing exists, so that the readiness probe always has a
 * target whose spawn is guaranteed to fail rather than one PATH might quietly satisfy.
 */
const SYSTEM_BROWSER_CANDIDATES: readonly string[] = [
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
];

/** What `SHELLX_MOTION_BROWSER` currently means. */
type BrowserOverride =
  | { kind: "unset" }
  | { kind: "usable"; executable: string }
  /** Set, but Motion will not use it AND will not substitute anything else. */
  | { kind: "unusable"; value: string; problem: string };

/**
 * Read and judge the `SHELLX_MOTION_BROWSER` pin.
 *
 * A pin that cannot be used FAILS CLOSED. Falling through to the cache scan meant a one-character
 * typo silently launched a different browser and reported `source: "path"` — indistinguishable, in
 * the doctor output, from a machine with no override at all, and the delivery mechanism that turned
 * a planted cache entry into an execution. An operator who names a path is entitled to be told that
 * path was not usable.
 *
 * Trimming happens HERE, once. Two readers that trimmed differently is why a whitespace-padded
 * value could never match the resolved executable and quietly degraded to `source: "path"`.
 */
function readBrowserOverride(): BrowserOverride {
  const value = process.env[MOTION_BROWSER_OVERRIDE_ENV_VAR]?.trim();
  if (!value) return { kind: "unset" };
  // A relative value is resolved against the CWD by `existsSync` and against PATH by `spawn`
  // (`shell: false`), so the probe and the launcher would disagree about what `./chrome` even
  // names — and `./chrome` would run a binary out of whatever directory Motion happened to start
  // in. Refused rather than normalised: guessing which of the two the operator meant IS the
  // ambiguity, so picking one is not a resolution of it.
  if (!isAbsolute(value)) {
    return {
      kind: "unusable",
      value,
      problem: `${MOTION_BROWSER_OVERRIDE_ENV_VAR} is set to ${JSON.stringify(value)}, which is not an absolute path.`
        + " Motion will not guess whether that means a file in the current directory or a name on PATH, and it"
        + " will not fall back to another browser while a pin is set. Set it to an absolute path, or unset it."
    };
  }
  if (!isUsableExecutable(value)) {
    return {
      kind: "unusable",
      value,
      problem: `${MOTION_BROWSER_OVERRIDE_ENV_VAR} is set to ${JSON.stringify(value)}, and no file exists there.`
        + " Motion will not silently launch a different browser instead. Correct the path, or unset the variable"
        + " to use the browsers this machine already has."
    };
  }
  return { kind: "usable", executable: value };
}

/**
 * Whether a candidate is something Motion could actually spawn.
 *
 * `statSync` rather than `existsSync`: a directory satisfies "exists" and then fails the spawn with
 * an error that describes nothing.
 */
function isUsableExecutable(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Every path Motion will consider, in preference order.
 *
 * @returns Candidate executables. Existence is NOT checked here — callers decide whether they want
 *   the first that exists (the launcher) or a spawn target regardless (the readiness probe).
 *   EMPTY when `SHELLX_MOTION_BROWSER` is set to something unusable: a pin that cannot be honoured
 *   removes every other candidate rather than promoting one, so this list never describes a browser
 *   Motion would in fact decline to launch.
 */
export function browserExecutableCandidates(): string[] {
  const override = readBrowserOverride();
  if (override.kind === "unusable") return [];
  return [
    ...(override.kind === "usable" ? [override.executable] : []),
    ...scanPlaywrightBrowserCache().candidates,
    ...SYSTEM_BROWSER_CANDIDATES
  ];
}

/**
 * The Chrome/Chromium Motion would launch right now.
 *
 * @returns The first candidate that exists on disk, or null when this machine has none — including
 *   when a `SHELLX_MOTION_BROWSER` pin is set and unusable, in which case
 *   {@link motionBrowserOverrideProblem} says why.
 */
export function findMotionBrowserExecutable(): string | null {
  return browserExecutableCandidates().find(isUsableExecutable) ?? null;
}

/**
 * Why Motion is refusing to consider any browser at all, or null when it is not refusing.
 *
 * Exists so the launcher's "no browser found" error can name the pin it was told to use, instead of
 * printing the same sentence a machine with no browser and no pin would get — which reads as "set
 * SHELLX_MOTION_BROWSER" to someone who just did.
 */
export function motionBrowserOverrideProblem(): string | null {
  const override = readBrowserOverride();
  return override.kind === "unusable" ? override.problem : null;
}

/**
 * Playwright cache directories the trust rule declined, for a diagnostic.
 *
 * A security refusal that produces a silent "no browser found" sends a CI user to reinstall a
 * browser they already have — into the same rejected cache. Recomputed on each call: it is only
 * consulted from failure paths, never in a loop.
 */
export function untrustedMotionBrowserCaches(): MotionBrowserCacheRefusal[] {
  return scanPlaywrightBrowserCache().refusals;
}

/** A resolved probe target: what to run, and how it was found. Shaped like the FFmpeg resolver's. */
export interface MotionBrowserExecutableLocation {
  executable: string;
  source: MotionToolSource;
  /** Present only when `executable` came from the auto-discovered Playwright cache. */
  autoDiscoveredCache?: true;
  /**
   * Set ONLY when `SHELLX_MOTION_BROWSER` is set to something Motion cannot use.
   *
   * Its presence means the answer is final and negative: nothing was spawned, nothing else was
   * considered, and `executable` is the rejected pin itself so a report can name it. A caller that
   * probes tools must treat this as `broken` from an `override` source rather than running the
   * executable — see `probeMotionTool` in `@shellx-motion/renderer-ffmpeg`.
   */
  problem?: string;
}

/**
 * What the readiness probe should spawn, whether or not a browser is installed.
 *
 * When nothing exists this still returns a path — the first ABSOLUTE candidate — so the probe can
 * report `missing` from a real spawn failure through the caller's runner seam, exactly as the
 * FFmpeg probe does, instead of needing a second, differently-shaped code path.
 *
 * The one case that does NOT get a spawn target is an unusable pin, which returns `problem`
 * instead. Spawning something else there would answer about a browser the operator did not ask for.
 */
export function resolveMotionBrowserExecutable(): MotionBrowserExecutableLocation {
  const override = readBrowserOverride();
  if (override.kind === "unusable") {
    return { executable: override.value, source: "override", problem: override.problem };
  }
  const cacheCandidates = scanPlaywrightBrowserCache().candidates;
  const candidates: Array<{ executable: string; autoDiscoveredCache?: true }> = [
    ...(override.kind === "usable" ? [{ executable: override.executable }] : []),
    ...cacheCandidates.map((executable) => ({ executable, autoDiscoveredCache: true as const })),
    ...SYSTEM_BROWSER_CANDIDATES.map((executable) => ({ executable }))
  ];
  const selected = candidates.find((candidate) => isUsableExecutable(candidate.executable))
    ?? candidates.find((candidate) => isAbsolute(candidate.executable))
    ?? { executable: SYSTEM_BROWSER_CANDIDATES[0] };
  return {
    executable: selected.executable,
    source: override.kind === "usable" && selected.executable === override.executable ? "override" : "path",
    ...(selected.autoDiscoveredCache ? { autoDiscoveredCache: true as const } : {})
  };
}

/**
 * Revalidate a browser immediately before a caller gives it to a process-creation API.
 *
 * Node and Playwright expose a pathname rather than an open executable descriptor, so they cannot
 * make the final check and `exec` one indivisible operation. The cache is therefore rescanned at
 * each repository-native process boundary; a changed, symlinked, non-regular or untrusted layout
 * is rejected rather than handed to the probe or launcher. Explicit pins and fixed system paths
 * deliberately retain their documented trust model, while still requiring a regular file to exist.
 */
export function motionBrowserExecutableVerificationProblem(location: MotionBrowserExecutableLocation): string | null {
  if (location.problem) return location.problem;
  if (!isUsableExecutable(location.executable)) return "the selected browser executable is no longer a regular file";
  if (!location.autoDiscoveredCache) return null;
  if (!scanPlaywrightBrowserCache().candidates.includes(location.executable)) {
    return "the auto-discovered Playwright cache executable no longer passes canonical-path, ownership, mode, and regular-file checks";
  }
  return null;
}
