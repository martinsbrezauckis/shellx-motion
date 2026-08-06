/**
 * Which Chrome/Chromium Motion is willing to EXECUTE, and which it refuses.
 *
 * Every case here is a regression for a proven finding, not a hypothetical. The resolver's output
 * is spawned by `shellx-motion doctor` and by `motion.platform.requirements` — the lowest
 * permission tier Motion has, documented as a safe read-only pre-flight — so "which directory may
 * contribute a candidate" is a security answer, and each assertion below pins one clause of it:
 *
 *   ORDERING   a planted `chromium-zz` outranked every real build under the old lexicographic
 *              sort, and a planted binary was demonstrated RUNNING from a doctor invocation. Now
 *              numeric, with non-numeric names rejected rather than ranked.
 *   TRUST      a numeric sort alone still runs a planted `chromium-99999`, so a cache directory
 *              other principals can write contributes nothing.
 *   PIN        a `SHELLX_MOTION_BROWSER` pin naming a missing path fell through and launched a
 *              DIFFERENT browser, reporting `source: "path"` as though no pin had been set.
 *   PIN SHAPE  a bare or relative pin was tested CWD-relative by `existsSync` and PATH-relative
 *              by `spawn`, so the probe and the launcher disagreed about what it named.
 *
 * The environment is fully pinned per case (HOME and LOCALAPPDATA included), so nothing here can
 * pass or fail because of the browser the developer's own machine happens to have installed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, chownSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserExecutableCandidates,
  findMotionBrowserExecutable,
  motionBrowserOverrideProblem,
  resolveMotionBrowserExecutable,
  untrustedMotionBrowserCaches
} from "./browser-executable";
import { resolvesInside, untrustedExecutableDirectoryReason } from "./executable-trust";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function cacheRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-browser-trust-"));
  tempDirs.push(root);
  return root;
}

/** Write a runnable Chromium stand-in at `<root>/<entry>/chrome-linux/chrome`. */
function plantBuild(root: string, entry: string): string {
  const executable = join(root, entry, "chrome-linux", "chrome");
  mkdirSync(join(root, entry, "chrome-linux"), { recursive: true });
  writeFileSync(executable, "#!/bin/sh\necho 'Chromium 1.0.0.0'\n");
  chmodSync(executable, 0o755);
  return executable;
}

/**
 * Run with only the caches and pin this test names.
 *
 * HOME and LOCALAPPDATA are cleared to a scratch directory rather than left alone: a developer with
 * a real `~/.cache/ms-playwright` would otherwise contribute candidates these assertions counted.
 */
async function withBrowserEnv(
  env: { playwrightBrowsersPath?: string; browserPath?: string },
  run: () => Promise<void> | void
): Promise<void> {
  const emptyHome = await mkdtemp(join(tmpdir(), "shellx-motion-browser-home-"));
  tempDirs.push(emptyHome);
  const keys = ["PLAYWRIGHT" + "_BROWSERS_PATH", "SHELLX" + "_MOTION_BROWSER", "HOME", "LOCALAPPDATA"] as const;
  const previous = keys.map((key) => [key, process.env[key]] as const);
  const applied: Record<string, string | undefined> = {
    [keys[0]]: env.playwrightBrowsersPath,
    [keys[1]]: env.browserPath,
    [keys[2]]: emptyHome,
    [keys[3]]: join(emptyHome, "AppData")
  };
  for (const key of keys) {
    if (applied[key] === undefined) delete process.env[key];
    else process.env[key] = applied[key];
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A supplementary group this account is in but which is not its primary group, when one exists. */
function foreignGroupId(): number | null {
  if (typeof process.getgroups !== "function" || typeof process.getgid !== "function") return null;
  const primary = process.getgid();
  return process.getgroups().find((gid) => gid !== primary) ?? null;
}

const posixOnly = typeof process.getuid === "function";

describe("the Playwright cache scan orders builds numerically", () => {
  it("does NOT select a planted chromium-zz that outsorts every genuine build", async () => {
    const root = await cacheRoot();
    // `chromium-zz` > `chromium-999` > `chromium-1200` as STRINGS. The old comparator was
    // `.sort().reverse()`, so this entry won permanently — and the reviewer's PoC showed the
    // binary inside it being executed by a `read_motion` pre-flight.
    plantBuild(root, "chromium-zz");
    const genuine = plantBuild(root, "chromium-1200");

    await withBrowserEnv({ playwrightBrowsersPath: root }, () => {
      expect(findMotionBrowserExecutable()).toBe(genuine);
      expect(browserExecutableCandidates().some((path) => path.includes("chromium-zz"))).toBe(false);
      expect(resolveMotionBrowserExecutable().executable).toBe(genuine);
    });
  });

  it("compares build numbers, not their digits, so 1200 beats 999", async () => {
    const root = await cacheRoot();
    plantBuild(root, "chromium-999");
    const newest = plantBuild(root, "chromium-1200");

    await withBrowserEnv({ playwrightBrowsersPath: root }, () => {
      expect(findMotionBrowserExecutable()).toBe(newest);
    });
  });

  it("says WHY a `chromium-`-shaped directory was skipped, rather than ignoring it silently", async () => {
    const root = await cacheRoot();
    plantBuild(root, "chromium-zz");

    await withBrowserEnv({ playwrightBrowsersPath: root }, () => {
      expect(untrustedMotionBrowserCaches()).toEqual([{
        path: join(root, "chromium-zz"),
        label: "chromium-zz in the browser cache at PLAYWRIGHT_BROWSERS_PATH",
        reason: "its name is not `chromium-<build number>`, so Playwright did not create it"
      }]);
    });
  });

  it("leaves Playwright's own non-Chromium entries alone", async () => {
    const root = await cacheRoot();
    plantBuild(root, "firefox-1466");
    plantBuild(root, "chromium_headless_shell-1200");
    const genuine = plantBuild(root, "chromium-1200");

    await withBrowserEnv({ playwrightBrowsersPath: root }, () => {
      expect(findMotionBrowserExecutable()).toBe(genuine);
      // Neither is `chromium-<n>`, and neither was TRYING to be — so neither is a refusal to report.
      expect(untrustedMotionBrowserCaches()).toEqual([]);
    });
  });
});

describe.skipIf(!posixOnly)("the Playwright cache scan refuses directories other people can write", () => {
  it("refuses a world-writable cache root even when its build number is the highest", async () => {
    const root = await cacheRoot();
    plantBuild(root, "chromium-99999");
    chmodSync(root, 0o777);

    await withBrowserEnv({ playwrightBrowsersPath: root }, () => {
      // A numeric sort alone would have picked this. The shared CI/Docker/NFS cache the review
      // named is exactly this shape: writable by anyone, so its contents prove nothing.
      //
      // Asserted as "not this path" rather than "null", because a developer machine with a real
      // `/usr/bin/google-chrome` legitimately falls through to it — and that fall-through is the
      // correct outcome, not a second finding.
      expect(findMotionBrowserExecutable()).not.toContain(root);
      expect(browserExecutableCandidates().some((path) => path.startsWith(root))).toBe(false);
      expect(untrustedMotionBrowserCaches()).toEqual([{
        path: root,
        label: "the browser cache at PLAYWRIGHT_BROWSERS_PATH",
        reason: "it is world-writable"
      }]);
    });
  });

  it("refuses one world-writable build directory inside an otherwise-trusted root", async () => {
    const root = await cacheRoot();
    plantBuild(root, "chromium-99999");
    chmodSync(join(root, "chromium-99999"), 0o777);
    const genuine = plantBuild(root, "chromium-1200");

    await withBrowserEnv({ playwrightBrowsersPath: root }, () => {
      expect(findMotionBrowserExecutable()).toBe(genuine);
    });
  });

  it("refuses a build directory that is a symlink out of the cache", async () => {
    const root = await cacheRoot();
    const outside = await cacheRoot();
    plantBuild(outside, "evil");
    symlinkSync(join(outside, "evil"), join(root, "chromium-9999"));
    const genuine = plantBuild(root, "chromium-1200");

    await withBrowserEnv({ playwrightBrowsersPath: root }, () => {
      // `existsSync` and `spawn` both follow the link, so a containment check on the RESOLVED path
      // is the only thing standing between a trusted-looking cache and an arbitrary binary.
      expect(findMotionBrowserExecutable()).toBe(genuine);
      expect(untrustedMotionBrowserCaches()).toEqual([{
        path: join(root, "chromium-9999"),
        label: "chromium-9999 in the browser cache at PLAYWRIGHT_BROWSERS_PATH",
        reason: "it is a link that leaves the browser cache"
      }]);
    });
  });

  it("accepts a group-writable cache whose group is this account's own primary group", async () => {
    // The user-private-group layout every RPM-based distro ships with umask 002. Refusing it would
    // report "no browser" to a large share of legitimate Linux users, which is why the trust rule
    // carves it out explicitly rather than rejecting every g+w directory.
    const root = await cacheRoot();
    const genuine = plantBuild(root, "chromium-1200");
    chmodSync(root, 0o775);

    await withBrowserEnv({ playwrightBrowsersPath: root }, () => {
      expect(findMotionBrowserExecutable()).toBe(genuine);
    });
  });

  it("refuses a cache writable by a group that is NOT this account's primary group", async () => {
    const foreign = foreignGroupId();
    if (foreign === null) return; // No supplementary group on this host: nothing to assert against.
    const root = await cacheRoot();
    plantBuild(root, "chromium-1200");
    chownSync(root, process.getuid!(), foreign);
    chmodSync(root, 0o775);

    await withBrowserEnv({ playwrightBrowsersPath: root }, () => {
      expect(findMotionBrowserExecutable()).not.toContain(root);
      expect(untrustedMotionBrowserCaches()[0]?.reason).toMatch(/writable by group/);
    });
  });
});

describe("an explicit SHELLX_MOTION_BROWSER pin fails closed", () => {
  it("refuses to substitute a cached browser when the pin names a path with no file at it", async () => {
    const root = await cacheRoot();
    plantBuild(root, "chromium-1200");

    await withBrowserEnv({ playwrightBrowsersPath: root, browserPath: "/opt/shellx/chrom" }, () => {
      // THE finding: this used to return the cache entry and report `source: "path"`, so a
      // one-character typo silently handed control to whatever the scan ranked highest — and was
      // indistinguishable in the report from having set no pin at all.
      expect(findMotionBrowserExecutable()).toBe(null);
      expect(browserExecutableCandidates()).toEqual([]);
      const location = resolveMotionBrowserExecutable();
      expect(location.source).toBe("override");
      expect(location.executable).toBe("/opt/shellx/chrom");
      expect(location.problem).toContain("/opt/shellx/chrom");
      expect(location.problem).toMatch(/no file exists there/);
      expect(motionBrowserOverrideProblem()).toBe(location.problem);
    });
  });

  it("refuses a relative pin instead of resolving it two different ways", async () => {
    // `existsSync("./chrome")` is CWD-relative and `spawn("./chrome", {shell:false})` resolves
    // through PATH, so the probe and the launcher answered about different files — and `./chrome`
    // ran a binary out of whatever directory Motion started in.
    for (const value of ["./chrome", "chrome", "bin/chrome"]) {
      await withBrowserEnv({ browserPath: value }, () => {
        expect(findMotionBrowserExecutable()).toBe(null);
        expect(motionBrowserOverrideProblem()).toMatch(/not an absolute path/);
      });
    }
  });

  it("refuses a pin that names a directory rather than a program", async () => {
    const root = await cacheRoot();

    await withBrowserEnv({ browserPath: root }, () => {
      expect(findMotionBrowserExecutable()).toBe(null);
      expect(motionBrowserOverrideProblem()).toMatch(/no file exists there/);
    });
  });

  it("trims the pin in BOTH readers, so a padded value is still an override", async () => {
    const root = await cacheRoot();
    const pinned = join(root, "pinned-chrome");
    writeFileSync(pinned, "#!/bin/sh\nexit 0\n");
    chmodSync(pinned, 0o755);

    await withBrowserEnv({ browserPath: `  ${pinned}\t` }, () => {
      // `browserExecutableCandidates` read the RAW env value while `resolveMotionBrowserExecutable`
      // trimmed it, so the two could never be equal and a padded pin was silently demoted to
      // `source: "path"` — a pin honoured but reported as if it were not one.
      expect(findMotionBrowserExecutable()).toBe(pinned);
      expect(resolveMotionBrowserExecutable()).toEqual({ executable: pinned, source: "override" });
    });
  });

  it("still reports an override as an override when it is usable", async () => {
    const root = await cacheRoot();
    const pinned = join(root, "real-chrome");
    writeFileSync(pinned, "#!/bin/sh\nexit 0\n");
    chmodSync(pinned, 0o755);

    await withBrowserEnv({ browserPath: pinned }, () => {
      expect(motionBrowserOverrideProblem()).toBe(null);
      expect(resolveMotionBrowserExecutable().source).toBe("override");
    });
  });

  it("keeps the no-pin fallback: an absolute spawn target the probe can fail against", async () => {
    await withBrowserEnv({}, () => {
      const location = resolveMotionBrowserExecutable();
      // Never a bare name. A `chrome` on PATH that the launcher would not select must not be able
      // to answer the readiness probe green.
      expect(location.problem).toBeUndefined();
      expect(location.executable.startsWith("/") || /^[A-Za-z]:\\/.test(location.executable)).toBe(true);
    });
  });
});

describe("the trust rule itself", () => {
  it("accepts a directory only this account can write", async () => {
    const root = await cacheRoot();
    expect(untrustedExecutableDirectoryReason(root)).toBe(null);
  });

  it.skipIf(!posixOnly)("names each refusal so a caller can explain it", async () => {
    const root = await cacheRoot();
    chmodSync(root, 0o777);
    expect(untrustedExecutableDirectoryReason(root)).toBe("it is world-writable");
    chmodSync(root, 0o755);

    const file = join(root, "not-a-directory");
    writeFileSync(file, "x");
    expect(untrustedExecutableDirectoryReason(file)).toBe("it is not a directory");
    expect(untrustedExecutableDirectoryReason(join(root, "absent"))).toBe("it could not be resolved on this filesystem");
  });

  it.skipIf(!posixOnly)("treats the sticky bit as rescuing an ancestor and never a terminal directory", async () => {
    // The asymmetry is the whole rule. `/tmp` is 1777 and every `mkdtemp` fixture in this repo
    // lives under it, so a strict ancestor rule would refuse every legitimate temp install; sticky
    // is exactly the bit that forbids the rename substitution an ancestor would otherwise allow.
    // The attack on a TERMINAL directory is creating a new `chromium-99999` inside it, which sticky
    // does not forbid — so it buys nothing there.
    const root = await cacheRoot();
    const child = join(root, "child");
    mkdirSync(child);
    chmodSync(child, 0o755);

    chmodSync(root, 0o1777);
    expect(untrustedExecutableDirectoryReason(root)).toBe("it is world-writable");
    expect(untrustedExecutableDirectoryReason(child)).toBe(null);

    chmodSync(root, 0o777);
    expect(untrustedExecutableDirectoryReason(child)).toMatch(/one of its parent directories is untrusted/);
    // With the ancestor walk switched off, the same directory passes: the caller has taken
    // responsibility for having already validated the chain above it.
    expect(untrustedExecutableDirectoryReason(child, { ancestors: false })).toBe(null);
    chmodSync(root, 0o755);
  });

  it("resolves containment through symlinks and rejects a sibling with a shared prefix", async () => {
    const root = await cacheRoot();
    const sibling = `${root}-evil`;
    mkdirSync(sibling);
    tempDirs.push(sibling);
    mkdirSync(join(root, "inside"));
    symlinkSync(sibling, join(root, "escape"));

    expect(resolvesInside(root, join(root, "inside"))).toBe(true);
    expect(resolvesInside(root, root)).toBe(true);
    // A string prefix test would call both of these contained.
    expect(resolvesInside(root, join(root, "escape"))).toBe(false);
    expect(resolvesInside(root, sibling)).toBe(false);
  });
});
