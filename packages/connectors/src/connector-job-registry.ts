/**
 * Motion-owned execution registry for the generic connector-job protocol.
 *
 * Consumers select an advertised descriptor and submit only its closed data request. They never
 * choose an implementation, filesystem path, command line, renderer, or provider. A trusted host
 * resolves the request's opaque references, while this registry remains the sole place that binds
 * a capability id to Motion code.
 */
import { dirname, isAbsolute } from "node:path";
import {
  motionJobFailure,
  motionCapabilityCatalog,
  prepareGenericConnectorRequest,
  type ConnectorCapabilityDescriptor,
  type GenericConnectorRequestPreparation,
  type MotionJobFailure
} from "@shellx-motion/core";
import { prepareCanvasToCutConnectorSelection, runPreparedCanvasToCutConnector } from "./canvas-to-cut";
import { runScriptToCutConnector } from "./script-to-cut";
import { runSourceToCutConnector } from "./source-to-cut";
import { runTemplateToCutConnector } from "./template-to-cut";

export interface MotionConnectorJobSubmitRequest {
  capabilityId: string;
  descriptorRevision: number;
  descriptorFingerprint: string;
  requestSchemaId: string;
  request: Record<string, unknown>;
}

export interface PreparedMotionConnectorJob extends GenericConnectorRequestPreparation {
  readonly catalogFingerprint: string;
  readonly operation: string;
}

export type MotionConnectorReferenceAccess = "read" | "write";

/** Host authority: opaque caller data can become a path only through this trusted callback. */
export interface MotionConnectorReferenceAuthority {
  resolvePath(input: {
    /** Authenticated coordinator owner; opaque references are never portable across callers. */
    callerId: string;
    capabilityId: string;
    fieldId: string;
    reference: string;
    access: MotionConnectorReferenceAccess;
    signal: AbortSignal;
  }): Promise<string>;
}

export interface MotionConnectorJobExecutionServices {
  /** Authenticated logical owner carried by the coordinator or named-CLI compatibility adapter. */
  callerId: string;
  references: MotionConnectorReferenceAuthority;
  signal: AbortSignal;
  /** Trusted internal marker for the named local compatibility adapter, never a generic request field. */
  namedCompatibility?: true;
  /** Trusted named-CLI adapter data; never accepted by the generic connector submit request. */
  namedCompatibilityOptions?: Readonly<Record<string, unknown>>;
}

export type MotionConnectorJobExecutionResult =
  | {
      ok: true;
      binding: PreparedMotionConnectorJob;
      receiptPath: string;
      /** The connector returned only after its atomic delivery commit completed. */
      committed: true;
      result: unknown;
    }
  | {
      ok: false;
      binding: PreparedMotionConnectorJob;
      error: MotionJobFailure;
    };

type RegisteredExecutor = (
  prepared: PreparedMotionConnectorJob,
  services: MotionConnectorJobExecutionServices
) => Promise<unknown>;

const EXECUTORS: Readonly<Record<string, RegisteredExecutor>> = Object.freeze({
  "connector.canvas-to-cut@1": async (prepared, services) => {
    const canvasSelectionPath = await referencePath(prepared, services, "input", "read");
    throwIfAborted(services.signal);
    const canvas = await prepareCanvasToCutConnectorSelection({
      canvasSelectionPath,
      // Generic submit has only the selected opaque file. The named CLI is a distinct host-owned
      // compatibility adapter and explicitly marks its trusted local selection bundle.
      canvasSelectionAuthority: services.namedCompatibility === true ? "trusted-local-bundle" : "opaque-file",
      signal: services.signal
    });
    throwIfAborted(services.signal);
    const outDir = await referencePath(prepared, services, "output", "write");
    throwIfAborted(services.signal);
    return await runPreparedCanvasToCutConnector(canvas, outDir);
  },
  "connector.script-to-cut@1": async (prepared, services) => {
    const paths = await inputOutputPaths(prepared, services);
    const cutPlacement = recordOption(services, "cutPlacement");
    return await runScriptToCutConnector({
      scriptPath: paths.input,
      outDir: paths.output,
      ...(cutPlacement ? { cutPlacement: cutPlacement as never } : {}),
      signal: services.signal
    });
  },
  "connector.source-to-cut@1": async (prepared, services) => {
    const paths = await inputOutputPaths(prepared, services);
    return await runSourceToCutConnector({
      sourcePath: paths.input,
      sourceInputRoot: dirname(paths.input),
      outDir: paths.output,
      ...integerOptions(services, ["maxFrames", "frameDurationMs", "width", "height", "fps"]),
      signal: services.signal
    });
  },
  "connector.template-to-cut@1": async (prepared, services) => {
    const paths = await inputOutputPaths(prepared, services);
    const values = recordOption(services, "values") ?? {};
    const cutPlacement = recordOption(services, "cutPlacement");
    return await runTemplateToCutConnector({
      packageRoot: paths.input,
      values: values as never,
      outDir: paths.output,
      ...(cutPlacement ? { cutPlacement: cutPlacement as never } : {}),
      signal: services.signal
    });
  }
});

/**
 * Bind one request to the exact descriptor the caller discovered.
 *
 * A catalog update between discovery and submission is a refusal, never an implicit migration.
 */
export function prepareAdmittedMotionConnectorJob(input: MotionConnectorJobSubmitRequest): PreparedMotionConnectorJob {
  const catalog = motionCapabilityCatalog();
  const descriptor = catalog.descriptors.find((candidate) => candidate.id === input.capabilityId);
  if (!descriptor) throw connectorJobError("unknown_capability", `Unknown connector capability: ${input.capabilityId}.`);
  assertAdmittedDescriptor(descriptor);
  if (descriptor.revision !== input.descriptorRevision || descriptor.fingerprint !== input.descriptorFingerprint) {
    throw connectorJobError("connector_descriptor_drift", `Connector capability ${descriptor.id} no longer matches the submitted descriptor revision and fingerprint.`);
  }
  if (descriptor.request.id !== input.requestSchemaId) {
    throw connectorJobError("connector_descriptor_drift", `Connector capability ${descriptor.id} no longer matches the submitted request schema id.`);
  }
  const prepared = prepareGenericConnectorRequest(catalog, input.capabilityId, input.request);
  if (!EXECUTORS[prepared.capabilityId]) {
    throw connectorJobError("capability_unavailable", `Connector capability ${prepared.capabilityId} has no installed Motion executor.`);
  }
  return Object.freeze({ ...prepared, catalogFingerprint: catalog.fingerprint, operation: prepared.capabilityId });
}

/** Execute a previously bound request, rechecking the live catalog before any reference resolves. */
export async function executePreparedMotionConnectorJob(
  prepared: PreparedMotionConnectorJob,
  services: MotionConnectorJobExecutionServices
): Promise<MotionConnectorJobExecutionResult> {
  let rebound: PreparedMotionConnectorJob;
  try {
    rebound = prepareAdmittedMotionConnectorJob({
      capabilityId: prepared.capabilityId,
      descriptorRevision: prepared.descriptorRevision,
      descriptorFingerprint: prepared.descriptorFingerprint,
      requestSchemaId: prepared.requestSchemaId,
      request: prepared.request
    });
  } catch (error) {
    return failure(prepared, error);
  }
  if (rebound.catalogFingerprint !== prepared.catalogFingerprint) {
    return failure(prepared, connectorJobError("connector_descriptor_drift", "The Motion capability catalog changed after connector-job admission."));
  }
  try {
    throwIfAborted(services.signal);
    const result = await EXECUTORS[rebound.capabilityId]!(rebound, services);
    const record = resultRecord(result);
    if (record.ok !== true) {
      const nested = resultRecord(record.error);
      return {
        ok: false,
        binding: rebound,
        error: motionJobFailure(nested, {
          code: "connector_failed",
          message: `Connector capability ${rebound.capabilityId} failed.`
        })
      };
    }
    if (typeof record.receiptPath !== "string" || !isAbsolute(record.receiptPath)) {
      return failure(rebound, connectorJobError("connector_receipt_unavailable", `Connector capability ${rebound.capabilityId} returned no absolute receipt path.`));
    }
    return { ok: true, binding: rebound, receiptPath: record.receiptPath, committed: true, result };
  } catch (error) {
    return failure(rebound, error);
  }
}

function assertAdmittedDescriptor(descriptor: ConnectorCapabilityDescriptor): void {
  if (descriptor.invocation.admission !== "admitted") {
    const code = descriptor.availability.state === "refused" ? "capability_refused" : "capability_unavailable";
    throw connectorJobError(code, `Connector capability ${descriptor.id} is ${descriptor.invocation.admission} and cannot enter generic connector-job execution.`);
  }
  if (descriptor.availability.platforms.includes(process.platform as "darwin" | "linux" | "win32") === false) {
    throw connectorJobError("capability_unavailable", `Connector capability ${descriptor.id} is unavailable on ${process.platform}.`);
  }
}

async function inputOutputPaths(
  prepared: PreparedMotionConnectorJob,
  services: MotionConnectorJobExecutionServices
): Promise<{ input: string; output: string }> {
  const input = await referencePath(prepared, services, "input", "read");
  throwIfAborted(services.signal);
  const output = await referencePath(prepared, services, "output", "write");
  throwIfAborted(services.signal);
  return { input, output };
}

async function referencePath(
  prepared: PreparedMotionConnectorJob,
  services: MotionConnectorJobExecutionServices,
  fieldId: string,
  access: MotionConnectorReferenceAccess
): Promise<string> {
  const reference = prepared.request[fieldId];
  if (typeof reference !== "string") throw connectorJobError("invalid_args", `Connector request field '${fieldId}' is not an opaque reference.`);
  const path = await services.references.resolvePath({
    callerId: services.callerId,
    capabilityId: prepared.capabilityId,
    fieldId,
    reference,
    access,
    signal: services.signal
  });
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw connectorJobError("connector_reference_refused", `The host did not resolve '${fieldId}' to an absolute trusted path.`);
  }
  return path;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw connectorJobError("job_cancelled", signal.reason instanceof Error ? signal.reason.message : "Connector job was cancelled.");
}

function failure(prepared: PreparedMotionConnectorJob, error: unknown): MotionConnectorJobExecutionResult {
  return { ok: false, binding: prepared, error: connectorJobErrorDetail(error) };
}

function connectorJobErrorDetail(error: unknown): MotionJobFailure {
  if (error instanceof MotionConnectorJobError) {
    return motionJobFailure({ code: error.code, message: error.message, retryable: false }, {
      code: "connector_failed", message: "Connector job failed."
    });
  }
  const record = resultRecord(error);
  return motionJobFailure({
    code: record.code,
    message: error instanceof Error ? error.message : record.message ?? String(error),
    retryable: record.retryable,
    retryAfterMs: record.retryAfterMs,
    remedy: record.remedy,
    suggestedAction: record.suggestedAction
  }, { code: "connector_failed", message: "Connector job failed." });
}

function resultRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function recordOption(services: MotionConnectorJobExecutionServices, key: string): Record<string, unknown> | undefined {
  const value = services.namedCompatibilityOptions?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function integerOptions(services: MotionConnectorJobExecutionServices, keys: readonly string[]): Record<string, number> {
  return Object.fromEntries(keys.flatMap((key) => {
    const value = services.namedCompatibilityOptions?.[key];
    return Number.isSafeInteger(value) ? [[key, Number(value)]] : [];
  }));
}

class MotionConnectorJobError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MotionConnectorJobError";
  }
}

function connectorJobError(code: string, message: string): MotionConnectorJobError {
  return new MotionConnectorJobError(code, message);
}
