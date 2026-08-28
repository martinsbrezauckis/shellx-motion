import { spawn } from "node:child_process";
import {
  LocalMotionJobError,
  childEnvironment,
  createOwnedUnixProcessGroup,
  type LocalMotionProcessContainmentEvidence
} from "@shellx-motion/core";
import {
  FFMPEG_TIMEOUT_EXIT_CODE,
  appendFfmpegProcessOutput,
  nativeWindowsJobObjectRequired,
  portableFfmpegContainmentEvidence,
  resolveFfmpegTimeoutMs,
  terminateFfmpegProcessTree,
  unavailableWindowsContainment,
  windowsTaskkillFallbackEvidence,
  type FfmpegProcessTerminationMode
} from "./ffmpeg-process-control";
import { settleFfmpegProcessAfterLeaderExit } from "./ffmpeg-process-lifecycle";
import { startWindowsJobObjectStreamingProcess } from "./streaming-windows-job";
import type { FfmpegCommand, FfmpegProcessResult } from "./index";

// Kept package-private: no renderer barrel, CLI, Debug/MCP, or SDK surface can select this factory.
// The explicit re-export makes the internal module reachable in the shipped source graph for a
// future trusted host adopter, without promoting it to a package entry point.
export { createEnforcedUntrustedParserProcessFactory } from "./enforced-untrusted-parser.js";

export interface StreamingFfmpegProcess {
  readonly closed: Promise<FfmpegProcessResult>;
  /** Resolves only when this frame no longer needs caller-side backpressure handling. */
  write(frame: Buffer): Promise<{
    backpressured: boolean;
    /** Node Writable's observed byte queue directly after the frame write. */
    bufferedInputBytes: number;
    inputHighWaterMarkBytes: number;
  }>;
  /** Close stdin normally and wait for encoder termination. */
  end(): Promise<FfmpegProcessResult>;
  /** Stop the exact process tree launched for this encode and wait for it to settle. */
  abort(reason?: Error): Promise<FfmpegProcessResult>;
}

export interface StartStreamingFfmpegProcessInput {
  command: FfmpegCommand;
  signal: AbortSignal;
  watchProcess(pid: number): void;
  reportProcessContainment(evidence: LocalMotionProcessContainmentEvidence): void;
  /** Canonical governor-owned root for the native Windows launch request and status. */
  scratchRoot?: string;
  /** The same process-tree RSS ceiling enforced by the enclosing governor. */
  maxProcessTreeRssBytes?: number;
}

export type StreamingFfmpegProcessFactory = (input: StartStreamingFfmpegProcessInput) => Promise<StreamingFfmpegProcess>;

/** Internal launch facts for a fixed host-owned shim. This is intentionally not a render request option. */
export interface TrustedStreamingFfmpegLaunch {
  executable: string;
  args: string[];
  /** Deliberately complete rather than merged with childEnvironment(): no host HOME/tokens/proxies leak to the shim. */
  env: NodeJS.ProcessEnv;
}

/**
 * The production pipe process transport. It deliberately receives a fully constructed
 * command from the policy layer so encoder/audio selection remains outside this renderer-neutral
 * handoff, while ownership of shell-free stdin backpressure stays here.
 */
export const startStreamingFfmpegProcess: StreamingFfmpegProcessFactory = async (input) => {
  const launch = {
    executable: input.command.executable,
    args: input.command.args,
    env: childEnvironment()
  };
  if (process.platform === "win32") {
    return startWindowsJobObjectStreamingProcess(input, launch, spawnStreamingFfmpegProcess);
  }
  return startStreamingFfmpegProcessWithTrustedLaunch(input, launch);
};

/**
 * Internal-only shared pipe transport for a launch that has already been constructed by trusted
 * host code. It preserves the normal timeout/process-tree containment behavior while ensuring a
 * caller can replace the executable and complete environment without a shell.
 */
export async function startStreamingFfmpegProcessWithTrustedLaunch(
  input: StartStreamingFfmpegProcessInput,
  launch: TrustedStreamingFfmpegLaunch
): Promise<StreamingFfmpegProcess> {
  if (input.command.shell !== false) throw new Error("Streaming FFmpeg requires shell:false.");
  const mode = streamingTerminationMode();
  if (mode === "windows-taskkill-fallback" && nativeWindowsJobObjectRequired()) {
    input.reportProcessContainment(unavailableWindowsContainment("native_helper_missing"));
    throw new LocalMotionJobError(
      "job_process_containment_unavailable",
      "This trusted streaming launch has no native Windows Job Object integration."
    );
  }
  input.reportProcessContainment(mode === "windows-taskkill-fallback"
    ? windowsTaskkillFallbackEvidence("native_helper_missing")
    : portableFfmpegContainmentEvidence(mode));

  return spawnStreamingFfmpegProcess(input, launch, mode);
}

export function spawnStreamingFfmpegProcess(
  input: StartStreamingFfmpegProcessInput,
  launch: TrustedStreamingFfmpegLaunch,
  mode: FfmpegProcessTerminationMode
): StreamingFfmpegProcess {
  let child;
  try {
    child = spawn(launch.executable, launch.args, {
      env: launch.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: mode === "unix-process-group",
      windowsHide: true
    });
  } catch (error) {
    const spawnError = error as NodeJS.ErrnoException;
    return closedProcess({ exitCode: spawnError.code === "ENOENT" ? 127 : 1, stdout: "", stderr: spawnError.message });
  }
  if (child.pid) input.watchProcess(child.pid);
  const ownedUnixProcessGroup = mode === "unix-process-group"
    ? createOwnedUnixProcessGroup(child.pid)
    : undefined;

  let stdout = "";
  let stderr = "";
  let settled: FfmpegProcessResult | undefined;
  let forceTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let groupSettlement: Promise<void> | undefined;
  let timedOut = false;
  let stdinError: Error | undefined;
  let resolveClosed!: (result: FfmpegProcessResult) => void;
  const closed = new Promise<FfmpegProcessResult>((resolve) => { resolveClosed = resolve; });
  const finish = (result: FfmpegProcessResult) => {
    if (settled) return;
    settled = result;
    if (forceTimer) clearTimeout(forceTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    input.signal.removeEventListener("abort", abortFromSignal);
    resolveClosed(result);
  };
  const armForceTermination = (forceAfterMs: number) => {
    forceTimer ??= setTimeout(() => {
      if (!settled) terminateProcessTree(child, true, mode, ownedUnixProcessGroup);
    }, forceAfterMs);
    forceTimer.unref?.();
  };
  const stop = (reason?: Error, forceAfterMs = 250) => {
    if (settled) return;
    if (reason) stderr = appendFfmpegProcessOutput(stderr, `\n${reason.message}`);
    terminateProcessTree(child, false, mode, ownedUnixProcessGroup);
    armForceTermination(forceAfterMs);
  };
  const settleAfterContainedGroupExit = (result: FfmpegProcessResult) => {
    if (groupSettlement) return;
    groupSettlement = settleFfmpegProcessAfterLeaderExit(
      ownedUnixProcessGroup,
      result,
      () => terminateProcessTree(child, true, mode, ownedUnixProcessGroup)
    ).then(finish);
  };
  const abortFromSignal = () => stop(input.signal.reason instanceof Error
    ? input.signal.reason
    : new Error("FFmpeg streaming job cancelled."));

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = appendFfmpegProcessOutput(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = appendFfmpegProcessOutput(stderr, chunk); });
  child.stdin.on("error", (error) => { stdinError ??= error; });
  child.on("error", (error: NodeJS.ErrnoException) => {
    settleAfterContainedGroupExit({ exitCode: error.code === "ENOENT" ? 127 : 1, stdout, stderr: appendFfmpegProcessOutput(stderr, error.message) });
  });
  child.on("close", (code) => settleAfterContainedGroupExit({ exitCode: timedOut ? FFMPEG_TIMEOUT_EXIT_CODE : code ?? 1, stdout, stderr }));
  const timeoutMs = resolveFfmpegTimeoutMs();
  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      stop(new Error(`Streaming FFmpeg command timed out after ${timeoutMs}ms.`), 100);
    }, timeoutMs);
    timeoutTimer.unref?.();
  }
  input.signal.addEventListener("abort", abortFromSignal, { once: true });
  if (input.signal.aborted) abortFromSignal();

  return {
    closed,
    async write(frame) {
      if (settled) throw encoderClosedError(settled);
      if (stdinError) throw stdinError;
      const accepted = child.stdin.write(frame);
      const bufferedInputBytes = child.stdin.writableLength;
      const inputHighWaterMarkBytes = child.stdin.writableHighWaterMark;
      if (accepted) return { backpressured: false, bufferedInputBytes, inputHighWaterMarkBytes };
      await new Promise<void>((resolveDrain, rejectDrain) => {
        const cleanup = () => {
          child.stdin.removeListener("drain", onDrain);
          child.removeListener("close", onClose);
          child.stdin.removeListener("error", onError);
        };
        const onDrain = () => { cleanup(); resolveDrain(); };
        const onClose = () => { cleanup(); rejectDrain(encoderClosedError(settled)); };
        const onError = (error: Error) => { cleanup(); rejectDrain(error); };
        child.stdin.once("drain", onDrain);
        child.once("close", onClose);
        child.stdin.once("error", onError);
      });
      if (settled) throw encoderClosedError(settled);
      return { backpressured: true, bufferedInputBytes, inputHighWaterMarkBytes };
    },
    async end() {
      if (!settled) child.stdin.end();
      return closed;
    },
    async abort(reason) {
      stop(reason);
      return closed;
    }
  };
}

function closedProcess(result: FfmpegProcessResult): StreamingFfmpegProcess {
  return {
    closed: Promise.resolve(result),
    write: async () => { throw encoderClosedError(result); },
    end: async () => result,
    abort: async () => result
  };
}

function encoderClosedError(result: FfmpegProcessResult | undefined): Error {
  return new Error(result
    ? `Streaming FFmpeg exited with code ${result.exitCode}.`
    : "Streaming FFmpeg closed before accepting a frame.");
}

type StreamingTerminationMode = "unix-process-group" | "windows-taskkill-fallback" | "direct-child";

function streamingTerminationMode(): StreamingTerminationMode {
  if (process.platform === "win32") return "windows-taskkill-fallback";
  return process.platform === "linux" || process.platform === "darwin" ? "unix-process-group" : "direct-child";
}

function terminateProcessTree(
  child: { pid?: number; kill(signal?: NodeJS.Signals | number): boolean },
  force: boolean,
  mode: FfmpegProcessTerminationMode,
  ownedUnixProcessGroup?: ReturnType<typeof createOwnedUnixProcessGroup>
): void {
  terminateFfmpegProcessTree(child, force, mode, ownedUnixProcessGroup);
}
