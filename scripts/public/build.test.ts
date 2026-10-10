/**
 * `build.mjs` checks launcher mode only where POSIX uses it for direct execution.
 * Windows ships the repository-owned `.mjs` launcher as source, so the file must exist and
 * remain regular, but its non-portable POSIX executable bit is not a build gate.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assertExecutableRuntimeAsset } from "./build.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function nonExecutableLauncher(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-build-launcher-"));
  roots.push(root);
  const launcher = join(root, "enforced-untrusted-browser-launcher.mjs");
  await writeFile(launcher, "#!/usr/bin/env node\n", "utf8");
  await chmod(launcher, 0o644);
  return launcher;
}

const rendererBrowser = { name: "@shellx-motion/renderer-browser" };

describe("assertExecutableRuntimeAsset", () => {
  it("accepts a regular source launcher without POSIX execute bits on Windows", async () => {
    const launcher = await nonExecutableLauncher();

    expect(() => assertExecutableRuntimeAsset(rendererBrowser, launcher, "win32")).not.toThrow();
  });

  it.each(["linux", "darwin"] as const)("rejects a source launcher without POSIX execute bits on %s", async (platform) => {
    const launcher = await nonExecutableLauncher();

    expect(() => assertExecutableRuntimeAsset(rendererBrowser, launcher, platform)).toThrow(
      "runtime launcher must be a source executable"
    );
  });

  it("still rejects a non-file launcher on Windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-build-launcher-directory-"));
    roots.push(root);
    const launcherDirectory = join(root, "enforced-untrusted-browser-launcher.mjs");
    await mkdir(launcherDirectory);

    expect(() => assertExecutableRuntimeAsset(rendererBrowser, launcherDirectory, "win32")).toThrow(
      "runtime launcher must be a source executable"
    );
  });
});
