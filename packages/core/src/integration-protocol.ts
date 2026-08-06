import { MOTION_EXPORT_PRESETS } from "./export-presets";

export const SHELLX_MOTION_INTEGRATION_PROTOCOL = 1;

export type ShellXIntegrationHost = "shellx-motion" | "shellx-cut" | "shellx-canvas";

export interface ShellXIntegrationCapabilities {
  schema: "shellx-motion/integration-capabilities@1";
  host: ShellXIntegrationHost;
  protocol: { min: number; max: number; preferred: number };
  schemas: Record<string, string[]>;
  modes: string[];
  presets: string[];
  features: string[];
  limits: {
    maxPlanBytes: number;
    maxArtifactBytes: number;
    maxOperations: number;
  };
}

export interface ShellXIntegrationBinding {
  schema: "shellx-motion/integration-binding@1";
  protocol: number;
  producer: ShellXIntegrationHost;
  consumer: ShellXIntegrationHost;
  mode: string;
  payloadSchema: string;
  requiredFeatures: string[];
}

export interface ShellXIntegrationEnvelope {
  schema: "shellx-motion/integration-envelope@1";
  producer: ShellXIntegrationCapabilities;
  binding: ShellXIntegrationBinding;
}

export interface VerifiedShellXIntegrationEnvelope {
  envelope: ShellXIntegrationEnvelope;
  negotiation: ShellXIntegrationNegotiation;
}

export interface ShellXIntegrationNegotiation {
  schema: "shellx-motion/integration-negotiation@1";
  ok: boolean;
  localHost: ShellXIntegrationHost;
  remoteHost: ShellXIntegrationHost;
  selectedProtocol?: number;
  modes: string[];
  presets: string[];
  features: string[];
  schemas: Record<string, string[]>;
  limits: ShellXIntegrationCapabilities["limits"];
  missingRequiredModes: string[];
  error?: { code: "unsupported_protocol" | "missing_required_mode"; message: string };
}

const HOST_CAPABILITIES: Record<ShellXIntegrationHost, Omit<ShellXIntegrationCapabilities, "schema" | "host">> = {
  "shellx-motion": {
    protocol: { min: 1, max: 1, preferred: 1 },
    schemas: {
      package: ["shellx-motion/package-manifest@1", "shellx-motion/motion@1"],
      artifact: ["shellx-motion/artifact-handle@1", "shellx-motion/artifact-handle-ref@1"],
      receipt: ["shellx-motion/receipt@1"],
      cut: ["shellx-motion/cut-import-plan@1"],
      canvas: ["shellx-motion/canvas-bridge-package@1", "shellx-motion/canvas-frame-selection@1"]
    },
    modes: ["package.preview", "render.frame", "render.final", "canvas.bridge", "cut.import.plan"],
    // Derived from the single-source Motion export preset list so this advertisement can never omit a
    // preset the ffmpeg renderer actually supports (connector-review D6: mov-prores was missing here).
    presets: [...MOTION_EXPORT_PRESETS],
    features: ["artifact.attestation", "atomic-output", "browser-workflow", "deterministic-seek", "render-session"],
    limits: { maxPlanBytes: 4_194_304, maxArtifactBytes: 8_589_934_592, maxOperations: 10_000 }
  },
  "shellx-cut": {
    protocol: { min: 1, max: 1, preferred: 1 },
    schemas: {
      artifact: ["shellx-motion/artifact-handle@1", "shellx-motion/artifact-handle-ref@1"],
      receipt: ["shellx-motion/receipt@1"],
      cut: ["shellx-motion/cut-import-plan@1"]
    },
    modes: ["cut.import.plan"],
    presets: ["png-frame", "mp4-h264"],
    features: ["artifact.attestation", "atomic-apply", "background-cancel", "idempotent-apply"],
    limits: { maxPlanBytes: 4_194_304, maxArtifactBytes: 8_589_934_592, maxOperations: 10_000 }
  },
  "shellx-canvas": {
    protocol: { min: 1, max: 1, preferred: 1 },
    schemas: {
      package: ["shellx-motion/package-manifest@1", "shellx-motion/motion@1"],
      artifact: ["shellx-motion/artifact-handle@1", "shellx-motion/artifact-handle-ref@1"],
      receipt: ["shellx-motion/receipt@1"],
      canvas: ["shellx-motion/canvas-bridge-package@1", "shellx-motion/canvas-frame-selection@1"]
    },
    modes: ["package.preview", "canvas.bridge"],
    presets: ["png-frame", "mp4-h264"],
    features: ["artifact.attestation", "motion-package-save", "cut-handoff"],
    limits: { maxPlanBytes: 4_194_304, maxArtifactBytes: 8_589_934_592, maxOperations: 10_000 }
  }
};

export function integrationCapabilitiesForHost(host: ShellXIntegrationHost): ShellXIntegrationCapabilities {
  return structuredClone({
    schema: "shellx-motion/integration-capabilities@1" as const,
    host,
    ...HOST_CAPABILITIES[host]
  });
}

export function negotiateIntegrationCapabilities(
  local: ShellXIntegrationCapabilities,
  remote: ShellXIntegrationCapabilities,
  requiredModes: string[] = []
): ShellXIntegrationNegotiation {
  const minimum = Math.max(local.protocol.min, remote.protocol.min);
  const maximum = Math.min(local.protocol.max, remote.protocol.max);
  const modes = intersection(local.modes, remote.modes);
  const presets = intersection(local.presets, remote.presets);
  const features = intersection(local.features, remote.features);
  const schemas = Object.fromEntries(
    [...new Set([...Object.keys(local.schemas), ...Object.keys(remote.schemas)])]
      .sort()
      .map((key) => [key, intersection(local.schemas[key] ?? [], remote.schemas[key] ?? [])])
      .filter(([, values]) => (values as string[]).length > 0)
  );
  const limits = {
    maxPlanBytes: Math.min(local.limits.maxPlanBytes, remote.limits.maxPlanBytes),
    maxArtifactBytes: Math.min(local.limits.maxArtifactBytes, remote.limits.maxArtifactBytes),
    maxOperations: Math.min(local.limits.maxOperations, remote.limits.maxOperations)
  };
  const missingRequiredModes = [...new Set(requiredModes)].filter((mode) => !modes.includes(mode)).sort();
  const base = {
    schema: "shellx-motion/integration-negotiation@1" as const,
    localHost: local.host,
    remoteHost: remote.host,
    modes,
    presets,
    features,
    schemas,
    limits,
    missingRequiredModes
  };
  if (minimum > maximum) {
    return {
      ...base,
      ok: false,
      error: {
        code: "unsupported_protocol",
        message: `${local.host} supports ${local.protocol.min}-${local.protocol.max}; ${remote.host} supports ${remote.protocol.min}-${remote.protocol.max}.`
      }
    };
  }
  const selectedProtocol = Math.max(
    minimum,
    Math.min(local.protocol.preferred, remote.protocol.preferred, maximum)
  );
  if (missingRequiredModes.length > 0) {
    return {
      ...base,
      ok: false,
      selectedProtocol,
      error: {
        code: "missing_required_mode",
        message: `No shared support for required mode(s): ${missingRequiredModes.join(", ")}.`
      }
    };
  }
  return { ...base, ok: true, selectedProtocol };
}

/**
 * Create the self-contained protocol evidence carried by connector payloads.
 * Consumers re-negotiate this envelope against their own current capabilities;
 * the selected protocol is evidence, never authority by itself.
 */
export function createIntegrationEnvelope(input: {
  producer: ShellXIntegrationHost;
  consumer: ShellXIntegrationHost;
  mode: string;
  payloadSchema: string;
  requiredFeatures?: string[];
}): ShellXIntegrationEnvelope {
  const producer = integrationCapabilitiesForHost(input.producer);
  const consumer = integrationCapabilitiesForHost(input.consumer);
  const negotiation = negotiateIntegrationCapabilities(producer, consumer, [input.mode]);
  if (!negotiation.ok || negotiation.selectedProtocol === undefined) {
    throw new Error(negotiation.error?.message ?? "Integration capabilities are incompatible.");
  }
  const requiredFeatures = [...new Set(input.requiredFeatures ?? [])].sort();
  const missingFeature = requiredFeatures.find((feature) => !negotiation.features.includes(feature));
  if (missingFeature) throw new Error(`No shared support for required feature: ${missingFeature}.`);
  if (!sharedSchemaValues(negotiation).has(input.payloadSchema)) {
    throw new Error(`No shared support for payload schema: ${input.payloadSchema}.`);
  }
  return {
    schema: "shellx-motion/integration-envelope@1",
    producer,
    binding: {
      schema: "shellx-motion/integration-binding@1",
      protocol: negotiation.selectedProtocol,
      producer: input.producer,
      consumer: input.consumer,
      mode: input.mode,
      payloadSchema: input.payloadSchema,
      requiredFeatures
    }
  };
}

/**
 * Parse and re-negotiate an untrusted connector envelope before any payload
 * paths, artifacts, or operations are consumed.
 */
export function verifyIntegrationEnvelope(
  value: unknown,
  expected: {
    producer: ShellXIntegrationHost;
    consumer: ShellXIntegrationHost;
    mode: string;
    payloadSchema: string;
  }
): VerifiedShellXIntegrationEnvelope {
  const envelopeRecord = closedRecord(value, ["schema", "producer", "binding"], "Integration envelope");
  if (envelopeRecord.schema !== "shellx-motion/integration-envelope@1") {
    throw new Error("Unsupported integration envelope schema.");
  }
  const producer = parseIntegrationCapabilities(envelopeRecord.producer);
  const bindingRecord = closedRecord(
    envelopeRecord.binding,
    ["schema", "protocol", "producer", "consumer", "mode", "payloadSchema", "requiredFeatures"],
    "Integration binding"
  );
  if (bindingRecord.schema !== "shellx-motion/integration-binding@1") {
    throw new Error("Unsupported integration binding schema.");
  }
  if (!Number.isSafeInteger(bindingRecord.protocol) || Number(bindingRecord.protocol) < 1) {
    throw new Error("Integration binding protocol must be a positive integer.");
  }
  if (!isIntegrationHost(bindingRecord.producer) || !isIntegrationHost(bindingRecord.consumer)) {
    throw new Error("Integration binding host is invalid.");
  }
  const mode = requiredString(bindingRecord.mode, "Integration binding mode");
  const payloadSchema = requiredString(bindingRecord.payloadSchema, "Integration binding payloadSchema");
  const requiredFeatures = stringArray(bindingRecord.requiredFeatures, "binding.requiredFeatures");
  const binding: ShellXIntegrationBinding = {
    schema: "shellx-motion/integration-binding@1",
    protocol: Number(bindingRecord.protocol),
    producer: bindingRecord.producer,
    consumer: bindingRecord.consumer,
    mode,
    payloadSchema,
    requiredFeatures
  };

  if (producer.host !== expected.producer || binding.producer !== expected.producer) {
    throw new Error(`Integration producer must be ${expected.producer}.`);
  }
  if (binding.consumer !== expected.consumer) throw new Error(`Integration consumer must be ${expected.consumer}.`);
  if (binding.mode !== expected.mode) throw new Error(`Integration mode must be ${expected.mode}.`);
  if (binding.payloadSchema !== expected.payloadSchema) {
    throw new Error(`Integration payload schema must be ${expected.payloadSchema}.`);
  }

  const consumer = integrationCapabilitiesForHost(expected.consumer);
  const negotiation = negotiateIntegrationCapabilities(producer, consumer, [expected.mode]);
  if (!negotiation.ok || negotiation.selectedProtocol === undefined) {
    throw new Error(negotiation.error?.message ?? "Integration capabilities are incompatible.");
  }
  if (binding.protocol !== negotiation.selectedProtocol) {
    throw new Error(`Integration protocol ${binding.protocol} does not match negotiated protocol ${negotiation.selectedProtocol}.`);
  }
  const missingFeature = binding.requiredFeatures.find((feature) => !negotiation.features.includes(feature));
  if (missingFeature) throw new Error(`No shared support for required feature: ${missingFeature}.`);
  if (!sharedSchemaValues(negotiation).has(expected.payloadSchema)) {
    throw new Error(`No shared support for payload schema: ${expected.payloadSchema}.`);
  }
  return {
    envelope: { schema: "shellx-motion/integration-envelope@1", producer, binding },
    negotiation
  };
}

export function parseIntegrationCapabilities(value: unknown): ShellXIntegrationCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Integration capabilities must be an object.");
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(["schema", "host", "protocol", "schemas", "modes", "presets", "features", "limits"]);
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unknownKey) throw new Error(`Integration capabilities contain unknown field '${unknownKey}'.`);
  if (record.schema !== "shellx-motion/integration-capabilities@1") {
    throw new Error("Unsupported integration capabilities schema.");
  }
  if (!isIntegrationHost(record.host)) throw new Error("Integration capabilities host is invalid.");
  const protocol = integerRecord(record.protocol, ["min", "max", "preferred"], "protocol");
  if (protocol.min > protocol.max || protocol.preferred < protocol.min || protocol.preferred > protocol.max) {
    throw new Error("Integration protocol range/preferred version is inconsistent.");
  }
  const limits = integerRecord(record.limits, ["maxPlanBytes", "maxArtifactBytes", "maxOperations"], "limits");
  const schemasRecord = objectRecord(record.schemas, "schemas");
  const schemas = Object.fromEntries(
    Object.entries(schemasRecord).map(([key, entries]) => [key, stringArray(entries, `schemas.${key}`)])
  );
  return {
    schema: "shellx-motion/integration-capabilities@1",
    host: record.host,
    protocol,
    schemas,
    modes: stringArray(record.modes, "modes"),
    presets: stringArray(record.presets, "presets"),
    features: stringArray(record.features, "features"),
    limits
  };
}

function intersection(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((value) => rightSet.has(value)).sort();
}

function sharedSchemaValues(negotiation: ShellXIntegrationNegotiation): Set<string> {
  return new Set(Object.values(negotiation.schemas).flat());
}

function isIntegrationHost(value: unknown): value is ShellXIntegrationHost {
  return value === "shellx-motion" || value === "shellx-cut" || value === "shellx-canvas";
}

function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function closedRecord(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  const record = objectRecord(value, field);
  const unknownKey = Object.keys(record).find((key) => !keys.includes(key));
  if (unknownKey) throw new Error(`${field} contains unknown field '${unknownKey}'.`);
  return record;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string.`);
  return value;
}

function integerRecord<K extends string>(
  value: unknown,
  keys: readonly K[],
  field: string
): Record<K, number> {
  const record = objectRecord(value, field);
  const unknownKey = Object.keys(record).find((key) => !keys.includes(key as K));
  if (unknownKey) throw new Error(`${field} contains unknown field '${unknownKey}'.`);
  const result = {} as Record<K, number>;
  for (const key of keys) {
    const number = record[key];
    if (!Number.isSafeInteger(number) || Number(number) < 1) throw new Error(`${field}.${key} must be a positive integer.`);
    result[key] = Number(number);
  }
  return result;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`${field} must be an array of non-empty strings.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${field} must not contain duplicates.`);
  return [...value];
}
