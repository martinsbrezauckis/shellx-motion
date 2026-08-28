import { compareCodeUnits } from "./canonical-json";
import { capabilityDescriptorFingerprint, documentationResourceFingerprint } from "./connector-discovery-parser";
import type { ConnectorCapabilityDescriptor, ConnectorRequestField, ConnectorRequestSchema, MotionDocumentationResource } from "./connector-discovery";

const DESCRIPTOR_SCHEMA = "shellx-motion/capability-descriptor@2" as const;
const REQUEST_SCHEMA = "shellx-motion/connector-request-schema@1" as const;
const JOB_SCHEMA = "shellx-motion/connector-job@2" as const;
const GENERIC_JOB_CONTROLS = ["cancel", "events", "get", "list", "retry"] as const;

function canonicalOutputs(outputs: readonly ConnectorCapabilityDescriptor["outputs"][number][]): ConnectorCapabilityDescriptor["outputs"] {
  const canonical = outputs.map((output) => ({ ...output, mediaKinds: [...output.mediaKinds], schemas: [...output.schemas] }));
  canonical.sort((left, right) => compareCodeUnits(left.role, right.role));
  if (new Set(canonical.map((output) => output.role)).size !== canonical.length) throw new Error("Static descriptor outputs must have unique roles.");
  return canonical;
}

function descriptor(input: Omit<ConnectorCapabilityDescriptor, "schema" | "fingerprint">): ConnectorCapabilityDescriptor {
  const content = { ...input, outputs: canonicalOutputs(input.outputs), schema: DESCRIPTOR_SCHEMA };
  return { ...content, fingerprint: capabilityDescriptorFingerprint(content) };
}

const P2_OUTPUTS = canonicalOutputs([
  { role: "artifact_handle" as const, mediaKinds: ["application/json"], schemas: ["shellx-motion/artifact-handle@1"] },
  { role: "cut_import_plan" as const, mediaKinds: ["application/json"], schemas: ["shellx-motion/cut-import-plan@1"] },
  { role: "receipt" as const, mediaKinds: ["application/json"], schemas: ["shellx-motion/receipt@1"] },
  { role: "rendered_media" as const, mediaKinds: ["video/mp4"], schemas: ["shellx-motion/artifact-handle-ref@1"] }
]);

export const CURRENT_DOCUMENTATION_RESOURCES: readonly MotionDocumentationResource[] = [
  documentationResource("motion.cut-and-design-studio"), documentationResource("motion.host-integration")
].sort((left, right) => compareCodeUnits(left.id, right.id));

function documentationResource(id: string): MotionDocumentationResource {
  const content = { schema: "shellx-motion/docs-resource@1" as const, id, revision: 1 };
  return { ...content, fingerprint: documentationResourceFingerprint(content) };
}

function documentation(resource: string, anchor: string): ConnectorCapabilityDescriptor["documentation"] {
  const document = CURRENT_DOCUMENTATION_RESOURCES.find((candidate) => candidate.id === resource);
  if (!document) throw new Error(`Unknown static documentation resource: ${resource}.`);
  return { resource: document.id, anchor, resourceFingerprint: document.fingerprint };
}

export const CURRENT_CONNECTOR_DESCRIPTORS: readonly ConnectorCapabilityDescriptor[] = [
  descriptor({
    id: "connector.canvas-bridge-export@1", revision: 2, title: "Canvas bridge export", summary: "Compatibility bridge from a Canvas frame selection to Motion data.", category: "host-bridge",
    documentation: documentation("motion.cut-and-design-studio", "connector-modes-into-cut"),
    availability: { state: "compatibility-only", reason: "Current named CLI compatibility route; it is not a generic connector-job admission.", platforms: ["darwin", "linux", "win32"], execution: "named-cli-compatibility-only" },
    request: requestSchema("shellx-motion/connector-request/canvas-bridge-export@1", [referenceField("input"), referenceField("output")]),
    outputs: [{ role: "canvas_frame_selection", mediaKinds: ["application/json"], schemas: ["shellx-motion/canvas-frame-selection@1"] }, { role: "receipt", mediaKinds: ["application/json"], schemas: ["shellx-motion/receipt@1"] }],
    invocation: compatibilityInvocation(), requirements: { integrationModes: ["canvas.bridge"], integrationFeatures: [], permissionTier: "write_local" }
  }),
  descriptor({
    id: "connector.canvas-to-mp4@1", revision: 3, title: "Canvas to MP4", summary: "Linux-only compatibility Canvas-to-MP4 export; its legacy dry-run semantics are not generic admission.", category: "render-export",
    documentation: documentation("motion.cut-and-design-studio", "connector-modes-into-cut"),
    availability: { state: "compatibility-only", reason: "Linux-only named CLI route requiring exact closed-tree package publication; generic submit is not admitted.", platforms: ["linux"], execution: "named-cli-compatibility-only" },
    request: requestSchema("shellx-motion/connector-request/canvas-to-mp4@1", [referenceField("input"), referenceField("output")]),
    outputs: [{ role: "receipt", mediaKinds: ["application/json"], schemas: ["shellx-motion/receipt@1"] }, { role: "rendered_media", mediaKinds: ["video/mp4"], schemas: ["shellx-motion/artifact-handle-ref@1"] }],
    invocation: compatibilityInvocation(), requirements: { integrationModes: ["render.final"], integrationFeatures: ["artifact.attestation"], permissionTier: "write_local" }
  }),
  p2Descriptor("connector.canvas-to-cut@1", "Canvas to Cut P2B", "Linux-only P2B Browser-to-FFmpeg H.264 rendered-media handoff.", "canvas-to-cut", "Linux-only P2B; requires an absent or empty output and produces real Browser-to-FFmpeg H.264 rendered media."),
  descriptor({
    id: "connector.cut-generate-to-cut@1", revision: 3, title: "Cut Generate to Cut", summary: "Linux-only legacy named compatibility handoff retained without generic connector-job admission.", category: "cut-handoff",
    documentation: documentation("motion.cut-and-design-studio", "connector-modes-into-cut"),
    availability: { state: "compatibility-only", reason: "Linux-only pre-P2B facade requiring exact closed-tree scripted-package publication; generic submit is not admitted.", platforms: ["linux"], execution: "named-cli-compatibility-only" },
    request: requestSchema("shellx-motion/connector-request/cut-generate-to-cut@1", [referenceField("input"), referenceField("output")]), outputs: P2_OUTPUTS,
    invocation: compatibilityInvocation(), requirements: { integrationModes: ["cut.import.plan"], integrationFeatures: ["artifact.attestation"], permissionTier: "write_local" }
  }),
  p2Descriptor("connector.script-to-cut@1", "Script to Cut P2B", "Linux-only P2B Browser-to-FFmpeg H.264 rendered-media handoff from scripted-video evidence.", "script-to-cut", "Linux-only P2B; real Browser-to-FFmpeg H.264 rendered media only, with no dry-run or alternate lane."),
  p2Descriptor("connector.source-to-cut@1", "Source to Cut P2B", "Linux-only P2B Browser-to-FFmpeg H.264 rendered-media handoff from source-import evidence.", "source-to-cut", "Linux-only P2B; real Browser-to-FFmpeg H.264 rendered media only, with source input retained as evidence."),
  p2Descriptor("connector.template-to-cut@1", "Template to Cut P2A", "Linux-only P2A Browser-to-FFmpeg H.264 rendered-media handoff for admitted templates.", "template-to-cut", "Linux-only P2A; real Browser-to-FFmpeg H.264 rendered media to an absent or empty output only."),
  refusedDescriptor("cut.scene3d-handoff@1", "Scene3D Cut handoff", "Scene3D is visible for planning but has no admitted Cut connector route.", "Current Scene3D/Cut admission is refused; discovery does not authorize execution."),
  refusedDescriptor("cut.c6-physics-handoff@1", "C6 physics Cut handoff", "C6 physics remains outside current Cut connector admission.", "Current C6/Cut admission is refused; discovery does not authorize execution."),
  refusedDescriptor("cut.c7-scene-orchestration-handoff@1", "C7 scene orchestration Cut handoff", "C7 scene orchestration remains outside current Cut connector admission.", "Current C7/Cut admission is refused; discovery does not authorize execution.")
].sort((left, right) => compareCodeUnits(left.id, right.id));

function p2Descriptor(id: string, title: string, summary: string, route: string, reason: string): ConnectorCapabilityDescriptor {
  return descriptor({
    id, revision: 2, title, summary, category: "cut-handoff", documentation: documentation("motion.cut-and-design-studio", "template-to-cut-and-p2b-canvas-script-and-source-to-cut"),
    availability: { state: "conditional", reason, platforms: ["linux"], execution: "generic-connector-job" },
    request: requestSchema(`shellx-motion/connector-request/${route}@1`, [referenceField("input"), referenceField("output")]), outputs: P2_OUTPUTS,
    invocation: admittedInvocation(), requirements: { integrationModes: ["cut.import.plan"], integrationFeatures: ["artifact.attestation"], permissionTier: "render_motion" }
  });
}

function refusedDescriptor(id: string, title: string, summary: string, reason: string): ConnectorCapabilityDescriptor {
  return descriptor({
    id, revision: 2, title, summary, category: "scene-orchestration", documentation: documentation("motion.host-integration", "self-describing-connector-discovery-and-generic-jobs"),
    availability: { state: "refused", reason, platforms: ["darwin", "linux", "win32"], execution: "not-admitted" },
    request: requestSchema(`shellx-motion/connector-request/${id.replace("cut.", "")}`, []), outputs: [],
    invocation: refusedInvocation(), requirements: { integrationModes: ["cut.import.plan"], integrationFeatures: [], permissionTier: "write_local" }
  });
}

function requestSchema(id: string, fields: ConnectorRequestField[]): ConnectorRequestSchema {
  return { schema: REQUEST_SCHEMA, id, maxBytes: 65_536, fields: [...fields].sort((left, right) => compareCodeUnits(left.id, right.id)) };
}

function referenceField(id: string): ConnectorRequestField {
  return { id, type: "opaque-reference", required: true, maxLength: 128 };
}

function admittedInvocation(): ConnectorCapabilityDescriptor["invocation"] {
  return { schema: JOB_SCHEMA, model: "fixed-generic-connector-job", admission: "admitted", jobControls: [...GENERIC_JOB_CONTROLS] };
}

function compatibilityInvocation(): ConnectorCapabilityDescriptor["invocation"] {
  return { schema: JOB_SCHEMA, model: "fixed-generic-connector-job", admission: "compatibility-only", jobControls: [] };
}

function refusedInvocation(): ConnectorCapabilityDescriptor["invocation"] {
  return { schema: JOB_SCHEMA, model: "fixed-generic-connector-job", admission: "not-admitted", jobControls: [] };
}
