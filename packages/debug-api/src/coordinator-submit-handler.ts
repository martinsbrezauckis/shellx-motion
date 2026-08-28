/** Coordinator-owned final-video submission and shared service wiring. */
import {
  MotionConnectorJobBindingJournal,
  MotionJobCoordinator,
  motionJobFailure,
  type MotionJobView
} from "@shellx-motion/core";
import type { MotionConnectorReferenceAuthority } from "@shellx-motion/connectors";
import { planFinalVideoFrameTransport, readFfmpegExportPreset } from "@shellx-motion/renderer-ffmpeg";
import type { MotionDebugResult } from "./command-registry.js";
import { parseCoordinatedRenderSubmit } from "./coordinated-render-submit.js";
import { retryCoordinatedJob, submitCoordinatedConnector } from "./coordinator-connector-submit-handler.js";

export interface CoordinatorSubmitServices {
  jobTrackingDisabled: boolean;
  injectedBrowserRenderer: boolean;
  /** Host-owned direct GPU-final execution availability. False refuses before a job is queued. */
  gpuFinalExecutionAvailable: boolean;
  /** Server-generated/authenticated owner principal. Absent principals fail closed. */
  callerId?: string;
  coordinator(): MotionJobCoordinator;
  executeFinal(renderArgs: Record<string, unknown>, signal: AbortSignal): Promise<MotionDebugResult>;
  unhandled(error: unknown): MotionDebugResult;
}

interface CoordinatedJobDomainInput {
  jobView?: MotionJobView | null;
  jobCoordinator?: MotionJobCoordinator;
  injectedBrowserRenderer: boolean;
  gpuFinalExecutionAvailable: boolean;
  callerId?: string;
  connectorJobReferences?: MotionConnectorReferenceAuthority;
  connectorJobBindingJournal?: MotionConnectorJobBindingJournal;
  executeFinal(renderArgs: Record<string, unknown>, signal: AbortSignal): Promise<MotionDebugResult>;
  unhandled(error: unknown): MotionDebugResult;
  connectorUnhandled?(error: unknown): MotionDebugResult;
}

let defaultJobCoordinator: MotionJobCoordinator | undefined;

/** Build the three coupled coordinator services without expanding the central Debug dispatcher. */
export function coordinatedJobDomainServices(input: CoordinatedJobDomainInput) {
  const disabled = input.jobView === null;
  const coordinator = disabled ? undefined : input.jobCoordinator ?? (defaultJobCoordinator ??= new MotionJobCoordinator());
  return {
    jobView: disabled ? undefined : input.jobView ?? coordinator?.jobView(),
    jobCoordinator: coordinator,
    submitCoordinatedRender: async (args: unknown) => await submitCoordinatedRender(args, {
      jobTrackingDisabled: disabled,
      injectedBrowserRenderer: input.injectedBrowserRenderer,
      gpuFinalExecutionAvailable: input.gpuFinalExecutionAvailable,
      callerId: input.callerId,
      coordinator: () => coordinator ?? (defaultJobCoordinator ??= new MotionJobCoordinator()),
      executeFinal: input.executeFinal,
      unhandled: input.unhandled
    }),
    submitCoordinatedConnector: async (args: unknown) => await submitCoordinatedConnector(args, {
      jobTrackingDisabled: disabled,
      callerId: input.callerId,
      connectorJobReferences: input.connectorJobReferences,
      connectorJobBindingJournal: input.connectorJobBindingJournal,
      coordinator: () => coordinator ?? (defaultJobCoordinator ??= new MotionJobCoordinator()),
      unhandled: input.connectorUnhandled ?? input.unhandled
    }),
    retryCoordinatedJob: async (retry: { jobId: string; callerId: string; newJobId?: string }) => await retryCoordinatedJob(retry, {
      connectorJobReferences: input.connectorJobReferences,
      connectorJobBindingJournal: input.connectorJobBindingJournal,
      coordinator: () => coordinator ?? (defaultJobCoordinator ??= new MotionJobCoordinator())
    })
  };
}

/** Admit only the cancellation-proven streamed or durable-segmented final-video routes. */
export async function submitCoordinatedRender(args: unknown, services: CoordinatorSubmitServices): Promise<MotionDebugResult> {
  if (services.jobTrackingDisabled) return coordinatorDisabled();
  if (!services.callerId) return ownerPrincipalUnavailable();
  const parsed = parseCoordinatedRenderSubmit(args);
  if (!parsed.ok) return invalidArgs(parsed.message);
  const { jobId: suppliedJobId, renderArgs } = parsed.value;
  const preset = typeof renderArgs.preset === "string" ? renderArgs.preset : "mp4-h264";
  if (!readFfmpegExportPreset(preset)) {
    return invalidArgs("motion.job.submit admits only final-video FFmpeg presets because only the streamed final route is coordinator-cancellable. Use motion.render.final for stills, image sequences, or other materialized compatibility paths.");
  }
  const segmented = renderArgs.segmented !== undefined;
  const transport = planFinalVideoFrameTransport({
    keepFrames: false, capturedBrowserWorkflow: false, exactSourceQuality: false,
    injectedFrameRenderer: services.injectedBrowserRenderer
  });
  if (!segmented && transport.delivery !== "streamed") {
    return invalidArgs("motion.job.submit is unavailable with an injected browser renderer because that selects a materialized compatibility route. Use motion.render.final for that host configuration.");
  }
  const frameLane = typeof renderArgs.frameLane === "string" ? renderArgs.frameLane : "browser";
  if (frameLane !== "browser" && frameLane !== "native" && frameLane !== "gpu") {
    return invalidArgs("motion.job.submit frameLane must be browser, native, or gpu.");
  }
  if (frameLane === "gpu") {
    if (!services.gpuFinalExecutionAvailable) {
      return capabilityUnavailable("GPU final job execution is unavailable on this host; no GPU job was queued.");
    }
    if (!gpuFinalVideoPreset(preset)) {
      return invalidArgs("GPU final jobs require a strict streamed FFmpeg video preset (MP4, WebM, or MOV); GIF delivery is not a GPU final-video job.");
    }
  }
  if (segmented && services.injectedBrowserRenderer && frameLane === "browser") {
    return invalidArgs("motion.job.submit segmented browser delivery requires the fixed host browser session, not an injected renderer. Select frameLane native or use motion.render.final on a host without injection.");
  }
  try {
    const coordinator = services.coordinator();
    const submitted = await coordinator.submit({
      ...(suppliedJobId ? { jobId: suppliedJobId } : {}),
      callerId: services.callerId, lane: "ffmpeg", frameLane, operation: "render.final",
      execute: async (signal) => executionFrom(await services.executeFinal(renderArgs, signal))
    });
    if (!submitted.ok) return { ok: false, error: { code: submitted.code, message: submitted.message }, warnings: [] };
    const initial = await coordinator.jobView().get({ jobId: submitted.value.jobId, callerId: services.callerId });
    const state = initial.ok ? initial.job.state : "pending";
    return {
      ok: true,
      visibleState: { panel: "render", operation: "job.submit", jobId: submitted.value.jobId, state },
      result: { ok: true, jobId: submitted.value.jobId, frameLane, state, lifecycle: initial.ok ? initial.job.lifecycle : "pending" }, warnings: []
    };
  } catch (error) {
    return services.unhandled(error);
  }
}

function gpuFinalVideoPreset(preset: string): boolean {
  return preset !== "gif";
}

function executionFrom(result: MotionDebugResult) {
  const detail = typeof result.result === "object" && result.result !== null ? result.result as Record<string, unknown> : undefined;
  const producerEvidence = producerEvidenceLink(detail?.receipt);
  return {
    ok: result.ok,
    ...(result.receiptId ? { receiptId: result.receiptId } : {}),
    ...(typeof detail?.receiptPath === "string" ? { receiptPath: detail.receiptPath } : {}),
    ...(producerEvidence ? { producerEvidence } : {}),
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    ...(!result.ok ? { error: motionJobFailure(result.error, {
      code: "invalid_args",
      message: result.error.message
    }) } : {})
  };
}

/** Keep the coordinator record small: the final receipt remains the authority for full evidence. */
function producerEvidenceLink(receipt: unknown): { frameLane: "browser" | "native" | "gpu"; schema?: string } | undefined {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return undefined;
  const output = (receipt as { output?: unknown }).output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const transport = (output as { frameTransport?: unknown }).frameTransport;
  if (!transport || typeof transport !== "object" || Array.isArray(transport)) return undefined;
  const producer = (transport as { producer?: unknown }).producer;
  if (!producer || typeof producer !== "object" || Array.isArray(producer)) return undefined;
  const frameLane = (producer as { frameLane?: unknown }).frameLane;
  if (frameLane !== "browser" && frameLane !== "native" && frameLane !== "gpu") return undefined;
  const evidence = (producer as { evidence?: unknown }).evidence;
  const schema = evidence && typeof evidence === "object" && !Array.isArray(evidence)
    && typeof (evidence as { schema?: unknown }).schema === "string"
    ? (evidence as { schema: string }).schema
    : undefined;
  return { frameLane, ...(schema ? { schema } : {}) };
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function coordinatorDisabled(): MotionDebugResult {
  return {
    ok: false,
    error: {
      code: "capability_unavailable",
      message: "Motion job tracking is disabled on this host.",
      suggestedAction: "Ask the host operator to enable Motion job tracking before submitting or controlling a coordinator job."
    },
    warnings: []
  };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return {
    ok: false,
    error: {
      code: "capability_unavailable",
      message,
      suggestedAction: "Configure a host with direct strict GPU final-render execution, then submit a new GPU job."
    },
    warnings: []
  };
}

function ownerPrincipalUnavailable(): MotionDebugResult {
  return {
    ok: false,
    error: {
      code: "capability_unavailable",
      message: "Motion job submission requires a server-authenticated owner principal.",
      suggestedAction: "Ask the host operator to use an authenticated Motion transport or configure a trusted in-process caller identity."
    },
    warnings: []
  };
}
