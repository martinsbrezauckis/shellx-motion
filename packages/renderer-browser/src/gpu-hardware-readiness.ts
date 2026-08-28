/**
 * Source-only GPU readiness for the platform/doctor surfaces.
 *
 * This module deliberately does not open Chromium, create a WebGPU adapter, or
 * read a prior render receipt.  A trusted Chromium binary is a prerequisite,
 * not proof that it selected a hardware adapter.  `available` is therefore
 * possible only when a host injects a fresh, strictly bound active-proof that
 * it produced outside this read-only operation.
 */
import {
  hashFile,
  motionBrowserExecutableVerificationProblem,
  resolveMotionBrowserExecutable,
  type MotionBrowserExecutableLocation,
  type MotionToolSource,
} from "@shellx-motion/core";
import { GPU_BROWSER_HARDWARE_ARGS, gpuBrowserHardwareArgs } from "./gpu-browser-hardware-profile";
import { GPU_BROWSER_DEFAULT_ARGS_TO_IGNORE, GPU_BROWSER_SANDBOX } from "./gpu-browser-session-identity";
import type { GpuRuntimeEvidence } from "./gpu-runtime-types";

export const GPU_HARDWARE_READINESS_SCHEMA = "shellx-motion/gpu-hardware-readiness@1" as const;
export const GPU_ACTIVE_HOST_PROOF_SCHEMA = "shellx-motion/gpu-active-host-proof@1" as const;

/** The final browser path is intentionally restricted to platforms it contains before launch. */
export type GpuHardwareSupportedPlatform = "linux" | "darwin" | "win32";
export type GpuHardwareReadinessStatus = "available" | "requires-hardware-proof" | "unsupported";
export type GpuHardwareReadinessRefusalCode =
  | "gpu_platform_unsupported"
  | "gpu_trusted_chromium_missing"
  | "gpu_trusted_chromium_unverified"
  | "gpu_hardware_proof_required"
  | "gpu_prior_receipt_not_live_proof"
  | "gpu_active_proof_invalid"
  | "gpu_active_proof_stale"
  | "gpu_active_proof_browser_changed";

export interface GpuHardwareReadinessRefusal {
  code: GpuHardwareReadinessRefusalCode;
  message: string;
}

export interface GpuActiveHostProof {
  schema: typeof GPU_ACTIVE_HOST_PROOF_SCHEMA;
  /** ISO timestamp set by the host that actually performed the active probe. */
  capturedAt: string;
  /** Host-selected proof lifetime, bounded to one day by this consumer. */
  validForMs: number;
  platform: GpuHardwareSupportedPlatform;
  browser: {
    source: MotionToolSource;
    /** SHA-256 of the exact regular executable that the active probe opened. */
    executableSha256: string;
    /** Protocol/version value measured by the active host, not a receipt claim. */
    version: string;
  };
  launch: {
    hardwareArgs: string[];
    chromiumSandbox: true;
    ignoredDefaultArgs: string[];
    finalContainment: "precontained-direct-chromium";
  };
  /**
   * The exact validated result from `assessGpuRuntime`, not an independently
   * reconstructed adapter claim. Its adapter fingerprint binds the selected
   * page adapter to the correlated non-software CDP hardware device.
   */
  runtime: GpuRuntimeEvidence;
  receipt: {
    /** Only an active host probe receipt is admissible; previews/finals are not liveness proof. */
    operation: "gpu.hardware.probe";
    lane: "gpu";
    status: "passed";
  };
}

export interface GpuHardwareReadiness {
  schema: typeof GPU_HARDWARE_READINESS_SCHEMA;
  status: GpuHardwareReadinessStatus;
  platform: { id: NodeJS.Platform; supported: boolean };
  /** Executable identity only. This never means a WebGPU adapter was opened. */
  trustedChromium: {
    status: "present" | "missing" | "unverified";
    source?: MotionToolSource;
    version?: string;
  };
  fixedLaunchProfile: {
    hardwareArgs: readonly string[];
    chromiumSandbox: true;
    ignoredDefaultArgs: readonly string[];
    finalContainment: "precontained-direct-chromium";
  };
  sandbox: {
    browser: "required";
    gpu: "no-disable-flags-in-motion-profile";
  };
  adapterDeviceProof: ({
    status: "not-tested";
    /** A caller must arrange this as an explicit host operation; doctor never launches it. */
    requiredCommand: "host-owned motion.platform.gpu.probe";
  } | {
    status: "active-host-proof";
    requiredCommand: "host-owned motion.platform.gpu.probe";
    capturedAt: string;
    validUntil: string;
    adapterFingerprint: string;
  });
  /** GPU rasterisation never takes audio; the final FFmpeg lane owns it. */
  audio: { gpuRaster: "none"; finalVideo: "ffmpeg" };
  refusals: GpuHardwareReadinessRefusal[];
}

export interface GpuHardwareReadinessInput {
  /** The Chromium report already collected by the shared platform requirements operation. */
  chromium: { status: "ready" | "missing" | "broken" | "unverified"; source: MotionToolSource; version?: string };
  /** Host-owned active proof. It is never accepted from CLI/Debug command arguments. */
  activeHostProof?: unknown;
  platform?: NodeJS.Platform;
  now?: () => Date;
  /** Test seam; untouched when no active proof is supplied. */
  resolveBrowser?: () => MotionBrowserExecutableLocation;
  /** Test seam for the pre-hash executable trust check. */
  verifyBrowser?: (location: MotionBrowserExecutableLocation) => string | null;
  /** Test seam; the production value safely hashes the current regular executable. */
  hashExecutable?: (path: string) => Promise<string>;
}

/**
 * Build a deterministic GPU readiness payload without opening a browser.
 *
 * The normal no-proof path does not resolve, hash, or launch a browser beyond
 * the shared Chromium identity report supplied by the caller.  Hashing is
 * reserved for verification of already-created host evidence, so an injected
 * stale proof cannot make a changed executable look qualified.
 */
export async function assessGpuHardwareReadiness(input: GpuHardwareReadinessInput): Promise<GpuHardwareReadiness> {
  const platform = input.platform ?? process.platform;
  const supported = isSupportedPlatform(platform);
  const chromium = chromiumStatus(input.chromium);
  const profile = fixedLaunchProfile(platform);
  const base = (status: GpuHardwareReadinessStatus, refusals: GpuHardwareReadinessRefusal[], proof?: ActiveProofSummary): GpuHardwareReadiness => ({
    schema: GPU_HARDWARE_READINESS_SCHEMA,
    status,
    platform: { id: platform, supported },
    trustedChromium: chromium,
    fixedLaunchProfile: profile,
    sandbox: { browser: "required", gpu: "no-disable-flags-in-motion-profile" },
    adapterDeviceProof: proof
      ? { status: "active-host-proof", requiredCommand: "host-owned motion.platform.gpu.probe", ...proof }
      : { status: "not-tested", requiredCommand: "host-owned motion.platform.gpu.probe" },
    audio: { gpuRaster: "none", finalVideo: "ffmpeg" },
    refusals
  });

  if (!supported) return base("unsupported", [{
    code: "gpu_platform_unsupported",
    message: `GPU final containment is not implemented for ${platform}; no Chromium or WebGPU probe was launched.`
  }]);
  if (chromium.status === "missing") return base("requires-hardware-proof", [{
    code: "gpu_trusted_chromium_missing",
    message: "A trusted Chromium identity probe is not available, so Motion cannot request WebGPU hardware proof."
  }]);
  if (chromium.status === "unverified") return base("requires-hardware-proof", [{
    code: "gpu_trusted_chromium_unverified",
    message: "Chromium was found but its identity probe did not pass; Motion will not claim GPU readiness."
  }]);

  if (input.activeHostProof === undefined) return base("requires-hardware-proof", [{
    code: "gpu_hardware_proof_required",
    message: "Trusted Chromium is present, but this source-only check did not launch WebGPU. Supply a fresh host-owned active GPU proof to establish adapter and device readiness."
  }]);

  if (looksLikePriorGpuReceipt(input.activeHostProof)) return base("requires-hardware-proof", [{
    code: "gpu_prior_receipt_not_live_proof",
    message: "A prior GPU preview or render receipt is not live adapter/device proof for the currently selected browser."
  }]);

  const proof = parseActiveHostProof(input.activeHostProof, platform);
  if (!proof) return base("requires-hardware-proof", [{
    code: "gpu_active_proof_invalid",
    message: "The injected GPU proof does not meet the active-host schema, adapter correlation, safe launch-profile, sandbox, or receipt requirements."
  }]);
  const freshness = freshProof(proof, input.now?.() ?? new Date());
  if (!freshness.ok) return base("requires-hardware-proof", [{ code: "gpu_active_proof_stale", message: freshness.message }]);
  if (proof.browser.source !== input.chromium.source || !sameBrowserVersion(proof.browser.version, input.chromium.version)) {
    return base("requires-hardware-proof", [{
      code: "gpu_active_proof_browser_changed",
      message: "The active GPU proof names a different Chromium source or version than the current trusted Chromium identity probe."
    }]);
  }

  const location = (input.resolveBrowser ?? resolveMotionBrowserExecutable)();
  if (location.source !== input.chromium.source || (input.verifyBrowser ?? motionBrowserExecutableVerificationProblem)(location)) {
    return base("requires-hardware-proof", [{
      code: "gpu_active_proof_browser_changed",
      message: "The current trusted Chromium executable no longer matches the browser used for the active GPU proof."
    }]);
  }
  let executableSha256: string;
  try {
    executableSha256 = await (input.hashExecutable ?? hashFile)(location.executable);
  } catch {
    return base("requires-hardware-proof", [{
      code: "gpu_active_proof_browser_changed",
      message: "Motion could not re-hash the current trusted Chromium executable before accepting GPU hardware proof."
    }]);
  }
  if (executableSha256 !== proof.browser.executableSha256) return base("requires-hardware-proof", [{
    code: "gpu_active_proof_browser_changed",
    message: "The current trusted Chromium executable hash differs from the browser used for the active GPU proof."
  }]);

  return base("available", [], {
    capturedAt: proof.capturedAt,
    validUntil: new Date(Date.parse(proof.capturedAt) + proof.validForMs).toISOString(),
    adapterFingerprint: proof.runtime.adapterFingerprint
  });
}

/**
 * `Browser.version()` reports the protocol version (for example `140.0.0.0`)
 * while the platform identity probe often includes the browser label. Compare
 * the stable dotted version rather than making an otherwise identical active
 * session fail merely because those two trustworthy probes present it differently.
 */
function sameBrowserVersion(activeVersion: string, platformVersion: string | undefined): boolean {
  if (!platformVersion) return false;
  const active = versionNumber(activeVersion);
  const platform = versionNumber(platformVersion);
  return active && platform ? active === platform : activeVersion === platformVersion;
}

function versionNumber(value: string): string | null {
  const match = value.match(/(?:^|[^0-9])(\d{1,5}(?:\.\d{1,5}){1,3})(?:$|[^0-9])/);
  return match?.[1] ?? null;
}

interface ActiveProofSummary {
  capturedAt: string;
  validUntil: string;
  adapterFingerprint: string;
}

function isSupportedPlatform(platform: NodeJS.Platform): platform is GpuHardwareSupportedPlatform {
  return platform === "linux" || platform === "darwin" || platform === "win32";
}

function chromiumStatus(report: GpuHardwareReadinessInput["chromium"]): GpuHardwareReadiness["trustedChromium"] {
  if (report.status === "ready") return { status: "present", source: report.source, ...(report.version ? { version: report.version } : {}) };
  if (report.status === "missing") return { status: "missing", source: report.source };
  return { status: "unverified", source: report.source };
}

function fixedLaunchProfile(platform: NodeJS.Platform): GpuHardwareReadiness["fixedLaunchProfile"] {
  return {
    hardwareArgs: platform === "linux" || platform === "darwin" || platform === "win32"
      ? gpuBrowserHardwareArgs(platform)
      : GPU_BROWSER_HARDWARE_ARGS,
    chromiumSandbox: GPU_BROWSER_SANDBOX,
    ignoredDefaultArgs: GPU_BROWSER_DEFAULT_ARGS_TO_IGNORE,
    finalContainment: "precontained-direct-chromium"
  };
}

function looksLikePriorGpuReceipt(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const operation = value.operation;
  return operation === "preview.gpu.frame" || operation === "render.final" || operation === "gpu.preview";
}

function parseActiveHostProof(value: unknown, platform: NodeJS.Platform): GpuActiveHostProof | null {
  if (!isRecord(value) || value.schema !== GPU_ACTIVE_HOST_PROOF_SCHEMA
    || !isString(value.capturedAt) || !isInteger(value.validForMs) || value.validForMs < 1 || value.validForMs > 86_400_000
    || !isSupportedPlatform(platform) || value.platform !== platform
    || !isRecord(value.browser) || !isMotionToolSource(value.browser.source) || !isSha256(value.browser.executableSha256) || !isNonemptyString(value.browser.version)
    || !isRecord(value.launch) || !sameStrings(value.launch.hardwareArgs, gpuBrowserHardwareArgs(platform))
      || value.launch.chromiumSandbox !== true || !sameStrings(value.launch.ignoredDefaultArgs, GPU_BROWSER_DEFAULT_ARGS_TO_IGNORE)
      || value.launch.finalContainment !== "precontained-direct-chromium"
    || !isRuntime(value.runtime, value.browser.source) || !isRecord(value.receipt)
      || value.receipt.operation !== "gpu.hardware.probe" || value.receipt.lane !== "gpu" || value.receipt.status !== "passed") return null;
  return value as unknown as GpuActiveHostProof;
}

function freshProof(proof: GpuActiveHostProof, now: Date): { ok: true } | { ok: false; message: string } {
  const capturedAt = Date.parse(proof.capturedAt);
  if (!Number.isFinite(capturedAt)) return { ok: false, message: "The injected active GPU proof has no valid capture timestamp." };
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || capturedAt > nowMs + 300_000) return { ok: false, message: "The injected active GPU proof timestamp is implausibly in the future." };
  if (nowMs > capturedAt + proof.validForMs) return { ok: false, message: "The injected active GPU proof is stale; it exceeded its host-declared freshness window." };
  return { ok: true };
}

function isRuntime(value: unknown, browserSource: unknown): value is GpuActiveHostProof["runtime"] {
  if (!isRecord(value) || value.schema !== "shellx-motion/gpu-runtime-evidence@1" || value.backend !== "webgpu-browser"
    || value.browserSource !== browserSource || !isEnabledWebGpu(value.webgpuFeatureStatus)
    || !isSha256(value.adapterFingerprint) || !isRecord(value.adapter) || !isRecord(value.limits)) return false;
  const adapter = value.adapter;
  if (!isPositiveIdentifier(adapter.cdpVendorId) || !isPositiveIdentifier(adapter.cdpDeviceId)
    || !isNonemptyString(adapter.cdpVendor) || !isNonemptyString(adapter.cdpDevice)
    || !isNonemptyString(adapter.vendor) || !isStringOrNull(adapter.device)
    || !isStringOrNull(adapter.architecture) || !isStringOrNull(adapter.description)
    || isSoftwareIdentity(adapter.cdpVendor, adapter.cdpDevice, adapter.vendor, adapter.device)) return false;
  // `assessGpuRuntime` admits privacy-reduced Windows information such as
  // vendor=nvidia, device="", architecture=blackwell only after it has
  // correlated it to exactly one non-software CDP device. Requiring its
  // evidence schema and fingerprint here retains that prior validation instead
  // of falsely demanding a device name the browser deliberately withheld.
  const pageHasDevice = hasNonemptyText(adapter.device);
  if (!pageHasDevice && !hasNonemptyText(adapter.architecture) && !hasNonemptyText(adapter.description)) return false;
  if (!identityOverlaps(adapter.vendor, `${adapter.cdpVendor} ${adapter.cdpDevice}`)) return false;
  return isPositiveInteger(value.limits.maxTextureDimension2D) && isPositiveInteger(value.limits.maxBufferSize)
    && isPositiveInteger(value.limits.maxStorageBufferBindingSize);
}

function isMotionToolSource(value: unknown): value is MotionToolSource {
  return value === "path" || value === "override" || value === "shellx-family";
}
function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }
function isNonemptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function isStringOrNull(value: unknown): value is string | null { return value === null || typeof value === "string"; }
function hasNonemptyText(value: string | null): boolean { return typeof value === "string" && value.trim().length > 0; }
function isInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value); }
function isPositiveInteger(value: unknown): value is number { return isInteger(value) && value > 0; }
function isPositiveIdentifier(value: unknown): value is number { return isInteger(value) && value > 0 && value < 0xffff; }
function isSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function isEnabledWebGpu(value: unknown): boolean { return value === "enabled" || value === "enabled_on" || value === "enabled_readback"; }
function identityOverlaps(left: string, right: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const a = normalize(left), b = normalize(right);
  return a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a));
}
function isSoftwareIdentity(...values: Array<string | null>): boolean {
  return /swiftshader|llvmpipe|software|lavapipe|microsoft basic render/i.test(values.filter((value): value is string => typeof value === "string").join(" "));
}
