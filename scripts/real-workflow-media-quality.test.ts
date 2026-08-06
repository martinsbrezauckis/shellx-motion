/**
 * Coverage for where a finished real-workflow demo is allowed to land.
 *
 * The destination must not default to one operator's mounted-drive layout. Two properties are
 * pinned here: a local path must not be disclosed, and the workflow must remain portable across
 * development environment to anyone reading the repository, and on a machine that is not that one
 * the recursive `mkdir` happily created a `/mnt/c/...` tree and hid the demo in it.
 *
 * The fix is that there is no default at all, so these tests assert an absence. That is worth
 * stating explicitly: a test that only checked "the default is not the WSL path" would pass again
 * the moment someone substitutes a different hardcoded home directory.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveWindowsDownloadsRoot, WINDOWS_DOWNLOADS_ENV } from "./real-workflow-media-quality";

describe("real-workflow demo destination", () => {
  it("refuses to invent a destination when none is configured", () => {
    expect(() => resolveWindowsDownloadsRoot({})).toThrow(/is not set/);
    // Empty and whitespace-only count as unset: `FOO= pnpm run ...` must not resolve to the
    // process working directory, which is what a bare truthiness check would have allowed.
    expect(() => resolveWindowsDownloadsRoot({ [WINDOWS_DOWNLOADS_ENV]: "" })).toThrow(/is not set/);
    expect(() => resolveWindowsDownloadsRoot({ [WINDOWS_DOWNLOADS_ENV]: "   " })).toThrow(/is not set/);
  });

  it("names the variable to set in the failure, not just the fact of failing", () => {
    // The script fails after a full render, so the message is the only thing standing between the
    // operator and re-running the whole workflow to find out what was missing.
    expect(() => resolveWindowsDownloadsRoot({})).toThrow(new RegExp(WINDOWS_DOWNLOADS_ENV));
  });

  it("takes an absolute configured path verbatim", () => {
    expect(resolveWindowsDownloadsRoot({ [WINDOWS_DOWNLOADS_ENV]: "/mnt/c/Users/Example/Downloads/demos" }))
      .toBe("/mnt/c/Users/Example/Downloads/demos");
    expect(resolveWindowsDownloadsRoot({ [WINDOWS_DOWNLOADS_ENV]: " /var/tmp/demos " })).toBe("/var/tmp/demos");
  });

  it("refuses a relative path rather than anchoring it at the working directory", () => {
    expect(() => resolveWindowsDownloadsRoot({ [WINDOWS_DOWNLOADS_ENV]: "demos" })).toThrow(/absolute path/);
    expect(() => resolveWindowsDownloadsRoot({ [WINDOWS_DOWNLOADS_ENV]: "../demos" })).toThrow(/absolute path/);
  });

  it("keeps no host path anywhere in the module source", () => {
    // The finding is about a literal in shipped source, so the regression check reads the source.
    // A unit test over the resolver alone cannot see a hardcoded path reintroduced elsewhere in
    // the file — a fallback inside copyToWindowsDownloads, say.
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "real-workflow-media-quality.ts"), "utf8");
    // Matches a named home directory followed by a further segment: `/home/<user>/x`,
    // `/Users/<user>/x`, `/mnt/<drive>/Users/<user>/x`, `C:\Users\<user>`. The angle-bracket
    // placeholders this module uses in its prose and its error message do not match, which is the
    // point — describing the removed default must not be what trips the guard against it.
    const hostPaths = source.match(/(?:\/mnt\/[a-z])?\/(?:home|Users)\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g) ?? [];
    expect(hostPaths).toEqual([]);
  });
});
