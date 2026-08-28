/** Shared private contract for the C6C exact-duration terminal Browser boundary. */
import type { AgentScriptExecutionEvidence } from "@shellx-motion/core";

export const CHECKPOINT_STORYBOARD_TERMINAL_SCHEMA = "shellx-motion/checkpoint-storyboard-terminal-boundary@1" as const;

export type TerminalStaticDocument = Readonly<{
  readonly width: number;
  readonly height: number;
  readonly background: string;
}>;

/**
 * Immutable capture-time facts. Terminal rendering must not read the mutable source package
 * again after session selection, including when Chromium launch yields to user code.
 */
export interface TerminalBoundaryDescriptor {
  readonly packageId: string;
  readonly durationMs: number;
  readonly document: TerminalStaticDocument;
  readonly scriptExecution: Readonly<AgentScriptExecutionEvidence>;
  readonly staticFingerprint: string;
}

export interface CheckpointStoryboardTerminalBoundaryEvidence {
  readonly schema: typeof CHECKPOINT_STORYBOARD_TERMINAL_SCHEMA;
  readonly mode: "exact-duration-static-background";
  readonly endpoint: { readonly requestedAtMs: number; readonly durationMs: number; readonly exactDuration: true };
  readonly execution: {
    readonly renderFramesCalls: 1; readonly requestedFrames: 1; readonly capturedFrames: 1;
    readonly maxConcurrency: 1; readonly maxFrameAttempts: 1; readonly retries: 0;
    readonly cacheHits: 0; readonly reused: false;
  };
  readonly document: {
    readonly width: number; readonly height: number; readonly background: string;
    readonly layersLoaded: 0; readonly sourceLoads: 0; readonly fontLoads: 0;
    readonly assetLoads: 0; readonly scriptLoads: 0; readonly mediaLoads: 0; readonly webglContexts: 0;
  };
  readonly network: {
    readonly policy: "deny-all"; readonly approvedOrigins: readonly [];
    readonly requestsAllowed: 0; readonly webSocketsAllowed: 0;
  };
}
