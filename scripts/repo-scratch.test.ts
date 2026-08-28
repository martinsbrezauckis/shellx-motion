import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPrivateRepoScratchPath, RepoScratchError, preparePrivateRepoScratch } from "./repo-scratch.mjs";

const lstatTestState = vi.hoisted(() => ({ beforeLstat: undefined as undefined | ((path: string) => Promise<void>) }));

// The release helper intentionally rejects this managed host's uid-65534 system ancestors.  Keep
// production untouched: this test fixture models the ordinary host fact that / and /home are
// system-owned, while every repository and descendant check continues to use the real filesystem.
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    lstat: async (...args: Parameters<typeof original.lstat>) => {
      const path = typeof args[0] === "string" ? args[0] : "";
      await lstatTestState.beforeLstat?.(path);
      const facts = await original.lstat(...args);
      if (path !== "/" && path !== "/home") return facts;
      return new Proxy(facts, {
        get(target, property, receiver) {
          return property === "uid" ? 0 : Reflect.get(target, property, receiver);
        }
      });
    }
  };
});

const roots: string[] = [];
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

afterEach(async () => {
  lstatTestState.beforeLstat = undefined;
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function repositoryRoot(): Promise<string> {
  const root = await mkdtemp(join(REPOSITORY_ROOT, ".repo-scratch-test-"));
  roots.push(root);
  return root;
}

describe("private repository scratch preparation", () => {
  it.skipIf(process.platform === "win32")("creates a fresh release scratch at 0700 under umask 0002", async () => {
    const root = await repositoryRoot();
    const previousUmask = process.umask(0o002);
    try {
      const scratch = await preparePrivateRepoScratch(root);
      expect(scratch).toBe(join(root, ".scratch"));
      expect(Number((await lstat(scratch)).mode) & 0o777).toBe(0o700);
    } finally {
      process.umask(previousUmask);
    }
  });

  it.skipIf(process.platform === "win32")("creates an admitted nested profile root at 0700 under umask 0002", async () => {
    const root = await repositoryRoot();
    const scratch = await preparePrivateRepoScratch(root);
    const nested = join(scratch, "source-storyboard-cut-smoke");
    const previousUmask = process.umask(0o002);
    try {
      await assertPrivateRepoScratchPath(root, nested);
      await mkdir(nested, { recursive: true, mode: 0o700 });
      expect(Number((await lstat(nested)).mode) & 0o777).toBe(0o700);
    } finally {
      process.umask(previousUmask);
    }
  });

  it.skipIf(process.platform === "win32")("refuses an existing shared-writable scratch without mutating it", async () => {
    const root = await repositoryRoot();
    const scratch = join(root, ".scratch");
    await mkdir(scratch, { mode: 0o700 });
    await chmod(scratch, 0o775);
    const sentinel = join(scratch, "competitor.txt");
    await writeFile(sentinel, "keep", "utf8");
    const scratchBefore = await lstat(scratch);
    const sentinelBefore = await lstat(sentinel);

    await expect(preparePrivateRepoScratch(root)).rejects.toMatchObject<Partial<RepoScratchError>>({
      code: "repo_scratch_unsafe",
      path: scratch
    });
    const scratchAfter = await lstat(scratch);
    const sentinelAfter = await lstat(sentinel);
    expect(Number(scratchAfter.mode) & 0o777).toBe(0o775);
    expect([scratchAfter.dev, scratchAfter.ino]).toEqual([scratchBefore.dev, scratchBefore.ino]);
    expect([sentinelAfter.dev, sentinelAfter.ino]).toEqual([sentinelBefore.dev, sentinelBefore.ino]);
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  });

  it.skipIf(process.platform === "win32")("refuses a scratch symlink without touching its target", async () => {
    const root = await repositoryRoot();
    const target = join(root, "competitor");
    const scratch = join(root, ".scratch");
    await mkdir(target, { mode: 0o700 });
    const sentinel = join(target, "keep.txt");
    await writeFile(sentinel, "keep", "utf8");
    await symlink(target, scratch, "dir");
    const scratchBefore = await lstat(scratch);
    const sentinelBefore = await lstat(sentinel);

    await expect(preparePrivateRepoScratch(root)).rejects.toMatchObject<Partial<RepoScratchError>>({
      code: "repo_scratch_unsafe",
      path: scratch
    });
    const scratchAfter = await lstat(scratch);
    const sentinelAfter = await lstat(sentinel);
    expect(scratchAfter.isSymbolicLink()).toBe(true);
    expect([scratchAfter.dev, scratchAfter.ino]).toEqual([scratchBefore.dev, scratchBefore.ino]);
    expect([sentinelAfter.dev, sentinelAfter.ino]).toEqual([sentinelBefore.dev, sentinelBefore.ino]);
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  });

  it.skipIf(process.platform === "win32")("refuses a shared-writable repository ancestor before touching private scratch", async () => {
    const root = await repositoryRoot();
    const scratch = join(root, ".scratch");
    await mkdir(scratch, { mode: 0o700 });
    const sentinel = join(scratch, "competitor.txt");
    await writeFile(sentinel, "keep", "utf8");
    await chmod(root, 0o775);
    const rootBefore = await lstat(root);
    const scratchBefore = await lstat(scratch);
    const sentinelBefore = await lstat(sentinel);

    await expect(preparePrivateRepoScratch(root)).rejects.toMatchObject<Partial<RepoScratchError>>({
      code: "repo_scratch_unsafe",
      path: root
    });

    const rootAfter = await lstat(root);
    const scratchAfter = await lstat(scratch);
    const sentinelAfter = await lstat(sentinel);
    expect(Number(rootAfter.mode) & 0o777).toBe(0o775);
    expect([rootAfter.dev, rootAfter.ino]).toEqual([rootBefore.dev, rootBefore.ino]);
    expect([scratchAfter.dev, scratchAfter.ino]).toEqual([scratchBefore.dev, scratchBefore.ino]);
    expect([sentinelAfter.dev, sentinelAfter.ino]).toEqual([sentinelBefore.dev, sentinelBefore.ino]);
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  });

  it.skipIf(process.platform === "win32")("refuses an unsafe nested profile root without mutating its competitor content", async () => {
    const root = await repositoryRoot();
    const scratch = await preparePrivateRepoScratch(root);
    const nested = join(scratch, "source-storyboard-cut-smoke");
    await mkdir(nested, { mode: 0o700 });
    await chmod(nested, 0o775);
    const sentinel = join(nested, "competitor.txt");
    await writeFile(sentinel, "keep", "utf8");
    const nestedBefore = await lstat(nested);
    const sentinelBefore = await lstat(sentinel);

    await expect(assertPrivateRepoScratchPath(root, nested)).rejects.toMatchObject<Partial<RepoScratchError>>({
      code: "repo_scratch_unsafe",
      path: nested
    });

    const nestedAfter = await lstat(nested);
    const sentinelAfter = await lstat(sentinel);
    expect(Number(nestedAfter.mode) & 0o777).toBe(0o775);
    expect([nestedAfter.dev, nestedAfter.ino]).toEqual([nestedBefore.dev, nestedBefore.ino]);
    expect([sentinelAfter.dev, sentinelAfter.ino]).toEqual([sentinelBefore.dev, sentinelBefore.ino]);
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  });

  it.skipIf(process.platform === "win32")("refuses a retained repository-root replacement and preserves the admitted scratch", async () => {
    const root = await repositoryRoot();
    const retainedRoot = `${root}-retained`;
    roots.push(retainedRoot);
    const scratch = join(root, ".scratch");
    let rootLstatCalls = 0;
    let replaced = false;
    lstatTestState.beforeLstat = async (path) => {
      if (path !== root || ++rootLstatCalls !== 3) return;
      await rename(root, retainedRoot);
      await mkdir(root, { mode: 0o700 });
      replaced = true;
    };

    await expect(preparePrivateRepoScratch(root)).rejects.toMatchObject<Partial<RepoScratchError>>({
      code: "repo_scratch_unsafe",
      path: root
    });

    expect(replaced).toBe(true);
    expect((await lstat(join(retainedRoot, ".scratch"))).isDirectory()).toBe(true);
    await expect(lstat(scratch)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
