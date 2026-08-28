/**
 * Explicit, host-owned GPU hardware proof.
 *
 * Unlike `doctor` and `motion.platform.requirements`, this operation intentionally
 * opens WebGPU. It uses the strict final-browser route: an OS process group or
 * Windows Job Object exists before Chromium resumes, the browser has a private
 * transient profile, and the one tiny frame is read back before a proof can pass.
 * The operation accepts no package input, browser flags, profile path, or proof
 * fields from a caller.
 */
import { createHash } from "node:crypto";
import {
  compileGpuFramePlan,
  GPU_FRAME_INTENT_SCHEMA,
  hashFile,
  motionBrowserExecutableVerificationProblem,
  resolveMotionBrowserExecutable,
  type MotionBrowserExecutableLocation,
  type RetainedDirectoryAuthority
} from "@shellx-motion/core";
import { createGpuFrameRenderSession, type GpuFrameRenderSessionOpenResult } from "./gpu-frame-renderer";
import { gpuBrowserHardwareArgs } from "./gpu-browser-hardware-profile";
import { GPU_ACTIVE_HOST_PROOF_SCHEMA, type GpuActiveHostProof } from "./gpu-hardware-readiness";
import type { GpuRuntimeFailure } from "./gpu-runtime-types";
import type { GpuBrowserProcess } from "./gpu-browser-process";
import { isGpuBrowserProcess, isPrecontainedGpuBrowser } from "./gpu-process-containment";

export const GPU_ACTIVE_HARDWARE_PROBE_OPERATION = "gpu.hardware.probe" as const;
export const GPU_ACTIVE_HARDWARE_PROBE_TIMEOUT_MS = 30_000;
export const GPU_ACTIVE_HARDWARE_PROOF_VALID_FOR_MS = 10 * 60 * 1_000;

export type GpuActiveHardwareProbeResult =
  | {
    ok: true;
    proof: GpuActiveHostProof;
    frame: { width: number; height: number; sha256: string };
  }
  | { ok: false; failure: GpuRuntimeFailure };

/** Host/test-only seams. CLI and Debug callers never receive these knobs as arguments. */
export interface GpuActiveHardwareProbeServices {
  now?: () => Date;
  validForMs?: number;
  resolveBrowser?: () => MotionBrowserExecutableLocation;
  verifyBrowser?: (location: MotionBrowserExecutableLocation) => string | null;
  hashExecutable?: (path: string) => Promise<string>;
  openFrameSession?: (options: {
    finalBrowser: { scratchRoot: string; maxProcessTreeRssBytes: number; signal?: AbortSignal };
    browserLocation: MotionBrowserExecutableLocation;
  }) => Promise<GpuFrameRenderSessionOpenResult>;
}

/**
 * Authority supplied only by the embedding CLI/host after it has reserved one
 * exact private child under an admitted scratch root. The renderer never
 * selects a temporary directory, creates the parent, or removes this child.
 */
export interface GpuActiveHardwareProbeOptions {
  readonly scratchRoot: string;
  readonly scratchAuthority: RetainedDirectoryAuthority;
  readonly maxProcessTreeRssBytes: number;
  readonly signal?: AbortSignal;
  /** Called only after strict pre-launch containment has been verified. */
  readonly onBrowserProcess?: (browser: GpuBrowserProcess) => void;
}

/**
 * Launch a fresh pre-contained Chromium GPU session and prove it with one
 * 4-by-4 rect-and-point frame readback. A passed result is the only value that
 * `assessGpuHardwareReadiness` may use to return `available`.
 */
export async function runGpuActiveHardwareProbe(
  options: GpuActiveHardwareProbeOptions,
  services: GpuActiveHardwareProbeServices = {}
): Promise<GpuActiveHardwareProbeResult> {
  if (!options.scratchAuthority || options.scratchAuthority.path !== options.scratchRoot) {
    return failure("gpu_browser_unavailable", "The active GPU probe requires an exact host-owned private scratch authority.");
  }
  if (!Number.isSafeInteger(options.maxProcessTreeRssBytes)
    || options.maxProcessTreeRssBytes < 64 * 1024 * 1024
    || options.maxProcessTreeRssBytes > 1024 * 1024 * 1024 * 1024) {
    return failure("gpu_browser_unavailable", "The active GPU probe requires a host-admitted process-tree memory limit.");
  }
  try {
    await options.scratchAuthority.assertCurrent();
  } catch {
    return failure("gpu_browser_unavailable", "The active GPU probe scratch authority is no longer current.");
  }
  const location = (services.resolveBrowser ?? resolveMotionBrowserExecutable)();
  const verificationProblem = (services.verifyBrowser ?? motionBrowserExecutableVerificationProblem)(location);
  if (verificationProblem) return failure("gpu_browser_unavailable", "Motion could not establish a trusted Chromium executable for the active GPU probe.");

  let executableSha256: string;
  try {
    executableSha256 = await (services.hashExecutable ?? hashFile)(location.executable);
  } catch {
    return failure("gpu_browser_unavailable", "Motion could not hash the trusted Chromium executable before the active GPU probe.");
  }

  let session: Extract<GpuFrameRenderSessionOpenResult, { ok: true }>['session'] | undefined;
  try {
    const opened = await (services.openFrameSession ?? ((input) => createGpuFrameRenderSession([], [], input)))({
      finalBrowser: {
        scratchRoot: options.scratchRoot,
        maxProcessTreeRssBytes: options.maxProcessTreeRssBytes,
        ...(options.signal ? { signal: options.signal } : {})
      },
      browserLocation: location
    });
    if (!opened.ok) return opened;
    session = opened.session;
    if (!isGpuBrowserProcess(session.browserProcess)
      || !isPrecontainedGpuBrowser(session.browserProcess.containment, session.browserProcess.pid, options.maxProcessTreeRssBytes)) {
      return failure("gpu_browser_launch_failed", "The active GPU probe refused a browser that was not pre-contained before launch.");
    }
    try {
      options.onBrowserProcess?.(session.browserProcess);
    } catch {
      return failure("gpu_browser_launch_failed", "The host could not register the pre-contained GPU browser process.");
    }
    const frame = await session.render(ACTIVE_HARDWARE_PROBE_FRAME, {
      timeoutMs: GPU_ACTIVE_HARDWARE_PROBE_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {})
    });
    if (!frame.ok) return frame;
    if (frame.frame.width !== 4 || frame.frame.height !== 4 || frame.frame.rgba.byteLength !== 4 * 4 * 4 || !isSha256(frame.frame.sha256)
      || createHash("sha256").update(frame.frame.rgba).digest("hex") !== frame.frame.sha256
      || !hasExpectedProbePixels(frame.frame.rgba)) {
      return failure("gpu_render_failed", "The active GPU probe did not produce its bounded 4-by-4 readback.");
    }
    if (frame.frame.evidence.browserSource !== location.source || !isSha256(frame.frame.evidence.adapterFingerprint)) {
      return failure("gpu_render_failed", "The active GPU probe could not bind its rendered adapter evidence to the trusted browser.");
    }
    const browserVersion = session.browserVersion?.trim() ?? "";
    if (!browserVersion) return failure("gpu_browser_launch_failed", "The active GPU probe browser did not report a version.");
    const capturedAt = (services.now ?? (() => new Date()))().toISOString();
    const validForMs = services.validForMs ?? GPU_ACTIVE_HARDWARE_PROOF_VALID_FOR_MS;
    if (!Number.isInteger(validForMs) || validForMs < 1 || validForMs > 86_400_000) {
      return failure("gpu_render_failed", "The host selected an invalid active GPU-proof lifetime.");
    }
    return {
      ok: true,
      proof: {
        schema: GPU_ACTIVE_HOST_PROOF_SCHEMA,
        capturedAt,
        validForMs,
        platform: process.platform as GpuActiveHostProof["platform"],
        browser: { source: location.source, executableSha256, version: browserVersion },
        launch: {
          hardwareArgs: [...gpuBrowserHardwareArgs()],
          chromiumSandbox: true,
          ignoredDefaultArgs: ["--enable-unsafe-swiftshader"],
          finalContainment: "precontained-direct-chromium"
        },
        runtime: frame.frame.evidence,
        receipt: { operation: GPU_ACTIVE_HARDWARE_PROBE_OPERATION, lane: "gpu", status: "passed" }
      },
      frame: { width: frame.frame.width, height: frame.frame.height, sha256: frame.frame.sha256 }
    };
  } catch {
    return failure("gpu_render_failed", "The active GPU probe could not complete its bounded hardware frame readback.");
  } finally {
    await session?.close().catch(() => undefined);
  }
}

const ACTIVE_HARDWARE_PROBE_FRAME = compileGpuFramePlan({
  schema: GPU_FRAME_INTENT_SCHEMA,
  width: 4,
  height: 4,
  clear: { r: 0, g: 0, b: 0, a: 1 },
  draws: [
    { kind: "rect", id: "probe-rect", x: 1, y: 1, width: 2, height: 2, color: { r: 1, g: 0.5, b: 0, a: 1 } },
    { kind: "points", id: "probe-point", seed: 19, points: [{ x: 2, y: 2, size: 1, color: { r: 0, g: 1, b: 1, a: 1 } }] }
  ]
});

function failure(code: GpuRuntimeFailure["code"], message: string): GpuActiveHardwareProbeResult {
  return { ok: false, failure: { code, message } };
}

function isSha256(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }

/** Refuse a clear/blank buffer: the proof frame must contain our orange rect or cyan point. */
function hasExpectedProbePixels(rgba: Buffer): boolean {
  for (let offset = 0; offset < rgba.byteLength; offset += 4) {
    const [r, g, b, a] = [rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!, rgba[offset + 3]!];
    const orangeRect = r >= 200 && g >= 80 && g <= 180 && b <= 64 && a >= 200;
    const cyanPoint = r <= 64 && g >= 180 && b >= 180 && a >= 200;
    if (orangeRect || cyanPoint) return true;
  }
  return false;
}
