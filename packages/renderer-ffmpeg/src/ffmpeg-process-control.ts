import { spawn } from "node:child_process";
import {
  type LocalMotionProcessContainmentEvidence,
  type OwnedUnixProcessGroup
} from "@shellx-motion/core";

export const DEFAULT_FFMPEG_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
export const FFMPEG_TIMEOUT_EXIT_CODE = 124;
export const MAX_FFMPEG_OUTPUT_CHARS = 1_000_000;
/** API-visible diagnostics stay much smaller than retained process output. */
export const MAX_FFMPEG_DIAGNOSTIC_CHARS = 4_096;

export type FfmpegProcessTerminationMode = "windows-job-object" | "windows-taskkill-fallback" | "unix-process-group" | "direct-child";

/** The one output-retention rule used by every FFmpeg child, including streaming pipes. */
export function appendFfmpegProcessOutput(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_FFMPEG_OUTPUT_CHARS ? next.slice(-MAX_FFMPEG_OUTPUT_CHARS) : next;
}

/** Keep the established final-lines diagnostic policy, then redact and cap it for API errors. */
export function summarizeFfmpegDiagnostic(stderr: string): string {
  const summary = redactFfmpegDiagnostic(stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" "));
  return summary.length > MAX_FFMPEG_DIAGNOSTIC_CHARS
    ? `${summary.slice(0, MAX_FFMPEG_DIAGNOSTIC_CHARS - 1)}…`
    : summary;
}

export function redactFfmpegDiagnostic(value: string): string {
  return value.replace(/\b[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Z0-9_]*=([^\s]+)/g, (match) => `${match.split("=")[0]}=[redacted]`);
}

/** The encode wall-clock budget applies to image2pipe exactly as it applies to image sequences. */
export function resolveFfmpegTimeoutMs(): number {
  const raw = process.env.SHELLX_MOTION_FFMPEG_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_FFMPEG_COMMAND_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : DEFAULT_FFMPEG_COMMAND_TIMEOUT_MS;
}

/** One tree terminator: Unix process group, Windows taskkill /T, then direct-child fallback. */
export function terminateFfmpegProcessTree(
  child: { pid?: number; kill(signal?: NodeJS.Signals | number): boolean },
  force: boolean,
  mode: FfmpegProcessTerminationMode,
  ownedUnixProcessGroup?: OwnedUnixProcessGroup
): void {
  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  if (mode === "windows-taskkill-fallback" && child.pid) {
    try {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
        shell: false,
        stdio: "ignore",
        windowsHide: true
      });
      killer.unref();
      return;
    } catch {
      // Fall through to direct signalling when taskkill itself cannot start.
    }
  } else if (mode === "unix-process-group") {
    // The launch path must capture this handle immediately after spawn. Never reconstruct group
    // authority from a bare numeric PID during cleanup, after the leader may already have exited.
    if (ownedUnixProcessGroup?.signal(signal)) return;
  }
  try { child.kill(signal); } catch { /* Process already exited. */ }
}

export function nativeWindowsJobObjectRequired(): boolean {
  return /^(?:1|true|yes)$/i.test(process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT?.trim() ?? "");
}

export function portableFfmpegContainmentEvidence(mode: "unix-process-group" | "direct-child"): LocalMotionProcessContainmentEvidence {
  return {
    schema: "shellx-motion/process-containment@1",
    mode,
    status: mode === "unix-process-group" ? "enforced" : "unavailable",
    killTree: mode === "unix-process-group",
    memoryLimit: mode === "unix-process-group" ? "rss-monitor" : "none",
    ...(mode === "direct-child" ? { reasonCode: "unsupported_platform" as const } : {})
  };
}

export function unavailableWindowsContainment(
  reasonCode: "native_helper_missing" | "native_setup_failed"
): LocalMotionProcessContainmentEvidence {
  return {
    schema: "shellx-motion/process-containment@1",
    mode: "direct-child",
    status: "unavailable",
    killTree: false,
    memoryLimit: "none",
    reasonCode
  };
}

export function windowsTaskkillFallbackEvidence(
  reasonCode: "native_helper_missing" | "native_setup_failed",
  helperSha256?: string
): LocalMotionProcessContainmentEvidence {
  return {
    schema: "shellx-motion/process-containment@1",
    mode: "windows-taskkill-fallback",
    status: "fallback",
    killTree: true,
    memoryLimit: "rss-monitor",
    reasonCode,
    ...(helperSha256 ? { launcher: { kind: "powershell-csharp" as const, sha256: helperSha256 } } : {})
  };
}
