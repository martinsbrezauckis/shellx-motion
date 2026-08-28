/**
 * One readiness answer, and it has to be able to say all four things (the readiness-parity invariant).
 *
 * Before this, three surfaces answered "can this machine render?" differently, none of them could
 * distinguish an absent FFmpeg from a broken one, and none modelled FFprobe at all — so a machine
 * that could encode but could not verify what it encoded had no representation.
 *
 * The second half of this suite covers the lane-dependence defect that followed: Chromium was not
 * modelled at all, so `render.final` reported ready on a machine whose default `render` could not
 * draw a single frame. Those tests assert BOTH directions — no false green, and no false red for a
 * machine the native lane can serve — because either one alone is satisfied by a wrong fix.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAbsolute } from "node:path";
import { pinMotionToolExecutables, type MotionToolPins } from "@shellx-motion/core/test-support";
import {
  checkMotionPlatformRequirements,
  ffmpegLooksAbsent,
  ffmpegLooksLikeBrokenLoad,
  motionOperationReadiness,
  motionPlatformRequirements,
  motionRequirementsReport,
  motionToolIdentity,
  motionToolReport,
  MOTION_PLATFORM_REQUIREMENTS_SCHEMA,
  MOTION_TOOL_VERSION_MAX_CHARS,
  probeMotionTool,
  resolveMotionToolLocation,
  type FfmpegRunner,
  type MotionToolName
} from "./index";

/**
 * The three tools, pinned to paths this suite created, for every test in this file.
 *
 * The probe resolves a real executable PATH from the real machine and hands that to the runner, so
 * without a pin these tests answer about whatever browser and FFmpeg the host happens to carry. That
 * is not hypothetical, and it has now cost this suite twice. The fixture recognised tools by NAME:
 * first it did not know `ffmpeg.exe`, and four tests failed on Windows alone; then it did not know
 * `/usr/bin/google-chrome` — the first system candidate, the browser GitHub's runner image carries,
 * and the exact path this repository's own CI pins into `SHELLX_MOTION_BROWSER` — and six tests
 * failed on CI while passing on every workstation whose browser was a Playwright cache entry named
 * `chrome`. Both are the same defect: a test that lets the machine choose its own input.
 *
 * Pinning ends the guess rather than extending it by one more name. There is exactly one path each
 * tool can resolve to, on every machine and every OS, and the runner below matches it exactly.
 */
let pins: MotionToolPins;
beforeAll(() => { pins = pinMotionToolExecutables("platform-requirements"); });
afterAll(() => pins.release());

/** One tool's answer to a version probe. */
interface ToolAnswer { exitCode: number; stdout?: string; stderr?: string }

/**
 * A runner that answers a version probe per TOOL, matched on the exact path this suite pinned.
 *
 * A tool with no entry is not installed: the ENOENT-shaped default is what `missing` is made of.
 * An executable that is not one of the pinned paths is a different failure entirely — the pin is not
 * in force and the probe is describing the host — so it throws instead of being reported as one more
 * absent tool, which is how the name-matching predecessor hid exactly that.
 */
function runnerFor(answers: Partial<Record<MotionToolName, ToolAnswer>>): FfmpegRunner {
  return async (command) => {
    const tool = pins.toolFor(command.executable);
    if (!tool) throw new Error(`This suite pinned the tool executables, but the probe resolved ${command.executable}.`);
    const answer = answers[tool] ?? { exitCode: 1, stderr: `spawn ${command.executable} ENOENT` };
    return { exitCode: answer.exitCode, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
  };
}

const READY = { exitCode: 0, stdout: "ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers\nbuilt with gcc 13" };
const CHROMIUM_READY = { exitCode: 0, stdout: "Google Chrome for Testing 141.0.7390.54" };
/** Every tool answers. The baseline the lane-dependence tests vary one thing away from. */
const ALL_READY = { ffmpeg: READY, ffprobe: READY, chromium: CHROMIUM_READY };

describe("checkMotionPlatformRequirements", () => {
  it("resolves the executables this suite pinned, not the ones the host happens to have", () => {
    // The guard on every other test in this file. If the pin ever stops taking effect — a renamed
    // override variable, a resolver that consults something before it — the probes below quietly go
    // back to describing the machine, which is the exact failure this fixture exists to end.
    for (const tool of ["ffmpeg", "ffprobe", "chromium"] as const) {
      expect(resolveMotionToolLocation(tool)).toMatchObject({ executable: pins.executable[tool], source: "override" });
    }
  });

  it("separates 'the probe ran' from 'the machine is ready'", async () => {
    const requirements = await checkMotionPlatformRequirements({
      runner: runnerFor({ ...ALL_READY, ffprobe: { exitCode: 1, stderr: "spawn ffprobe ENOENT" } })
    });

    // This is the conflation that made "FFmpeg is missing" read as "doctor failed".
    expect(requirements.ok).toBe(true);
    expect(requirements.satisfied).toBe(false);
    expect(requirements.schema).toBe(MOTION_PLATFORM_REQUIREMENTS_SCHEMA);
    expect(requirements.missingCount).toBe(1);
  });

  it("models FFprobe as its own tool, so encoding can work while verification does not", async () => {
    const requirements = await checkMotionPlatformRequirements({
      runner: runnerFor({ ...ALL_READY, ffprobe: { exitCode: 1, stderr: "spawn ffprobe ENOENT" } })
    });

    expect(motionOperationReadiness(requirements, "preview.frame")).toMatchObject({ satisfied: true, blockedBy: [] });
    expect(motionOperationReadiness(requirements, "render.final")).toMatchObject({ satisfied: true, blockedBy: [] });
    expect(motionOperationReadiness(requirements, "quality.check")).toMatchObject({ satisfied: false, blockedBy: ["ffprobe"] });
  });

  it("tells a broken install from an absent one, because the advice is opposite", async () => {
    const absent = await probeMotionTool("ffmpeg", runnerFor({}));
    const broken = await probeMotionTool("ffmpeg", runnerFor({ ffmpeg: { exitCode: 127, stderr: "Permission denied" } }));

    expect(absent.status).toBe("missing");
    expect(broken.status).toBe("broken");
    // "Install FFmpeg" would send the broken-install user to repair something that is not wrong.
    expect(motionToolReport(broken).problem).toMatch(/broken or blocked install/i);
    expect(motionToolReport(absent).problem).toMatch(/not installed/i);
    // The raw error is preserved either way, so a caller can classify it themselves.
    expect(broken.detail).toContain("Permission denied");
  });

  it("carries install guidance and the override variable for every tool", async () => {
    const requirements = await checkMotionPlatformRequirements({ runner: runnerFor({}) });

    for (const tool of requirements.tools) {
      expect(tool.installOptions.length).toBeGreaterThan(0);
      expect(tool.downloadUrl).toMatch(/^https:\/\//);
      expect(tool.requiredFor.length).toBeGreaterThan(0);
      expect(tool.requiredForOperations.length).toBeGreaterThan(0);
    }
    expect(requirements.tools.map((tool) => tool.overrideEnvVar))
      .toEqual(["SHELLX_MOTION_FFMPEG", "SHELLX_MOTION_FFPROBE", "SHELLX_MOTION_BROWSER"]);
  });

  it("derives `satisfied` from operation readiness, so the two cannot drift", () => {
    const requirements = motionPlatformRequirements([
      motionToolReport({ tool: "ffmpeg", source: "path", resolvedFrom: "ffmpeg", status: "ready", version: "v" }),
      motionToolReport({ tool: "ffprobe", source: "path", resolvedFrom: "ffprobe", status: "ready", version: "v" }),
      motionToolReport({ tool: "chromium", source: "path", resolvedFrom: "/usr/bin/chromium", status: "ready", version: "v" })
    ]);

    expect(requirements.satisfied).toBe(true);
    expect(requirements.operations.every((operation) => operation.satisfied)).toBe(true);
    expect(requirements.capacity).toMatchObject({
      schema: "shellx-motion/host-render-capacity@1",
      jobs: { maxConcurrentJobs: expect.any(Number), maxProcessTreeRssBytes: expect.any(Number) },
      points: { portablePointsPerLayer: 8_192, maxPointsPerLayer: expect.any(Number) },
    });
  });

  it("renders a human report from the same result the JSON reports", async () => {
    const requirements = await checkMotionPlatformRequirements({
      runner: runnerFor({ ...ALL_READY, ffprobe: { exitCode: 1, stderr: "spawn ffprobe ENOENT" } })
    });

    const report = motionRequirementsReport(requirements);
    expect(report).toContain("OK       ffmpeg");
    expect(report).toContain("MISSING  ffprobe");
    // The operations block is what tells a user "preview works, verification does not".
    expect(report).toContain("NO   quality.check  (needs ffprobe)");
    expect(report).toContain("YES  render.final");
    expect(report).toContain("Adaptive render capacity:");
    expect(report).toContain("points/layer");
  });
});

/**
 * Chromium is a first-class requirement of the DEFAULT render, and only of the default one.
 *
 * The defect: `OPERATION_TOOLS["render.final"]` was `["ffmpeg"]`, so `doctor --operation
 * render.final` returned `satisfied:true` on a machine with no browser and the very next `render`
 * died with "No Chrome/Chromium executable found for browser renderer". A false green on the
 * prescribed pre-flight, on the one command the product exists for.
 */
describe("render.final is lane-dependent: Chromium blocks the default route, not the operation", () => {
  /** Everything answers except anything chrome-shaped. */
  const NO_BROWSER = { ffmpeg: READY, ffprobe: READY };

  it("refuses to call a browser-less machine ready for the default render", async () => {
    const requirements = await checkMotionPlatformRequirements({ runner: runnerFor(NO_BROWSER) });
    const render = motionOperationReadiness(requirements, "render.final");

    // THE regression. Before the fix every one of these was the opposite.
    expect(render.satisfied).toBe(false);
    expect(render.blockedBy).toEqual(["chromium"]);
    expect(requirements.satisfied).toBe(false);
    expect(requirements.missingCount).toBe(1);
    expect(requirements.tools.find((tool) => tool.tool === "chromium")).toMatchObject({
      status: "missing",
      present: false,
      overrideEnvVar: "SHELLX_MOTION_BROWSER",
      requiredForOperations: ["render.final"]
    });
  });

  it("does NOT claim the machine cannot render — it names the flag that renders anyway", async () => {
    const requirements = await checkMotionPlatformRequirements({ runner: runnerFor(NO_BROWSER) });
    const render = motionOperationReadiness(requirements, "render.final");

    // The other half of the defect. Modelling Chromium as an unconditional requirement would have
    // told a user with a working native lane that their machine cannot render at all.
    expect(render.possible).toBe(true);
    expect(render.alternative).toMatchObject({ flag: "--frame-lane native", avoids: ["chromium"] });
    // Proven on a browser-less machine: this flag delivers an MP4 for a package the native lane can
    // draw and refuses `native_text_not_deliverable` for one it cannot. The flag is offered; the
    // condition is stated rather than left for the render to discover.
    expect(render.alternative?.packageDependent).toBe(true);
    expect(render.alternative?.tradeoff).toMatch(/native_text_not_deliverable/);
  });

  it("withdraws the alternative when it would not actually rescue the render", async () => {
    // FFmpeg absent too: `--frame-lane native` still cannot encode, so offering it would be an
    // instruction that does not work.
    const requirements = await checkMotionPlatformRequirements({ runner: runnerFor({ ffprobe: READY }) });
    const render = motionOperationReadiness(requirements, "render.final");

    expect(render.blockedBy).toEqual(["ffmpeg", "chromium"]);
    expect(render.possible).toBe(false);
    expect(render.alternative).toBeUndefined();
  });

  it("leaves preview.frame alone, because its default lane is native", async () => {
    const requirements = await checkMotionPlatformRequirements({ runner: runnerFor(NO_BROWSER) });

    // `preview` defaults to `--lane native`. A browser lane a caller must opt into with a flag
    // cannot make the default unready — the mirror image of the render.final rule.
    expect(motionOperationReadiness(requirements, "preview.frame"))
      .toMatchObject({ satisfied: true, possible: true, blockedBy: [] });
  });

  it("says nothing new when every tool is present", async () => {
    const requirements = await checkMotionPlatformRequirements({ runner: runnerFor(ALL_READY) });
    const render = motionOperationReadiness(requirements, "render.final");

    expect(requirements.satisfied).toBe(true);
    expect(render).toEqual({ operation: "render.final", satisfied: true, blockedBy: [], possible: true });
    // A healthy machine's answer carries no alternative: the field means "the default is blocked".
    expect(render.alternative).toBeUndefined();
  });

  it("prints the escape route next to the NO, not only in the JSON", async () => {
    const report = motionRequirementsReport(await checkMotionPlatformRequirements({ runner: runnerFor(NO_BROWSER) }));

    expect(report).toContain("MISSING  chromium");
    expect(report).toContain("NO   render.final  (needs chromium)");
    // Without this line a user reads "cannot render" and installs a browser they may not need.
    expect(report).toContain("--frame-lane native");
    expect(report).toContain("depends on the package");
    // And the install guidance must be Chromium's, not FFmpeg's copied across.
    expect(report).toContain("npx playwright-core install chromium");
    expect(report).not.toContain("winget install --id Gyan.FFmpeg -e");
  });

  it("reports a browser that exists but cannot start as broken, not missing", async () => {
    // The shape a minimal Linux container produces: the binary is there, its shared libraries are
    // not. An existence check would have called this machine ready and let the render find out.
    const requirements = await checkMotionPlatformRequirements({
      runner: runnerFor({
        ...ALL_READY,
        chromium: { exitCode: 127, stderr: "error while loading shared libraries: libnss3.so" }
      })
    });
    const chromium = requirements.tools.find((tool) => tool.tool === "chromium");

    expect(chromium?.status).toBe("broken");
    expect(chromium?.problem).toMatch(/broken or blocked install/i);
    expect(chromium?.detail).toContain("libnss3.so");
    expect(motionOperationReadiness(requirements, "render.final").satisfied).toBe(false);
  });

  it("probes the browser the renderer would launch, not a PATH lookup", async () => {
    // Deliberately OUTSIDE this suite's pin, because the property under test is what the resolver
    // does when nobody named a browser: every route it can then take — a Playwright cache entry, a
    // well-known system install, or the "this machine has none" fallback — is an absolute path. So a
    // `chrome` on PATH that `findMotionBrowserExecutable` would not select can never answer this
    // probe green. Pinning would make the assertion vacuously true, which is why it is lifted here.
    delete process.env.SHELLX_MOTION_BROWSER;
    try {
      const probe = await probeMotionTool("chromium", async () => ({ exitCode: 1, stdout: "", stderr: "spawn ENOENT" }));

      expect(probe.tool).toBe("chromium");
      expect(probe.resolvedFrom).not.toBe("chromium");
      expect(isAbsolute(probe.resolvedFrom)).toBe(true);
    } finally {
      process.env.SHELLX_MOTION_BROWSER = pins.executable.chromium;
    }
  });
});

describe("motionToolIdentity keeps a receipt shareable", () => {
  it("records the command name and how it was found, never a machine-private path", () => {
    const identity = motionToolIdentity({
      tool: "ffmpeg",
      source: "override",
      resolvedFrom: "/home/somebody/private/tools/ffmpeg-7.0/bin/ffmpeg",
      version: "ffmpeg version 7.0"
    });

    expect(identity.executable).toBe("ffmpeg");
    expect(JSON.stringify(identity)).not.toContain("/home/somebody");
    expect(identity.source).toBe("override");
  });

  it("handles a Windows-style override path on any platform", () => {
    expect(motionToolIdentity({
      tool: "ffprobe",
      source: "shellx-family",
      resolvedFrom: "C:\\Users\\Someone\\AppData\\Local\\ShellX Motion\\tools\\ffmpeg\\bin\\ffprobe.exe"
    }).executable).toBe("ffprobe.exe");
  });

  it("bounds and redacts the version line", () => {
    const long = motionToolIdentity({ tool: "ffmpeg", source: "path", resolvedFrom: "ffmpeg", version: "x".repeat(500) });
    expect(long.version).toBeDefined();
    expect((long.version ?? "").length).toBeLessThanOrEqual(MOTION_TOOL_VERSION_MAX_CHARS);

    const leaky = motionToolIdentity({
      tool: "ffmpeg",
      source: "path",
      resolvedFrom: "ffmpeg",
      version: "ffmpeg version 6.1 API_TOKEN=hunter2\nsecond line"
    });
    expect(leaky.version).toContain("[redacted]");
    expect(leaky.version).not.toContain("hunter2");
    // Only the first line — the build string — is kept.
    expect(leaky.version).not.toContain("second line");
  });

  it("omits the version entirely rather than inventing one", () => {
    expect(motionToolIdentity({ tool: "ffprobe", source: "path", resolvedFrom: "ffprobe" }).version).toBeUndefined();
  });

  /**
   * A banner is text a program Motion did not write, printed into a terminal that obeys it.
   *
   * `ESC[8m` sets "conceal", so every LINE OF THE REPORT AFTER this one renders invisible — a
   * version string that hides the missing-tool rows underneath it. A bare `\r` is the same trick
   * cheaply: it returns the cursor and overwrites what was already drawn. Neither was stripped,
   * and this value is a published SDK export (`@shellx-motion/sdk` -> platform) that hosts print.
   */
  it("strips control characters a banner could use to rewrite the report around it", () => {
    const concealing = motionToolIdentity({
      tool: "chromium",
      source: "path",
      resolvedFrom: "/usr/bin/chromium",
      version: "Chromium 141.0\u001b[8m hidden\u0007"
    });
    // The whole CSI sequence goes, not just its ESC: `Chromium 141.0[8m` would be inert but is a
    // puzzle for whoever reads the report. The BEL goes with the blanket control strip.
    expect(concealing.version).toBe("Chromium 141.0 hidden");
    expect(concealing.version).not.toContain("\u001b");

    // A bare CR is a line terminator too: the first line ends there, it does not ride along.
    expect(motionToolIdentity({
      tool: "ffmpeg",
      source: "path",
      resolvedFrom: "ffmpeg",
      version: "ffmpeg version 7.1\rOK       chromium  (fake)"
    }).version).toBe("ffmpeg version 7.1");

    // Bidi overrides reorder what a reader sees without changing the string. Same class, same fate.
    expect(motionToolIdentity({
      tool: "ffmpeg",
      source: "path",
      resolvedFrom: "ffmpeg",
      version: "ffmpeg \u202Eversion\u202C 7.1"
    }).version).toBe("ffmpeg version 7.1");
  });
});

/**
 * The report's OTHER fields have to redact to the same standard `executable` does.
 *
 * `motionToolIdentity` reduces the resolved path to a basename because an absolute path names a
 * user's home directory, their username and their install layout. `detail` then republished
 * exactly that, verbatim, from the raw spawn error — in an object `motion.platform.requirements`
 * returns to any `read_motion` caller and `doctor --json` prints.
 */
describe("motionToolReport redacts every field a third-party binary supplied", () => {
  it("replaces absolute paths in `detail`, the way the executable is reduced to a basename", () => {
    const report = motionToolReport({
      tool: "chromium",
      source: "path",
      resolvedFrom: "/home/somebody/.cache/ms-playwright/chromium-1200/chrome-linux/chrome",
      status: "missing",
      detail: "spawn /home/somebody/.cache/ms-playwright/chromium-1200/chrome-linux/chrome ENOENT"
    });

    expect(report.executable).toBe("chrome");
    expect(report.detail).toBe("spawn <path> ENOENT");
    expect(JSON.stringify(report)).not.toContain("/home/somebody");
    expect(JSON.stringify(report)).not.toContain("somebody");
  });

  it("redacts a Windows path in `detail` too", () => {
    expect(motionToolReport({
      tool: "ffmpeg",
      source: "shellx-family",
      resolvedFrom: "C:\\Users\\Someone\\AppData\\Local\\ShellX Motion\\tools\\ffmpeg\\bin\\ffmpeg.exe",
      status: "broken",
      detail: "C:\\Users\\Someone\\tools\\ffmpeg.exe is not a valid Win32 application"
    }).detail).toBe("<path> is not a valid Win32 application");
  });

  it("keeps the diagnostic part of a loader failure while dropping the path", () => {
    // The message still has to be usable: what is stripped is the location, not the cause.
    expect(motionToolReport({
      tool: "chromium",
      source: "path",
      resolvedFrom: "/opt/chrome/chrome",
      status: "broken",
      detail: "/opt/chrome/chrome: error while loading shared libraries: libnss3.so: cannot open shared object file"
    }).detail).toContain("libnss3.so");
  });

  it("strips control characters from `detail` as well as from the version", () => {
    expect(motionToolReport({
      tool: "ffmpeg",
      source: "path",
      resolvedFrom: "ffmpeg",
      status: "broken",
      detail: "exit 1\u001b[8m and the rest of the report"
    }).detail).toBe("exit 1 and the rest of the report");
  });

  it("prefers a prober-supplied problem over the generic per-status sentence", () => {
    const report = motionToolReport({
      tool: "chromium",
      source: "override",
      resolvedFrom: "/opt/shellx/chrom",
      status: "broken",
      problem: "SHELLX_MOTION_BROWSER is set to \"/opt/shellx/chrom\", and no file exists there."
    });

    // "found but did not answer a version probe" is literally untrue of a pin naming nothing, and
    // the one fact the operator needs is the value they typed.
    expect(report.problem).toBe("SHELLX_MOTION_BROWSER is set to \"/opt/shellx/chrom\", and no file exists there.");
    expect(report.problem).not.toMatch(/did not answer a version probe/);
  });

  it("appends prober notes to the problem, so a security refusal is not silent", () => {
    const report = motionToolReport({
      tool: "chromium",
      source: "path",
      resolvedFrom: "/usr/bin/chromium",
      status: "missing",
      detail: "spawn ENOENT",
      notes: ["Motion did not use the browser cache at PLAYWRIGHT_BROWSERS_PATH because it is world-writable."]
    });

    // Without this, the report tells a CI user to install a browser into the same cache Motion has
    // just refused to execute out of — forever.
    expect(report.problem).toMatch(/^No Chrome\/Chromium was found\./);
    expect(report.problem).toContain("PLAYWRIGHT_BROWSERS_PATH because it is world-writable");
  });
});

/**
 * "No such file" is printed by BOTH a missing program and a present one whose libraries are
 * missing, and the two need opposite advice.
 */
describe("classifying a failure: absent vs present-but-unable-to-load", () => {
  it("calls a missing shared library BROKEN, not missing", () => {
    // The exact string ld.so prints. `ffmpegLooksAbsent`'s `/no such file/i` matched its tail, so
    // this reported `missing` and sent the user to reinstall a browser they already had — past the
    // `broken` prose two fields away that names this case and gives the command that fixes it.
    const raw = "/opt/chrome/chrome: error while loading shared libraries: libnss3.so:"
      + " cannot open shared object file: No such file or directory";

    expect(ffmpegLooksLikeBrokenLoad(raw)).toBe(true);
    expect(ffmpegLooksAbsent(raw)).toBe(false);
    expect(motionToolReport({ tool: "chromium", source: "path", resolvedFrom: "/opt/chrome/chrome", status: "broken", detail: raw }).problem)
      .toMatch(/install-deps chromium/);
  });

  it("calls the macOS spelling broken too", () => {
    for (const raw of [
      "dyld[4711]: Library not loaded: @rpath/libvpx.9.dylib",
      "dyld: Symbol not found: _CFStringGetLength"
    ]) {
      expect(ffmpegLooksAbsent(raw)).toBe(false);
    }
  });

  it("still calls a genuinely absent program missing", () => {
    for (const raw of [
      "spawn ffmpeg ENOENT",
      "ffmpeg: command not found",
      "'ffmpeg' is not recognized as an internal or external command",
      "/usr/bin/ffmpeg: No such file or directory"
    ]) {
      expect(ffmpegLooksAbsent(raw)).toBe(true);
    }
  });

  it("routes the classification through the probe, end to end", async () => {
    const requirements = await checkMotionPlatformRequirements({
      runner: runnerFor({
        ...ALL_READY,
        chromium: {
          exitCode: 127,
          stderr: "chrome: error while loading shared libraries: libnss3.so: cannot open shared object file: No such file or directory"
        }
      })
    });
    const chromium = requirements.tools.find((tool) => tool.tool === "chromium");

    expect(chromium?.status).toBe("broken");
    expect(chromium?.problem).toMatch(/broken or blocked install/i);
  });
});
