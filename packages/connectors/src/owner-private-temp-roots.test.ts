import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnerPrivateTempRoots } from "./owner-private-temp-roots.test-support";

const roots = createOwnerPrivateTempRoots();
afterEach(async () => await roots.cleanup());

describe("owner-private connector fixture roots", () => {
  it("creates a direct owner-private OS-temp child", async () => {
    const root = await roots.create("owner-check");
    const facts = await lstat(root);

    expect(dirname(root)).toBe(resolve(tmpdir()));
    expect(facts.isDirectory()).toBe(true);
    expect(facts.isSymbolicLink()).toBe(false);
    if (process.platform !== "win32") {
      expect(facts.uid).toBe(process.getuid?.());
      expect(facts.mode & 0o777).toBe(0o700);
    }
  });

  it("rejects unsafe labels before they can become cleanup targets", async () => {
    await expect(roots.create("../outside")).rejects.toThrow(/unsafe connector test-temp label/i);
  });

  it("removes every tracked root and asserts its absence", async () => {
    const root = await roots.create("cleanup-check");
    await roots.cleanup();
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
