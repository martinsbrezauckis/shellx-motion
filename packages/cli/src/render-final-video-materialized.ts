/**
 * Legacy materialized final-video execution for the CLI.
 *
 * The public final-video planner chooses this only when frame files are required. Keeping the
 * preflight and frame-directory ownership policy here prevents the streamed default from ever
 * creating, inspecting, or deleting a frame directory.
 */
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  acquireDerivedOutputPublication,
  preflightMaterializedFrameSequence,
  type DerivedOutputPublication,
  type MaterializedFrameSequencePreflight,
  type MaterializedFrameSequencePreflightOptions,
  type MotionAudioMasterBus,
  type MotionPackage,
  type OperationReceipt
} from "@shellx-motion/core";
import type { BrowserFrameRenderer } from "@shellx-motion/debug-api";
import {
  browserTypographyAttestationRefusal,
  createMotionBrowserRenderSession,
  renderMotionBrowserFrame,
  type BrowserCaptureWorkflow,
  type MotionBrowserRenderSession
} from "@shellx-motion/renderer-browser";
import {
  buildEncodeImageSequenceCommand,
  checkFfmpeg,
  encodeImageSequenceWithPolicy,
  redactAbortedFinalOutputEvidence,
  type FfmpegAudioInput,
  type FfmpegCommand,
  type FfmpegExportPreset,
  type FfmpegRunner
} from "@shellx-motion/renderer-ffmpeg";
import { createNativeRenderSession, INTERMEDIATE_FRAME_PNG_COMPRESSION_LEVEL } from "@shellx-motion/renderer-native";
import { FrameLaneWarnings } from "./frame-lane-warnings";
import { framesDirRefusal } from "./output-dir-guard";
import { throwIfCancelled } from "./render-cancelled";
import type { BrowserWorkflowRenderEvidence } from "./render-receipt-file";

type MaterializedResponse = Record<string, unknown> & { ok: false; command: "render"; receipt?: OperationReceipt };

export type MaterializedFinalVideoResult =
  | { kind: "refused"; response: MaterializedResponse }
  | { kind: "dry-run"; resourcePreflight: MaterializedFrameSequencePreflight; command: FfmpegCommand }
  | {
      kind: "encoded";
      encoded: Extract<Awaited<ReturnType<typeof encodeImageSequenceWithPolicy>>, { ok: true }>;
      /** Present only for CLI receipt-first paired publication; callers must commit or abort it. */
      outputPublication?: DerivedOutputPublication;
      lastFrameReceipt: unknown;
      /** Present only for the explicit --keep-frames retention request. */
      frames?: { dir: string; count: number };
      workflowEvidence?: BrowserWorkflowRenderEvidence;
      /** Removes transient frames after the caller's exact-source quality check has consumed them. */
      cleanup: () => Promise<void>;
    };

export interface RenderMaterializedFinalVideoInput {
  pkg: MotionPackage;
  packageRoot: string;
  frameLane: "browser" | "native";
  frameCount: number;
  framesDir: string;
  framesRoot: string;
  framesDirCallerSupplied: boolean;
  outputPath: string;
  preset: FfmpegExportPreset;
  audio?: FfmpegAudioInput;
  audioTracks?: FfmpegAudioInput[];
  audioMaster?: MotionAudioMasterBus;
  inputRoots: string[];
  outputRoots: string[];
  quality?: { minUniqueFrameHashes: number };
  forceSoftwareEncode: boolean;
  force: boolean;
  keepFrames: boolean;
  dryRun: boolean;
  workflow?: BrowserCaptureWorkflow;
  callerId?: string;
  browserFrameRenderer?: BrowserFrameRenderer;
  ffmpegRunner?: FfmpegRunner;
  signal?: AbortSignal;
  preflight?: MaterializedFrameSequencePreflightOptions;
  /** CLI-only: leave the verified final media private until its matching receipt is durable. */
  deferOutputPublication?: boolean;
  /** CLI-only: caller-owned reservation for receipt-first paired publication. */
  outputPublication?: DerivedOutputPublication;
}

/** Execute the previous PNG-sequence route after the caller's public planner selects it. */
export async function renderMaterializedFinalVideo(input: RenderMaterializedFinalVideoInput): Promise<MaterializedFinalVideoResult> {
  const browserTypographyRefusal = input.frameLane === "browser"
    ? browserTypographyAttestationRefusal(input.pkg)
    : null;
  if (browserTypographyRefusal) {
    return {
      kind: "refused",
      response: { ok: false, command: "render", lane: "ffmpeg", frameLane: input.frameLane, error: browserTypographyRefusal }
    };
  }
  const resourcePreflight = preflightMaterializedFrameSequence({
    frameCount: input.frameCount,
    width: input.pkg.motion.width,
    height: input.pkg.motion.height,
    frameLane: input.frameLane,
    motion: input.pkg.motion
  }, input.preflight);
  if (resourcePreflight.status === "refused") {
    return { kind: "refused", response: materializedPreflightRefusal(resourcePreflight, input.frameLane) };
  }

  const command = buildEncodeImageSequenceCommand({
    framesDir: input.framesDir,
    fps: input.pkg.motion.fps,
    durationMs: input.pkg.motion.durationMs,
    outputPath: input.outputPath,
    preset: input.preset,
    ...(input.audio ? { audio: input.audio } : {}),
    ...(input.audioTracks ? { audioTracks: input.audioTracks } : {}),
    ...(input.audioMaster !== undefined ? { audioMaster: input.audioMaster } : {}),
    inputRoots: input.inputRoots,
    outputRoots: input.outputRoots
  });
  if (input.dryRun) return { kind: "dry-run", resourcePreflight, command };

  const health = await checkFfmpeg({ ...(input.ffmpegRunner ? { runner: input.ffmpegRunner } : {}) });
  if (!health.ok) return { kind: "refused", response: { ok: false, command: "render", lane: "ffmpeg", error: health.error } };

  let publication: DerivedOutputPublication;
  try {
    publication = input.outputPublication ?? await acquireDerivedOutputPublication({ outputPath: input.outputPath, kind: "file", force: input.force });
  } catch (error) {
    return { kind: "refused", response: { ok: false, command: "render", lane: "ffmpeg", frameLane: input.frameLane, error: publicationError(error) } };
  }
  const framesGuard = await framesDirRefusal(input.framesDir, {
    force: input.force,
    callerSupplied: input.framesDirCallerSupplied,
    withinRoot: input.framesRoot
  });
  if (framesGuard) {
    await publication.abort();
    return { kind: "refused", response: { ok: false, command: "render", lane: "ffmpeg", frameLane: input.frameLane, error: framesGuard } };
  }

  // This closure is deliberately created only after `framesDirRefusal` has established that the
  // exact directory is an empty or Motion-owned frame sink. No other caller-selected path is ever
  // recursively removed. PNGs persist only for the explicit retention intent.
  const cleanup = async () => {
    if (!input.keepFrames) await rm(input.framesDir, { recursive: true, force: true });
  };
  let lastFrameReceipt: unknown = null;
  const frameLaneWarnings = new FrameLaneWarnings();
  let workflowEvidence: BrowserWorkflowRenderEvidence | undefined;
  let completed = false;
  try {
    if (input.frameLane === "native") {
      const nativeSession = await createNativeRenderSession({
        packageRoot: input.packageRoot,
        outputRoots: [input.framesDir],
        pngCompressionLevel: INTERMEDIATE_FRAME_PNG_COMPRESSION_LEVEL,
        renderTarget: "delivery"
      });
      try {
        for (let frameIndex = 0; frameIndex < input.frameCount; frameIndex += 1) {
          const outputPath = join(input.framesDir, frameFileName(frameIndex));
          throwIfCancelled(input.signal, "native frame rendering");
          const frame = await nativeSession.renderFrameAtMs(frameTimestampMs(frameIndex, input.pkg.motion.fps, input.pkg.motion.durationMs), outputPath);
          lastFrameReceipt = frame.receipt;
          frameLaneWarnings.observe(frame.receipt);
          if (!frame.ok) {
            return {
              kind: "refused",
              response: {
                ok: false, command: "render", lane: "ffmpeg", frameLane: input.frameLane,
                error: frame.error,
                ...(input.keepFrames ? { frameReceipt: frame.receipt } : {}),
                ...(input.keepFrames ? { frames: { dir: input.framesDir, count: frameIndex } } : {})
              }
            };
          }
        }
      } finally {
        nativeSession.close();
      }
    } else {
      const browserSession = input.browserFrameRenderer ? undefined : await createMotionBrowserRenderSession(input.pkg, input.callerId ? { callerId: input.callerId } : {});
      try {
        const frames = await renderBrowserFrames(
          input.pkg,
          Array.from({ length: input.frameCount }, (_, frameIndex) => ({
            outDir: input.framesDir,
            outputPath: join(input.framesDir, frameFileName(frameIndex)),
            atMs: frameTimestampMs(frameIndex, input.pkg.motion.fps, input.pkg.motion.durationMs),
            ...(input.workflow ? { workflow: input.workflow } : {})
          })),
          browserSession,
          input.browserFrameRenderer,
          input.signal
        );
        const lastFrame = frames.at(-1);
        lastFrameReceipt = lastFrame?.receipt ?? null;
        for (const frame of frames) frameLaneWarnings.observe(frame.receipt);
        if (lastFrame) workflowEvidence = browserWorkflowEvidence(lastFrame);
      } finally {
        await browserSession?.close();
      }
    }

    const encoded = await encodeImageSequenceWithPolicy({
      packageId: input.pkg.manifest.id,
      framesDir: input.framesDir,
      fps: input.pkg.motion.fps,
      width: input.pkg.motion.width,
      height: input.pkg.motion.height,
      durationMs: input.pkg.motion.durationMs,
      outputPath: input.outputPath,
      outputPublication: publication,
      preset: input.preset,
      ...(input.audio ? { audio: input.audio } : {}),
      ...(input.audioTracks ? { audioTracks: input.audioTracks } : {}),
      ...(input.audioMaster !== undefined ? { audioMaster: input.audioMaster } : {}),
      inputRoots: input.inputRoots,
      outputRoots: input.outputRoots,
      ...(input.quality ? { quality: input.quality } : {}),
      resourcePreflight,
      ...(input.forceSoftwareEncode ? { forceSoftwareEncode: true } : {}),
      ...(health.version ? { ffmpegVersion: health.version } : {}),
      ...(input.ffmpegRunner ? { runner: input.ffmpegRunner } : {})
    });
    if (!encoded.ok) {
      if (encoded.receipt) {
        redactAbortedFinalOutputEvidence(encoded.receipt, encoded.error);
        frameLaneWarnings.applyTo(encoded.receipt);
      }
      return {
        kind: "refused",
        response: {
          ok: false, command: "render", lane: "ffmpeg", frameLane: input.frameLane,
          error: encoded.error,
          ...(encoded.receipt ? { receipt: encoded.receipt, output: encoded.receipt.output } : {}),
          ...(input.keepFrames ? { frameReceipt: lastFrameReceipt } : {}),
          ...(input.keepFrames ? { frames: { dir: input.framesDir, count: input.frameCount } } : {})
        }
      };
    }
    frameLaneWarnings.applyTo(encoded.receipt);
    if (!input.deferOutputPublication) {
      await publication.publishFile(await publication.verifyFile());
      encoded.command = { ...encoded.command, args: encoded.command.args.map((arg) => arg === publication.stagingPath ? input.outputPath : arg) };
      encoded.receipt.output = { ...(encoded.receipt.output as Record<string, unknown>), path: input.outputPath };
      encoded.receipt.artifacts = encoded.receipt.artifacts?.map((artifact) => artifact.path === publication.stagingPath ? { ...artifact, path: input.outputPath } : artifact);
    }
    completed = true;
    return {
      kind: "encoded",
      encoded,
      lastFrameReceipt,
      ...(input.keepFrames ? { frames: { dir: input.framesDir, count: input.frameCount } } : {}),
      ...(workflowEvidence ? { workflowEvidence } : {}),
      ...(input.deferOutputPublication ? { outputPublication: publication } : {}),
      cleanup
    };
  } finally {
    if (!completed) await publication.abort();
    if (!completed) await cleanup();
  }
}

function publicationError(error: unknown): { code: string; message: string } {
  return { code: (error as { code?: string }).code ?? "derived_output_publish_failed", message: error instanceof Error ? error.message : String(error) };
}

function materializedPreflightRefusal(
  resourcePreflight: MaterializedFrameSequencePreflight,
  frameLane: "browser" | "native"
): MaterializedResponse {
  return {
    ok: false,
    command: "render",
    lane: "ffmpeg",
    frameLane,
    error: {
      code: resourcePreflight.refusal?.code === "render_static_sequence_limit_exceeded"
        ? "render_budget_exceeded"
        : resourcePreflight.refusal?.code ?? "render_resource_preflight_exceeded",
      message: resourcePreflight.refusal?.message ?? "Materialized frame sequence was refused.",
      ...(resourcePreflight.refusal?.suggestedAction ? { suggestedAction: resourcePreflight.refusal.suggestedAction } : {}),
      resourcePreflight
    }
  };
}

/** Remove source-PNG paths from evidence when the materialized sequence is transient scratch. */
export function withoutTransientFrameSourcePaths<T extends Record<string, unknown>>(qualityCheck: T, framesDir: string): T {
  const frameRoot = `${resolve(framesDir)}${sep}`;
  const samples = Array.isArray(qualityCheck.samples) ? qualityCheck.samples : undefined;
  if (!samples) return qualityCheck;
  return {
    ...qualityCheck,
    samples: samples.map((sample) => {
      const sampleRecord = record(sample);
      const baselinePath = sampleRecord?.baselinePath;
      if (!sampleRecord || typeof baselinePath !== "string" || !resolve(baselinePath).startsWith(frameRoot)) return sample;
      const { baselinePath: _transientPath, ...safeSample } = sampleRecord;
      return safeSample;
    })
  } as T;
}

async function renderBrowserFrames(
  pkg: MotionPackage,
  frames: Array<{ outDir: string; outputPath: string; atMs: number; workflow?: BrowserCaptureWorkflow }>,
  session: MotionBrowserRenderSession | undefined,
  injected: BrowserFrameRenderer | undefined,
  signal: AbortSignal | undefined
): Promise<Awaited<ReturnType<typeof renderMotionBrowserFrame>>[]> {
  if (!injected) return session!.renderFrames(frames, signal ? { signal } : {});
  const results: Awaited<ReturnType<typeof renderMotionBrowserFrame>>[] = [];
  for (const frame of frames) {
    throwIfCancelled(signal, "browser frame rendering");
    results.push(await injected(pkg, frame));
  }
  return results;
}

function browserWorkflowEvidence(frame: { output?: unknown; receipt?: unknown }): BrowserWorkflowRenderEvidence | undefined {
  const output = record(frame.output);
  const receipt = record(frame.receipt);
  const inputHashes = record(receipt?.inputHashes);
  const workflow = output?.workflow;
  const workflowTrace = output?.workflowTrace;
  const trace = record(workflowTrace);
  const workflowHash = typeof inputHashes?.workflow === "string" ? inputHashes.workflow : typeof trace?.workflowHash === "string" ? trace.workflowHash : undefined;
  if (workflow === undefined && workflowTrace === undefined && !workflowHash) return undefined;
  return { ...(workflow !== undefined ? { workflow } : {}), ...(workflowTrace !== undefined ? { workflowTrace } : {}), ...(workflowHash ? { workflowHash } : {}) };
}

function frameTimestampMs(frameIndex: number, fps: number, durationMs: number): number {
  return Math.max(0, Math.min(Math.round((frameIndex * 1000) / fps), Math.max(0, durationMs - 1)));
}

function frameFileName(frameIndex: number): string { return `${String(frameIndex + 1).padStart(6, "0")}.png`; }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
