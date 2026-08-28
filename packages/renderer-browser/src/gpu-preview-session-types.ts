import type { LocalMotionJobEvidence, LocalMotionJobGovernor, MotionPackage, OperationReceipt, PublicationCommitUncertainEvidence } from "@shellx-motion/core";
import type { createGpuFrameRenderSession } from "./gpu-frame-renderer";
import type { PreparedGpuSceneResources } from "./gpu-scene-resources";
import type { GpuPageSessionResourceMetrics } from "./gpu-page-session-resources";
import type { GpuRuntimeEvidence } from "./gpu-runtime-types";
import type { GpuPreviewVideoProviderCleanupEvidence, OpenGpuPreviewVideoFrameProvider } from "./gpu-preview-video-frame-provider";
import type { resolveGpuPreviewOutputPath } from "./gpu-preview-output";
import type { GpuEffectModuleUseAuthority } from "./gpu-effect-module-use-authority";

export interface GpuPreviewFrameOptions {
  atMs?: number;
  outDir: string;
  outputPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  callerId?: string;
  jobId?: string;
  now?: () => string;
}

export interface GpuPreviewFrame {
  path: string;
  sha256: string;
  width: number;
  height: number;
  atMs: number;
  gpu: GpuRuntimeEvidence;
  resources: LocalMotionJobEvidence;
}

export type GpuPreviewResult =
  | { ok: true; frame: GpuPreviewFrame; receipt: OperationReceipt }
  | {
    ok: false;
    error: {
      code: string;
      message: string;
      layerId?: string;
      possiblyCommitted?: true;
      publicPaths?: readonly string[];
      expectedPublications?: readonly PublicationCommitUncertainEvidence[];
    };
    resources?: LocalMotionJobEvidence;
  };

export interface GpuPreviewSession {
  renderFrame(options: GpuPreviewFrameOptions): Promise<GpuPreviewResult>;
  /** Reusable callers may retain this bounded cleanup evidence after close. */
  close(): Promise<GpuPreviewSessionCleanupEvidence>;
}

export interface GpuPreviewSessionCleanupEvidence {
  closed: true;
  runtimeResources: GpuPageSessionResourceMetrics | null;
  provider: GpuPreviewVideoProviderCleanupEvidence | null;
  /** Present only on the private retained C6G session; generic reusable sessions remain unchanged. */
  scene3dAnimation?: { staticWrapperCompilations: number; framePlanCompilations: number };
}

export interface GpuPreviewSessionOptions {
  governor?: LocalMotionJobGovernor;
  /** Test/host seam; production uses the renderer-owned WebGPU session opener. */
  openRuntime?: typeof createGpuFrameRenderSession;
  /** Host-owned preview decoder opener. Absent video packages never invoke it. */
  openVideoProvider?: OpenGpuPreviewVideoFrameProvider;
  /** Opaque host-minted use authority; packages, SDK callers, and options cannot mint one. */
  effectModuleAuthority?: GpuEffectModuleUseAuthority;
  /** Test seams; production uses renderer-owned verified resources and output-path resolution. */
  prepareResourcesForTest?: (pkg: MotionPackage) => Promise<PreparedGpuSceneResources>;
  resolveOutputPathForTest?: typeof resolveGpuPreviewOutputPath;
}
