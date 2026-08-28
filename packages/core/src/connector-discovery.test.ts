import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  capabilityCatalogFingerprint,
  capabilityDescriptorFingerprint,
  motionCapabilityCatalog,
  motionRuntimeProbe,
  parseMotionCapabilityCatalog,
  parseMotionRuntimeProbe,
  prepareGenericConnectorRequest,
  validateConnectorRequest
} from "./connector-discovery";
import { CURRENT_DOCUMENTATION_RESOURCES } from "./connector-discovery-catalog";
import { validateAgainstPublishedSchema } from "./published-schema-check";

describe("MCI-2 self-describing connector discovery", () => {
  it("creates one canonical, closed protocol @2 catalog with admitted P2 generic-job truth", () => {
    const first = motionCapabilityCatalog();
    const second = motionCapabilityCatalog();
    expect(first).toEqual(second);
    expect(first.descriptors.map((descriptor) => descriptor.id)).toEqual([...first.descriptors.map((descriptor) => descriptor.id)].sort());
    for (const descriptor of first.descriptors) {
      const roles = descriptor.outputs.map((output) => output.role);
      expect(roles).toEqual([...roles].sort());
      expect(new Set(roles).size).toBe(roles.length);
    }
    for (const id of ["connector.script-to-cut@1", "connector.source-to-cut@1", "connector.template-to-cut@1"]) {
      expect(first.descriptors.find((descriptor) => descriptor.id === id)).toMatchObject({
        schema: "shellx-motion/capability-descriptor@2",
        revision: 2,
        availability: { state: "conditional", platforms: ["linux"], execution: "generic-connector-job" },
        invocation: { schema: "shellx-motion/connector-job@2", admission: "admitted", jobControls: ["cancel", "events", "get", "list", "retry"] },
        requirements: { permissionTier: "render_motion" }
      });
    }
    expect(first.descriptors.find((descriptor) => descriptor.id === "connector.canvas-to-cut@1")).toMatchObject({
      schema: "shellx-motion/capability-descriptor@2",
      revision: 3,
      summary: expect.stringContaining("asset-free Canvas selections only"),
      availability: { state: "conditional", platforms: ["linux"], execution: "generic-connector-job" },
      invocation: { schema: "shellx-motion/connector-job@2", admission: "admitted", jobControls: ["cancel", "events", "get", "list", "retry"] },
      requirements: { permissionTier: "render_motion" }
    });
    expect(first.descriptors.find((descriptor) => descriptor.id === "connector.canvas-to-mp4@1")).toMatchObject({
      revision: 3,
      availability: { state: "compatibility-only", platforms: ["linux"], execution: "named-cli-compatibility-only" },
      invocation: { schema: "shellx-motion/connector-job@2", admission: "compatibility-only", jobControls: [] },
      requirements: { permissionTier: "write_local" }
    });
    expect(first.descriptors.find((descriptor) => descriptor.id === "connector.cut-generate-to-cut@1")).toMatchObject({
      revision: 3,
      availability: { state: "compatibility-only", platforms: ["linux"], execution: "named-cli-compatibility-only" },
      invocation: { schema: "shellx-motion/connector-job@2", admission: "compatibility-only", jobControls: [] },
      requirements: { permissionTier: "write_local" }
    });
    for (const id of ["cut.scene3d-handoff@1", "cut.c6-physics-handoff@1", "cut.c7-scene-orchestration-handoff@1"]) {
      expect(first.descriptors.find((descriptor) => descriptor.id === id)).toMatchObject({
        availability: { state: "refused", execution: "not-admitted" },
        invocation: { schema: "shellx-motion/connector-job@2", admission: "not-admitted", jobControls: [] },
        outputs: []
      });
    }
    expect(JSON.stringify(first)).not.toMatch(/(?:executable|argv|provider|https?:|callback|command)/i);
  });

  it("rejects invalid v2 availability, admission, controls, and permission pairings", () => {
    const catalog = structuredClone(motionCapabilityCatalog());
    const p2 = catalog.descriptors.find((descriptor) => descriptor.id === "connector.template-to-cut@1")!;
    p2.invocation.jobControls = ["events", "cancel", "get", "list", "retry"];
    p2.fingerprint = capabilityDescriptorFingerprint(p2);
    catalog.fingerprint = capabilityCatalogFingerprint(catalog);
    expect(() => parseMotionCapabilityCatalog(catalog)).toThrow("jobControls");

    const duplicateControls = structuredClone(motionCapabilityCatalog());
    const duplicateDescriptor = duplicateControls.descriptors.find((descriptor) => descriptor.id === "connector.template-to-cut@1")!;
    duplicateDescriptor.invocation.jobControls = ["cancel", "events", "get", "list", "list"];
    duplicateDescriptor.fingerprint = capabilityDescriptorFingerprint(duplicateDescriptor);
    duplicateControls.fingerprint = capabilityCatalogFingerprint(duplicateControls);
    expect(() => parseMotionCapabilityCatalog(duplicateControls)).toThrow("duplicates");

    const badPermission = structuredClone(motionCapabilityCatalog());
    const permissionDescriptor = badPermission.descriptors.find((descriptor) => descriptor.id === "connector.template-to-cut@1")!;
    permissionDescriptor.requirements.permissionTier = "write_local";
    permissionDescriptor.fingerprint = capabilityDescriptorFingerprint(permissionDescriptor);
    badPermission.fingerprint = capabilityCatalogFingerprint(badPermission);
    expect(() => parseMotionCapabilityCatalog(badPermission)).toThrow("render_motion");

    const badAvailability = structuredClone(motionCapabilityCatalog());
    const availabilityDescriptor = badAvailability.descriptors.find((descriptor) => descriptor.id === "connector.template-to-cut@1")!;
    availabilityDescriptor.availability.execution = "named-cli-compatibility-only" as never;
    availabilityDescriptor.fingerprint = capabilityDescriptorFingerprint(availabilityDescriptor);
    badAvailability.fingerprint = capabilityCatalogFingerprint(badAvailability);
    expect(() => parseMotionCapabilityCatalog(badAvailability)).toThrow("generic connector-job");

    const badCompatibility = structuredClone(motionCapabilityCatalog());
    const compatibilityDescriptor = badCompatibility.descriptors.find((descriptor) => descriptor.id === "connector.canvas-to-mp4@1")!;
    compatibilityDescriptor.invocation = { schema: "shellx-motion/connector-job@2", model: "fixed-generic-connector-job", admission: "not-admitted", jobControls: [] };
    compatibilityDescriptor.fingerprint = capabilityDescriptorFingerprint(compatibilityDescriptor);
    badCompatibility.fingerprint = capabilityCatalogFingerprint(badCompatibility);
    expect(() => parseMotionCapabilityCatalog(badCompatibility)).toThrow("Compatibility-only");
  });

  it("rejects unsorted descriptors, duplicate fields, forged fingerprints, and unbounded documentation references", () => {
    const catalog = structuredClone(motionCapabilityCatalog());
    catalog.descriptors.reverse();
    expect(() => parseMotionCapabilityCatalog(catalog)).toThrow("sorted");

    const forged = structuredClone(motionCapabilityCatalog());
    forged.descriptors[0]!.fingerprint = "0".repeat(64);
    forged.fingerprint = capabilityCatalogFingerprint(forged);
    expect(() => parseMotionCapabilityCatalog(forged)).toThrow("fingerprint");

    const badDocs = structuredClone(motionCapabilityCatalog());
    badDocs.descriptors[0]!.documentation.anchor = "../../not-a-resource";
    badDocs.descriptors[0]!.fingerprint = capabilityDescriptorFingerprint(badDocs.descriptors[0]!);
    badDocs.fingerprint = capabilityCatalogFingerprint(badDocs);
    expect(() => parseMotionCapabilityCatalog(badDocs)).toThrow("anchor");

    const duplicated = structuredClone(motionCapabilityCatalog());
    duplicated.descriptors[0]!.request.fields.push(structuredClone(duplicated.descriptors[0]!.request.fields[0]!));
    duplicated.descriptors[0]!.fingerprint = capabilityDescriptorFingerprint(duplicated.descriptors[0]!);
    duplicated.fingerprint = capabilityCatalogFingerprint(duplicated);
    expect(() => parseMotionCapabilityCatalog(duplicated)).toThrow("duplicates");

    const unsortedOutputs = structuredClone(motionCapabilityCatalog());
    const outputDescriptor = unsortedOutputs.descriptors.find((candidate) => candidate.id === "connector.canvas-bridge-export@1")!;
    outputDescriptor.outputs.reverse();
    outputDescriptor.fingerprint = capabilityDescriptorFingerprint(outputDescriptor);
    unsortedOutputs.fingerprint = capabilityCatalogFingerprint(unsortedOutputs);
    expect(() => parseMotionCapabilityCatalog(unsortedOutputs)).toThrow("descriptor outputs");

    const duplicateOutputs = structuredClone(motionCapabilityCatalog());
    const duplicateOutputDescriptor = duplicateOutputs.descriptors.find((candidate) => candidate.id === "connector.canvas-bridge-export@1")!;
    duplicateOutputDescriptor.outputs.push(structuredClone(duplicateOutputDescriptor.outputs[1]!));
    duplicateOutputDescriptor.fingerprint = capabilityDescriptorFingerprint(duplicateOutputDescriptor);
    duplicateOutputs.fingerprint = capabilityCatalogFingerprint(duplicateOutputs);
    expect(() => parseMotionCapabilityCatalog(duplicateOutputs)).toThrow("descriptor outputs");

    const forgedRequirements = structuredClone(motionCapabilityCatalog());
    const descriptor = forgedRequirements.descriptors[0]!;
    descriptor.requirements.integrationFeatures = ["future.unadvertised"];
    descriptor.fingerprint = capabilityDescriptorFingerprint(descriptor);
    forgedRequirements.fingerprint = capabilityCatalogFingerprint(forgedRequirements);
    expect(() => parseMotionCapabilityCatalog(forgedRequirements)).toThrow("unadvertised integration feature");
  });

  it("prepares a synthetic future capability through the generic consumer without an id branch", () => {
    const futureCapabilityId = "connector.future-render@1";
    const catalog = structuredClone(motionCapabilityCatalog());
    const descriptor = structuredClone(catalog.descriptors.find((candidate) => candidate.id === "connector.template-to-cut@1")!);
    descriptor.id = futureCapabilityId;
    descriptor.title = "Synthetic future render";
    descriptor.summary = "A fixture proving catalog-driven future capability preparation.";
    descriptor.request = {
      schema: "shellx-motion/connector-request-schema@1",
      id: "shellx-motion/connector-request/future-render@1",
      maxBytes: 256,
      fields: [
        { id: "output", type: "opaque-reference", required: true, maxLength: 32 },
        { id: "quality", type: "enum", required: true, values: ["balanced", "cinematic"] }
      ]
    };
    descriptor.fingerprint = capabilityDescriptorFingerprint(descriptor);
    catalog.descriptors.push(descriptor);
    catalog.descriptors.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    catalog.fingerprint = capabilityCatalogFingerprint(catalog);

    expect(prepareGenericConnectorRequest(catalog, futureCapabilityId, { output: "future-output", quality: "balanced" })).toEqual({
      capabilityId: futureCapabilityId,
      descriptorRevision: descriptor.revision,
      descriptorFingerprint: descriptor.fingerprint,
      requestSchemaId: "shellx-motion/connector-request/future-render@1",
      request: { output: "future-output", quality: "balanced" }
    });
    const consumerSource = readFileSync(fileURLToPath(new URL("./connector-discovery-parser.ts", import.meta.url)), "utf8");
    expect(consumerSource).not.toContain(futureCapabilityId);
  });

  it("keeps the closed historical @1 catalog parser available but refuses it for generic preparation", () => {
    const historical = structuredClone(motionCapabilityCatalog()) as any;
    historical.schema = "shellx-motion/capability-catalog@1";
    historical.protocol = { min: 1, max: 1, preferred: 1 };
    for (const descriptor of historical.descriptors) {
      descriptor.schema = "shellx-motion/capability-descriptor@1";
      descriptor.revision = 1;
      descriptor.invocation = { schema: "shellx-motion/connector-job@1", model: "fixed-generic-connector-job", admission: "not-admitted", jobControls: [] };
      descriptor.requirements.permissionTier = "write_local";
      if (descriptor.availability.state === "conditional") descriptor.availability.execution = "named-cli-compatibility-only";
      descriptor.fingerprint = capabilityDescriptorFingerprint(descriptor);
    }
    historical.fingerprint = capabilityCatalogFingerprint(historical);
    const historicalSchema = JSON.parse(readFileSync(fileURLToPath(new URL("../../../schemas/capability-catalog-v1.schema.json", import.meta.url)), "utf8"));
    const currentSchema = JSON.parse(readFileSync(fileURLToPath(new URL("../../../schemas/capability-catalog.schema.json", import.meta.url)), "utf8"));
    const integration = JSON.parse(readFileSync(fileURLToPath(new URL("../../../schemas/integration-capabilities.schema.json", import.meta.url)), "utf8"));
    const resolveIntegration = (ref: string) => ref === "integration-capabilities.schema.json" ? integration : undefined;
    expect(historicalSchema.$id).toBe("shellx-motion/capability-catalog@1");
    expect(validateAgainstPublishedSchema(historicalSchema, historical, resolveIntegration)).toEqual([]);
    expect(validateAgainstPublishedSchema(currentSchema, motionCapabilityCatalog(), resolveIntegration)).toEqual([]);
    expect(parseMotionCapabilityCatalog(historical)).toMatchObject({ schema: "shellx-motion/capability-catalog@1", protocol: { min: 1, max: 1, preferred: 1 } });
    expect(() => prepareGenericConnectorRequest(historical, "connector.template-to-cut@1", { input: "source", output: "target" })).toThrow("catalog @2");
  });

  it("enforces canonical UTF-8 request limits and opaque refs without admitting paths or URLs", () => {
    const request = {
      schema: "shellx-motion/connector-request-schema@1",
      id: "shellx-motion/connector-request/test@1",
      maxBytes: 20,
      fields: [{ id: "output", type: "opaque-reference", required: true, maxLength: 32 }]
    };
    expect(() => validateConnectorRequest(request, { output: "bounded-reference" })).toThrow("UTF-8 byte limit");
    for (const unsafe of ["relative/path", "relative\\path", "https://example.test/out", "C:\\output"]) {
      expect(() => validateConnectorRequest({ ...request, maxBytes: 256 }, { output: unsafe })).toThrow("opaque reference");
    }
  });

  it("reports supplied source facts as unqualified without exposing a path or distribution identity", () => {
    const probe = motionRuntimeProbe({
      engineVersion: "0.2.64",
      cliVersion: "0.2.64",
      execution: "source",
      platform: "linux",
      architecture: "x64",
      nodeVersion: "v24.0.0"
    });
    expect(parseMotionRuntimeProbe(probe)).toEqual(probe);
    expect(probe).toMatchObject({
      protocols: {
        integration: { min: 1, max: 1, preferred: 1 },
        capabilityCatalog: { min: 1, max: 2, preferred: 2 },
        connectorJob: { min: 1, max: 2, preferred: 2 }
      },
      catalog: { schema: "shellx-motion/capability-catalog@2" },
      provenance: { execution: "source", managedDistribution: "unmanaged", distributionQualification: "unverified", cleanHostQualification: "unverified" }
    });
    expect(JSON.stringify(probe)).not.toMatch(/(?:distributionId|payloadPath|launcherPath|\/home\/|C:\\\\)/);
    expect(() => motionRuntimeProbe({ ...probe.runtime, engineVersion: "0.2.64", cliVersion: "0.2.64", execution: "managed" as never })).toThrow("execution");
  });

  it("matches the published catalog schema and keeps the Core contract browser-neutral", () => {
    const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../../../schemas/capability-catalog.schema.json", import.meta.url)), "utf8"));
    const integration = JSON.parse(readFileSync(fileURLToPath(new URL("../../../schemas/integration-capabilities.schema.json", import.meta.url)), "utf8"));
    expect(validateAgainstPublishedSchema(schema, motionCapabilityCatalog(), (ref) => ref === "integration-capabilities.schema.json" ? integration : undefined)).toEqual([]);
    for (const sourceName of ["connector-discovery.ts", "connector-discovery-parser.ts", "connector-discovery-catalog.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(`./${sourceName}`, import.meta.url)), "utf8");
      expect(source).not.toContain("node:");
    }
  });

  it("maps every catalog documentation resource and anchor to shipped public Markdown without catalog paths", () => {
    const publicDocumentation = new Map([
      ["motion.cut-and-design-studio", "../../../docs/public/cut-and-design-studio.md"],
      ["motion.host-integration", "../../../docs/public/host-integration.md"]
    ]);
    expect([...CURRENT_DOCUMENTATION_RESOURCES].map((resource) => resource.id)).toEqual([...publicDocumentation.keys()]);
    const headings = new Map<string, Set<string>>();
    for (const resource of CURRENT_DOCUMENTATION_RESOURCES) {
      const relativePath = publicDocumentation.get(resource.id);
      expect(relativePath).toBeDefined();
      const markdown = readFileSync(fileURLToPath(new URL(relativePath!, import.meta.url)), "utf8");
      const slugs = new Set([...markdown.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)].map((match) => match[1]!.toLowerCase().replace(/[`*_]/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-")));
      headings.set(resource.id, slugs);
    }
    const catalog = motionCapabilityCatalog();
    for (const descriptor of catalog.descriptors) expect(headings.get(descriptor.documentation.resource)).toContain(descriptor.documentation.anchor);
    expect(JSON.stringify(catalog.resources)).not.toMatch(/(?:docs\/public|\.md)/);
  });

  it("keeps catalog growth bounded at 64 documentation resources and 256 descriptors", () => {
    const catalogSchema = JSON.parse(readFileSync(fileURLToPath(new URL("../../../schemas/capability-catalog.schema.json", import.meta.url)), "utf8"));
    const runtimeSchema = JSON.parse(readFileSync(fileURLToPath(new URL("../../../schemas/runtime-probe.schema.json", import.meta.url)), "utf8"));
    const integration = JSON.parse(readFileSync(fileURLToPath(new URL("../../../schemas/integration-capabilities.schema.json", import.meta.url)), "utf8"));
    const resolveIntegration = (ref: string) => ref === "integration-capabilities.schema.json" ? integration : undefined;

    const tooManyResources = structuredClone(motionCapabilityCatalog());
    tooManyResources.resources = Array.from({ length: 65 }, () => structuredClone(tooManyResources.resources[0]!));
    expect(validateAgainstPublishedSchema(catalogSchema, tooManyResources, resolveIntegration)).not.toEqual([]);
    expect(() => parseMotionCapabilityCatalog(tooManyResources)).toThrow("documentation resources");

    const tooManyDescriptors = structuredClone(motionCapabilityCatalog());
    tooManyDescriptors.descriptors = Array.from({ length: 257 }, () => structuredClone(tooManyDescriptors.descriptors[0]!));
    expect(validateAgainstPublishedSchema(catalogSchema, tooManyDescriptors, resolveIntegration)).not.toEqual([]);
    expect(() => parseMotionCapabilityCatalog(tooManyDescriptors)).toThrow("catalog descriptors");

    for (const descriptorCount of [0, 257]) {
      const probe = motionRuntimeProbe({ engineVersion: "0.2.64", cliVersion: "0.2.64", execution: "packed", platform: "linux", architecture: "x64", nodeVersion: "v24.0.0" });
      probe.catalog.descriptorCount = descriptorCount;
      expect(validateAgainstPublishedSchema(runtimeSchema, probe)).not.toEqual([]);
      expect(() => parseMotionRuntimeProbe(probe)).toThrow("descriptorCount");
    }
  });

  it("keeps published-schema conditionals aligned with the closed runtime parser", () => {
    const catalogSchema = JSON.parse(readFileSync(fileURLToPath(new URL("../../../schemas/capability-catalog.schema.json", import.meta.url)), "utf8"));
    const runtimeSchema = JSON.parse(readFileSync(fileURLToPath(new URL("../../../schemas/runtime-probe.schema.json", import.meta.url)), "utf8"));
    const integration = JSON.parse(readFileSync(fileURLToPath(new URL("../../../schemas/integration-capabilities.schema.json", import.meta.url)), "utf8"));
    const resolveIntegration = (ref: string) => ref === "integration-capabilities.schema.json" ? integration : undefined;

    const wrongFieldKind = structuredClone(motionCapabilityCatalog());
    wrongFieldKind.descriptors.find((descriptor) => descriptor.id === "connector.template-to-cut@1")!.request.fields[0]!.minimum = 0;
    wrongFieldKind.descriptors.find((descriptor) => descriptor.id === "connector.template-to-cut@1")!.fingerprint = capabilityDescriptorFingerprint(wrongFieldKind.descriptors.find((descriptor) => descriptor.id === "connector.template-to-cut@1")!);
    wrongFieldKind.fingerprint = capabilityCatalogFingerprint(wrongFieldKind);
    expect(validateAgainstPublishedSchema(catalogSchema, wrongFieldKind, resolveIntegration)).not.toEqual([]);
    expect(() => parseMotionCapabilityCatalog(wrongFieldKind)).toThrow("bounds");

    // JSON Schema cannot compare sibling integer values; the parser is the documented owner of
    // this deliberately stricter lower-bound-before-upper-bound invariant.
    const invertedBounds = structuredClone(motionCapabilityCatalog());
    const boundedDescriptor = invertedBounds.descriptors.find((descriptor) => descriptor.id === "connector.template-to-cut@1")!;
    boundedDescriptor.request.fields = [{ id: "count", type: "integer", required: true, minimum: 2, maximum: 1 }];
    boundedDescriptor.fingerprint = capabilityDescriptorFingerprint(boundedDescriptor);
    invertedBounds.fingerprint = capabilityCatalogFingerprint(invertedBounds);
    expect(validateAgainstPublishedSchema(catalogSchema, invertedBounds, resolveIntegration)).toEqual([]);
    expect(() => parseMotionCapabilityCatalog(invertedBounds)).toThrow("maximum");

    const refusedOutput = structuredClone(motionCapabilityCatalog());
    const refused = refusedOutput.descriptors.find((descriptor) => descriptor.id === "cut.scene3d-handoff@1")!;
    refused.outputs.push({ role: "receipt", mediaKinds: ["application/json"], schemas: ["shellx-motion/receipt@1"] });
    refused.fingerprint = capabilityDescriptorFingerprint(refused);
    refusedOutput.fingerprint = capabilityCatalogFingerprint(refusedOutput);
    expect(validateAgainstPublishedSchema(catalogSchema, refusedOutput, resolveIntegration)).not.toEqual([]);
    expect(() => parseMotionCapabilityCatalog(refusedOutput)).toThrow("outputs");

    const noDescriptors = structuredClone(motionCapabilityCatalog());
    noDescriptors.descriptors = [];
    noDescriptors.fingerprint = capabilityCatalogFingerprint(noDescriptors);
    expect(validateAgainstPublishedSchema(catalogSchema, noDescriptors, resolveIntegration)).not.toEqual([]);
    expect(() => parseMotionCapabilityCatalog(noDescriptors)).toThrow("catalog descriptors");

    const tooManyRequirements = structuredClone(motionCapabilityCatalog());
    const requirementDescriptor = tooManyRequirements.descriptors[0]!;
    requirementDescriptor.requirements.integrationModes = Array.from({ length: 9 }, (_, index) => `mode.${index}`);
    requirementDescriptor.fingerprint = capabilityDescriptorFingerprint(requirementDescriptor);
    tooManyRequirements.fingerprint = capabilityCatalogFingerprint(tooManyRequirements);
    expect(validateAgainstPublishedSchema(catalogSchema, tooManyRequirements, resolveIntegration)).not.toEqual([]);
    expect(() => parseMotionCapabilityCatalog(tooManyRequirements)).toThrow("integrationModes");

    const wrongPackage = motionRuntimeProbe({ engineVersion: "0.2.64", cliVersion: "0.2.64", execution: "packed", platform: "linux", architecture: "x64", nodeVersion: "v24.0.0" });
    wrongPackage.engine.name = "@shellx-motion/cli" as "@shellx-motion/core";
    expect(validateAgainstPublishedSchema(runtimeSchema, wrongPackage)).not.toEqual([]);
    expect(() => parseMotionRuntimeProbe(wrongPackage)).toThrow("name");
  });
});
