/**
 * Direct behaviour tests for `createMotionPackage` — the agent cold-start command.
 *
 * This function once had no direct test at all; the only coverage
 * was an MCP test proving the action could be *discovered*. The two defects that mattered were
 * invisible to that: a check-then-write race (two creators both saw an empty directory and both
 * wrote into it) and partial publication (an interruption between the two `writeFile` calls left a
 * directory holding half a package, which reads as broken rather than absent).
 *
 * So the suite is built around the two properties that had to change — publication is atomic, and
 * concurrent creation has exactly one winner — plus the ordinary contract that was previously
 * asserted only through the CLI.
 *
 * The remaining command-and-creation cases use the same shape of proof: the
 * input that used to be accepted, and the thing that used to refuse it later. Bounds are asserted
 * against `MOTION_DOCUMENT_LIMITS` rather than against literals on purpose — a test that hard-codes
 * 7680 passes just as happily when the limit and the renderer stop agreeing.
 *
 * Dependencies: `./package-create`, `./validate` + `./schema` for the "it validates as authored"
 * claim, `./job-governor` for the limits, and node:fs. Temp directories are created under the OS
 * temp dir and removed in `afterEach`.
 */
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MOTION_DOCUMENT_LIMITS, motionDocumentFrameCount } from "./job-governor";
import { createMotionPackage } from "./package-create";
import { loadSchema, validateDocument } from "./validate";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-create-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Staging directories are dot-prefixed; a clean run leaves none of them behind. */
async function stagingLeftovers(parent: string): Promise<string[]> {
  return (await readdir(parent)).filter((entry) => entry.startsWith(".shellx-motion-stage-"));
}

describe("createMotionPackage", () => {
  it("publishes a package that validates as authored", async () => {
    const parent = await temporaryRoot();
    const packageRoot = join(parent, "hero");

    const result = await createMotionPackage({ packageRoot, name: "Launch Hero", width: 1280, height: 720, fps: 25, durationMs: 4000 });

    expect(result).toMatchObject({
      name: "Launch Hero",
      width: 1280,
      height: 720,
      fps: 25,
      durationMs: 4000,
      layerCount: 1,
      files: ["motion.json", "manifest.json", "assets/"]
    });
    // The readable stem still comes from the name; the suffix is what makes it this package's id.
    expect(result.packageId).toMatch(/^pkg_launch_hero_[0-9a-f]{16}$/);
    expect(result.motionId).toMatch(/^motion_launch_hero_[0-9a-f]{16}$/);
    expect((await readdir(packageRoot)).sort()).toEqual(["assets", "manifest.json", "motion.json"]);
    expect(await stagingLeftovers(parent)).toEqual([]);

    const motion = JSON.parse(await readFile(join(packageRoot, "motion.json"), "utf8"));
    const validation = await validateDocument(await loadSchema("motion"), motion);
    expect(validation.ok).toBe(true);
  });

  it("creates missing parent directories", async () => {
    const parent = await temporaryRoot();
    const packageRoot = join(parent, "nested", "deeper", "pkg");

    await createMotionPackage({ packageRoot });

    expect((await readdir(packageRoot)).sort()).toEqual(["assets", "manifest.json", "motion.json"]);
  });

  it("accepts a target directory the caller already created, as long as it is empty", async () => {
    const parent = await temporaryRoot();
    const packageRoot = join(parent, "pre-made");
    await mkdir(packageRoot, { recursive: true, mode: 0o700 });

    await createMotionPackage({ packageRoot });

    expect((await readdir(packageRoot)).sort()).toEqual(["assets", "manifest.json", "motion.json"]);
  });

  it("refuses a non-empty directory without touching what is there", async () => {
    const parent = await temporaryRoot();
    const packageRoot = join(parent, "occupied");
    await mkdir(packageRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(packageRoot, "motion.json"), "{\"existing\":true}\n", "utf8");

    await expect(createMotionPackage({ packageRoot })).rejects.toThrow(/not empty/i);

    expect(JSON.parse(await readFile(join(packageRoot, "motion.json"), "utf8"))).toEqual({ existing: true });
    expect(await stagingLeftovers(parent)).toEqual([]);
  });

  it("refuses a path occupied by a file", async () => {
    const parent = await temporaryRoot();
    const packageRoot = join(parent, "taken");
    await writeFile(packageRoot, "not a directory\n", "utf8");

    await expect(createMotionPackage({ packageRoot })).rejects.toThrow(/not a directory/i);
    expect(await readFile(packageRoot, "utf8")).toBe("not a directory\n");
  });

  it("refuses a symbolic-link package destination without following it", async () => {
    const parent = await temporaryRoot();
    const packageRoot = join(parent, "linked-package");
    const outside = join(parent, "caller-owned");
    await mkdir(outside);
    await writeFile(join(outside, "marker.txt"), "caller-owned", "utf8");
    await symlink(outside, packageRoot, process.platform === "win32" ? "junction" : "dir");

    await expect(createMotionPackage({ packageRoot })).rejects.toThrow(/not a directory/i);

    await expect(readFile(join(outside, "marker.txt"), "utf8")).resolves.toBe("caller-owned");
    expect(await stagingLeftovers(parent)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("refuses an unsafe output parent before it creates a package stage", async () => {
    const parent = await temporaryRoot();
    const unsafeParent = join(parent, "unsafe");
    const packageRoot = join(unsafeParent, "package");
    await mkdir(unsafeParent, { mode: 0o777 });
    await chmod(unsafeParent, 0o777);

    await expect(createMotionPackage({ packageRoot })).rejects.toThrow(/topology is unsafe|writable/i);

    await expect(lstat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(unsafeParent)).toEqual([]);
  });

  it("preserves a retargeted stage rather than recursively cleaning a caller replacement", async () => {
    const parent = await temporaryRoot();
    const packageRoot = join(parent, "package");
    const retainedStage = join(parent, "retained-stage");

    await expect(createMotionPackage({ packageRoot }, {
      beforeCommit: async (stagingPath) => {
        await rename(stagingPath, retainedStage);
        await mkdir(stagingPath, { mode: 0o700 });
        await writeFile(join(stagingPath, "replacement.txt"), "caller replacement", "utf8");
      }
    })).rejects.toThrow(/changed after Motion captured its identity/i);

    await expect(readFile(join(retainedStage, "manifest.json"), "utf8")).resolves.toContain('"schema": "shellx-motion/package-manifest@1"');
    const replacement = (await readdir(parent)).find((entry) => entry.startsWith(".package.shellx-motion-stage-"));
    expect(replacement).toBeDefined();
    await expect(readFile(join(parent, replacement!, "replacement.txt"), "utf8")).resolves.toBe("caller replacement");
    await expect(lstat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects non-positive resource inputs before creating anything", async () => {
    const parent = await temporaryRoot();
    const packageRoot = join(parent, "invalid");

    await expect(createMotionPackage({ packageRoot, width: 0 })).rejects.toThrow(/width must be an integer from 1 to/);
    await expect(createMotionPackage({ packageRoot, fps: -1 })).rejects.toThrow(/fps must be a number from 1 to/);
    await expect(readdir(packageRoot)).rejects.toThrow();
    expect(await stagingLeftovers(parent)).toEqual([]);
  });

  /**
   * the command-and-creation contract defect 1. Before this, `createMotionPackage({ width: 100000, height: 100000 })` reported
   * success, `motion.package.validate` called the result valid, and the agent's next command —
   * `motion.preview.frame` — exited with an unhandled `LocalMotionJobError` stack trace from
   * `assertLocalMotionFrameBudget`. The bounds below are read from the same constant the renderers
   * are bounded by, so this suite fails if the two ever stop meaning the same thing.
   */
  describe("resource bounds", () => {
    const limits = MOTION_DOCUMENT_LIMITS;

    it("refuses a frame larger than any lane renders, naming the range", async () => {
      const parent = await temporaryRoot();

      await expect(createMotionPackage({ packageRoot: join(parent, "wide"), width: limits.maxDimension + 1 }))
        .rejects.toThrow(`Motion package width must be an integer from 1 to ${limits.maxDimension}; received ${limits.maxDimension + 1}.`);
      await expect(createMotionPackage({ packageRoot: join(parent, "tall"), height: limits.maxDimension + 1 }))
        .rejects.toThrow(`Motion package height must be an integer from 1 to ${limits.maxDimension}; received ${limits.maxDimension + 1}.`);
      // Both sides legal, the frame is not: 7680x7680 is 58.9M pixels against a 33.2M ceiling.
      await expect(createMotionPackage({ packageRoot: join(parent, "square"), width: limits.maxDimension, height: limits.maxDimension }))
        .rejects.toThrow(new RegExp(`renders at most ${limits.maxFramePixels} pixels per frame`));
      expect(await readdir(parent)).toEqual([]);
    });

    it("refuses a frame rate outside the window every authoring path shares", async () => {
      const parent = await temporaryRoot();

      await expect(createMotionPackage({ packageRoot: join(parent, "fast"), fps: limits.maxFps + 1 }))
        .rejects.toThrow(`Motion package fps must be a number from ${limits.minFps} to ${limits.maxFps}; received ${limits.maxFps + 1}.`);
      await expect(createMotionPackage({ packageRoot: join(parent, "slow"), fps: 0.5 }))
        .rejects.toThrow(/fps must be a number from 1 to 120/);
      expect(await readdir(parent)).toEqual([]);
    });

    it("refuses a duration whose frame count exceeds the render budget, quoting the caller's own fps", async () => {
      const parent = await temporaryRoot();
      const fps = 60;
      const overBudgetMs = ((limits.maxFrames + 1) * 1_000) / fps;

      // The message must name the limit at 60 fps (600000ms), not the 1-fps headline number: an
      // agent told "at most 36000000ms" while authoring at 60 fps would retry and fail again.
      await expect(createMotionPackage({ packageRoot: join(parent, "long"), fps, durationMs: overBudgetMs }))
        .rejects.toThrow(`so at ${fps} fps the longest document is ${(limits.maxFrames * 1_000) / fps}ms`);
      await expect(createMotionPackage({ packageRoot: join(parent, "endless"), durationMs: Number.POSITIVE_INFINITY }))
        .rejects.toThrow(/durationMs must be a number greater than 0/);
      expect(await readdir(parent)).toEqual([]);
    });

    it("refuses a document that fits every single limit but blows the pixel-frame budget", async () => {
      const parent = await temporaryRoot();
      // 4K for 20 minutes: 3840x2160 is a legal frame, 30 is a legal fps, 36000 frames is the exact
      // frame ceiling — and together they are 298 billion pixel-frames against an 80 billion budget.
      await expect(createMotionPackage({
        packageRoot: join(parent, "uhd-marathon"),
        width: 3_840,
        height: 2_160,
        fps: 30,
        durationMs: 1_200_000
      })).rejects.toThrow(new RegExp(`renders at most ${limits.maxPixelFrames}`));
      expect(await readdir(parent)).toEqual([]);
    });

    it("accepts the ceiling itself, so the bound is the limit and not a margin below it", async () => {
      const parent = await temporaryRoot();

      const widest = await createMotionPackage({
        packageRoot: join(parent, "widest"),
        width: limits.maxDimension,
        height: limits.maxFramePixels / limits.maxDimension,
        durationMs: 1_000
      });
      expect(widest.width * widest.height).toBe(limits.maxFramePixels);

      const longest = await createMotionPackage({
        packageRoot: join(parent, "longest"),
        fps: limits.maxFps,
        durationMs: (limits.maxFrames * 1_000) / limits.maxFps,
        width: 640,
        height: 360
      });
      expect(motionDocumentFrameCount(longest.durationMs, longest.fps)).toBe(limits.maxFrames);
    });

    it("refuses a name long enough to be a payload rather than a name", async () => {
      const parent = await temporaryRoot();

      await expect(createMotionPackage({ packageRoot: join(parent, "novel"), name: "x".repeat(129) }))
        .rejects.toThrow("Motion package name must be at most 128 characters; received 129.");
      expect(await readdir(parent)).toEqual([]);
    });
  });

  /**
   * the command-and-creation contract defect 2. `background` was copied through as any string. `midnightblue` is a real CSS
   * colour that Motion does not resolve: the native lane failed the first preview with "Unsupported
   * color format: midnightblue", and the browser lane silently substituted transparent — a wrong
   * picture with no error at all, which is the worse of the two.
   */
  describe("background", () => {
    it("refuses a colour no lane resolves, and names the forms that work", async () => {
      const parent = await temporaryRoot();

      await expect(createMotionPackage({ packageRoot: join(parent, "css-name"), background: "midnightblue" }))
        .rejects.toThrow(/background must be a colour Motion renders/);
      // The advice has to carry the alternatives, not just the verdict.
      await expect(createMotionPackage({ packageRoot: join(parent, "css-name-2"), background: "midnightblue" }))
        .rejects.toThrow(/#rrggbb.*rgb\(\).*transparent.*navy/s);
      await expect(createMotionPackage({ packageRoot: join(parent, "garbage"), background: "not a colour; <script>" }))
        .rejects.toThrow(/background must be a colour Motion renders/);
      await expect(createMotionPackage({ packageRoot: join(parent, "blank"), background: "   " }))
        .rejects.toThrow(/background must be a colour Motion renders/);
      expect(await readdir(parent)).toEqual([]);
    });

    it("accepts every form the renderers accept, and stores it trimmed", async () => {
      const parent = await temporaryRoot();
      const accepted = ["#0b1020", "#fff", "#11223344", "rgba(10, 20, 30, 0.5)", "hsl(210 40% 12%)", "navy", "transparent"];

      for (const [index, background] of accepted.entries()) {
        const created = await createMotionPackage({ packageRoot: join(parent, `bg-${index}`), background: `  ${background}  ` });
        const motion = JSON.parse(await readFile(join(created.packageRoot, "motion.json"), "utf8"));
        expect(motion.background).toBe(background);
      }
    });
  });

  /**
   * the command-and-creation contract defect 3. Ids were a fold of the human name, so every unnamed package on the machine was
   * `pkg_untitled_motion` and receipts, caches and host lineage could not tell two of them apart.
   *
   * The alphabet assertion is the important one. `job-id-file.ts` records the collision risk
   * earlier the same day: ids that differ only in case are ONE id on Windows and macOS, where the
   * filesystem folds case, so one caller's evidence overwrites another's. Lowercase-only ids make
   * that unreachable rather than merely unlikely.
   */
  describe("identity", () => {
    it("gives two identically-named packages different ids", async () => {
      const parent = await temporaryRoot();

      const first = await createMotionPackage({ packageRoot: join(parent, "team-a") });
      const second = await createMotionPackage({ packageRoot: join(parent, "team-b") });

      expect(first.packageId).not.toBe(second.packageId);
      expect(first.motionId).not.toBe(second.motionId);
      expect(first.name).toBe(second.name);
      // The two documents on disk carry the same distinct ids the caller was told about.
      const manifest = JSON.parse(await readFile(join(parent, "team-a", "manifest.json"), "utf8"));
      const motion = JSON.parse(await readFile(join(parent, "team-a", "motion.json"), "utf8"));
      expect(manifest.id).toBe(first.packageId);
      expect(motion.id).toBe(first.motionId);
    });

    it("keeps ids inside an alphabet a case-insensitive filesystem cannot fold together", async () => {
      const parent = await temporaryRoot();

      const mixed = await createMotionPackage({ packageRoot: join(parent, "mixed"), name: "Launch Hero" });
      const shouty = await createMotionPackage({ packageRoot: join(parent, "shouty"), name: "LAUNCH-HERO" });
      const symbols = await createMotionPackage({ packageRoot: join(parent, "symbols"), name: "Ünïcode ✦ Piece" });

      for (const created of [mixed, shouty, symbols]) {
        expect(created.packageId).toMatch(/^[a-z0-9_]{1,96}$/);
        expect(created.motionId).toMatch(/^[a-z0-9_]{1,96}$/);
        expect(created.packageId.toLowerCase()).toBe(created.packageId);
      }
      // Two names that fold to one readable stem must still be two packages.
      expect(mixed.packageId.startsWith("pkg_launch_hero_")).toBe(true);
      expect(shouty.packageId.startsWith("pkg_launch_hero_")).toBe(true);
      expect(mixed.packageId).not.toBe(shouty.packageId);
    });

    it("pairs the manifest and motion ids so lineage can join them", async () => {
      const parent = await temporaryRoot();

      const created = await createMotionPackage({ packageRoot: join(parent, "paired"), name: "Paired" }, {
        uniqueSuffix: () => "0123456789abcdef"
      });

      expect(created.packageId).toBe("pkg_paired_0123456789abcdef");
      expect(created.motionId).toBe("motion_paired_0123456789abcdef");
    });

    it("refuses an id outside the alphabet instead of writing it", async () => {
      const parent = await temporaryRoot();

      // The seam is test-only, but it is the one place an id shape can be introduced, so it is held
      // to the same rule production is: an uppercase suffix would reintroduce the case-fold hazard.
      await expect(createMotionPackage({ packageRoot: join(parent, "shouty-id") }, { uniqueSuffix: () => "ABCDEF" }))
        .rejects.toThrow(/id must be 1\.\.96 characters of lowercase letters, digits or underscore/);
      await expect(readdir(join(parent, "shouty-id"))).rejects.toThrow();
      expect(await stagingLeftovers(parent)).toEqual([]);
    });

    // Each package creation performs native route-authority checks. The 500-publication randomness
    // soak is covered on POSIX; Windows retains ordinary same-name uniqueness coverage above.
    it.skipIf(process.platform === "win32")("mints 500 ids without a repeat", async () => {
      const parent = await temporaryRoot();
      const ids = new Set<string>();

      for (let index = 0; index < 500; index += 1) {
        ids.add((await createMotionPackage({ packageRoot: join(parent, String(index)) })).packageId);
      }

      expect(ids.size).toBe(500);
    });
  });

  it("gives exactly one winner when two creators race on the same path", async () => {
    const parent = await temporaryRoot();
    const packageRoot = join(parent, "contested");

    const outcomes = await Promise.allSettled([
      createMotionPackage({ packageRoot, name: "First Creator", width: 1920, height: 1080 }),
      createMotionPackage({ packageRoot, name: "Second Creator", width: 640, height: 360 })
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The published package must be ONE creator's work end to end — the old check-then-write could
    // interleave, leaving one creator's motion.json beside the other's manifest.json.
    const motion = JSON.parse(await readFile(join(packageRoot, "motion.json"), "utf8"));
    const manifest = JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8"));
    const winner = fulfilled[0].status === "fulfilled" ? fulfilled[0].value : undefined;
    expect(winner).toBeDefined();
    expect(motion.name).toBe(winner?.name);
    expect(manifest.name).toBe(winner?.name);
    expect(motion.id).toBe(winner?.motionId);
    expect(manifest.id).toBe(winner?.packageId);
    expect(motion.width).toBe(winner?.width);
    expect((await readdir(packageRoot)).sort()).toEqual(["assets", "manifest.json", "motion.json"]);
    expect(await stagingLeftovers(parent)).toEqual([]);
  });

  it("survives eight concurrent creators with one published package and no leftovers", async () => {
    const parent = await temporaryRoot();
    const packageRoot = join(parent, "stampede");

    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, (_unused, index) => createMotionPackage({ packageRoot, name: `Creator ${index}` }))
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect((await readdir(packageRoot)).sort()).toEqual(["assets", "manifest.json", "motion.json"]);
    expect(await stagingLeftovers(parent)).toEqual([]);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") expect(String(outcome.reason)).toMatch(/not empty|another creator|changed after Motion captured its identity|publication may have committed/i);
    }
  });

  it("leaves no package and no staging directory when a write fails partway through", async () => {
    const parent = await temporaryRoot();
    const packageRoot = join(parent, "interrupted");
    let written = 0;

    // Fails on the SECOND file, the exact interruption point that used to leave motion.json without
    // manifest.json — a directory that reads as a broken package instead of an absent one.
    await expect(createMotionPackage({ packageRoot }, {
      writeFile: async (path, contents) => {
        written += 1;
        if (written === 2) throw new Error("simulated interruption");
        await writeFile(path, contents, "utf8");
      }
    })).rejects.toThrow(/simulated interruption/);

    expect(written).toBe(2);
    await expect(readdir(packageRoot)).rejects.toThrow();
    expect(await stagingLeftovers(parent)).toEqual([]);
  });

  it("leaves a caller-created empty target intact when publication fails", async () => {
    const parent = await temporaryRoot();
    const packageRoot = join(parent, "pre-made-then-failed");
    await mkdir(packageRoot, { recursive: true, mode: 0o700 });

    await expect(createMotionPackage({ packageRoot }, {
      writeFile: async () => {
        throw new Error("simulated interruption");
      }
    })).rejects.toThrow(/simulated interruption/);

    // The target is untouched: the failure happened in staging, before the rename could claim it.
    expect(await readdir(packageRoot)).toEqual([]);
    expect(await stagingLeftovers(parent)).toEqual([]);
  });

  it("writes an empty document only when asked", async () => {
    const parent = await temporaryRoot();
    const withLayer = join(parent, "with-layer");
    const withoutLayer = join(parent, "without-layer");

    const populated = await createMotionPackage({ packageRoot: withLayer });
    const empty = await createMotionPackage({ packageRoot: withoutLayer, empty: true });

    expect(populated.layerCount).toBe(1);
    expect(empty.layerCount).toBe(0);
    expect(JSON.parse(await readFile(join(withoutLayer, "motion.json"), "utf8")).layers).toEqual([]);
  });
});
