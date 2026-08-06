/**
 * A package identifier is a PATH COMPONENT, and both the input and the sink must treat it as one.
 *
 * Role: pins the package-id path boundary. `manifest.id` is joined onto the frames root:
 *
 *     const framesDir = join(framesRoot, pkg.manifest.id);
 *
 * Two independent layers are asserted here because either alone is a single point of failure:
 *
 *   1. the LOADER refuses a traversing id, which closes the known vector;
 *   2. the SINK refuses a path outside its root whatever the input did, which closes the class --
 *      any future field joined onto a path lands there, and a containment check at the sink cannot
 *      be forgotten by the next caller the way input validation can.
 *
 * Dependencies: `./package` (loader), `./output-dir-guard` (sink). Primary caller: `pnpm test` in
 * `packages/core`.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMotionPackage } from "./package";
import { prepareFramesDir } from "./output-dir-guard";

const FIXTURE = resolve(import.meta.dirname, "../../../fixtures/packages/lower-third");

/** Copy the real fixture and give it an attacker-chosen id. */
async function packageWithId(id: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-pkg-id-"));
  const packageRoot = join(root, "pkg");
  await mkdir(packageRoot, { recursive: true });
  for (const name of ["manifest.json", "motion.json"]) {
    const text = await readFile(join(FIXTURE, name), "utf8");
    if (name === "manifest.json") {
      const manifest = JSON.parse(text) as Record<string, unknown>;
      manifest.id = id;
      await writeFile(join(packageRoot, name), JSON.stringify(manifest, null, 2), "utf8");
    } else {
      await writeFile(join(packageRoot, name), text, "utf8");
    }
  }
  return packageRoot;
}

describe("package id path safety", () => {
  it("refuses a manifest id that would traverse out of its directory", async () => {
    for (const id of ["../victim", "../../etc", "a/b", "..", ".", "/abs", "a\\b", "-leading-dash-ok-but-not-slash/x"]) {
      const packageRoot = await packageWithId(id);
      try {
        await expect(loadMotionPackage(packageRoot), `id ${JSON.stringify(id)} must be refused`)
          .rejects.toThrow(/manifest\.id must be a single path-safe component/);
      } finally {
        await rm(resolve(packageRoot, ".."), { recursive: true, force: true });
      }
    }
  });

  it("still accepts the identifiers real packages use", async () => {
    for (const id of ["pkg_lower_third", "pkg-shellx-media-launch", "pkg.v2", "A1"]) {
      const packageRoot = await packageWithId(id);
      try {
        const pkg = await loadMotionPackage(packageRoot);
        expect(pkg.manifest.id).toBe(id);
      } finally {
        await rm(resolve(packageRoot, ".."), { recursive: true, force: true });
      }
    }
  });

  it("refuses to prepare a frames directory outside its root, and deletes nothing", async () => {
    // The sink's own guarantee, tested WITHOUT the loader: this is what protects a path built from
    // some other unvalidated field in future. `callerSupplied: false` is the branch that wipes with
    // no evidence, so it is the one that must refuse first.
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-frames-root-"));
    const framesRoot = join(root, "frames");
    const victim = join(root, "victim");
    await mkdir(framesRoot, { recursive: true });
    await mkdir(victim, { recursive: true });
    await writeFile(join(victim, "important.txt"), "IRREPLACEABLE", "utf8");
    try {
      const escaping = join(framesRoot, "..", "victim");

      const result = await prepareFramesDir(escaping, { force: false, callerSupplied: false, withinRoot: framesRoot });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("frames_dir_escapes_root");
      expect(existsSync(join(victim, "important.txt")), "the guard must not have deleted anything").toBe(true);

      // --force is "wipe the directory I named", never "wipe wherever this resolves to".
      const forced = await prepareFramesDir(escaping, { force: true, callerSupplied: true, withinRoot: framesRoot });
      expect(forced.ok).toBe(false);
      expect(existsSync(join(victim, "important.txt")), "--force must not license an escaping path").toBe(true);

      // A path genuinely inside the root still works, or the guard would be a wall.
      const inside = await prepareFramesDir(join(framesRoot, "pkg_ok"), { force: false, callerSupplied: false, withinRoot: framesRoot });
      expect(inside.ok).toBe(true);
      expect(existsSync(join(framesRoot, "pkg_ok"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
