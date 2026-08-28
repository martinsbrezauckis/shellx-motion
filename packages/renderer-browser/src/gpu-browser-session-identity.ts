import type { ChildProcess } from "node:child_process";
import type { MotionToolSource } from "@shellx-motion/core";
import { gpuBrowserHardwareArgs } from "./gpu-browser-hardware-profile";

export const GPU_BROWSER_SANDBOX = true;
export const GPU_BROWSER_DEFAULT_ARGS_TO_IGNORE = ["--enable-unsafe-swiftshader"] as const;

/**
 * Browser facts observed from the exact Chromium process that owns a GPU
 * session. A later doctor probe cannot substitute for this rendered session.
 */
export interface GpuBrowserSessionIdentity {
  readonly name: string;
  readonly version: string;
  readonly userAgent: string;
  readonly executableSha256: string;
  readonly source: MotionToolSource;
  readonly args: readonly string[];
  readonly ignoredDefaultArgs: readonly string[];
  readonly sandbox: { readonly enabled: true; readonly status: "enabled" };
}

/** Converts CDP/process/page facts into the immutable identity carried to qualification evidence. */
export function createGpuBrowserSessionIdentity(input: {
  source: MotionToolSource;
  executableSha256: string;
  version: string;
  product: unknown;
  userAgent: unknown;
}): GpuBrowserSessionIdentity | null {
  const version = input.version.trim();
  const product = typeof input.product === "string" ? input.product.trim() : "";
  const userAgent = typeof input.userAgent === "string" ? input.userAgent.trim() : "";
  const executableSha256 = input.executableSha256.trim();
  const name = product.replace(/\/[\d.]+$/, "").trim();
  if (!name || !version || !userAgent || !/^[a-f0-9]{64}$/.test(executableSha256)) return null;
  return Object.freeze({
    name, version, userAgent, executableSha256, source: input.source,
    args: Object.freeze([...gpuBrowserHardwareArgs()]),
    ignoredDefaultArgs: Object.freeze([...GPU_BROWSER_DEFAULT_ARGS_TO_IGNORE]),
    sandbox: Object.freeze({ enabled: true as const, status: "enabled" as const })
  });
}

/** A post-session executable hash must exactly retain the admitted launch identity. */
export function sameGpuBrowserExecutableSha256(before: string, after: string): boolean {
  return /^[a-f0-9]{64}$/.test(before) && before === after;
}

/** Reject invalid/sentinel process ids before a host can watch the wrong browser tree. */
export function browserServerProcessPid(child: ChildProcess | null): number | null {
  const pid = child?.pid;
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}
