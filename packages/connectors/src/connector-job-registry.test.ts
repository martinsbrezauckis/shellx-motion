import { describe, expect, it } from "vitest";
import { motionCapabilityCatalog } from "@shellx-motion/core";
import {
  executePreparedMotionConnectorJob,
  prepareAdmittedMotionConnectorJob,
  type MotionConnectorReferenceAuthority,
  type PreparedMotionConnectorJob
} from "./connector-job-registry";

function templateRequest() {
  const catalog = motionCapabilityCatalog();
  const descriptor = catalog.descriptors.find((candidate) => candidate.id === "connector.template-to-cut@1");
  if (!descriptor) throw new Error("template descriptor missing");
  return {
    catalog,
    descriptor,
    request: {
      capabilityId: descriptor.id,
      descriptorRevision: descriptor.revision,
      descriptorFingerprint: descriptor.fingerprint,
      requestSchemaId: descriptor.request.id,
      request: { input: "input_ref", output: "output_ref" }
    }
  };
}

describe.runIf(process.platform === "linux")("Motion connector job registry", () => {
  it("binds an admitted request to the exact current descriptor and catalog", () => {
    const fixture = templateRequest();
    expect(prepareAdmittedMotionConnectorJob(fixture.request)).toMatchObject({
      capabilityId: fixture.descriptor.id,
      descriptorRevision: fixture.descriptor.revision,
      descriptorFingerprint: fixture.descriptor.fingerprint,
      requestSchemaId: fixture.descriptor.request.id,
      catalogFingerprint: fixture.catalog.fingerprint,
      operation: fixture.descriptor.id,
      request: { input: "input_ref", output: "output_ref" }
    });
  });

  it("refuses descriptor drift and compatibility-only capabilities before reference resolution", async () => {
    const fixture = templateRequest();
    expect(() => prepareAdmittedMotionConnectorJob({ ...fixture.request, descriptorFingerprint: "0".repeat(64) }))
      .toThrow(/no longer matches/);
    const compatibility = fixture.catalog.descriptors.find((candidate) => candidate.id === "connector.canvas-bridge-export@1");
    if (!compatibility) throw new Error("compatibility descriptor missing");
    expect(() => prepareAdmittedMotionConnectorJob({
      capabilityId: compatibility.id,
      descriptorRevision: compatibility.revision,
      descriptorFingerprint: compatibility.fingerprint,
      requestSchemaId: compatibility.request.id,
      request: { input: "input_ref", output: "output_ref" }
    })).toThrow(/cannot enter generic connector-job execution/);

    let resolutions = 0;
    const references: MotionConnectorReferenceAuthority = { async resolvePath() { resolutions += 1; return "/never"; } };
    const prepared = prepareAdmittedMotionConnectorJob(fixture.request);
    const drifted = { ...prepared, catalogFingerprint: "f".repeat(64) } as PreparedMotionConnectorJob;
    await expect(executePreparedMotionConnectorJob(drifted, { callerId: "cut:workspace-a", references, signal: new AbortController().signal }))
      .resolves.toMatchObject({ ok: false, error: { code: "connector_descriptor_drift" } });
    expect(resolutions).toBe(0);
  });

  it("honours cancellation before resolving opaque references", async () => {
    const prepared = prepareAdmittedMotionConnectorJob(templateRequest().request);
    const controller = new AbortController();
    controller.abort(new Error("operator cancelled"));
    let resolutions = 0;
    const references: MotionConnectorReferenceAuthority = { async resolvePath() { resolutions += 1; return "/never"; } };
    await expect(executePreparedMotionConnectorJob(prepared, { callerId: "cut:workspace-a", references, signal: controller.signal }))
      .resolves.toMatchObject({ ok: false, error: { code: "job_cancelled", message: "operator cancelled" } });
    expect(resolutions).toBe(0);
  });

  it("refuses a host resolver that returns a relative path", async () => {
    const prepared = prepareAdmittedMotionConnectorJob(templateRequest().request);
    const references: MotionConnectorReferenceAuthority = { async resolvePath() { return "relative/path"; } };
    await expect(executePreparedMotionConnectorJob(prepared, { callerId: "cut:workspace-a", references, signal: new AbortController().signal }))
      .resolves.toMatchObject({ ok: false, error: { code: "connector_reference_refused" } });
  });
});

describe.runIf(process.platform !== "linux")("Motion connector job registry platform refusal", () => {
  it("refuses the currently Linux-only admitted P2 executors before reference resolution", () => {
    expect(() => prepareAdmittedMotionConnectorJob(templateRequest().request)).toThrow(`unavailable on ${process.platform}`);
  });
});
