import { spawn } from "node:child_process";
import { childEnvironment, createOwnedUnixProcessGroup, type OwnedUnixProcessGroup } from "@shellx-motion/core";
import {
  FFMPEG_TIMEOUT_EXIT_CODE,
  appendFfmpegProcessOutput,
  resolveFfmpegTimeoutMs,
  terminateFfmpegProcessTree,
  type FfmpegProcessTerminationMode
} from "./ffmpeg-process-control.js";
import type { FfmpegCommand, FfmpegProcessResult } from "./index";

// Darwin can briefly report EPERM for a killed, empty group before it reports ESRCH.
// Keep the result pending for that transition; EPERM itself never proves cleanup.
const PROCESS_GROUP_CLEANUP_TIMEOUT_MS = process.platform === "darwin" ? 5_000 : 1_500;

/**
 * Private terminal facts for the descriptor-bound strict-SDR inverse only. This is deliberately
 * separate from the generic FFmpeg result: an exit code cannot prove that the launch group and
 * its pipes reached a terminal state.
 */
export interface StrictSdrHeldInverseTerminalObservation {
  readonly childCloseObserved: boolean;
  readonly settlementStartedByClose: boolean;
  readonly ownedUnixProcessGroupCreated: boolean;
  readonly groupGoneAfterSettlement: boolean;
}

/** The private held inverse may report enforcement only after all terminal facts hold. */
export function strictSdrHeldInverseTerminalContainmentEstablished(
  observation: StrictSdrHeldInverseTerminalObservation | undefined,
): boolean {
  return observation?.childCloseObserved === true
    && observation.settlementStartedByClose === true
    && observation.ownedUnixProcessGroupCreated === true
    && observation.groupGoneAfterSettlement === true;
}

type FfmpegGroupSettlement = Readonly<{
  result: FfmpegProcessResult;
  groupGoneAfterSettlement: boolean;
}>;

/**
 * A closed leader is not terminal while its owned Unix process group remains present. Force the
 * retained group, then make the result fail closed if its disappearance cannot be confirmed.
 */
export async function settleFfmpegProcessAfterLeaderExit(
  group: OwnedUnixProcessGroup | undefined,
  result: FfmpegProcessResult,
  forceTerminate: () => void
): Promise<FfmpegProcessResult> {
  return (await settleFfmpegProcessAfterLeaderExitWithObservation(group, result, forceTerminate)).result;
}

async function settleFfmpegProcessAfterLeaderExitWithObservation(
  group: OwnedUnixProcessGroup | undefined,
  result: FfmpegProcessResult,
  forceTerminate: () => void
): Promise<FfmpegGroupSettlement> {
  if (!group) return { result, groupGoneAfterSettlement: false };
  if (group.presence() === "gone") return { result, groupGoneAfterSettlement: true };
  forceTerminate();
  if (await group.waitForExit(PROCESS_GROUP_CLEANUP_TIMEOUT_MS)) {
    return { result, groupGoneAfterSettlement: true };
  }
  return {
    result: {
      exitCode: 1,
      stdout: result.stdout,
      stderr: appendFfmpegProcessOutput(result.stderr, "\nMotion could not confirm contained Unix process-group cleanup."),
    },
    groupGoneAfterSettlement: false,
  };
}

export interface FfmpegProcessRunLimits {
  timeoutMs?: number;
  label?: string;
}

/**
 * Spawn one shell-free FFmpeg-style child, retaining its launch process group until terminal
 * settlement. The stream transport uses the same group-settlement primitive above.
 */
export function runSpawnedFfmpegChild(
  command: FfmpegCommand,
  signal: AbortSignal,
  watchProcess: (pid: number) => void,
  terminationMode: () => FfmpegProcessTerminationMode,
  limits: FfmpegProcessRunLimits = {}
): Promise<FfmpegProcessResult> {
  return runSpawnedFfmpegChildWithExecutable(command, signal, watchProcess, terminationMode, limits);
}

/**
 * Non-root internal launch primitive for a descriptor authority minted by
 * `unadopted/descriptor-bound-tool-execution`. It is deliberately not part of `FfmpegCommand`:
 * root-package callers can never make the launched binary disagree with their declared pathname.
 */
export function runDescriptorBoundFfmpegChild(
  command: FfmpegCommand,
  executableFd: number,
  signal: AbortSignal,
  watchProcess: (pid: number) => void,
  terminationMode: () => FfmpegProcessTerminationMode,
  limits: FfmpegProcessRunLimits = {}
): Promise<FfmpegProcessResult> {
  if (process.platform === "win32" || !Number.isInteger(executableFd) || executableFd < 3) {
    return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Descriptor-bound FFmpeg execution is unavailable on this host." });
  }
  return runSpawnedFfmpegChildWithExecutable(command, signal, watchProcess, terminationMode, limits, executableFd);
}

/**
 * Private Linux-only FFprobe launch for the one-slot strict-SDR candidate. Its child descriptor
 * table is deliberately fixed: held tool at 3 and held encoded media at 4. This is not a command
 * or request-level descriptor facility.
 */
export function runLinearSrgbSdrHeldProbeChild(
  command: FfmpegCommand,
  ffprobeFd: number,
  sourceFd: number,
  signal: AbortSignal,
  watchProcess: (pid: number) => void,
  terminationMode: () => FfmpegProcessTerminationMode,
  limits: FfmpegProcessRunLimits = {},
): Promise<FfmpegProcessResult> {
  return runLinearSrgbSdrHeldChild(command, ffprobeFd, [sourceFd], signal, watchProcess, terminationMode, limits);
}

/**
 * Private Linux-only inverse launch for the one-slot strict-SDR candidate. Its child descriptor
 * table is deliberately fixed: held tool at 3, source at 4, and exclusive decoded output at 5.
 */
export function runLinearSrgbSdrHeldInverseChild(
  command: FfmpegCommand,
  ffmpegFd: number,
  sourceFd: number,
  decodedFd: number,
  signal: AbortSignal,
  watchProcess: (pid: number) => void,
  terminationMode: () => FfmpegProcessTerminationMode,
  limits: FfmpegProcessRunLimits = {},
  observeTerminal?: (observation: StrictSdrHeldInverseTerminalObservation) => void,
): Promise<FfmpegProcessResult> {
  return runLinearSrgbSdrHeldChild(command, ffmpegFd, [sourceFd, decodedFd], signal, watchProcess, terminationMode, limits, observeTerminal);
}

function runLinearSrgbSdrHeldChild(
  command: FfmpegCommand,
  executableFd: number,
  inheritedFds: readonly number[],
  signal: AbortSignal,
  watchProcess: (pid: number) => void,
  terminationMode: () => FfmpegProcessTerminationMode,
  limits: FfmpegProcessRunLimits,
  observeTerminal?: (observation: StrictSdrHeldInverseTerminalObservation) => void,
): Promise<FfmpegProcessResult> {
  if (process.platform !== "linux" || !Number.isInteger(executableFd) || executableFd < 3
    || inheritedFds.some((fd) => !Number.isInteger(fd) || fd < 3)) {
    return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Strict SDR held-media execution is unavailable on this host." });
  }
  const expectedFds = inheritedFds.length === 1 ? [4] : [4, 5];
  if (inheritedFds.length !== expectedFds.length
    || command.executable !== "/proc/self/fd/3"
    || expectedFds.some((fd) => !command.args.includes(`/proc/self/fd/${fd}`))) {
    return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Strict SDR held-media command did not retain its fixed descriptor operands." });
  }
  return runSpawnedFfmpegChildWithExecutable(command, signal, watchProcess, terminationMode, limits, executableFd, inheritedFds, observeTerminal);
}

function runSpawnedFfmpegChildWithExecutable(
  command: FfmpegCommand,
  signal: AbortSignal,
  watchProcess: (pid: number) => void,
  terminationMode: () => FfmpegProcessTerminationMode,
  limits: FfmpegProcessRunLimits,
  executableFd?: number,
  inheritedFds: readonly number[] = [],
  observeTerminal?: (observation: StrictSdrHeldInverseTerminalObservation) => void,
): Promise<FfmpegProcessResult> {
  return new Promise((resolveResult) => {
    let child;
    try {
      const executable = executableFd === undefined
        ? command.executable
        : process.platform === "linux" ? "/proc/self/fd/3" : "/dev/fd/3";
      child = spawn(executable, command.args, {
        // Without an explicit `env`, Node hands the child the operator's entire
        // environment, SHELLX_MOTION_DEBUG_TOKEN included. FFmpeg needs none of it.
        env: childEnvironment(),
        shell: false,
        stdio: executableFd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", executableFd, ...inheritedFds],
        // Unix descendants inherit a process group. The Windows Job helper owns its native job;
        // the compatibility path remains a normal descendant tree for taskkill /T.
        detached: process.platform !== "win32",
        windowsHide: true
      });
    } catch (error) {
      const spawnError = error as NodeJS.ErrnoException;
      resolveResult({ exitCode: spawnError.code === "ENOENT" ? 127 : 1, stdout: "", stderr: spawnError.message });
      return;
    }
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (!childStdout || !childStderr) {
      try { child.kill(); } catch { /* spawn is already terminating */ }
      resolveResult({ exitCode: 1, stdout: "", stderr: "Motion FFmpeg spawn did not provide piped standard streams." });
      return;
    }
    if (child.pid) watchProcess(child.pid);
    const ownedUnixProcessGroup = terminationMode() === "unix-process-group"
      ? createOwnedUnixProcessGroup(child.pid)
      : undefined;
    const ownedUnixProcessGroupCreated = ownedUnixProcessGroup !== undefined;
    let childCloseObserved = false;
    let settlementStartedByClose = false;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    let groupSettlement: Promise<void> | null = null;
    const timeoutMs = limits.timeoutMs ?? resolveFfmpegTimeoutMs();
    const armForceTermination = () => {
      if (killTimer) return;
      killTimer = setTimeout(() => {
        if (!settled) terminateFfmpegProcessTree(child, true, terminationMode(), ownedUnixProcessGroup);
      }, 100);
      killTimer.unref?.();
    };
    const stop = () => {
      terminateFfmpegProcessTree(child, false, terminationMode(), ownedUnixProcessGroup);
      armForceTermination();
    };
    const timeoutTimer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          stderr = appendFfmpegProcessOutput(stderr, `\n${limits.label ?? "FFmpeg command"} timed out after ${timeoutMs}ms.`);
          stop();
        }, timeoutMs)
      : null;
    timeoutTimer?.unref?.();
    const finish = (result: FfmpegProcessResult, groupGoneAfterSettlement: boolean) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", abortChild);
      let terminalResult = result;
      if (observeTerminal) {
        try {
          observeTerminal(Object.freeze({ childCloseObserved, settlementStartedByClose, ownedUnixProcessGroupCreated, groupGoneAfterSettlement }));
        } catch {
          terminalResult = {
            exitCode: 1,
            stdout: result.stdout,
            stderr: appendFfmpegProcessOutput(result.stderr, "\nMotion strict-SDR held inverse terminal observation failed."),
          };
        }
      }
      resolveResult(terminalResult);
    };
    const settleAfterContainedGroupExit = (result: FfmpegProcessResult) => {
      if (groupSettlement) return;
      groupSettlement = settleFfmpegProcessAfterLeaderExitWithObservation(
        ownedUnixProcessGroup,
        result,
        () => terminateFfmpegProcessTree(child, true, terminationMode(), ownedUnixProcessGroup)
      ).then(
        (settlement) => finish(settlement.result, settlement.groupGoneAfterSettlement),
        () => finish({
          exitCode: 1,
          stdout: result.stdout,
          stderr: appendFfmpegProcessOutput(result.stderr, "\nMotion could not settle contained Unix process-group cleanup."),
        }, false),
      );
    };
    const abortChild = () => {
      stderr = appendFfmpegProcessOutput(stderr, `\n${signal.reason instanceof Error ? signal.reason.message : "FFmpeg job cancelled."}`);
      terminateFfmpegProcessTree(child, false, terminationMode(), ownedUnixProcessGroup);
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (!settled) terminateFfmpegProcessTree(child, true, terminationMode(), ownedUnixProcessGroup);
        }, 250);
        killTimer.unref?.();
      }
    };
    signal.addEventListener("abort", abortChild, { once: true });
    if (signal.aborted) abortChild();

    childStdout.setEncoding("utf8");
    childStderr.setEncoding("utf8");
    childStdout.on("data", (chunk) => { stdout = appendFfmpegProcessOutput(stdout, chunk); });
    childStderr.on("data", (chunk) => { stderr = appendFfmpegProcessOutput(stderr, chunk); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      settleAfterContainedGroupExit({ exitCode: error.code === "ENOENT" ? 127 : 1, stdout, stderr: appendFfmpegProcessOutput(stderr, error.message) });
    });
    child.on("close", (code) => {
      childCloseObserved = true;
      // An error may have begun settlement first. A late `close` then only drains Node's child
      // handle; it cannot retroactively prove that the terminal result waited for the close.
      if (!groupSettlement) settlementStartedByClose = true;
      settleAfterContainedGroupExit({ exitCode: timedOut ? FFMPEG_TIMEOUT_EXIT_CODE : code ?? 1, stdout, stderr });
    });
  });
}
