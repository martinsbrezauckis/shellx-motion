import { describe, expect, it } from "vitest";
import {
  createIntegrationEnvelope,
  integrationCapabilitiesForHost,
  negotiateIntegrationCapabilities,
  parseIntegrationCapabilities,
  verifyIntegrationEnvelope
} from "./integration-protocol";

describe("ShellX integration protocol", () => {
  it("publishes stable host manifests without sharing mutable state", () => {
    const motion = integrationCapabilitiesForHost("shellx-motion");
    const cut = integrationCapabilitiesForHost("shellx-cut");
    expect(motion).toMatchObject({
      schema: "shellx-motion/integration-capabilities@1",
      host: "shellx-motion",
      protocol: { min: 1, max: 1, preferred: 1 }
    });
    expect(cut.modes).toEqual(["cut.import.plan"]);
    motion.modes.push("mutated");
    expect(integrationCapabilitiesForHost("shellx-motion").modes).not.toContain("mutated");
  });

  it("negotiates the highest shared protocol and required mode", () => {
    const result = negotiateIntegrationCapabilities(
      integrationCapabilitiesForHost("shellx-motion"),
      integrationCapabilitiesForHost("shellx-cut"),
      ["cut.import.plan"]
    );
    expect(result).toMatchObject({
      ok: true,
      selectedProtocol: 1,
      modes: ["cut.import.plan"],
      missingRequiredModes: [],
      schemas: {
        artifact: ["shellx-motion/artifact-handle-ref@1", "shellx-motion/artifact-handle@1"],
        cut: ["shellx-motion/cut-import-plan@1"],
        receipt: ["shellx-motion/receipt@1"]
      },
      limits: { maxPlanBytes: 4_194_304, maxArtifactBytes: 8_589_934_592, maxOperations: 10_000 }
    });
    expect(result.features).toContain("artifact.attestation");

    const widerMotion = integrationCapabilitiesForHost("shellx-motion");
    widerMotion.protocol = { min: 1, max: 3, preferred: 1 };
    const newerCut = integrationCapabilitiesForHost("shellx-cut");
    newerCut.protocol = { min: 2, max: 3, preferred: 2 };
    expect(negotiateIntegrationCapabilities(widerMotion, newerCut).selectedProtocol).toBe(2);
  });

  it("fails clearly for protocol skew and missing required modes", () => {
    const motion = integrationCapabilitiesForHost("shellx-motion");
    const futureCut = integrationCapabilitiesForHost("shellx-cut");
    futureCut.protocol = { min: 2, max: 2, preferred: 2 };
    expect(negotiateIntegrationCapabilities(motion, futureCut)).toMatchObject({
      ok: false,
      error: { code: "unsupported_protocol" }
    });
    expect(negotiateIntegrationCapabilities(
      motion,
      integrationCapabilitiesForHost("shellx-canvas"),
      ["cut.import.plan"]
    )).toMatchObject({
      ok: false,
      selectedProtocol: 1,
      missingRequiredModes: ["cut.import.plan"],
      error: { code: "missing_required_mode" }
    });
  });

  it("parses closed capability manifests and rejects malformed ranges", () => {
    const canvas = integrationCapabilitiesForHost("shellx-canvas");
    expect(parseIntegrationCapabilities(JSON.parse(JSON.stringify(canvas)))).toEqual(canvas);
    expect(() => parseIntegrationCapabilities({ ...canvas, unexpected: true })).toThrow("unknown field");
    expect(() => parseIntegrationCapabilities({
      ...canvas,
      protocol: { min: 2, max: 1, preferred: 1 }
    })).toThrow("inconsistent");
  });

  it("creates and re-negotiates a Canvas connector envelope", () => {
    const envelope = createIntegrationEnvelope({
      producer: "shellx-canvas",
      consumer: "shellx-motion",
      mode: "canvas.bridge",
      payloadSchema: "shellx-motion/canvas-frame-selection@1",
      requiredFeatures: ["artifact.attestation"]
    });
    const verified = verifyIntegrationEnvelope(JSON.parse(JSON.stringify(envelope)), {
      producer: "shellx-canvas",
      consumer: "shellx-motion",
      mode: "canvas.bridge",
      payloadSchema: "shellx-motion/canvas-frame-selection@1"
    });
    expect(verified.negotiation).toMatchObject({ ok: true, selectedProtocol: 1 });
    expect(verified.envelope.binding.requiredFeatures).toEqual(["artifact.attestation"]);
  });

  it("fails closed for skewed, retargeted, and feature-incompatible envelopes", () => {
    const envelope = createIntegrationEnvelope({
      producer: "shellx-canvas",
      consumer: "shellx-motion",
      mode: "canvas.bridge",
      payloadSchema: "shellx-motion/canvas-frame-selection@1"
    });
    const expected = {
      producer: "shellx-canvas" as const,
      consumer: "shellx-motion" as const,
      mode: "canvas.bridge",
      payloadSchema: "shellx-motion/canvas-frame-selection@1"
    };
    expect(() => verifyIntegrationEnvelope({ ...envelope, unexpected: true }, expected)).toThrow("unknown field");
    expect(() => verifyIntegrationEnvelope({
      ...envelope,
      binding: { ...envelope.binding, protocol: 2 }
    }, expected)).toThrow("does not match negotiated protocol");
    expect(() => verifyIntegrationEnvelope({
      ...envelope,
      binding: { ...envelope.binding, consumer: "shellx-cut" }
    }, expected)).toThrow("consumer must be shellx-motion");
    expect(() => verifyIntegrationEnvelope({
      ...envelope,
      binding: { ...envelope.binding, requiredFeatures: ["future.magic"] }
    }, expected)).toThrow("No shared support for required feature");
  });
});
