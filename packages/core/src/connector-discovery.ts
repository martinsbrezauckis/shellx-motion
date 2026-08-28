/** Closed, read-only Motion connector discovery contracts. */
import { integrationCapabilitiesForHost, type ShellXIntegrationCapabilities } from "./integration-protocol";
import { CURRENT_CONNECTOR_DESCRIPTORS, CURRENT_DOCUMENTATION_RESOURCES } from "./connector-discovery-catalog";
import { capabilityCatalogFingerprint, motionRuntimeProbe as buildMotionRuntimeProbe, parseMotionCapabilityCatalog } from "./connector-discovery-parser";

export const MOTION_RUNTIME_PROBE_SCHEMA = "shellx-motion/runtime-probe@1" as const;
/** MCI-1 remains a closed historical format; new catalogs are explicitly @2. */
export const MOTION_CAPABILITY_CATALOG_SCHEMA_V1 = "shellx-motion/capability-catalog@1" as const;
export const MOTION_CAPABILITY_CATALOG_SCHEMA = "shellx-motion/capability-catalog@2" as const;
export const MOTION_CAPABILITY_DESCRIPTOR_SCHEMA_V1 = "shellx-motion/capability-descriptor@1" as const;
export const MOTION_CAPABILITY_DESCRIPTOR_SCHEMA = "shellx-motion/capability-descriptor@2" as const;
export const MOTION_CONNECTOR_REQUEST_SCHEMA = "shellx-motion/connector-request-schema@1" as const;
export const MOTION_CONNECTOR_JOB_SCHEMA_V1 = "shellx-motion/connector-job@1" as const;
export const MOTION_CONNECTOR_JOB_SCHEMA = "shellx-motion/connector-job@2" as const;

export type MotionRuntimeExecution = "source" | "packed";
export type MotionRuntimeProvenance = { execution: MotionRuntimeExecution; managedDistribution: "unmanaged"; distributionQualification: "unverified"; cleanHostQualification: "unverified" };
export type ProtocolOne = { min: 1; max: 1; preferred: 1 };
export type ProtocolOneToTwo = { min: 1; max: 2; preferred: 2 };
export interface MotionRuntimeProbe {
  schema: typeof MOTION_RUNTIME_PROBE_SCHEMA;
  engine: { name: "@shellx-motion/core"; version: string };
  cli: { name: "@shellx-motion/cli"; version: string };
  runtime: { platform: "darwin" | "linux" | "win32"; architecture: string; nodeVersion: string };
  protocols: { integration: ProtocolOne; capabilityCatalog: ProtocolOne | ProtocolOneToTwo; connectorJob: ProtocolOne | ProtocolOneToTwo };
  catalog: { schema: typeof MOTION_CAPABILITY_CATALOG_SCHEMA_V1 | typeof MOTION_CAPABILITY_CATALOG_SCHEMA; fingerprint: string; descriptorCount: number };
  provenance: MotionRuntimeProvenance;
}
export interface MotionDocumentationResource { schema: "shellx-motion/docs-resource@1"; id: string; revision: number; fingerprint: string; }
export type ConnectorRequestFieldType = "boolean" | "enum" | "integer" | "opaque-reference" | "string";
export interface ConnectorRequestField { id: string; type: ConnectorRequestFieldType; required: boolean; maxLength?: number; minimum?: number; maximum?: number; values?: string[]; }
export interface ConnectorRequestSchema { schema: typeof MOTION_CONNECTOR_REQUEST_SCHEMA; id: string; maxBytes: number; fields: ConnectorRequestField[]; }
export type ConnectorOutput = { role: "artifact_handle" | "canvas_frame_selection" | "cut_import_plan" | "motion_package" | "receipt" | "rendered_media"; mediaKinds: string[]; schemas: string[] };
export type ConnectorJobControl = "cancel" | "events" | "get" | "list" | "retry";
export type ConnectorAvailabilityV1 =
  | { state: "conditional"; reason: string; platforms: Array<"darwin" | "linux" | "win32">; execution: "named-cli-compatibility-only" }
  | { state: "compatibility-only"; reason: string; platforms: Array<"darwin" | "linux" | "win32">; execution: "named-cli-compatibility-only" }
  | { state: "refused"; reason: string; platforms: Array<"darwin" | "linux" | "win32">; execution: "not-admitted" };
export type ConnectorAvailability =
  | { state: "conditional"; reason: string; platforms: Array<"darwin" | "linux" | "win32">; execution: "generic-connector-job" }
  | { state: "compatibility-only"; reason: string; platforms: Array<"darwin" | "linux" | "win32">; execution: "named-cli-compatibility-only" }
  | { state: "refused"; reason: string; platforms: Array<"darwin" | "linux" | "win32">; execution: "not-admitted" };
export interface ConnectorCapabilityDescriptorV1 {
  schema: typeof MOTION_CAPABILITY_DESCRIPTOR_SCHEMA_V1; id: string; revision: number; fingerprint: string; title: string; summary: string;
  category: "cut-handoff" | "host-bridge" | "render-export" | "scene-orchestration";
  documentation: { resource: string; anchor: string; resourceFingerprint: string };
  availability: ConnectorAvailabilityV1;
  request: ConnectorRequestSchema;
  invocation: { schema: typeof MOTION_CONNECTOR_JOB_SCHEMA_V1; model: "fixed-generic-connector-job"; admission: "not-admitted"; jobControls: [] };
  outputs: ConnectorOutput[];
  requirements: { integrationModes: string[]; integrationFeatures: string[]; permissionTier: "write_local" };
}
export interface ConnectorCapabilityDescriptor {
  schema: typeof MOTION_CAPABILITY_DESCRIPTOR_SCHEMA; id: string; revision: number; fingerprint: string; title: string; summary: string;
  category: "cut-handoff" | "host-bridge" | "render-export" | "scene-orchestration";
  documentation: { resource: string; anchor: string; resourceFingerprint: string };
  availability: ConnectorAvailability;
  request: ConnectorRequestSchema;
  invocation:
    | { schema: typeof MOTION_CONNECTOR_JOB_SCHEMA; model: "fixed-generic-connector-job"; admission: "admitted"; jobControls: ConnectorJobControl[] }
    | { schema: typeof MOTION_CONNECTOR_JOB_SCHEMA; model: "fixed-generic-connector-job"; admission: "compatibility-only" | "not-admitted"; jobControls: [] };
  outputs: ConnectorOutput[];
  requirements: { integrationModes: string[]; integrationFeatures: string[]; permissionTier: "render_motion" | "write_local" };
}
export interface MotionCapabilityCatalogV1 { schema: typeof MOTION_CAPABILITY_CATALOG_SCHEMA_V1; protocol: ProtocolOne; integrationCapabilities: ShellXIntegrationCapabilities; resources: MotionDocumentationResource[]; descriptors: ConnectorCapabilityDescriptorV1[]; fingerprint: string; }
export interface MotionCapabilityCatalog { schema: typeof MOTION_CAPABILITY_CATALOG_SCHEMA; protocol: { min: 2; max: 2; preferred: 2 }; integrationCapabilities: ShellXIntegrationCapabilities; resources: MotionDocumentationResource[]; descriptors: ConnectorCapabilityDescriptor[]; fingerprint: string; }
export type ParsedConnectorCapabilityDescriptor = ConnectorCapabilityDescriptorV1 | ConnectorCapabilityDescriptor;
export type ParsedMotionCapabilityCatalog = MotionCapabilityCatalogV1 | MotionCapabilityCatalog;
export interface GenericConnectorRequestPreparation { capabilityId: string; descriptorRevision: number; descriptorFingerprint: string; requestSchemaId: string; request: Record<string, unknown>; }

/** Static catalog data never selects an executable, path, provider, network, or implementation. */
export function motionCapabilityCatalog(): MotionCapabilityCatalog {
  const content = {
    schema: MOTION_CAPABILITY_CATALOG_SCHEMA,
    protocol: { min: 2, max: 2, preferred: 2 } as const,
    integrationCapabilities: integrationCapabilitiesForHost("shellx-motion"),
    resources: structuredClone(Array.from(CURRENT_DOCUMENTATION_RESOURCES)),
    descriptors: structuredClone(Array.from(CURRENT_CONNECTOR_DESCRIPTORS))
  };
  const catalog = parseMotionCapabilityCatalog({ ...content, fingerprint: capabilityCatalogFingerprint(content) });
  if (catalog.schema !== MOTION_CAPABILITY_CATALOG_SCHEMA) throw new Error("Generated capability catalog must be protocol @2.");
  return catalog;
}

/** This pure report is unqualified unless later immutable distribution verification changes it. */
export function motionRuntimeProbe(input: { engineVersion: string; cliVersion: string; execution: MotionRuntimeExecution; platform: string; architecture: string; nodeVersion: string }): MotionRuntimeProbe {
  return buildMotionRuntimeProbe(motionCapabilityCatalog(), input);
}

export {
  capabilityCatalogFingerprint,
  capabilityDescriptorFingerprint,
  documentationResourceFingerprint,
  parseConnectorCapabilityDescriptor,
  parseConnectorRequestSchema,
  parseMotionCapabilityCatalog,
  parseMotionDocumentationResource,
  parseMotionRuntimeProbe,
  prepareGenericConnectorRequest,
  validateConnectorRequest
} from "./connector-discovery-parser";
