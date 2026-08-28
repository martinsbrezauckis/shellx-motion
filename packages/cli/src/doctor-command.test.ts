/**
 * `shellx-motion doctor` and `motion.platform.requirements` must be the SAME answer (the readiness-parity invariant).
 *
 * Before this, the CLI returned `{ ok:false, checks, missingCount }` with no `satisfied` field when
 * FFmpeg was absent, MCP returned `ok:true` with `result.satisfied:false`, and the published Cut
 * integration spec promised they matched. A host reading either one could not trust the other, and
 * neither modelled FFprobe.
 *
 * The parity assertion here compares the two results structurally, including with a tool made
 * deliberately absent, so a future change that re-derives one of them locally fails loudly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "@shellx-motion/debug-api";
import type { MotionToolName } from "@shellx-motion/core";
import { gpuBrowserProcessContainmentEvidence } from "@shellx-motion/renderer-browser";
import { pinMotionToolExecutables, type MotionToolPins } from "@shellx-motion/core/test-support";
import type { FfmpegRunner } from "@shellx-motion/renderer-ffmpeg";
import { doctorCommand, gpuProbeScratchRoot } from "./doctor-command";

const READY = "ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers";

/**
 * The tools the FIXTURE-driven suite below pins, so its answers describe the fixture machine.
 *
 * Set up inside that suite and torn down after it, because the parity suite that follows is the
 * opposite kind of test: it probes whatever this machine really has, and pinning would take that
 * away. Nothing shared here leaks across the two.
 */
let pins: MotionToolPins;

/**
 * A runner that answers a version probe for the tools a fixture machine has.
 *
 * Matched on the exact pinned path rather than on a name. The name-matching predecessor decided
 * which tool an executable was with `/^(chrome|chromium|google chrome)/i`, which does not match
 * `/usr/bin/google-chrome` — the browser GitHub's runner image carries, and the one this
 * repository's CI pins — so `doctor` was told the browser was absent and this suite failed on CI
 * while passing everywhere else. An executable that is not one of the pinned paths throws, because
 * it means the pin is not in force and the answers would be about the host again.
 */
function runnerFor(present: ReadonlyArray<MotionToolName>): FfmpegRunner {
  return async (command) => {
    const tool = pins.toolFor(command.executable);
    if (!tool) throw new Error(`This suite pinned the tool executables, but the probe resolved ${command.executable}.`);
    return present.includes(tool)
      ? { exitCode: 0, stdout: `${tool} version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers`, stderr: "" }
      : { exitCode: 1, stdout: "", stderr: `spawn ${command.executable} ENOENT` };
  };
}

describe("motion doctor", () => {
  it("reports POSIX process-group containment without Windows-only native limits", () => {
    expect(gpuBrowserProcessContainmentEvidence({
      rootPid: 4_242,
      mode: "unix-process-group",
      status: "enforced",
      killTree: true,
      memoryLimit: "rss-monitor",
      maxProcessTreeRssBytes: 8 * 1024 * 1024 * 1024
    })).toEqual({
      schema: "shellx-motion/process-containment@1",
      mode: "unix-process-group",
      status: "enforced",
      killTree: true,
      memoryLimit: "rss-monitor"
    });
  });

  beforeAll(() => { pins = pinMotionToolExecutables("doctor-command"); });
  afterAll(() => pins.release());

  it("reports a missing tool as a SUCCESSFUL report, not a failed command", async () => {
    const result = await doctorCommand(["--json"], { ffmpegRunner: runnerFor([]) }) as Record<string, any>;

    // `ok` is "the probe ran". Conflating it with readiness made "FFmpeg is missing" look like
    // "doctor is broken", which is the one thing the user could actually have fixed.
    expect(result.ok).toBe(true);
    expect(result.satisfied).toBe(false);
    expect(result.missingCount).toBe(3);
    expect(result.requirements.schema).toBe("shellx-motion/platform-requirements@1");
    expect(result.requirements.capacity).toMatchObject({
      schema: "shellx-motion/host-render-capacity@1",
      points: { portablePointsPerLayer: 8_192, maxPointsPerLayer: expect.any(Number) },
    });
  });

  it("says yes when the machine can do what was asked, even with another tool missing", async () => {
    const result = await doctorCommand(["--json", "--operation", "render.final"], {
      ffmpegRunner: runnerFor(["ffmpeg", "chromium"])
    }) as Record<string, any>;

    expect(result.satisfied).toBe(true);
    expect(result.operation).toEqual({ operation: "render.final", satisfied: true, blockedBy: [], possible: true });
    // The machine-wide answer is still honest about what does not work.
    expect(result.requirements.satisfied).toBe(false);
    expect(result.requirements.operations).toContainEqual({ operation: "quality.check", satisfied: false, blockedBy: ["ffprobe"], possible: false });
  });

  it("does not answer green for the default render when the browser is absent", async () => {
    // The defect this scoped query used to hide: `render` rasterizes in a browser unless told
    // otherwise, so a machine with FFmpeg and no Chromium is NOT ready for `render.final` — and
    // this is the exact command an agent is told to run before rendering.
    const result = await doctorCommand(["--json", "--operation", "render.final"], {
      ffmpegRunner: runnerFor(["ffmpeg", "ffprobe"])
    }) as Record<string, any>;

    expect(result.satisfied).toBe(false);
    expect(result.operation.blockedBy).toEqual(["chromium"]);
    // And it must not overshoot into "this machine cannot render": it names the flag that can.
    expect(result.operation.possible).toBe(true);
    expect(result.operation.alternative.flag).toBe("--frame-lane native");
  });

  it("reports GPU launch policy separately from hardware readiness without opening a GPU browser", async () => {
    const result = await doctorCommand(["--json"], {
      ffmpegRunner: runnerFor(["ffmpeg", "ffprobe", "chromium"])
    }) as Record<string, any>;

    expect(result.gpu).toMatchObject({
      status: "requires-hardware-proof",
      trustedChromium: { status: "present" },
      adapterDeviceProof: { status: "not-tested", requiredCommand: "host-owned motion.platform.gpu.probe" },
      fixedLaunchProfile: { chromiumSandbox: true, finalContainment: "precontained-direct-chromium" },
      audio: { gpuRaster: "none", finalVideo: "ffmpeg" },
      refusals: [{ code: "gpu_hardware_proof_required" }]
    });
  });

  it("runs the GPU frame/readback operation only when the operator explicitly requests --probe-gpu", async () => {
    let calls = 0;
    const gpuHardwareProbeRunner = async () => {
      calls += 1;
      return { ok: false as const, failure: { code: "gpu_hardware_unavailable" as const, message: "fixture has no hardware adapter" } };
    };
    await doctorCommand(["--json"], { ffmpegRunner: runnerFor(["ffmpeg", "ffprobe", "chromium"]), gpuHardwareProbeRunner });
    expect(calls).toBe(0);

    const result = await doctorCommand(["--json", "--probe-gpu"], {
      ffmpegRunner: runnerFor(["ffmpeg", "ffprobe", "chromium"]),
      gpuHardwareProbeRunner
    }) as Record<string, any>;
    expect(calls).toBe(1);
    expect(result.gpuProbe).toEqual({ ok: false, failure: { code: "gpu_hardware_unavailable", message: "fixture has no hardware adapter" } });
    expect(result.gpu).toMatchObject({ status: "requires-hardware-proof", adapterDeviceProof: { status: "not-tested" } });
  });

  it("uses the host GPU scratch root while preserving an explicit embedder override", () => {
    expect(gpuProbeScratchRoot(undefined, { SHELLX_MOTION_SCRATCH_ROOT: " /private/motion-scratch " })).toBe("/private/motion-scratch");
    expect(gpuProbeScratchRoot("/embedder/scratch", { SHELLX_MOTION_SCRATCH_ROOT: "/host/scratch" })).toBe("/embedder/scratch");
    expect(gpuProbeScratchRoot(undefined, {})).toBe(".scratch");
  });

  it("refuses an unknown operation instead of quietly answering about the whole machine", async () => {
    const result = await doctorCommand(["--json", "--operation", "render.everything"], {
      ffmpegRunner: runnerFor(["ffmpeg", "ffprobe"])
    }) as Record<string, any>;

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("invalid_args");
  });

  it("prints a human report derived from the same result", async () => {
    const result = await doctorCommand([], { ffmpegRunner: runnerFor(["ffmpeg", "chromium"]) }) as Record<string, any>;

    expect(result.report).toContain("ffmpeg");
    expect(result.report).toContain("MISSING  ffprobe");
    expect(result.report).toContain("What this machine can do right now:");
    expect(result.report).toContain("Adaptive render capacity:");
    // The JSON and the prose come from one object, so they cannot disagree.
    expect(result.satisfied).toBe(false);
  });

  it("keeps the historical `checks` field pointing at the same tool array", async () => {
    const result = await doctorCommand(["--json"], { ffmpegRunner: runnerFor(["ffmpeg", "ffprobe", "chromium"]) }) as Record<string, any>;

    expect(result.checks).toBe(result.requirements.tools);
    expect(result.checks[0]).toMatchObject({ tool: "ffmpeg", present: true, overrideEnvVar: "SHELLX_MOTION_FFMPEG" });
    // The published prose contract Cut reads survives alongside the machine-readable list.
    expect(typeof result.checks[0].requiredFor).toBe("string");
    expect(result.checks[0].requiredForOperations).toEqual(["render.final"]);
  });
});

describe("CLI and MCP agree on the same machine", () => {
  it("returns byte-identical readiness results", async () => {
    // Both probe the real binaries on this machine — the point is that they cannot differ, whatever
    // this machine happens to have.
    const cli = await doctorCommand(["--json"]) as Record<string, any>;
    const mcp = await dispatchDebugCommand("motion.platform.requirements", {}, { tier: "read_motion" }) as Record<string, any>;

    expect(mcp.ok).toBe(true);
    expect((mcp.result as Record<string, any>).platform).toEqual(cli.requirements);
    expect((mcp.result as Record<string, any>).satisfied).toBe(cli.satisfied);
  }, 120_000);

  it("agrees when FFprobe is deliberately absent", async () => {
    // The override is the same one a user with a non-standard install would set; nothing is
    // uninstalled. This is the case that used to have no representation at all on either surface.
    const previous = process.env.SHELLX_MOTION_FFPROBE;
    process.env.SHELLX_MOTION_FFPROBE = "/nonexistent/shellx-motion-test/ffprobe";
    try {
      const cli = await doctorCommand(["--json"]) as Record<string, any>;
      const mcp = await dispatchDebugCommand("motion.platform.requirements", {}, { tier: "read_motion" }) as Record<string, any>;

      expect((mcp.result as Record<string, any>).platform).toEqual(cli.requirements);
      expect(cli.satisfied).toBe(false);
      expect((mcp.result as Record<string, any>).satisfied).toBe(false);
      const ffprobe = cli.requirements.tools.find((tool: { tool: string }) => tool.tool === "ffprobe");
      expect(ffprobe).toMatchObject({ status: "missing", source: "override" });
      // Encoding is unaffected: whatever this machine could render before, it still can — only the
      // readback is gone. Asserted relative to the same machine's baseline rather than pinned to
      // `satisfied:true`, because a CI host with no browser is legitimately not render-ready.
      const baseline = await doctorCommand(["--json", "--operation", "render.final"]) as Record<string, any>;
      expect(cli.requirements.operations).toContainEqual(baseline.operation);
    } finally {
      if (previous === undefined) delete process.env.SHELLX_MOTION_FFPROBE;
      else process.env.SHELLX_MOTION_FFPROBE = previous;
    }
  }, 120_000);

  it("agrees on a scoped operation query", async () => {
    const cli = await doctorCommand(["--json", "--operation", "quality.check"]) as Record<string, any>;
    const mcp = await dispatchDebugCommand("motion.platform.requirements", { operation: "quality.check" }, { tier: "read_motion" }) as Record<string, any>;

    expect((mcp.result as Record<string, any>).operation).toEqual(cli.operation);
  }, 45_000);

  it("refuses an unknown operation on the MCP surface too", async () => {
    const mcp = await dispatchDebugCommand("motion.platform.requirements", { operation: "nope" }, { tier: "read_motion" }) as Record<string, any>;

    expect(mcp.ok).toBe(false);
    expect((mcp.error as Record<string, any>).code).toBe("invalid_args");
  });
});
