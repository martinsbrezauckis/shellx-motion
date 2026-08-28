import type { OperationReceipt, ReceiptActor } from "@shellx-motion/core";
import type {
  FfmpegRunner,
  RenderStreamingFinalInput,
  RenderStreamingFinalResult
} from "@shellx-motion/renderer-ffmpeg";
import type { BrowserWorkflowServices } from "./integration-browser-workflow.js";
import type { MotionDebugResult } from "../command-registry.js";

/** Capabilities that the central Debug dispatch provides to integration commands. */
export interface IntegrationDomainServices extends BrowserWorkflowServices {
  /** Host-owned persistent generic connector submission; omitted when no coordinator is configured. */
  submitCoordinatedConnector?: (args: unknown) => Promise<MotionDebugResult>;
  ffmpegRunner?: FfmpegRunner;
  /** Host-only image2pipe seam; connector callers never receive it from command arguments. */
  streamingFinalRenderer?: (input: RenderStreamingFinalInput) => Promise<RenderStreamingFinalResult>;
  receiptsRoot?: string;
  readReceipt?: (path: string) => Promise<OperationReceipt | null>;
  readJson?: (path: string, withinRoot?: string) => Promise<unknown>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
  /** Observed transport actor included in the immutable Canvas package receipt. */
  receiptActor?: ReceiptActor;
  writeJson?: (path: string, value: unknown) => Promise<void>;
  authoringInputRoots?: string[];
  authoringOutputRoots?: string[];
}

/** Keep the high-level streamed renderer distinct from the probe/readback runner at connector boundaries. */
export function connectorStreamingServices(services: IntegrationDomainServices): {
  streamingRenderer?: (input: RenderStreamingFinalInput) => Promise<RenderStreamingFinalResult>;
  ffmpegRunner?: FfmpegRunner;
} {
  return {
    ...(services.streamingFinalRenderer ? { streamingRenderer: services.streamingFinalRenderer } : {}),
    ...(services.ffmpegRunner ? { ffmpegRunner: services.ffmpegRunner } : {})
  };
}
