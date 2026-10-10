import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FfmpegCommand } from "./index.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn
}));

import {
  startLinearSrgbSdrHeldStreamingFfmpegProcess,
  startStreamingFfmpegProcess,
  startStreamingFfmpegProcessWithTrustedLaunch
} from "./streaming-process.js";

beforeEach(() => {
  // Native Windows launch orchestration has its own deterministic unit contract; these transport
  // tests exercise the portable pipe child on every host.
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  spawn.mockReset();
});

describe("streaming FFmpeg process transport", () => {
  it("maps the candidate's fixed held FFmpeg and owned MP4 descriptors without widening command input", async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const process = await startLinearSrgbSdrHeldStreamingFfmpegProcess({
      command: { executable: "/proc/self/fd/3", shell: false, args: ["-y", "-f", "rawvideo", "-i", "pipe:0", "-f", "mp4", "/proc/self/fd/4"] },
      signal: new AbortController().signal,
      watchProcess: () => undefined,
      reportProcessContainment: () => undefined,
    }, { executable: "/proc/self/fd/3", shell: false, args: ["-y", "-f", "rawvideo", "-i", "pipe:0", "-f", "mp4", "/proc/self/fd/4"] }, 17, 18);
    expect(spawn).toHaveBeenCalledWith("/proc/self/fd/3", expect.any(Array), expect.objectContaining({
      shell: false,
      stdio: ["pipe", "pipe", "pipe", 17, 18],
      detached: true,
    }));
    child.emit("close", 0);
    await expect(process.end()).resolves.toEqual({ exitCode: 0, stdout: "", stderr: "" });

    await expect(startLinearSrgbSdrHeldStreamingFfmpegProcess({
      command: command(), signal: new AbortController().signal, watchProcess: () => undefined, reportProcessContainment: () => undefined,
    }, command(), 17, 18)).rejects.toThrow("fixed descriptor operands");
  });

  it("refuses shell authority before spawning", async () => {
    await expect(startStreamingFfmpegProcess({
      // Deliberately bypass FfmpegCommand's shell:false type to exercise the runtime refusal.
      command: { ...command(), shell: true } as unknown as FfmpegCommand,
      signal: new AbortController().signal,
      watchProcess: () => undefined,
      reportProcessContainment: () => undefined
    })).rejects.toThrow("shell:false");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("uses the governed pipe child, reports containment once, and honors stdin backpressure", async () => {
    const child = fakeChild();
    child.stdin.write = vi.fn(() => false);
    spawn.mockReturnValue(child);
    const containment: unknown[] = [];
    const watched: number[] = [];
    const process = await startStreamingFfmpegProcess({
      command: command(),
      signal: new AbortController().signal,
      watchProcess: (pid) => watched.push(pid),
      reportProcessContainment: (evidence) => containment.push(evidence)
    });

    expect(spawn).toHaveBeenCalledWith("ffmpeg-test", ["-f", "image2pipe", "pipe:0"], expect.objectContaining({
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: globalThis.process.platform === "linux" || globalThis.process.platform === "darwin"
    }));
    expect(watched).toEqual([4321]);
    expect(containment).toHaveLength(1);

    const pending = process.write(Buffer.from("frame"));
    child.stdin.emit("drain");
    await expect(pending).resolves.toMatchObject({ backpressured: true, inputHighWaterMarkBytes: expect.any(Number) });
    child.stdin.write = vi.fn(() => true);
    await expect(process.write(Buffer.from("next-frame"))).resolves.toMatchObject({ backpressured: false });
    child.stdout.emit("data", "encoder output");
    child.stderr.emit("data", "encoder diagnostic");
    child.emit("close", 0);
    await expect(process.end()).resolves.toEqual({ exitCode: 0, stdout: "encoder output", stderr: "encoder diagnostic" });
  });

  it("returns a bounded closed transport on child-launch failure", async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const process = await startStreamingFfmpegProcess({
      command: command(),
      signal: new AbortController().signal,
      watchProcess: () => undefined,
      reportProcessContainment: () => undefined
    });
    child.emit("error", Object.assign(new Error("missing ffmpeg"), { code: "ENOENT" }));
    await expect(process.closed).resolves.toEqual({ exitCode: 127, stdout: "", stderr: "missing ffmpeg" });
    await expect(process.write(Buffer.from("frame"))).rejects.toThrow("exited with code 127");
  });

  it("rejects later writes with the first cached stdin error", async () => {
    const child = fakeChild({ pid: null });
    spawn.mockReturnValue(child);
    const process = await startStreamingFfmpegProcess({
      command: command(), signal: new AbortController().signal,
      watchProcess: () => undefined, reportProcessContainment: () => undefined
    });
    const firstError = new Error("encoder input pipe broke");
    child.stdin.emit("error", firstError);
    child.stdin.emit("error", new Error("later pipe error"));

    await expect(process.write(Buffer.from("frame"))).rejects.toBe(firstError);
    child.emit("close", 1);
    await expect(process.closed).resolves.toMatchObject({ exitCode: 1 });
  });

  it("rejects a backpressured write when the child closes before drain", async () => {
    const child = fakeChild({ pid: null });
    child.stdin.write = vi.fn(() => false);
    spawn.mockReturnValue(child);
    const process = await startStreamingFfmpegProcess({
      command: command(), signal: new AbortController().signal,
      watchProcess: () => undefined, reportProcessContainment: () => undefined
    });

    const pending = process.write(Buffer.from("frame"));
    child.emit("close", 7);
    await expect(pending).rejects.toThrow("closed before accepting a frame");
    await expect(process.closed).resolves.toMatchObject({ exitCode: 7 });
  });

  it("rejects a backpressured write with the stdin error before drain", async () => {
    const child = fakeChild({ pid: null });
    child.stdin.write = vi.fn(() => false);
    spawn.mockReturnValue(child);
    const process = await startStreamingFfmpegProcess({
      command: command(), signal: new AbortController().signal,
      watchProcess: () => undefined, reportProcessContainment: () => undefined
    });

    const pending = process.write(Buffer.from("frame"));
    const pipeError = new Error("broken pipe during backpressure");
    child.stdin.emit("error", pipeError);
    await expect(pending).rejects.toBe(pipeError);
    await expect(process.write(Buffer.from("next frame"))).rejects.toBe(pipeError);
    child.emit("close", 1);
    await expect(process.closed).resolves.toMatchObject({ exitCode: 1 });
  });

  it("normalizes a synchronous missing-executable failure without exposing a live pipe", async () => {
    spawn.mockImplementation(() => { throw Object.assign(new Error("ffmpeg missing"), { code: "ENOENT" }); });
    const process = await startStreamingFfmpegProcess({
      command: command(),
      signal: new AbortController().signal,
      watchProcess: () => undefined,
      reportProcessContainment: () => undefined
    });
    await expect(process.closed).resolves.toEqual({ exitCode: 127, stdout: "", stderr: "ffmpeg missing" });
    await expect(process.end()).resolves.toEqual({ exitCode: 127, stdout: "", stderr: "ffmpeg missing" });
    await expect(process.write(Buffer.from("frame"))).rejects.toThrow("exited with code 127");
  });

  it("stops the exact direct child on cancellation and returns its bounded reason", async () => {
    const child = fakeChild({ pid: null });
    spawn.mockReturnValue(child);
    const process = await startStreamingFfmpegProcess({
      command: command(),
      signal: new AbortController().signal,
      watchProcess: () => undefined,
      reportProcessContainment: () => undefined
    });
    const pending = process.abort(new Error("operator cancellation"));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null);
    await expect(pending).resolves.toEqual({ exitCode: 1, stdout: "", stderr: "\noperator cancellation" });
  });

  it("relays a non-Error caller signal into the exact contained child", async () => {
    const child = fakeChild({ pid: null });
    spawn.mockReturnValue(child);
    const controller = new AbortController();
    const process = await startStreamingFfmpegProcess({
      command: command(),
      signal: controller.signal,
      watchProcess: () => undefined,
      reportProcessContainment: () => undefined
    });
    controller.abort("caller stopped");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null);
    await expect(process.closed).resolves.toEqual({ exitCode: 1, stdout: "", stderr: "\nFFmpeg streaming job cancelled." });
  });

  it("retains fail-closed native policy for an internal trusted launch without Job integration", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT", "1");
    const containment: unknown[] = [];
    await expect(startStreamingFfmpegProcessWithTrustedLaunch({
      command: command(),
      signal: new AbortController().signal,
      watchProcess: () => undefined,
      reportProcessContainment: (evidence) => containment.push(evidence)
    }, { executable: "trusted-node", args: ["launcher.mjs"], env: {} }))
      .rejects.toMatchObject({ code: "job_process_containment_unavailable" });
    expect(spawn).not.toHaveBeenCalled();
    expect(containment).toEqual([expect.objectContaining({
      mode: "direct-child",
      status: "unavailable",
      reasonCode: "native_helper_missing"
    })]);
  });
});

function command(): FfmpegCommand {
  return { executable: "ffmpeg-test", args: ["-f", "image2pipe", "pipe:0"], shell: false };
}

function fakeChild(input: { pid?: number | null } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = input.pid === null ? undefined : input.pid ?? 4321;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}
