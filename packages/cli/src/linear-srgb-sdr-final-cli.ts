import type { BrowserCaptureWorkflow } from "@shellx-motion/renderer-browser";
import {
  planLinearSrgbSdrFinalRender,
  preflightLinearSrgbSdrFinalRender,
  type FfmpegCommand,
  type RenderStreamingFinalInput,
  type StreamingFinalToolPolicy,
} from "@shellx-motion/renderer-ffmpeg";

export interface StreamingFinalCliContext {
  readonly pkg: RenderStreamingFinalInput["pkg"];
  readonly frameLane: RenderStreamingFinalInput["frameLane"];
  readonly outputPath: string;
  readonly preset: RenderStreamingFinalInput["preset"];
  readonly audio: RenderStreamingFinalInput["audio"] | undefined;
  readonly audioTracks: RenderStreamingFinalInput["audioTracks"] | undefined;
  readonly audioMaster: RenderStreamingFinalInput["audioMaster"] | undefined;
  readonly inputRoots: string[];
  readonly outputRoots: string[];
  readonly quality: RenderStreamingFinalInput["quality"] | undefined;
  readonly qualityManifest: RenderStreamingFinalInput["qualityManifest"] | undefined;
  readonly keepFrames: boolean;
  readonly force: boolean;
  readonly transport: NonNullable<RenderStreamingFinalInput["transport"]>;
  readonly signal: AbortSignal | undefined;
}

interface StreamingFinalCliBrowserPolicy {
  readonly workflow: BrowserCaptureWorkflow | undefined;
  readonly injectedFrameRenderer: boolean;
}

interface StreamingFinalCliToolPolicy {
  readonly runner?: NonNullable<StreamingFinalToolPolicy["runner"]>;
  readonly forceSoftwareEncode?: boolean;
  readonly ffmpegVersion?: string | null;
  readonly processFactory?: StreamingFinalToolPolicy["processFactory"];
}

export function planLinearSrgbSdrFinalCliRender(input: StreamingFinalCliContext, browser: StreamingFinalCliBrowserPolicy) {
  return planLinearSrgbSdrFinalRender({
    pkg: input.pkg,
    frameLane: input.frameLane,
    outputPath: input.outputPath,
    preset: input.preset,
    ...(input.audio ? { audio: input.audio } : {}),
    ...(input.audioTracks ? { audioTracks: input.audioTracks } : {}),
    ...(input.audioMaster ? { audioMaster: input.audioMaster } : {}),
    ...(input.quality ? { quality: input.quality } : {}),
    ...(input.qualityManifest ? { qualityManifest: input.qualityManifest } : {}),
    keepFrames: input.keepFrames,
    transport: input.transport,
    ...(browser.workflow || browser.injectedFrameRenderer ? { toolPolicy: {
      ...(browser.workflow ? { browser: { workflow: browser.workflow } } : {}),
      ...(browser.injectedFrameRenderer ? { injectedFrameRenderer: true } : {}),
    } } : {}),
  });
}

export function linearSrgbSdrFinalCliDryRun(
  plan: ReturnType<typeof planLinearSrgbSdrFinalRender>,
  legacyCommand: FfmpegCommand,
): { ffmpeg: FfmpegCommand; colorPipeline?: { intent: "linear-srgb-sdr@1"; routeFingerprint: string; preflight: "not_run" } } {
  return plan.kind === "strict"
    ? { ffmpeg: plan.command, colorPipeline: { intent: "linear-srgb-sdr@1", routeFingerprint: plan.route.fingerprint, preflight: "not_run" } }
    : { ffmpeg: legacyCommand };
}

export function streamingFinalCliRenderInput(input: StreamingFinalCliContext, tools: StreamingFinalCliToolPolicy, strict: boolean): RenderStreamingFinalInput {
  return {
    pkg: input.pkg,
    frameLane: input.frameLane,
    outputPath: input.outputPath,
    preset: input.preset,
    ...(input.audio ? { audio: input.audio } : {}),
    ...(input.audioTracks ? { audioTracks: input.audioTracks } : {}),
    ...(input.audioMaster ? { audioMaster: input.audioMaster } : {}),
    inputRoots: input.inputRoots,
    outputRoots: input.outputRoots,
    ...(input.quality ? { quality: input.quality } : {}),
    ...(input.qualityManifest ? { qualityManifest: input.qualityManifest } : {}),
    keepFrames: input.keepFrames,
    ...(input.force ? { force: true } : {}),
    transport: input.transport,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(strict ? {} : { toolPolicy: {
      ...(tools.runner ? { runner: tools.runner } : {}),
      ...(tools.forceSoftwareEncode ? { forceSoftwareEncode: true } : {}),
      ...(tools.ffmpegVersion ? { ffmpegVersion: tools.ffmpegVersion } : {}),
      ...(tools.processFactory ? { processFactory: tools.processFactory } : {}),
    } }),
  };
}

export const preflightLinearSrgbSdrFinalCliRender = preflightLinearSrgbSdrFinalRender;
