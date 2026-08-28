/** Host-only V25-B1 bridge from Debug dispatch to the strict GPU preview decoder. */
import type { MotionPackage } from "@shellx-motion/core";
import type { GpuEffectModuleUseAuthority, GpuPreviewSessionOptions, GpuPreviewVideoFrameProvider } from "@shellx-motion/renderer-browser";
import {
  createGovernedFfmpegRunner,
  createGpuPreviewVideoFrameProvider,
  type FfmpegRunner,
  type GpuPreviewFfmpegRunner
} from "@shellx-motion/renderer-ffmpeg";

export interface DebugGpuPreviewVideoProviderInput {
  pkg: MotionPackage;
  scratchRoot: string;
  callerId?: string;
  signal: AbortSignal;
  runner: GpuPreviewFfmpegRunner;
}

/** A host/test may substitute the provider, but callers can never select it through command args. */
export type DebugGpuPreviewVideoProviderFactory = (input: DebugGpuPreviewVideoProviderInput) => Promise<GpuPreviewVideoFrameProvider>;

export interface DebugGpuPreviewVideoServices {
  scratchRoot?: string;
  callerId?: string;
  signal?: AbortSignal;
  ffmpegRunner?: FfmpegRunner;
  providerFactory?: DebugGpuPreviewVideoProviderFactory;
  /** Opaque server-minted module-use authority; callers cannot configure it. */
  effectModuleAuthority?: GpuEffectModuleUseAuthority;
}

export type DebugGpuPreviewSessionOptions =
  | { ok: true; sessionOptions: GpuPreviewSessionOptions }
  | { ok: false; message: string };

/**
 * Build the private renderer session hook from dispatch authority. It intentionally accepts no
 * request arguments: source bytes, scratch, runner, caller, and cancellation all come from host state.
 */
export function createDebugGpuPreviewSessionOptions(
  services: DebugGpuPreviewVideoServices,
  options: { deferVideoCapabilityCheck?: boolean } = {}
): DebugGpuPreviewSessionOptions {
  if (!services.scratchRoot && !options.deferVideoCapabilityCheck) {
    return { ok: false, message: "GPU preview video decoding requires a host-owned debug scratch root." };
  }
  return {
    ok: true,
    sessionOptions: {
      ...(services.effectModuleAuthority ? { effectModuleAuthority: services.effectModuleAuthority } : {}),
      openVideoProvider: async ({ pkg, signal }) => {
        const scratchRoot = services.scratchRoot;
        if (!scratchRoot) throw new Error("GPU preview video decoding requires a host-owned debug scratch root.");
        const runner: GpuPreviewFfmpegRunner = async (command, commandSignal) => services.ffmpegRunner
          ? await services.ffmpegRunner(command)
          : await createGovernedFfmpegRunner({ scratchRoot, operation: "preview.gpu.decode", signal: commandSignal, ...(services.callerId ? { callerId: services.callerId } : {}) })(command);
        const input: DebugGpuPreviewVideoProviderInput = {
          pkg, scratchRoot, ...(services.callerId ? { callerId: services.callerId } : {}), signal, runner
        };
        return services.providerFactory
          ? await services.providerFactory(input)
          : createGpuPreviewVideoFrameProvider(input);
      }
    }
  };
}
