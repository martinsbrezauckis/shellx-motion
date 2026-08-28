import { describe, expect, it, vi } from "vitest";
import { motionCapabilityCatalog } from "@shellx-motion/core";

vi.mock("./template-to-cut", () => ({
  runTemplateToCutConnector: vi.fn(async () => ({
    ok: false,
    error: {
      code: "connector_future_backpressure",
      message: "future renderer is saturated",
      retryable: true,
      retryAfterMs: 2_500,
      remedy: "wait",
      suggestedAction: "Wait, then retry the same immutable connector binding."
    }
  }))
}));

import { executePreparedMotionConnectorJob, prepareAdmittedMotionConnectorJob } from "./connector-job-registry";

describe.runIf(process.platform === "linux")("connector typed failure convergence", () => {
  it("preserves an unknown future code and retry policy through the caller-qualified generic registry", async () => {
    const descriptor = motionCapabilityCatalog().descriptors.find((entry) => entry.id === "connector.template-to-cut@1");
    if (!descriptor) throw new Error("Template-to-Cut descriptor is missing.");
    const prepared = prepareAdmittedMotionConnectorJob({
      capabilityId: descriptor.id,
      descriptorRevision: descriptor.revision,
      descriptorFingerprint: descriptor.fingerprint,
      requestSchemaId: descriptor.request.id,
      request: { input: "input_ref", output: "output_ref" }
    });
    const resolvedFor: string[] = [];
    const result = await executePreparedMotionConnectorJob(prepared, {
      callerId: "cut:workspace-a",
      references: {
        async resolvePath(input) {
          resolvedFor.push(input.callerId);
          return input.access === "read" ? "/motion/input" : "/motion/output";
        }
      },
      signal: new AbortController().signal
    });
    expect(resolvedFor).toEqual(["cut:workspace-a", "cut:workspace-a"]);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "connector_future_backpressure",
        message: "future renderer is saturated",
        retryable: true,
        retryAfterMs: 2_500,
        remedy: "wait",
        suggestedAction: "Wait, then retry the same immutable connector binding."
      }
    });
  });
});
