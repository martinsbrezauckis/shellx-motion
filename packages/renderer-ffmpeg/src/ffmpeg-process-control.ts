import { spawn } from "node:child_process";
import {
  resolveWindowsSystemExecutable,
  sanitizeUntrustedDiagnostic,
  takeUtf8Prefix,
  takeUtf8Suffix,
  type LocalMotionProcessContainmentEvidence,
  type OwnedUnixProcessGroup
} from "@shellx-motion/core";

export const DEFAULT_FFMPEG_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
export const FFMPEG_TIMEOUT_EXIT_CODE = 124;
export const MAX_FFMPEG_OUTPUT_CHARS = 1_000_000;
/** API-visible diagnostics stay much smaller than retained process output. */
export const MAX_FFMPEG_DIAGNOSTIC_CHARS = 4_096;
/** Raw stderr inspected to produce the public diagnostic; never caller-configurable. */
export const MAX_FFMPEG_DIAGNOSTIC_RAW_BYTES = 64 * 1024;

export type FfmpegProcessTerminationMode = "windows-job-object" | "windows-taskkill-fallback" | "unix-process-group" | "direct-child";

/** The one output-retention rule used by every FFmpeg child, including streaming pipes. */
export function appendFfmpegProcessOutput(current: string, chunk: string): string {
  const retained = takeUtf8Suffix(current, MAX_FFMPEG_OUTPUT_CHARS).value;
  const boundedChunk = takeUtf8Suffix(chunk, MAX_FFMPEG_OUTPUT_CHARS).value;
  return takeUtf8Suffix(`${retained}${boundedChunk}`, MAX_FFMPEG_OUTPUT_CHARS).value;
}

/** Keep the established final-lines diagnostic policy, then redact and cap it for API errors. */
export function summarizeFfmpegDiagnostic(stderr: string): string {
  // The terminal lines are the useful FFmpeg failure. Retain only a bounded
  // suffix before parsing so a verbose prefix cannot hide the actual error.
  const raw = takeUtf8Suffix(stderr, MAX_FFMPEG_DIAGNOSTIC_RAW_BYTES);
  const lines = finalNonEmptyDiagnosticLines(raw.value, 2, raw.truncated);
  const safeLines = lines.map((line) => sanitizeUntrustedDiagnostic(line, {
    rawMaxBytes: MAX_FFMPEG_DIAGNOSTIC_RAW_BYTES,
    publicMaxBytes: MAX_FFMPEG_DIAGNOSTIC_RAW_BYTES
  }));
  const summary = retainTerminalDiagnosticLines(safeLines, MAX_FFMPEG_DIAGNOSTIC_CHARS);
  return sanitizeUntrustedDiagnostic(summary, {
    rawMaxBytes: MAX_FFMPEG_DIAGNOSTIC_RAW_BYTES,
    publicMaxBytes: MAX_FFMPEG_DIAGNOSTIC_CHARS,
    collapseWhitespace: true,
    sourceTruncated: raw.truncated
  });
}

export function redactFfmpegDiagnostic(value: string): string {
  return sanitizeUntrustedDiagnostic(value, {
    rawMaxBytes: MAX_FFMPEG_DIAGNOSTIC_RAW_BYTES,
    publicMaxBytes: MAX_FFMPEG_DIAGNOSTIC_CHARS,
    collapseWhitespace: true
  });
}

function finalNonEmptyDiagnosticLines(value: string, maximumLines: number, discardInitialPartialLine: boolean): string[] {
  const lines: string[] = [];
  let start = 0;
  if (discardInitialPartialLine) {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code !== 10 && code !== 13 && code !== 0x2028 && code !== 0x2029) continue;
      start = index + (code === 13 && value.charCodeAt(index + 1) === 10 ? 2 : 1);
      break;
    }
    if (start === 0) return lines;
  }
  for (let index = start; index <= value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (index !== value.length && code !== 10 && code !== 13 && code !== 0x2028 && code !== 0x2029) continue;
    const line = trimDiagnosticWhitespace(value.slice(start, index));
    if (line) {
      lines.push(line);
      if (lines.length > maximumLines) lines.shift();
    }
    if (code === 13 && value.charCodeAt(index + 1) === 10) index += 1;
    start = index + 1;
  }
  return lines;
}

function retainTerminalDiagnosticLines(lines: readonly string[], maxBytes: number): string {
  const retained: string[] = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const separatorBytes = retained.length > 0 ? 1 : 0;
    const lineBytes = Buffer.byteLength(line);
    const remaining = maxBytes - bytes - separatorBytes;
    if (remaining <= 0) continue;
    if (lineBytes > remaining) {
      const markerBytes = 3;
      const prefix = takeUtf8Prefix(line, Math.max(0, remaining - markerBytes)).value;
      if (prefix) retained.unshift(`${prefix}…`);
      break;
    }
    retained.unshift(line);
    bytes += lineBytes + separatorBytes;
  }
  return retained.join(" ");
}

function trimDiagnosticWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isDiagnosticWhitespace(value.charCodeAt(start))) start += 1;
  while (end > start && isDiagnosticWhitespace(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

function isDiagnosticWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32 || code === 0xa0;
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
      const killer = spawn(resolveWindowsSystemExecutable("taskkill"), ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
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
