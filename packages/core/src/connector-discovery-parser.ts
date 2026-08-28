import { canonicalJson, canonicalJsonSha256, compareCodeUnits } from "./canonical-json";
import { parseIntegrationCapabilities, type ShellXIntegrationCapabilities } from "./integration-protocol";
import {
  MOTION_CAPABILITY_CATALOG_SCHEMA,
  MOTION_CAPABILITY_CATALOG_SCHEMA_V1,
  MOTION_CAPABILITY_DESCRIPTOR_SCHEMA,
  MOTION_CAPABILITY_DESCRIPTOR_SCHEMA_V1,
  MOTION_CONNECTOR_JOB_SCHEMA,
  MOTION_CONNECTOR_JOB_SCHEMA_V1,
  MOTION_CONNECTOR_REQUEST_SCHEMA,
  MOTION_RUNTIME_PROBE_SCHEMA,
  type ConnectorCapabilityDescriptor,
  type ConnectorCapabilityDescriptorV1,
  type ConnectorJobControl,
  type ConnectorOutput,
  type ConnectorRequestField,
  type ConnectorRequestSchema,
  type GenericConnectorRequestPreparation,
  type MotionCapabilityCatalog,
  type MotionCapabilityCatalogV1,
  type MotionDocumentationResource,
  type MotionRuntimeProbe,
  type ParsedConnectorCapabilityDescriptor,
  type ParsedMotionCapabilityCatalog,
  type ProtocolOne,
  type ProtocolOneToTwo
} from "./connector-discovery";

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9._:-]{0,127}$/;
const CAPABILITY_ID = /^[a-z][a-z0-9._:-]{0,119}@\d{1,8}$/;
const SCHEMA_ID = /^[a-z][a-z0-9.-]{0,63}\/[a-z][a-z0-9._/-]{0,95}@\d{1,8}$/;
const OPAQUE_REFERENCE = /^[a-z][a-z0-9._-]{0,127}$/;
const GENERIC_JOB_CONTROLS: readonly ConnectorJobControl[] = ["cancel", "events", "get", "list", "retry"];

export function motionRuntimeProbe(catalog: MotionCapabilityCatalog, input: { engineVersion: string; cliVersion: string; execution: "source" | "packed"; platform: string; architecture: string; nodeVersion: string }): MotionRuntimeProbe {
  const execution = runtimeExecution(input.execution);
  return {
    schema: MOTION_RUNTIME_PROBE_SCHEMA,
    engine: { name: "@shellx-motion/core", version: requiredVersion(input.engineVersion, "Engine") },
    cli: { name: "@shellx-motion/cli", version: requiredVersion(input.cliVersion, "CLI") },
    runtime: { platform: platformName(input.platform, "runtime platform"), architecture: boundedString(input.architecture, "runtime architecture", 64), nodeVersion: boundedString(input.nodeVersion, "runtime nodeVersion", 64) },
    protocols: { integration: protocolOne(), capabilityCatalog: protocolOneToTwo(), connectorJob: protocolOneToTwo() },
    catalog: { schema: MOTION_CAPABILITY_CATALOG_SCHEMA, fingerprint: catalog.fingerprint, descriptorCount: catalog.descriptors.length },
    provenance: { execution, managedDistribution: "unmanaged", distributionQualification: "unverified", cleanHostQualification: "unverified" }
  };
}

export function parseMotionRuntimeProbe(value: unknown): MotionRuntimeProbe {
  const record = closedRecord(value, ["schema", "engine", "cli", "runtime", "protocols", "catalog", "provenance"], "Runtime probe");
  if (record.schema !== MOTION_RUNTIME_PROBE_SCHEMA) throw new Error("Unsupported runtime probe schema.");
  const runtime = closedRecord(record.runtime, ["platform", "architecture", "nodeVersion"], "runtime");
  const catalog = closedRecord(record.catalog, ["schema", "fingerprint", "descriptorCount"], "runtime probe catalog");
  const provenance = closedRecord(record.provenance, ["execution", "managedDistribution", "distributionQualification", "cleanHostQualification"], "runtime probe provenance");
  if (catalog.schema !== MOTION_CAPABILITY_CATALOG_SCHEMA_V1 && catalog.schema !== MOTION_CAPABILITY_CATALOG_SCHEMA) throw new Error("Runtime probe catalog schema is invalid.");
  if ((provenance.execution !== "source" && provenance.execution !== "packed") || provenance.managedDistribution !== "unmanaged" || provenance.distributionQualification !== "unverified" || provenance.cleanHostQualification !== "unverified") {
    throw new Error("Runtime probe may not claim managed or qualified distribution state before MDI-1 verification.");
  }
  const protocols = protocolSet(record.protocols, "runtime probe protocols");
  if (catalog.schema === MOTION_CAPABILITY_CATALOG_SCHEMA_V1) {
    if (!isProtocolOne(protocols.capabilityCatalog) || !isProtocolOne(protocols.connectorJob)) throw new Error("Historical capability catalog runtime probes must advertise protocol range 1 only.");
  } else if (!isProtocolOneToTwo(protocols.capabilityCatalog) || !isProtocolOneToTwo(protocols.connectorJob)) {
    throw new Error("Capability catalog @2 runtime probes must advertise protocol range 1 through 2 with preferred 2.");
  }
  return {
    schema: MOTION_RUNTIME_PROBE_SCHEMA,
    engine: namedVersion(record.engine, "engine", "@shellx-motion/core"), cli: namedVersion(record.cli, "cli", "@shellx-motion/cli"),
    runtime: { platform: platformName(runtime.platform, "runtime.platform"), architecture: boundedString(runtime.architecture, "runtime.architecture", 64), nodeVersion: boundedString(runtime.nodeVersion, "runtime.nodeVersion", 64) },
    protocols,
    catalog: { schema: catalog.schema, fingerprint: sha256(catalog.fingerprint, "runtime probe catalog fingerprint"), descriptorCount: boundedInteger(catalog.descriptorCount, "runtime probe catalog descriptorCount", 1, 256) },
    provenance: { execution: provenance.execution, managedDistribution: "unmanaged", distributionQualification: "unverified", cleanHostQualification: "unverified" }
  };
}

export function parseMotionCapabilityCatalog(value: unknown): ParsedMotionCapabilityCatalog {
  const record = closedRecord(value, ["schema", "protocol", "integrationCapabilities", "resources", "descriptors", "fingerprint"], "Capability catalog");
  if (record.schema !== MOTION_CAPABILITY_CATALOG_SCHEMA_V1 && record.schema !== MOTION_CAPABILITY_CATALOG_SCHEMA) throw new Error("Unsupported capability catalog schema.");
  const schema = record.schema;
  const resources = array(record.resources, "catalog documentation resources", 1, 64).map(parseMotionDocumentationResource);
  const descriptors = array(record.descriptors, "catalog descriptors", 1, 256).map(parseConnectorCapabilityDescriptor);
  if (descriptors.some((descriptor) => schema === MOTION_CAPABILITY_CATALOG_SCHEMA ? descriptor.schema !== MOTION_CAPABILITY_DESCRIPTOR_SCHEMA : descriptor.schema !== MOTION_CAPABILITY_DESCRIPTOR_SCHEMA_V1)) throw new Error("Capability catalog and descriptor schema versions must match.");
  assertSortedUnique(resources.map((resource) => resource.id), "catalog documentation resources");
  assertSortedUnique(descriptors.map((descriptor) => descriptor.id), "catalog descriptors");
  for (const descriptor of descriptors) {
    const resource = resources.find((candidate) => candidate.id === descriptor.documentation.resource);
    if (!resource || resource.fingerprint !== descriptor.documentation.resourceFingerprint) throw new Error(`Capability descriptor documentation resource is unknown or does not match its resource fingerprint: ${descriptor.id}.`);
  }
  const integrationCapabilities = parseIntegrationCapabilities(record.integrationCapabilities);
  validateDescriptorRequirements(descriptors, integrationCapabilities);
  if (schema === MOTION_CAPABILITY_CATALOG_SCHEMA) {
    const catalog: MotionCapabilityCatalog = {
      schema: MOTION_CAPABILITY_CATALOG_SCHEMA, protocol: protocolTwo(record.protocol, "catalog protocol"), integrationCapabilities, resources,
      descriptors: descriptors as ConnectorCapabilityDescriptor[], fingerprint: sha256(record.fingerprint, "catalog fingerprint")
    };
    if (catalog.fingerprint !== capabilityCatalogFingerprint(catalog)) throw new Error("Capability catalog fingerprint does not match its canonical content.");
    return catalog;
  }
  const catalog: MotionCapabilityCatalogV1 = {
    schema: MOTION_CAPABILITY_CATALOG_SCHEMA_V1, protocol: protocolOne(record.protocol, "catalog protocol"), integrationCapabilities, resources,
    descriptors: descriptors as ConnectorCapabilityDescriptorV1[], fingerprint: sha256(record.fingerprint, "catalog fingerprint")
  };
  if (catalog.fingerprint !== capabilityCatalogFingerprint(catalog)) throw new Error("Capability catalog fingerprint does not match its canonical content.");
  return catalog;
}

export function parseConnectorCapabilityDescriptor(value: unknown): ParsedConnectorCapabilityDescriptor {
  const record = closedRecord(value, ["schema", "id", "revision", "fingerprint", "title", "summary", "category", "documentation", "availability", "request", "invocation", "outputs", "requirements"], "Capability descriptor");
  if (record.schema !== MOTION_CAPABILITY_DESCRIPTOR_SCHEMA_V1 && record.schema !== MOTION_CAPABILITY_DESCRIPTOR_SCHEMA) throw new Error("Unsupported capability descriptor schema.");
  const documentation = closedRecord(record.documentation, ["resource", "anchor", "resourceFingerprint"], "descriptor documentation");
  const availability = closedRecord(record.availability, ["state", "reason", "platforms", "execution"], "descriptor availability");
  const invocation = closedRecord(record.invocation, ["schema", "model", "admission", "jobControls"], "descriptor invocation");
  const outputs = array(record.outputs, "descriptor outputs", 0, 8).map(parseOutput);
  assertSortedUnique(outputs.map((output) => output.role), "descriptor outputs");
  if ((availability.state === "refused" && outputs.length !== 0) || (availability.state !== "refused" && outputs.length === 0)) throw new Error("Capability descriptor outputs do not match its availability state.");
  const requirements = closedRecord(record.requirements, ["integrationModes", "integrationFeatures", "permissionTier"], "descriptor requirements");
  const common = {
    id: capabilityId(record.id, "descriptor id"), revision: boundedInteger(record.revision, "descriptor revision", 1, 1_000_000), fingerprint: sha256(record.fingerprint, "descriptor fingerprint"),
    title: boundedString(record.title, "descriptor title", 128), summary: boundedString(record.summary, "descriptor summary", 320), category: category(record.category),
    documentation: { resource: identifier(documentation.resource, "descriptor documentation resource"), anchor: documentationAnchor(documentation.anchor), resourceFingerprint: sha256(documentation.resourceFingerprint, "descriptor documentation resourceFingerprint") },
    request: parseConnectorRequestSchema(record.request), outputs,
    requirements: { integrationModes: sortedIdentifierArray(requirements.integrationModes, "descriptor integrationModes", 8), integrationFeatures: sortedIdentifierArray(requirements.integrationFeatures, "descriptor integrationFeatures", 8) }
  };
  const descriptor = record.schema === MOTION_CAPABILITY_DESCRIPTOR_SCHEMA
    ? parseV2Descriptor(common, availability, invocation, requirements.permissionTier)
    : parseV1Descriptor(common, availability, invocation, requirements.permissionTier);
  if (descriptor.fingerprint !== capabilityDescriptorFingerprint(descriptor)) throw new Error("Capability descriptor fingerprint does not match its canonical content.");
  return descriptor;
}

type DescriptorCommon = {
  id: string; revision: number; fingerprint: string; title: string; summary: string; category: ConnectorCapabilityDescriptor["category"];
  documentation: ConnectorCapabilityDescriptor["documentation"]; request: ConnectorRequestSchema; outputs: ConnectorOutput[];
  requirements: { integrationModes: string[]; integrationFeatures: string[] };
};

function parseV1Descriptor(common: DescriptorCommon, availabilityValue: Record<string, unknown>, invocation: Record<string, unknown>, permissionTier: unknown): ConnectorCapabilityDescriptorV1 {
  if ((availabilityValue.state !== "conditional" && availabilityValue.state !== "compatibility-only" && availabilityValue.state !== "refused")
    || (availabilityValue.execution !== "named-cli-compatibility-only" && availabilityValue.execution !== "not-admitted")
    || (availabilityValue.state === "refused" ? availabilityValue.execution !== "not-admitted" : availabilityValue.execution !== "named-cli-compatibility-only")) throw new Error("Historical capability descriptor availability and execution states are inconsistent.");
  if (invocation.schema !== MOTION_CONNECTOR_JOB_SCHEMA_V1 || invocation.model !== "fixed-generic-connector-job" || invocation.admission !== "not-admitted") throw new Error("Historical capability descriptor must use the fixed unadmitted connector-job model.");
  const controls = array(invocation.jobControls, "descriptor invocation jobControls", 0, 0);
  if (permissionTier !== "write_local") throw new Error("Historical capability descriptor permission tier must be write_local.");
  return {
    schema: MOTION_CAPABILITY_DESCRIPTOR_SCHEMA_V1, ...common,
    availability: { state: availabilityValue.state, reason: boundedString(availabilityValue.reason, "descriptor availability reason", 320), platforms: platformArray(availabilityValue.platforms, "descriptor availability platforms"), execution: availabilityValue.execution },
    invocation: { schema: MOTION_CONNECTOR_JOB_SCHEMA_V1, model: "fixed-generic-connector-job", admission: "not-admitted", jobControls: controls as [] },
    requirements: { ...common.requirements, permissionTier: "write_local" }
  } as ConnectorCapabilityDescriptorV1;
}

function parseV2Descriptor(common: DescriptorCommon, availabilityValue: Record<string, unknown>, invocation: Record<string, unknown>, permissionTier: unknown): ConnectorCapabilityDescriptor {
  if ((availabilityValue.state !== "conditional" && availabilityValue.state !== "compatibility-only" && availabilityValue.state !== "refused")
    || (availabilityValue.execution !== "generic-connector-job" && availabilityValue.execution !== "named-cli-compatibility-only" && availabilityValue.execution !== "not-admitted")) throw new Error("Capability descriptor availability and execution states are invalid.");
  if (invocation.schema !== MOTION_CONNECTOR_JOB_SCHEMA || invocation.model !== "fixed-generic-connector-job"
    || (invocation.admission !== "admitted" && invocation.admission !== "compatibility-only" && invocation.admission !== "not-admitted")) throw new Error("Capability descriptor connector-job v2 invocation is invalid.");
  const controls = parseJobControls(invocation.jobControls);
  const availability = { state: availabilityValue.state, reason: boundedString(availabilityValue.reason, "descriptor availability reason", 320), platforms: platformArray(availabilityValue.platforms, "descriptor availability platforms"), execution: availabilityValue.execution };
  if (availability.state === "conditional") {
    if (availability.execution !== "generic-connector-job" || invocation.admission !== "admitted" || !sameStrings(controls, GENERIC_JOB_CONTROLS) || permissionTier !== "render_motion") throw new Error("Conditional capability descriptors require admitted generic connector-job execution, stable controls, and render_motion permission.");
    return {
      schema: MOTION_CAPABILITY_DESCRIPTOR_SCHEMA, ...common,
      availability: { ...availability, state: "conditional", execution: "generic-connector-job" },
      invocation: { schema: MOTION_CONNECTOR_JOB_SCHEMA, model: "fixed-generic-connector-job", admission: "admitted", jobControls: controls },
      requirements: { ...common.requirements, permissionTier: "render_motion" }
    };
  }
  if (availability.state === "compatibility-only") {
    if (availability.execution !== "named-cli-compatibility-only" || invocation.admission !== "compatibility-only" || controls.length !== 0 || permissionTier !== "write_local") throw new Error("Compatibility-only capability descriptors require named CLI compatibility invocation and write_local permission.");
    return {
      schema: MOTION_CAPABILITY_DESCRIPTOR_SCHEMA, ...common,
      availability: { ...availability, state: "compatibility-only", execution: "named-cli-compatibility-only" },
      invocation: { schema: MOTION_CONNECTOR_JOB_SCHEMA, model: "fixed-generic-connector-job", admission: "compatibility-only", jobControls: [] },
      requirements: { ...common.requirements, permissionTier: "write_local" }
    };
  }
  if (availability.execution !== "not-admitted" || invocation.admission !== "not-admitted" || controls.length !== 0 || permissionTier !== "write_local") throw new Error("Refused capability descriptors require not-admitted execution and write_local permission.");
  return {
    schema: MOTION_CAPABILITY_DESCRIPTOR_SCHEMA, ...common,
    availability: { ...availability, state: "refused", execution: "not-admitted" },
    invocation: { schema: MOTION_CONNECTOR_JOB_SCHEMA, model: "fixed-generic-connector-job", admission: "not-admitted", jobControls: [] },
    requirements: { ...common.requirements, permissionTier: "write_local" }
  };
}

export function parseConnectorRequestSchema(value: unknown): ConnectorRequestSchema {
  const record = closedRecord(value, ["schema", "id", "maxBytes", "fields"], "Connector request schema");
  if (record.schema !== MOTION_CONNECTOR_REQUEST_SCHEMA) throw new Error("Unsupported connector request schema.");
  const fields = array(record.fields, "connector request fields", 0, 16).map(parseRequestField);
  assertSortedUnique(fields.map((field) => field.id), "connector request fields");
  return { schema: MOTION_CONNECTOR_REQUEST_SCHEMA, id: schemaId(record.id, "connector request schema id"), maxBytes: boundedInteger(record.maxBytes, "connector request maxBytes", 1, 65_536), fields };
}

export function parseMotionDocumentationResource(value: unknown): MotionDocumentationResource {
  const record = closedRecord(value, ["schema", "id", "revision", "fingerprint"], "Documentation resource");
  if (record.schema !== "shellx-motion/docs-resource@1") throw new Error("Unsupported documentation resource schema.");
  const resource: MotionDocumentationResource = { schema: "shellx-motion/docs-resource@1", id: identifier(record.id, "documentation resource id"), revision: boundedInteger(record.revision, "documentation resource revision", 1, 1_000_000), fingerprint: sha256(record.fingerprint, "documentation resource fingerprint") };
  if (resource.fingerprint !== documentationResourceFingerprint(resource)) throw new Error("Documentation resource fingerprint does not match its canonical content.");
  return resource;
}

/** Generic, side-effect-free reference-consumer preparation with no operation-id branch. */
export function prepareGenericConnectorRequest(catalogValue: unknown, capabilityId: string, requestValue: unknown): GenericConnectorRequestPreparation {
  const catalog = parseMotionCapabilityCatalog(catalogValue);
  if (catalog.schema !== MOTION_CAPABILITY_CATALOG_SCHEMA) throw new Error("Generic connector requests require capability catalog @2.");
  const descriptor = catalog.descriptors.find((candidate) => candidate.id === capabilityId);
  if (!descriptor) throw new Error(`Capability descriptor is unknown: ${capabilityId}.`);
  if (descriptor.availability.execution !== "generic-connector-job" || descriptor.invocation.admission !== "admitted") throw new Error(`Capability descriptor is not admitted for generic connector jobs: ${capabilityId}.`);
  return { capabilityId: descriptor.id, descriptorRevision: descriptor.revision, descriptorFingerprint: descriptor.fingerprint, requestSchemaId: descriptor.request.id, request: validateConnectorRequest(descriptor.request, requestValue) };
}

export function validateConnectorRequest(schemaValue: unknown, requestValue: unknown): Record<string, unknown> {
  const schema = parseConnectorRequestSchema(schemaValue);
  const request = closedRecord(requestValue, schema.fields.map((field) => field.id), "Connector request");
  for (const field of schema.fields) {
    const value = request[field.id];
    if (value === undefined) { if (field.required) throw new Error(`Connector request requires field '${field.id}'.`); continue; }
    validateRequestField(field, value);
  }
  if (new TextEncoder().encode(canonicalJson(request)).byteLength > schema.maxBytes) throw new Error(`Connector request exceeds its canonical UTF-8 byte limit of ${schema.maxBytes}.`);
  return structuredClone(request);
}

export function capabilityDescriptorFingerprint(value: Omit<ParsedConnectorCapabilityDescriptor, "fingerprint"> | ParsedConnectorCapabilityDescriptor): string { const { fingerprint: _fingerprint, ...content } = value as ParsedConnectorCapabilityDescriptor; return canonicalJsonSha256(content); }
export function capabilityCatalogFingerprint(value: Omit<ParsedMotionCapabilityCatalog, "fingerprint"> | ParsedMotionCapabilityCatalog): string { const { fingerprint: _fingerprint, ...content } = value as ParsedMotionCapabilityCatalog; return canonicalJsonSha256(content); }
export function documentationResourceFingerprint(value: Omit<MotionDocumentationResource, "fingerprint"> | MotionDocumentationResource): string { const { fingerprint: _fingerprint, ...content } = value as MotionDocumentationResource; return canonicalJsonSha256(content); }

function parseRequestField(value: unknown): ConnectorRequestField {
  const record = allowedRecord(value, ["id", "type", "required", "maxLength", "minimum", "maximum", "values"], "connector request field");
  for (const key of ["id", "type", "required"]) if (!(key in record)) throw new Error(`connector request field requires field '${key}'.`);
  const type = record.type;
  if (type !== "boolean" && type !== "enum" && type !== "integer" && type !== "opaque-reference" && type !== "string") throw new Error("Connector request field type is invalid.");
  if (typeof record.required !== "boolean") throw new Error("Connector request field required must be boolean.");
  const field: ConnectorRequestField = { id: identifier(record.id, "connector request field id"), type, required: record.required };
  if (type === "string" || type === "opaque-reference") field.maxLength = boundedInteger(record.maxLength, "connector request field maxLength", 1, 1024); else if (record.maxLength !== undefined) throw new Error("Connector request field maxLength is only valid for string fields.");
  if (type === "integer") { field.minimum = boundedInteger(record.minimum, "connector request field minimum", -1_000_000, 1_000_000); field.maximum = boundedInteger(record.maximum, "connector request field maximum", field.minimum, 1_000_000); } else if (record.minimum !== undefined || record.maximum !== undefined) throw new Error("Connector request field bounds are only valid for integer fields.");
  if (type === "enum") field.values = sortedIdentifierArray(record.values, "connector request field values", 16); else if (record.values !== undefined) throw new Error("Connector request field values are only valid for enum fields.");
  return field;
}

function parseOutput(value: unknown): ConnectorOutput {
  const record = closedRecord(value, ["role", "mediaKinds", "schemas"], "descriptor output");
  const role = record.role;
  if (role !== "artifact_handle" && role !== "canvas_frame_selection" && role !== "cut_import_plan" && role !== "motion_package" && role !== "receipt" && role !== "rendered_media") throw new Error("Capability descriptor output role is invalid.");
  return { role, mediaKinds: sortedBoundedStrings(record.mediaKinds, "descriptor output mediaKinds", 8, 128), schemas: sortedSchemaArray(record.schemas, "descriptor output schemas", 8) };
}

function validateRequestField(field: ConnectorRequestField, value: unknown): void {
  if (field.type === "boolean" && typeof value !== "boolean") throw new Error(`Connector request field '${field.id}' must be boolean.`);
  if ((field.type === "string" || field.type === "opaque-reference") && (typeof value !== "string" || Array.from(value).length === 0 || Array.from(value).length > field.maxLength!)) throw new Error(`Connector request field '${field.id}' must be a bounded non-empty string.`);
  if (field.type === "opaque-reference" && !OPAQUE_REFERENCE.test(value as string)) throw new Error(`Connector request field '${field.id}' must be an opaque reference, not a path or URL.`);
  if (field.type === "integer" && (!Number.isSafeInteger(value) || Number(value) < field.minimum! || Number(value) > field.maximum!)) throw new Error(`Connector request field '${field.id}' is outside its integer bounds.`);
  if (field.type === "enum" && (typeof value !== "string" || !field.values!.includes(value))) throw new Error(`Connector request field '${field.id}' has an unsupported value.`);
}

function validateDescriptorRequirements(descriptors: ParsedConnectorCapabilityDescriptor[], integration: ShellXIntegrationCapabilities): void {
  const modes = new Set(integration.modes), features = new Set(integration.features);
  for (const descriptor of descriptors) {
    for (const mode of descriptor.requirements.integrationModes) if (!modes.has(mode)) throw new Error(`Capability descriptor requires unadvertised integration mode '${mode}': ${descriptor.id}.`);
    for (const feature of descriptor.requirements.integrationFeatures) if (!features.has(feature)) throw new Error(`Capability descriptor requires unadvertised integration feature '${feature}': ${descriptor.id}.`);
  }
}

function parseJobControls(value: unknown): ConnectorJobControl[] {
  const controls = array(value, "descriptor invocation jobControls", 0, GENERIC_JOB_CONTROLS.length).map((control) => {
    if (control !== "cancel" && control !== "events" && control !== "get" && control !== "list" && control !== "retry") throw new Error("Capability descriptor connector-job control is invalid.");
    return control;
  });
  assertSortedUnique(controls, "descriptor invocation jobControls");
  return controls;
}
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function protocolOneToTwo(): ProtocolOneToTwo { return { min: 1, max: 2, preferred: 2 }; }
function isProtocolOne(value: ProtocolOne | ProtocolOneToTwo): value is ProtocolOne { return value.max === 1 && value.preferred === 1; }
function isProtocolOneToTwo(value: ProtocolOne | ProtocolOneToTwo): value is ProtocolOneToTwo { return value.max === 2 && value.preferred === 2; }
function protocolSet(value: unknown, field: string): MotionRuntimeProbe["protocols"] { const record = closedRecord(value, ["integration", "capabilityCatalog", "connectorJob"], field); return { integration: protocolOne(record.integration, `${field}.integration`), capabilityCatalog: protocolOneOrTwo(record.capabilityCatalog, `${field}.capabilityCatalog`), connectorJob: protocolOneOrTwo(record.connectorJob, `${field}.connectorJob`) }; }
function protocolOne(value: unknown, field: string): ProtocolOne;
function protocolOne(): ProtocolOne;
function protocolOne(value?: unknown, field?: string): ProtocolOne { if (arguments.length === 0) return { min: 1, max: 1, preferred: 1 }; const record = closedRecord(value, ["min", "max", "preferred"], field!); if (record.min !== 1 || record.max !== 1 || record.preferred !== 1) throw new Error(`${field} must be protocol range 1 only.`); return { min: 1, max: 1, preferred: 1 }; }
function protocolTwo(value: unknown, field: string): { min: 2; max: 2; preferred: 2 } { const record = closedRecord(value, ["min", "max", "preferred"], field); if (record.min !== 2 || record.max !== 2 || record.preferred !== 2) throw new Error(`${field} must be protocol range 2 only.`); return { min: 2, max: 2, preferred: 2 }; }
function protocolOneOrTwo(value: unknown, field: string): ProtocolOne | ProtocolOneToTwo { const record = closedRecord(value, ["min", "max", "preferred"], field); if (record.min !== 1 || (record.max !== 1 && record.max !== 2) || record.preferred !== record.max) throw new Error(`${field} must be protocol range 1 only or 1 through 2 with preferred 2.`); return record.max === 1 ? protocolOne() : protocolOneToTwo(); }
function namedVersion<T extends "@shellx-motion/core" | "@shellx-motion/cli">(value: unknown, field: string, expectedName: T): { name: T; version: string } { const record = closedRecord(value, ["name", "version"], field); if (record.name !== expectedName) throw new Error(`${field} name is invalid.`); return { name: expectedName, version: requiredVersion(record.version, field) }; }
function runtimeExecution(value: unknown): "source" | "packed" { if (value === "source" || value === "packed") return value; throw new Error("Runtime probe execution must be source or packed."); }
function platformName(value: unknown, field: string): "darwin" | "linux" | "win32" { if (value === "darwin" || value === "linux" || value === "win32") return value; throw new Error(`${field} must be darwin, linux, or win32.`); }
function platformArray(value: unknown, field: string): Array<"darwin" | "linux" | "win32"> { const values = array(value, field, 1, 3).map((entry) => platformName(entry, field)); assertSortedUnique(values, field); return values; }
function category(value: unknown): ConnectorCapabilityDescriptor["category"] { if (value === "cut-handoff" || value === "host-bridge" || value === "render-export" || value === "scene-orchestration") return value; throw new Error("Capability descriptor category is invalid."); }
function sortedIdentifierArray(value: unknown, field: string, maxItems: number): string[] { return sortedBoundedStrings(value, field, maxItems, 128).map((entry) => identifier(entry, field)); }
function sortedSchemaArray(value: unknown, field: string, maxItems: number): string[] { return sortedBoundedStrings(value, field, maxItems, 192).map((entry) => schemaId(entry, field)); }
function sortedBoundedStrings(value: unknown, field: string, maxItems: number, maxLength: number): string[] { const values = array(value, field, 0, maxItems).map((entry) => boundedString(entry, field, maxLength)); assertSortedUnique(values, field); return values; }
function identifier(value: unknown, field: string): string { const text = boundedString(value, field, 128); if (!IDENTIFIER.test(text)) throw new Error(`${field} must be a bounded lowercase identifier.`); return text; }
function documentationAnchor(value: unknown): string { const text = boundedString(value, "descriptor documentation anchor", 128); if (!/^[a-z][a-z0-9-]{0,127}$/.test(text)) throw new Error("descriptor documentation anchor must be a bounded anchor token."); return text; }
function capabilityId(value: unknown, field: string): string { const text = boundedString(value, field, 128); if (!CAPABILITY_ID.test(text)) throw new Error(`${field} must be a versioned capability id.`); return text; }
function schemaId(value: unknown, field: string): string { const text = boundedString(value, field, 192); if (!SCHEMA_ID.test(text)) throw new Error(`${field} must be a versioned schema id.`); return text; }
function sha256(value: unknown, field: string): string { const text = boundedString(value, field, 64); if (!SHA256.test(text)) throw new Error(`${field} must be lowercase SHA-256 hex.`); return text; }
function requiredVersion(value: unknown, field: string): string { const version = boundedString(value, `${field} version`, 64); if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`${field} version must be semver-shaped.`); return version; }
function boundedString(value: unknown, field: string, maxLength: number): string { if (typeof value !== "string" || Array.from(value).length === 0 || Array.from(value).length > maxLength) throw new Error(`${field} must be a non-empty string of at most ${maxLength} characters.`); return value; }
function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${field} must be an integer between ${minimum} and ${maximum}.`); return Number(value); }
function array(value: unknown, field: string, minimum: number, maximum: number): unknown[] { if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`${field} must contain ${minimum} to ${maximum} item(s).`); return value; }
function closedRecord(value: unknown, keys: readonly string[], field: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`); const record = value as Record<string, unknown>; const unexpected = Object.keys(record).find((key) => !keys.includes(key)); if (unexpected) throw new Error(`${field} contains unknown field '${unexpected}'.`); const missing = keys.find((key) => !(key in record)); if (missing) throw new Error(`${field} requires field '${missing}'.`); return record; }
function allowedRecord(value: unknown, keys: readonly string[], field: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`); const record = value as Record<string, unknown>; const unexpected = Object.keys(record).find((key) => !keys.includes(key)); if (unexpected) throw new Error(`${field} contains unknown field '${unexpected}'.`); return record; }
function assertSortedUnique(values: string[], field: string): void { if (new Set(values).size !== values.length) throw new Error(`${field} must not contain duplicates.`); for (let index = 1; index < values.length; index += 1) if (compareCodeUnits(values[index - 1]!, values[index]!) >= 0) throw new Error(`${field} must be sorted by code-unit order.`); }
