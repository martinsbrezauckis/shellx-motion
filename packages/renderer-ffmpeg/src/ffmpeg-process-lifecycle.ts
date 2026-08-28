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

const PROCESS_GROUP_CLEANUP_TIMEOUT_MS = 1_500;

/**
 * A closed leader is not terminal while its owned Unix process group remains present. Force the
 * retained group, then make the result fail closed if its disappearance cannot be confirmed.
 */
export async function settleFfmpegProcessAfterLeaderExit(
  group: OwnedUnixProcessGroup | undefined,
  result: FfmpegProcessResult,
  forceTerminate: () => void
): Promise<FfmpegProcessResult> {
  if (!group || group.presence() === "gone") return result;
  forceTerminate();
  if (await group.waitForExit(PROCESS_GROUP_CLEANUP_TIMEOUT_MS)) return result;
  return {
    exitCode: 1,
    stdout: result.stdout,
    stderr: appendFfmpegProcessOutput(result.stderr, "\nMotion could not confirm contained Unix process-group cleanup."),
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
  return new Promise((resolveResult) => {
    let child;
    try {
      child = spawn(command.executable, command.args, {
        // Without an explicit `env`, Node hands the child the operator's entire
        // environment, SHELLX_MOTION_DEBUG_TOKEN included. FFmpeg needs none of it.
        env: childEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
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
    if (child.pid) watchProcess(child.pid);
    const ownedUnixProcessGroup = terminationMode() === "unix-process-group"
      ? createOwnedUnixProcessGroup(child.pid)
      : undefined;
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
    const finish = (result: FfmpegProcessResult) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", abortChild);
      resolveResult(result);
    };
    const settleAfterContainedGroupExit = (result: FfmpegProcessResult) => {
      if (groupSettlement) return;
      groupSettlement = settleFfmpegProcessAfterLeaderExit(
        ownedUnixProcessGroup,
        result,
        () => terminateFfmpegProcessTree(child, true, terminationMode(), ownedUnixProcessGroup)
      ).then(finish);
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

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = appendFfmpegProcessOutput(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendFfmpegProcessOutput(stderr, chunk); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      settleAfterContainedGroupExit({ exitCode: error.code === "ENOENT" ? 127 : 1, stdout, stderr: appendFfmpegProcessOutput(stderr, error.message) });
    });
    child.on("close", (code) => {
      settleAfterContainedGroupExit({ exitCode: timedOut ? FFMPEG_TIMEOUT_EXIT_CODE : code ?? 1, stdout, stderr });
    });
  });
}
