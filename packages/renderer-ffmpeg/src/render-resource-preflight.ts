import type { MaterializedFrameSequencePreflight } from "@shellx-motion/core";

/** Core-owned final-frame admission evidence carried into the durable render receipt. */
export interface RenderResourcePreflightInput {
  resourcePreflight?: MaterializedFrameSequencePreflight;
}

/** Image-sequence receipts carry the same Core-owned admission evidence as encoded deliveries. */
export interface CreateImageSequenceReceiptInput extends RenderResourcePreflightInput {
  packageId: string;
  framesDir: string;
  fps: number;
  width: number;
  height: number;
  durationMs: number;
  frameCount: number;
  framePattern?: string;
  framePaths?: string[];
  warnings?: string[];
  now?: () => string;
}
