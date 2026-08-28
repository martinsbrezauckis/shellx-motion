import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { motionUserAccessPaths, readOrCreateRenderReuseProducerKey } from "./user-access.js";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("render-reuse producer key", () => {
  it("creates one private durable key and reads the same bytes on the next start", async () => {
    const root = await scratch();
    const paths = motionUserAccessPaths(root);
    const first = await readOrCreateRenderReuseProducerKey(paths);
    const second = await readOrCreateRenderReuseProducerKey(paths);
    expect(first).toEqual(second);
    expect(first.byteLength).toBe(32);
    expect((await lstat(paths.renderReuseProducerKeyFile)).isFile()).toBe(true);
    expect((await readFile(paths.renderReuseProducerKeyFile, "utf8")).trim()).not.toContain(first.toString("hex"));
  });

  it("refuses an invalid or linked key instead of replacing it", async () => {
    const invalidRoot = await scratch();
    const invalid = motionUserAccessPaths(invalidRoot);
    await writeFile(invalid.renderReuseProducerKeyFile, "not-a-key\n", { mode: 0o600 });
    await expect(readOrCreateRenderReuseProducerKey(invalid)).rejects.toThrow(/invalid/u);

    const linkedRoot = await scratch();
    const linked = motionUserAccessPaths(linkedRoot);
    await symlink(invalid.renderReuseProducerKeyFile, linked.renderReuseProducerKeyFile);
    await expect(readOrCreateRenderReuseProducerKey(linked)).rejects.toThrow(/regular file/u);
  });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-render-reuse-key-"));
  roots.push(root);
  return root;
}
