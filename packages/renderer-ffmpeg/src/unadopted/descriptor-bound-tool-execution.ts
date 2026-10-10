/**
 * Nonshipping source-only descriptor authority for retained tool probes.
 *
 * `publishConfig.exports` deliberately omits this development subpath. A descriptor is retained
 * in a process-local WeakMap, so a plain command object or a forged structural cast cannot select
 * a different executable than the source authority opened.
 */
import type { FileHandle } from "node:fs/promises";
import type { FfmpegCommand, FfmpegProcessResult } from "../index.js";
import { runDescriptorBoundFfmpegChild } from "../ffmpeg-process-lifecycle.js";
import type { FfmpegProcessTerminationMode } from "../ffmpeg-process-control.js";

declare const descriptorBoundToolExecutionBrand: unique symbol;

export interface DescriptorBoundToolExecution {
  readonly [descriptorBoundToolExecutionBrand]: "shellx-motion/descriptor-bound-tool-execution@1";
}

const executions = new WeakMap<object, { readonly fd: number }>();
const DEFAULT_TOOL_IDENTITY_PROBE_TIMEOUT_MS = 15_000;

/** Mint a non-forgeable execution capability for one already-open executable descriptor. */
export function establishDescriptorBoundToolExecution(handle: FileHandle): DescriptorBoundToolExecution {
  if (process.platform === "win32" || !Number.isInteger(handle.fd) || handle.fd < 3) {
    throw new Error("Descriptor-bound tool execution is unavailable on this host.");
  }
  const execution = Object.freeze({});
  executions.set(execution, Object.freeze({ fd: handle.fd }));
  return execution as DescriptorBoundToolExecution;
}

/** Execute the retained descriptor with the same short, contained identity-probe policy as V2. */
export async function executeDescriptorBoundTool(
  execution: DescriptorBoundToolExecution,
  command: FfmpegCommand
): Promise<FfmpegProcessResult> {
  const facts = typeof execution === "object" && execution !== null ? executions.get(execution) : undefined;
  if (!facts) throw new Error("Descriptor-bound tool execution authority was not established by this process.");
  return await runDescriptorBoundFfmpegChild(
    command,
    facts.fd,
    new AbortController().signal,
    () => {},
    identityProbeTerminationMode,
    { timeoutMs: resolveToolIdentityProbeTimeoutMs(), label: "retained tool identity probe" }
  );
}

function identityProbeTerminationMode(): FfmpegProcessTerminationMode {
  if (process.platform === "win32") return "windows-taskkill-fallback";
  return process.platform === "linux" || process.platform === "darwin" ? "unix-process-group" : "direct-child";
}

function resolveToolIdentityProbeTimeoutMs(): number {
  const raw = process.env.SHELLX_MOTION_TOOL_PROBE_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TOOL_IDENTITY_PROBE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : DEFAULT_TOOL_IDENTITY_PROBE_TIMEOUT_MS;
}
