/**
 * Contract tests for the browser render package fingerprint.
 *
 * The fingerprint is the session's identity for a prepared render package: it is compared across
 * processes and machines to decide whether the bytes a browser session is about to load are the
 * bytes that were checked. That makes locale-independence a correctness property, not a nicety.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browserPackageFingerprint } from "./browser-package-safety";

const roots: string[] = [];

/** Directory whose entry names are the strings different locales order differently. */
async function writeProbeTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-browser-fingerprint-"));
  roots.push(root);
  // "a" / "ä" / "z": en-US collates ä between a and z, sv-SE puts it after z.
  // "i1" / "I2": tr-TR orders dotted and dotless i differently from every other locale.
  await writeFile(join(root, "a.txt"), "alpha", "utf8");
  await writeFile(join(root, "ä.txt"), "a-umlaut", "utf8");
  await writeFile(join(root, "z.txt"), "zed", "utf8");
  await writeFile(join(root, "i1.txt"), "i-one", "utf8");
  await writeFile(join(root, "I2.txt"), "I-two", "utf8");
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "nested", "ä.txt"), "nested-a-umlaut", "utf8");
  await writeFile(join(root, "nested", "z.txt"), "nested-zed", "utf8");
  return root;
}

/**
 * Run `body` with every locale-sensitive global replaced by a thrower.
 *
 * Stronger and more portable than re-running under a set of `LC_ALL` values: it proves the code
 * path never CONSULTS the locale, and does not depend on which locale data the CI image ships.
 */
async function withLocaleTrap<T>(body: () => Promise<T>): Promise<T> {
  const globals = globalThis as Record<string, unknown>;
  const savedIntl = globals.Intl;
  const savedCompare = String.prototype.localeCompare;
  const boom = () => { throw new Error("locale-sensitive path reached from the package fingerprint"); };
  try {
    globals.Intl = new Proxy({}, { get: boom, has: boom, apply: boom });
    String.prototype.localeCompare = boom as typeof String.prototype.localeCompare;
    return await body();
  } finally {
    globals.Intl = savedIntl;
    String.prototype.localeCompare = savedCompare;
  }
}

describe("browser package fingerprint", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("fingerprints the same tree identically regardless of the host locale", async () => {
    // Regression for a reproduced defect: the directory walk was ordered with
    // `String.prototype.localeCompare`, and that order IS the `path\0size\0hash` record list the
    // fingerprint hashes. Live probe on one machine, same tree: 1380b63d… under en_US.UTF-8,
    // 70ad8f6c… under sv_SE.UTF-8, f4d0b7df… under tr_TR.UTF-8.
    const root = await writeProbeTree();
    const baseline = await browserPackageFingerprint(root);
    expect(await withLocaleTrap(() => browserPackageFingerprint(root))).toBe(baseline);
    expect(baseline).toMatch(/^[a-f0-9]{64}$/);
  });

  it("still refuses a symlink inside the package", async ({ skip }) => {
    // The comparator change must not have loosened the walk's safety checks.
    const { symlink } = await import("node:fs/promises");
    const root = await writeProbeTree();
    try {
      await symlink(join(root, "a.txt"), join(root, "link.txt"));
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        skip("The standard Windows test account cannot create symbolic links; covered on symlink-capable hosts.");
      }
      throw error;
    }
    await expect(browserPackageFingerprint(root)).rejects.toThrow("symbolic link");
  });
});
