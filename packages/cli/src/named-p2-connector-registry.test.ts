import { beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({ prepare: vi.fn(), execute: vi.fn() }));
vi.mock("@shellx-motion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shellx-motion/core")>()),
  motionCapabilityCatalog: () => ({
    descriptors: [{
      id: "connector.template-to-cut@1",
      revision: 2,
      fingerprint: "a".repeat(64),
      request: { id: "shellx-motion/connector-request/template-to-cut@1" }
    }]
  })
}));
vi.mock("@shellx-motion/connectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shellx-motion/connectors")>()),
  prepareAdmittedMotionConnectorJob: registry.prepare,
  executePreparedMotionConnectorJob: registry.execute
}));

import { NamedConnectorRegistryError, runNamedP2ConnectorThroughRegistry } from "./named-p2-connector-registry";

describe("named P2 connector registry adapter", () => {
  beforeEach(() => {
    registry.prepare.mockReset();
    registry.execute.mockReset();
  });

  it("binds a named verb to the advertised descriptor and trusted opaque references", async () => {
    const prepared = { capabilityId: "connector.template-to-cut@1", operation: "connector.template-to-cut@1" };
    registry.prepare.mockReturnValue(prepared);
    registry.execute.mockResolvedValue({ ok: true, result: { ok: true, marker: "generic-registry" } });
    const signal = new AbortController().signal;

    await expect(runNamedP2ConnectorThroughRegistry({
      subcommand: "template-to-cut",
      inputPath: "/trusted/input",
      outputPath: "/trusted/output",
      signal,
      namedCompatibilityOptions: { values: { title: "Catalog driven" } }
    })).resolves.toMatchObject({ ok: true, marker: "generic-registry" });

    expect(registry.prepare).toHaveBeenCalledWith({
      capabilityId: "connector.template-to-cut@1",
      descriptorRevision: 2,
      descriptorFingerprint: "a".repeat(64),
      requestSchemaId: "shellx-motion/connector-request/template-to-cut@1",
      request: { input: "named_input", output: "named_output" }
    });
    const services = registry.execute.mock.calls[0]![1];
    await expect(services.references.resolvePath({ fieldId: "input", reference: "named_input", access: "read" })).resolves.toBe("/trusted/input");
    await expect(services.references.resolvePath({ fieldId: "output", reference: "named_output", access: "write" })).resolves.toBe("/trusted/output");
    expect(services).toMatchObject({ signal, namedCompatibilityOptions: { values: { title: "Catalog driven" } } });
  });

  it("preserves the generic registry error code", async () => {
    registry.prepare.mockReturnValue({ capabilityId: "connector.template-to-cut@1" });
    registry.execute.mockResolvedValue({ ok: false, error: { code: "connector_reference_refused", message: "refused" } });
    await expect(runNamedP2ConnectorThroughRegistry({
      subcommand: "template-to-cut", inputPath: "/input", outputPath: "/output",
      signal: new AbortController().signal, namedCompatibilityOptions: {}
    })).rejects.toMatchObject({ name: "NamedConnectorRegistryError", code: "connector_reference_refused", message: "refused" } satisfies Partial<NamedConnectorRegistryError>);
  });
});
