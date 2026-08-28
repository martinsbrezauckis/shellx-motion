/** Generic descriptor-bound connector submission and restart-safe explicit retry. */
import {
  assertMotionJobId,
  mintMotionJobId,
  MotionConnectorJobBindingJournal,
  type MotionJobCoordinator,
  type MotionJobCoordinatorResult
} from "@shellx-motion/core";
import {
  executePreparedMotionConnectorJob,
  prepareAdmittedMotionConnectorJob,
  type MotionConnectorJobSubmitRequest,
  type MotionConnectorReferenceAuthority
} from "@shellx-motion/connectors";
import type { MotionDebugResult } from "./command-registry.js";

export interface CoordinatorConnectorSubmitServices {
  jobTrackingDisabled: boolean;
  callerId?: string;
  connectorJobReferences?: MotionConnectorReferenceAuthority;
  connectorJobBindingJournal?: MotionConnectorJobBindingJournal;
  coordinator(): MotionJobCoordinator;
  unhandled(error: unknown): MotionDebugResult;
}

/** Journal and admit one exact catalog descriptor before resolving any caller reference. */
export async function submitCoordinatedConnector(args: unknown, services: CoordinatorConnectorSubmitServices): Promise<MotionDebugResult> {
  if (services.jobTrackingDisabled) return coordinatorDisabled();
  const callerId = services.callerId;
  if (!callerId) return ownerPrincipalUnavailable();
  if (!services.connectorJobReferences) return connectorAuthorityUnavailable();
  if (!services.connectorJobBindingJournal) return connectorBindingJournalUnavailable();
  const parsed = parseConnectorSubmit(args);
  if (!parsed.ok) return invalidArgs(parsed.message);
  let prepared;
  try {
    prepared = prepareAdmittedMotionConnectorJob(parsed.value);
  } catch (error) {
    return connectorPreparationFailure(error);
  }
  try {
    const coordinator = services.coordinator();
    const jobId = parsed.jobId ?? mintMotionJobId();
    const bindingWrite = await services.connectorJobBindingJournal.write({
      jobId, callerId, ...connectorBindingData(prepared), request: prepared.request
    });
    if (!bindingWrite.ok) return connectorBindingFailure(bindingWrite.code);
    const submitted = await coordinator.submit({
      jobId, callerId, lane: "connector", operation: prepared.operation,
      submissionData: connectorSubmissionData(prepared, bindingWrite.binding.fingerprint),
      execute: connectorExecution(prepared, services.connectorJobReferences, callerId)
    });
    if (!submitted.ok) return { ok: false, error: { code: submitted.code, message: submitted.message }, warnings: [] };
    const initial = await coordinator.jobView().get({ jobId: submitted.value.jobId, callerId });
    const state = initial.ok ? initial.job.state : "pending";
    return {
      ok: true,
      visibleState: { panel: "connector", operation: "connector.submit", jobId: submitted.value.jobId, state },
      result: {
        ok: true, jobId: submitted.value.jobId, state,
        lifecycle: initial.ok ? initial.job.lifecycle : "pending",
        binding: { ...connectorBindingData(prepared), bindingFingerprint: bindingWrite.binding.fingerprint }
      },
      warnings: []
    };
  } catch (error) {
    return services.unhandled(error);
  }
}

interface CoordinatedConnectorRetryServices {
  connectorJobReferences?: MotionConnectorReferenceAuthority;
  connectorJobBindingJournal?: MotionConnectorJobBindingJournal;
  coordinator(): MotionJobCoordinator;
}

/**
 * Explicitly reconstruct a durable generic connector binding. Ordinary render retries retain their
 * process-owned callback path; no pending, running, cancelled or non-retryable job is resurrected.
 */
export async function retryCoordinatedJob(
  input: { jobId: string; callerId: string; newJobId?: string },
  services: CoordinatedConnectorRetryServices
): Promise<MotionJobCoordinatorResult<{ jobId: string; priorJobId: string }>> {
  const coordinator = services.coordinator();
  if (!services.connectorJobBindingJournal) return await coordinator.retry(input);
  const stored = await services.connectorJobBindingJournal.read({ jobId: input.jobId, callerId: input.callerId });
  if (!stored.ok) {
    if (stored.code === "binding_unknown") return await coordinator.retry(input);
    if (stored.code === "binding_not_visible") return coordinatorFailure("job_not_visible", `Motion job ${input.jobId} belongs to another caller.`);
    return coordinatorFailure("capability_unavailable", `Connector binding for Motion job ${input.jobId} is invalid.`);
  }
  if (!services.connectorJobReferences) {
    return coordinatorFailure("capability_unavailable", "Generic connector retry requires the host-owned opaque reference authority.");
  }
  const source = await coordinator.jobView().get({ jobId: input.jobId, callerId: input.callerId });
  if (!source.ok) {
    const code = source.code === "job_expired" ? "job_unknown" : source.code;
    return coordinatorFailure(code, `Motion job ${input.jobId} could not be read.`);
  }
  if (source.job.lifecycle !== "ended" || source.job.outcome !== "failed" || source.job.error?.retryable !== true) {
    return coordinatorFailure("job_not_retryable", `Motion job ${input.jobId} is not a retryable failed run.`);
  }
  if (input.newJobId === input.jobId) {
    return coordinatorFailure("job_not_retryable", "A retry must use a distinct job id so its source evidence remains immutable.");
  }
  let prepared;
  try {
    prepared = prepareAdmittedMotionConnectorJob({
      capabilityId: stored.binding.capabilityId,
      descriptorRevision: stored.binding.descriptorRevision,
      descriptorFingerprint: stored.binding.descriptorFingerprint,
      requestSchemaId: stored.binding.requestSchemaId,
      request: stored.binding.request
    });
  } catch (error) {
    return coordinatorFailure("capability_unavailable", error instanceof Error ? error.message : "The connector descriptor changed after the source run.");
  }
  if (prepared.catalogFingerprint !== stored.binding.catalogFingerprint) {
    return coordinatorFailure("capability_unavailable", "The Motion capability catalog changed after the source connector run; submit a newly discovered request instead.");
  }
  const jobId = input.newJobId ?? mintMotionJobId();
  let bindingWrite;
  try {
    bindingWrite = await services.connectorJobBindingJournal.write({
      jobId, callerId: stored.binding.callerId, ...connectorBindingData(prepared), request: prepared.request
    });
  } catch (error) {
    return coordinatorFailure("capability_unavailable", error instanceof Error ? error.message : "Connector retry binding could not be persisted.");
  }
  if (!bindingWrite.ok) return coordinatorFailure("capability_unavailable", `Connector retry binding was refused: ${bindingWrite.code}.`);
  const retryAttempt = (source.job.lineage?.retryAttempt ?? 0) + 1;
  const submitted = await coordinator.submit({
    jobId, callerId: stored.binding.callerId, lane: "connector", operation: prepared.operation,
    submissionData: connectorSubmissionData(prepared, bindingWrite.binding.fingerprint),
    lineage: {
      priorJobId: input.jobId,
      ...(source.job.receiptId ? { priorReceiptId: source.job.receiptId } : {}),
      retryAttempt
    },
    initialEvents: [{ type: "retry_submitted", data: { priorJobId: input.jobId, retryAttempt } }],
    execute: connectorExecution(prepared, services.connectorJobReferences, stored.binding.callerId)
  });
  return submitted.ok ? { ok: true, value: { jobId: submitted.value.jobId, priorJobId: input.jobId } } : submitted;
}

function connectorBindingData(prepared: ReturnType<typeof prepareAdmittedMotionConnectorJob>) {
  return {
    capabilityId: prepared.capabilityId,
    descriptorRevision: prepared.descriptorRevision,
    descriptorFingerprint: prepared.descriptorFingerprint,
    requestSchemaId: prepared.requestSchemaId,
    catalogFingerprint: prepared.catalogFingerprint
  };
}

function connectorSubmissionData(prepared: ReturnType<typeof prepareAdmittedMotionConnectorJob>, bindingFingerprint: string) {
  return { ...connectorBindingData(prepared), bindingFingerprint };
}

function connectorExecution(
  prepared: ReturnType<typeof prepareAdmittedMotionConnectorJob>,
  references: MotionConnectorReferenceAuthority,
  callerId: string
) {
  return async (signal: AbortSignal) => {
    const execution = await executePreparedMotionConnectorJob(prepared, { callerId, references, signal });
    return execution.ok
      ? { ok: true, receiptPath: execution.receiptPath, committed: execution.committed }
      : { ok: false, error: execution.error };
  };
}

function coordinatorFailure(
  code: "job_unknown" | "job_not_visible" | "job_not_retryable" | "job_not_terminal" | "capability_unavailable",
  message: string
): MotionJobCoordinatorResult<never> {
  return { ok: false, code, message };
}

function parseConnectorSubmit(args: unknown):
  | { ok: true; value: MotionConnectorJobSubmitRequest; jobId?: string }
  | { ok: false; message: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, message: "motion.connector.submit arguments must be an object." };
  const record = args as Record<string, unknown>;
  const allowed = ["jobId", "capabilityId", "descriptorRevision", "descriptorFingerprint", "requestSchemaId", "request"];
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected) return { ok: false, message: `motion.connector.submit contains unknown field '${unexpected}'.` };
  if (typeof record.capabilityId !== "string" || !record.capabilityId) return { ok: false, message: "motion.connector.submit requires capabilityId." };
  if (!Number.isSafeInteger(record.descriptorRevision) || Number(record.descriptorRevision) < 1) return { ok: false, message: "motion.connector.submit requires a positive descriptorRevision." };
  if (typeof record.descriptorFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(record.descriptorFingerprint)) return { ok: false, message: "motion.connector.submit requires a lowercase SHA-256 descriptorFingerprint." };
  if (typeof record.requestSchemaId !== "string" || !record.requestSchemaId) return { ok: false, message: "motion.connector.submit requires requestSchemaId." };
  if (!record.request || typeof record.request !== "object" || Array.isArray(record.request)) return { ok: false, message: "motion.connector.submit requires a request object." };
  if (record.jobId !== undefined) {
    try { assertMotionJobId(record.jobId as string); }
    catch { return { ok: false, message: "motion.connector.submit jobId must be 1..128 characters of letters, digits, dot, underscore, colon or hyphen." }; }
  }
  return {
    ok: true,
    value: {
      capabilityId: record.capabilityId,
      descriptorRevision: Number(record.descriptorRevision),
      descriptorFingerprint: record.descriptorFingerprint,
      requestSchemaId: record.requestSchemaId,
      request: structuredClone(record.request as Record<string, unknown>)
    },
    ...(typeof record.jobId === "string" ? { jobId: record.jobId } : {})
  };
}

function connectorPreparationFailure(error: unknown): MotionDebugResult {
  const detail = error && typeof error === "object" && !Array.isArray(error) ? error as { code?: unknown; message?: unknown } : {};
  return {
    ok: false,
    error: {
      code: typeof detail.code === "string" ? detail.code : "invalid_args",
      message: typeof detail.message === "string" ? detail.message : "Connector job request could not be prepared.",
      retryable: false
    },
    warnings: []
  };
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function coordinatorDisabled(): MotionDebugResult {
  return unavailable("Motion job tracking is disabled on this host.", "Ask the host operator to enable Motion job tracking before submitting a connector job.");
}

function ownerPrincipalUnavailable(): MotionDebugResult {
  return unavailable("Motion job submission requires a server-authenticated owner principal.", "Ask the host operator to use an authenticated Motion transport or configure a trusted in-process caller identity.");
}

function connectorAuthorityUnavailable(): MotionDebugResult {
  return unavailable("Generic connector jobs require a host-owned opaque reference authority; no connector job was queued.", "Ask the host operator to configure caller-scoped connector input and output reference resolution.");
}

function connectorBindingJournalUnavailable(): MotionDebugResult {
  return unavailable("Generic connector jobs require the immutable connector binding journal; no connector job was queued.", "Ask the host operator to configure one MotionConnectorJobBindingJournal beside the persistent coordinator.");
}

function connectorBindingFailure(code: "binding_conflict" | "binding_invalid"): MotionDebugResult {
  return unavailable(
    code === "binding_conflict" ? "This connector job id is already bound to different immutable request data." : "The stored connector binding is invalid or could not be verified.",
    code === "binding_conflict" ? "Submit with a new job id; never reuse an id for different connector data." : "Ask the host operator to inspect the connector binding journal before retrying."
  );
}

function unavailable(message: string, suggestedAction: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction }, warnings: [] };
}
