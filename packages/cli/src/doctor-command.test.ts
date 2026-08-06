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
import { describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "@shellx-motion/debug-api";
import type { FfmpegRunner } from "@shellx-motion/renderer-ffmpeg";
import { doctorCommand } from "./doctor-command";

const READY = "ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers";

/**
 * A runner that answers a version probe per executable basename.
 *
 * Chromium is named by whatever the host actually has — `chrome`, `chrome.exe`,
 * `Google Chrome for Testing`, `chromium` — because the resolver hands back a real path, so it is
 * matched by prefix. Keying it on one exact name would make this suite's answers depend on which
 * browser the machine running it happens to carry.
 */
function runnerFor(present: string[]): FfmpegRunner {
  return async (command) => {
    const executableName = command.executable.split(/[\\/]/).at(-1) ?? command.executable;
    const raw = executableName.replace(/\.exe$/i, "");
    const name = /^(chrome|chromium|google chrome)/i.test(raw) ? "chromium" : raw;
    return present.includes(name)
      ? { exitCode: 0, stdout: `${name} version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers`, stderr: "" }
      : { exitCode: 1, stdout: "", stderr: `spawn ${command.executable} ENOENT` };
  };
}

describe("motion doctor", () => {
  it("reports a missing tool as a SUCCESSFUL report, not a failed command", async () => {
    const result = await doctorCommand(["--json"], { ffmpegRunner: runnerFor([]) }) as Record<string, any>;

    // `ok` is "the probe ran". Conflating it with readiness made "FFmpeg is missing" look like
    // "doctor is broken", which is the one thing the user could actually have fixed.
    expect(result.ok).toBe(true);
    expect(result.satisfied).toBe(false);
    expect(result.missingCount).toBe(3);
    expect(result.requirements.schema).toBe("shellx-motion/platform-requirements@1");
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
  }, 45_000);

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
  }, 45_000);

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
