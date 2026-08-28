/**
 * Frame-lane orchestration shared by the typed final-render still, sequence, and FFmpeg paths.
 *
 * The selected lane is part of the deliverable's provenance: native requests stay native and fail
 * on the native capability/text contracts rather than falling through to browser rasterization.
 */
import {
  AgentScriptProvenanceRefusal,
  acquireDerivedOutputPublication,
  type DerivedOutputPublication,
  matchRendererCapability,
  NATIVE_CAPABILITY,
  type AgentScriptExecutionEvidence,
  type MotionDocument,
  type MotionPackage,
  type OperationReceipt
} from "@shellx-motion/core";
import {
  renderMotionBrowserFrame,
  type BrowserCaptureWorkflow,
  type BrowserFrameFormat,
  type BrowserFrameResult,
  type MotionBrowserRenderSessionFactory
} from "@shellx-motion/renderer-browser";
import { withRendererPrivateOutputPublication } from "@shellx-motion/renderer-browser/internal/private-output-publication";
import {
  createNativeRenderSession,
  INTERMEDIATE_FRAME_PNG_COMPRESSION_LEVEL,
  nativeTextDeliveryIssues,
  nativeTextDeliveryMessage,
  renderNativePreviewFrame,
  type NativePreviewError
} from "@shellx-motion/renderer-native";
import { withNativePrivateOutputPublication } from "@shellx-motion/renderer-native/internal/private-output-publication";
import { FrameLaneWarnings } from "@shellx-motion/renderer-ffmpeg/frame-lane-warnings";
import { dirname, join } from "node:path";
import { frameFileName, frameTimestampMs } from "./render-frame-sequence.js";
import {
  activeBrowserScripts,
  applyBrowserScriptEvidence,
  BrowserScriptEvidenceAccumulator
} from "./browser-script-evidence.js";

export type FinalFrameLane = "browser" | "native";

export type FinalBrowserFrameRenderer = (
  pkg: MotionPackage,
  options: {
    atMs: number;
    outDir: string;
    outputPath?: string;
    workflow?: BrowserCaptureWorkflow;
    format?: BrowserFrameFormat;
  }
) => Promise<BrowserFrameResult>;

export interface NativeFrameLaneRefusal {
  error: { code: string; message: string; suggestedAction: string; detail: unknown };
  warnings: string[];
}

export interface BrowserWorkflowRenderEvidence {
  workflow?: unknown;
  workflowTrace?: unknown;
  workflowHash?: string;
}

export interface FinalFramePass {
  frameReceipt: unknown;
  warnings: string[];
  workflowEvidence?: BrowserWorkflowRenderEvidence;
  applyTo(receipt: OperationReceipt): void;
}

export type FinalFramePassResult =
  | ({ ok: true; publication: DerivedOutputPublication } & FinalFramePass)
  | ({ ok: false; error: NativePreviewError } & FinalFramePass);

export type FinalFrameSequenceResult =
  | ({ ok: true; framePaths: string[]; renderedFrameCount: number } & FinalFramePass)
  | ({ ok: false; error: NativePreviewError; framePaths: string[]; renderedFrameCount: number } & FinalFramePass);

/** Preflight the native contracts that execution enforces too, including dry runs. */
export function nativeFrameLaneRefusal(
  pkg: MotionPackage,
  frameLane: FinalFrameLane,
  target: "still-frame" | "delivery"
): NativeFrameLaneRefusal | null {
  if (frameLane !== "native") return null;
  const capability = matchRendererCapability(pkg.motion, NATIVE_CAPABILITY);
  if (!capability.ok) {
    const warnings = capability.unsupported.map((unsupported) => unsupported.reason);
    const unsupportedLayerCount = new Set(capability.unsupported.map((unsupported) => unsupported.layerId)).size;
    return {
      error: {
        code: "unsupported_layer",
        message: `Native renderer cannot render ${capability.unsupported.length} unsupported ${capability.unsupported.length === 1 ? "feature" : "features"} across ${unsupportedLayerCount} ${unsupportedLayerCount === 1 ? "layer" : "layers"}.`,
        suggestedAction: "Use frameLane browser for this package; native final rendering never falls back automatically.",
        detail: { frameLane: "native", unsupported: capability.unsupported }
      },
      warnings
    };
  }
  if (target !== "delivery") return null;
  const textIssues = nativeTextDeliveryIssues(pkg.motion);
  if (textIssues.length === 0) return null;
  return {
    error: {
      code: "native_text_not_deliverable",
      message: nativeTextDeliveryMessage(textIssues),
      suggestedAction: "Use frameLane browser for delivery text the native block-glyph lane cannot reproduce.",
      detail: { frameLane: "native", unsupported: textIssues }
    },
    warnings: textIssues.map((issue) => issue.reason)
  };
}

export async function renderFinalStillFrame(input: {
  pkg: MotionPackage;
  packageRoot: string;
  outputPath: string;
  atMs: number;
  frameLane: FinalFrameLane;
  format: BrowserFrameFormat;
  workflow?: BrowserCaptureWorkflow;
  browserFrameRenderer?: FinalBrowserFrameRenderer;
}): Promise<FinalFramePassResult> {
  const warnings = new FrameLaneWarnings();
  const publication = await acquireDerivedOutputPublication({ outputPath: input.outputPath, kind: "file" });
  let staged = false;
  try {
    if (input.frameLane === "native") {
      const frame = await renderNativePreviewFrame(withNativePrivateOutputPublication({
        packageRoot: input.packageRoot,
        outputPath: publication.stagingPath,
        outputRoots: [publication.rootPath],
        atMs: input.atMs
      }, publication));
      warnings.observe(frame.receipt);
      const pass = framePass(warnings, frame.receipt);
      if (!frame.ok) return { ok: false, error: frame.error, ...pass };
      staged = true;
      return { ok: true, publication, ...pass };
    }
    const renderer = input.browserFrameRenderer ?? renderMotionBrowserFrame;
    const frame = await renderer(input.pkg, withRendererPrivateOutputPublication({
      outDir: dirname(publication.stagingPath),
      outputPath: publication.stagingPath,
      atMs: input.atMs,
      ...(input.workflow ? { workflow: input.workflow } : {}),
      format: input.format
    }, publication));
    const requiresScriptEvidence = activeBrowserScripts(input.pkg);
    const scriptEvidence = new BrowserScriptEvidenceAccumulator();
    scriptEvidence.observe(frame, requiresScriptEvidence);
    warnings.observe(frame.receipt);
    staged = true;
    return { ok: true, publication, ...framePass(warnings, frame.receipt, browserWorkflowEvidenceFromFrame(frame), scriptEvidence.finish(requiresScriptEvidence)) };
  } finally {
    if (!staged) await publication.abort();
  }
}

export async function renderFinalDeliveryFrames(input: {
  pkg: MotionPackage;
  packageRoot: string;
  outputDir: string;
  frameLane: FinalFrameLane;
  frameCount: number;
  workflow?: BrowserCaptureWorkflow;
  browserFrameRenderer?: FinalBrowserFrameRenderer;
  browserSessionFactory?: MotionBrowserRenderSessionFactory;
  activeScriptSessionAvailable?: boolean;
  intermediateFfmpegFrames?: boolean;
}): Promise<FinalFrameSequenceResult> {
  const warnings = new FrameLaneWarnings();
  const framePaths: string[] = [];
  let lastFrameReceipt: unknown = null;
  if (input.frameLane === "native") {
    const session = await createNativeRenderSession({
      packageRoot: input.packageRoot,
      outputRoots: [input.outputDir],
      renderTarget: "delivery",
      ...(input.intermediateFfmpegFrames ? { pngCompressionLevel: INTERMEDIATE_FRAME_PNG_COMPRESSION_LEVEL } : {})
    });
    try {
      for (let frameIndex = 0; frameIndex < input.frameCount; frameIndex += 1) {
        const framePath = join(input.outputDir, frameFileName(frameIndex));
        framePaths.push(framePath);
        const frame = await session.renderFrameAtMs(
          frameTimestampMs(frameIndex, input.pkg.motion.fps, input.pkg.motion.durationMs),
          framePath
        );
        lastFrameReceipt = frame.receipt;
        warnings.observe(frame.receipt);
        if (!frame.ok) {
          return {
            ok: false,
            error: frame.error,
            framePaths,
            renderedFrameCount: frameIndex,
            ...framePass(warnings, frame.receipt)
          };
        }
      }
    } finally {
      session.close();
    }
    return {
      ok: true,
      framePaths,
      renderedFrameCount: input.frameCount,
      ...framePass(warnings, lastFrameReceipt)
    };
  }

  const requiresScriptEvidence = activeBrowserScripts(input.pkg);
  if (requiresScriptEvidence && (!input.browserSessionFactory || input.activeScriptSessionAvailable === false)) {
    throw new AgentScriptProvenanceRefusal(
      "Active browser content requires one host-bound session for materialized multi-frame rendering."
    );
  }
  const renderer = input.browserFrameRenderer ?? renderMotionBrowserFrame;
  const session = input.browserSessionFactory ? await input.browserSessionFactory(input.pkg) : undefined;
  const scriptEvidence = new BrowserScriptEvidenceAccumulator();
  let lastBrowserFrame: BrowserFrameResult | undefined;
  try {
    for (let frameIndex = 0; frameIndex < input.frameCount; frameIndex += 1) {
      const framePath = join(input.outputDir, frameFileName(frameIndex));
      framePaths.push(framePath);
      const frameOptions = {
        outDir: input.outputDir,
        outputPath: framePath,
        atMs: frameTimestampMs(frameIndex, input.pkg.motion.fps, input.pkg.motion.durationMs),
        ...(input.workflow ? { workflow: input.workflow } : {})
      };
      const frame = session
        ? await session.renderFrame(frameOptions)
        : await renderer(input.pkg, frameOptions);
      scriptEvidence.observe(frame, requiresScriptEvidence);
      lastBrowserFrame = frame;
      lastFrameReceipt = frame.receipt;
      warnings.observe(frame.receipt);
    }
  } finally {
    await session?.close();
  }
  return {
    ok: true,
    framePaths,
    renderedFrameCount: input.frameCount,
    ...framePass(
      warnings,
      lastFrameReceipt,
      browserWorkflowEvidenceFromFrame(lastBrowserFrame ?? {}),
      scriptEvidence.finish(requiresScriptEvidence)
    )
  };
}

export function enrichRenderReceiptWithBrowserWorkflow(
  receipt: OperationReceipt,
  evidence: BrowserWorkflowRenderEvidence | undefined
): void {
  if (!evidence) return;
  if (evidence.workflowHash) {
    receipt.inputHashes = { ...receipt.inputHashes, workflow: evidence.workflowHash };
  }
  receipt.output = {
    ...(objectRecord(receipt.output) ?? {}),
    ...(evidence.workflow !== undefined ? { workflow: evidence.workflow } : {}),
    ...(evidence.workflowTrace !== undefined ? { workflowTrace: evidence.workflowTrace } : {})
  };
}

export function browserWorkflowResultFields(evidence: BrowserWorkflowRenderEvidence | undefined): Record<string, unknown> {
  if (!evidence) return {};
  return {
    ...(evidence.workflow !== undefined ? { workflow: evidence.workflow } : {}),
    ...(evidence.workflowTrace !== undefined ? { workflowTrace: evidence.workflowTrace } : {})
  };
}

function framePass(
  warnings: FrameLaneWarnings,
  frameReceipt: unknown,
  workflowEvidence?: BrowserWorkflowRenderEvidence,
  scriptExecution?: AgentScriptExecutionEvidence
): FinalFramePass {
  return {
    frameReceipt,
    warnings: warnings.list(),
    ...(workflowEvidence ? { workflowEvidence } : {}),
    applyTo: (receipt) => {
      warnings.applyTo(receipt);
      applyBrowserScriptEvidence(receipt, scriptExecution);
    }
  };
}

function browserWorkflowEvidenceFromFrame(frame: { output?: unknown; receipt?: unknown }): BrowserWorkflowRenderEvidence | undefined {
  const output = objectRecord(frame.output);
  const receipt = objectRecord(frame.receipt);
  const inputHashes = objectRecord(receipt?.inputHashes);
  const workflow = output?.workflow;
  const workflowTrace = output?.workflowTrace;
  const workflowHash = typeof inputHashes?.workflow === "string"
    ? inputHashes.workflow
    : workflowHashFromTrace(workflowTrace);
  if (workflow === undefined && workflowTrace === undefined && !workflowHash) return undefined;
  return {
    ...(workflow !== undefined ? { workflow } : {}),
    ...(workflowTrace !== undefined ? { workflowTrace } : {}),
    ...(workflowHash ? { workflowHash } : {})
  };
}

function workflowHashFromTrace(value: unknown): string | undefined {
  const trace = objectRecord(value);
  return typeof trace?.workflowHash === "string" ? trace.workflowHash : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
