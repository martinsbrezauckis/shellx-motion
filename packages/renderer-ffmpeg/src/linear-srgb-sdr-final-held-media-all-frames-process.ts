/**
 * Private binary stdout protocol for the same-parent all-delivered-frame inverse.
 * It deliberately does not share the generic UTF-8 FFmpeg result transport.
 */
import { spawn } from "node:child_process";
import { childEnvironment, createOwnedUnixProcessGroup, type OwnedUnixProcessGroup } from "@shellx-motion/core";
import {
  FFMPEG_TIMEOUT_EXIT_CODE,
  appendFfmpegProcessOutput,
  resolveFfmpegTimeoutMs,
  terminateFfmpegProcessTree,
  type FfmpegProcessTerminationMode,
} from "./ffmpeg-process-control.js";
import { heldAllDeliveredFramesInverseCommand } from "./linear-srgb-sdr-final-held-media-command.js";
import type { FfmpegCommand, FfmpegProcessResult } from "./index.js";

const PROCESS_GROUP_CLEANUP_TIMEOUT_MS = 1_500;

export type StrictSdrHeldAllFramesTerminalObservation = Readonly<{
  childCloseObserved: boolean;
  settlementStartedByClose: boolean;
  ownedUnixProcessGroupCreated: boolean;
  groupGoneAfterSettlement: boolean;
  stdoutEofObserved: boolean;
  stdoutErrorFree: boolean;
  streamCallbacksSettled: boolean;
  streamCallbacksSucceeded: boolean;
}>;

export function strictSdrHeldAllFramesTerminalEstablished(
  observation: StrictSdrHeldAllFramesTerminalObservation | undefined,
): boolean {
  return observation?.childCloseObserved === true
    && observation.settlementStartedByClose === true
    && observation.ownedUnixProcessGroupCreated === true
    && observation.groupGoneAfterSettlement === true
    && observation.stdoutEofObserved === true
    && observation.stdoutErrorFree === true
    && observation.streamCallbacksSettled === true
    && observation.streamCallbacksSucceeded === true;
}

export async function runLinearSrgbSdrHeldAllFramesChild(input: Readonly<{
  ffmpegFd: number;
  sourceFd: number;
  signal: AbortSignal;
  watchProcess(pid: number): void;
  terminationMode(): FfmpegProcessTerminationMode;
  maximumChunkBytes: number;
  consumeChunk(chunk: Buffer): Promise<void> | void;
  observeTerminal(observation: StrictSdrHeldAllFramesTerminalObservation): void;
  timeoutMs?: number;
  label?: string;
}>): Promise<FfmpegProcessResult> {
  if (process.platform !== "linux" || !Number.isInteger(input.ffmpegFd) || input.ffmpegFd < 3
    || !Number.isInteger(input.sourceFd) || input.sourceFd < 3
    || !Number.isSafeInteger(input.maximumChunkBytes) || input.maximumChunkBytes < 1
    || input.maximumChunkBytes > 1_048_576) {
    return { exitCode: 1, stdout: "", stderr: "Strict SDR all-delivered-frame binary execution did not retain its fixed descriptor protocol." };
  }
  try {
    return await run(input, heldAllDeliveredFramesInverseCommand());
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : "Strict SDR all-delivered-frame binary command construction failed." };
  }
}

async function run(input: Parameters<typeof runLinearSrgbSdrHeldAllFramesChild>[0], command: FfmpegCommand): Promise<FfmpegProcessResult> {
  return await new Promise((resolveResult) => {
    let child;
    try {
      child = spawn(command.executable, command.args, {
        env: childEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe", input.ffmpegFd, input.sourceFd],
        detached: true,
        windowsHide: true,
      });
    } catch (error) {
      const spawnError = error as NodeJS.ErrnoException;
      resolveResult({ exitCode: spawnError.code === "ENOENT" ? 127 : 1, stdout: "", stderr: spawnError.message });
      return;
    }
    const stdout = child.stdout, stderr = child.stderr;
    let mode: FfmpegProcessTerminationMode = "direct-child";
    let group: OwnedUnixProcessGroup | undefined;
    let launchFailure: unknown;
    try {
      if (!stdout || !stderr || !child.pid) {
        throw new Error("Strict SDR all-delivered-frame child did not provide binary stdout, diagnostic stderr, and a live PID.");
      }
      mode = input.terminationMode();
      if (mode !== "unix-process-group") {
        throw new Error("Strict SDR all-delivered-frame child did not retain its required Unix process-group mode.");
      }
      group = createOwnedUnixProcessGroup(child.pid);
      if (!group) throw new Error("Strict SDR all-delivered-frame child did not create its owned Unix process group.");
      input.watchProcess(child.pid);
    } catch (error) {
      launchFailure = error;
    }
    const groupCreated = group !== undefined;
    const timeoutMs = input.timeoutMs ?? resolveFfmpegTimeoutMs();
    let stderrText = "", settled = false, finishing = false, timedOut = false, childCloseObserved = false, settlementStartedByClose = false;
    let stdoutEofObserved = false, stdoutError: unknown, streamFailure: unknown;
    let groupSettlement: Promise<void> | undefined, forceTimer: NodeJS.Timeout | undefined, timeoutTimer: NodeJS.Timeout | undefined, closeDeadlineTimer: NodeJS.Timeout | undefined;
    let callbacks = Promise.resolve();

    const safeTerminate = (force: boolean) => {
      try {
        terminateFfmpegProcessTree(child, force, mode, group);
      } catch (error) {
        if (streamFailure === undefined) streamFailure = error;
      }
    };
    const forceTerminate = () => {
      if (forceTimer) return;
      forceTimer = setTimeout(() => {
        if (!settled) safeTerminate(true);
      }, 100);
      forceTimer.unref?.();
    };
    const noteFailure = (error: unknown) => {
      if (streamFailure === undefined) streamFailure = error;
      safeTerminate(false);
      forceTerminate();
      armCloseDeadline();
    };
    const abortChild = () => {
      stderrText = appendFfmpegProcessOutput(stderrText, `\n${input.signal.reason instanceof Error ? input.signal.reason.message : "FFmpeg job cancelled."}`);
      noteFailure(input.signal.reason ?? new Error("Strict SDR all-delivered-frame job cancelled."));
    };
    const finish = async (result: FfmpegProcessResult, groupGoneAfterSettlement: boolean) => {
      if (settled || finishing) return;
      finishing = true;
      // A close may race a paused final data event. Resume before draining the
      // serial chain, and repeat until no data handler has appended more work.
      if (streamFailure === undefined && stdoutError === undefined && stdout && !stdout.destroyed) stdout.resume();
      for (;;) {
        const pending = callbacks;
        await pending;
        if (pending === callbacks) break;
      }
      settled = true;
      timeoutTimer && clearTimeout(timeoutTimer);
      forceTimer && clearTimeout(forceTimer);
      closeDeadlineTimer && clearTimeout(closeDeadlineTimer);
      input.signal.removeEventListener("abort", abortChild);
      const streamCallbacksSettled = true;
      const streamCallbacksSucceeded = streamFailure === undefined;
      let terminalResult = result;
      if (streamFailure !== undefined || stdoutError !== undefined || !stdoutEofObserved || !childCloseObserved) {
        terminalResult = {
          exitCode: 1,
          stdout: "",
          stderr: appendFfmpegProcessOutput(result.stderr, `\n${streamFailure instanceof Error ? streamFailure.message : stdoutError instanceof Error ? stdoutError.message : "Strict SDR all-delivered-frame binary stdout did not reach clean EOF."}`),
        };
      }
      try {
        input.observeTerminal(Object.freeze({
          childCloseObserved,
          settlementStartedByClose,
          ownedUnixProcessGroupCreated: groupCreated,
          groupGoneAfterSettlement,
          stdoutEofObserved,
          stdoutErrorFree: stdoutError === undefined,
          streamCallbacksSettled,
          streamCallbacksSucceeded,
        }));
      } catch {
        terminalResult = {
          exitCode: 1,
          stdout: "",
          stderr: appendFfmpegProcessOutput(terminalResult.stderr, "\nMotion strict-SDR all-delivered-frame terminal observation failed."),
        };
      }
      resolveResult(terminalResult);
    };
    const settleAfterGroup = (result: FfmpegProcessResult) => {
      if (groupSettlement) return;
      groupSettlement = settleGroup(group, result, () => safeTerminate(true)).then(
        ({ result: settledResult, groupGoneAfterSettlement }) => finish(settledResult, groupGoneAfterSettlement),
        () => finish({ exitCode: 1, stdout: "", stderr: appendFfmpegProcessOutput(result.stderr, "\nMotion could not settle contained Unix process-group cleanup.") }, false),
      );
    };
    const armCloseDeadline = () => {
      if (closeDeadlineTimer || childCloseObserved || settled) return;
      closeDeadlineTimer = setTimeout(() => {
        settleAfterGroup({
          exitCode: 1,
          stdout: "",
          stderr: appendFfmpegProcessOutput(stderrText, "\nStrict SDR all-delivered-frame child did not emit close during bounded refusal cleanup."),
        });
      }, PROCESS_GROUP_CLEANUP_TIMEOUT_MS);
      closeDeadlineTimer.unref?.();
    };

    timeoutTimer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      stderrText = appendFfmpegProcessOutput(stderrText, `\n${input.label ?? "Strict SDR all-delivered-frame FFmpeg command"} timed out after ${timeoutMs}ms.`);
      noteFailure(new Error("Strict SDR all-delivered-frame FFmpeg command timed out."));
    }, timeoutMs) : undefined;
    timeoutTimer?.unref?.();
    input.signal.addEventListener("abort", abortChild, { once: true });

    if (stderr) {
      stderr.setEncoding("utf8");
      stderr.on("data", (chunk: string) => { stderrText = appendFfmpegProcessOutput(stderrText, chunk); });
      stderr.on("error", (error) => { noteFailure(error); });
    }
    if (stdout) {
      stdout.on("data", (chunk: Buffer) => {
        stdout.pause();
        callbacks = callbacks.then(async () => {
          if (chunk.byteLength > input.maximumChunkBytes) {
            throw new Error("Strict SDR all-delivered-frame binary stdout emitted an oversize admitted chunk.");
          }
          await input.consumeChunk(chunk);
        }).catch((error: unknown) => { noteFailure(error); }).finally(() => {
          if (!settled && streamFailure === undefined && stdoutError === undefined) stdout.resume();
        });
      });
      stdout.on("end", () => { stdoutEofObserved = true; });
      stdout.on("error", (error) => {
        stdoutError = error;
        noteFailure(error);
      });
    }
    child.on("error", (error: NodeJS.ErrnoException) => {
      stdoutError ??= error;
      stderrText = appendFfmpegProcessOutput(stderrText, error.message);
      noteFailure(error);
    });
    child.on("close", (code) => {
      childCloseObserved = true;
      if (!groupSettlement) settlementStartedByClose = true;
      settleAfterGroup({ exitCode: timedOut ? FFMPEG_TIMEOUT_EXIT_CODE : code ?? 1, stdout: "", stderr: stderrText });
    });
    if (launchFailure !== undefined) noteFailure(launchFailure);
    if (input.signal.aborted) abortChild();
  });
}

async function settleGroup(
  group: OwnedUnixProcessGroup | undefined,
  result: FfmpegProcessResult,
  forceTerminate: () => void,
): Promise<Readonly<{ result: FfmpegProcessResult; groupGoneAfterSettlement: boolean }>> {
  if (!group) return { result, groupGoneAfterSettlement: false };
  if (group.presence() === "gone") return { result, groupGoneAfterSettlement: true };
  forceTerminate();
  if (await group.waitForExit(PROCESS_GROUP_CLEANUP_TIMEOUT_MS)) return { result, groupGoneAfterSettlement: true };
  return {
    result: {
      exitCode: 1,
      stdout: "",
      stderr: appendFfmpegProcessOutput(result.stderr, "\nMotion could not confirm contained Unix process-group cleanup."),
    },
    groupGoneAfterSettlement: false,
  };
}
