import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MotionConnectorJobBindingJournal, MotionJobCoordinator, MotionJobLeaseDirectory, MotionJobRegistry, motionCapabilityCatalog } from "@shellx-motion/core";
import { retryCoordinatedJob, submitCoordinatedConnector } from "./coordinator-connector-submit-handler";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

function coordinatorAt(root: string): MotionJobCoordinator {
  return new MotionJobCoordinator({
    leases: new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") }),
    records: new MotionJobRegistry({ recordRoot: join(root, "records") }),
    eventsRoot: join(root, "events")
  });
}

async function coordinator(): Promise<{ jobs: MotionJobCoordinator; bindings: MotionConnectorJobBindingJournal; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-connector-submit-"));
  roots.push(root);
  return {
    jobs: coordinatorAt(root),
    bindings: new MotionConnectorJobBindingJournal({ bindingRoot: join(root, "bindings") }),
    root
  };
}

function request(jobId: string) {
  const descriptor = motionCapabilityCatalog().descriptors.find((candidate) => candidate.id === "connector.template-to-cut@1");
  if (!descriptor) throw new Error("template descriptor missing");
  return {
    jobId,
    capabilityId: descriptor.id,
    descriptorRevision: descriptor.revision,
    descriptorFingerprint: descriptor.fingerprint,
    requestSchemaId: descriptor.request.id,
    request: { input: "input_ref", output: "output_ref" }
  };
}

async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for connector job state.");
}

describe.runIf(process.platform === "linux")("generic coordinator connector submission", () => {
  it("submits one descriptor-bound job and cancels while its opaque input is resolving", async () => {
    const { jobs, bindings } = await coordinator();
    let resolutions = 0;
    const resolvedFor: string[] = [];
    const submitted = await submitCoordinatedConnector(request("cut:generic-cancel"), {
      jobTrackingDisabled: false,
      callerId: "cut:workspace",
      connectorJobReferences: {
        async resolvePath(input) {
          resolutions += 1;
          resolvedFor.push(input.callerId);
          return await new Promise<string>((_resolve, reject) => {
            const stop = () => reject(input.signal.reason instanceof Error ? input.signal.reason : new Error("cancelled"));
            if (input.signal.aborted) stop(); else input.signal.addEventListener("abort", stop, { once: true });
          });
        }
      },
      connectorJobBindingJournal: bindings,
      coordinator: () => jobs,
      unhandled: (error) => ({ ok: false, error: { code: "unhandled", message: String(error) }, warnings: [] })
    });
    expect(submitted).toMatchObject({ ok: true, result: { jobId: "cut:generic-cancel", binding: { capabilityId: "connector.template-to-cut@1", descriptorRevision: 2 } } });
    await eventually(async () => resolutions, (count) => count === 1);
    expect(resolvedFor).toEqual(["cut:workspace"]);
    await expect(jobs.cancel({ jobId: "cut:generic-cancel", callerId: "other:workspace" })).resolves.toMatchObject({ ok: false, code: "job_not_visible" });
    await expect(jobs.cancel({ jobId: "cut:generic-cancel", callerId: "cut:workspace", reason: "operator stop" })).resolves.toMatchObject({ ok: true });
    const terminal = await eventually(
      async () => await jobs.jobView().get({ jobId: "cut:generic-cancel", callerId: "cut:workspace" }),
      (answer) => answer.ok && answer.job.state === "cancelled"
    );
    expect(terminal).toMatchObject({ ok: true, job: { lane: "connector", operation: "connector.template-to-cut@1", state: "cancelled" } });
    const events = await jobs.events({ jobId: "cut:generic-cancel", callerId: "cut:workspace" });
    expect(events).toMatchObject({ ok: true, value: { events: expect.arrayContaining([
      expect.objectContaining({ type: "submitted", data: expect.objectContaining({
        capabilityId: "connector.template-to-cut@1", descriptorRevision: 2, requestSchemaId: "shellx-motion/connector-request/template-to-cut@1"
      }) }),
      expect.objectContaining({ type: "cancel_requested" }),
      expect.objectContaining({ type: "cancelled" })
    ]) } });
    expect(JSON.stringify(events)).not.toContain("/tmp/");
    expect(resolutions).toBe(1);
  });

  it("refuses descriptor drift and missing host reference authority before queueing", async () => {
    const { jobs, bindings } = await coordinator();
    let resolutions = 0;
    const drifted = { ...request("cut:generic-drift"), descriptorFingerprint: "0".repeat(64) };
    await expect(submitCoordinatedConnector(drifted, {
      jobTrackingDisabled: false, callerId: "cut:workspace",
      connectorJobReferences: { async resolvePath() { resolutions += 1; return "/never"; } },
      connectorJobBindingJournal: bindings,
      coordinator: () => jobs,
      unhandled: (error) => ({ ok: false, error: { code: "unhandled", message: String(error) }, warnings: [] })
    })).resolves.toMatchObject({ ok: false, error: { code: "connector_descriptor_drift" } });
    expect(resolutions).toBe(0);
    await expect(submitCoordinatedConnector(request("cut:no-authority"), {
      jobTrackingDisabled: false, callerId: "cut:workspace", coordinator: () => jobs,
      connectorJobBindingJournal: bindings,
      unhandled: (error) => ({ ok: false, error: { code: "unhandled", message: String(error) }, warnings: [] })
    })).resolves.toMatchObject({ ok: false, error: { code: "capability_unavailable" } });

    await expect(submitCoordinatedConnector(request("cut:no-journal"), {
      jobTrackingDisabled: false, callerId: "cut:workspace", coordinator: () => jobs,
      connectorJobReferences: { async resolvePath() { return "/never"; } },
      unhandled: (error) => ({ ok: false, error: { code: "unhandled", message: String(error) }, warnings: [] })
    })).resolves.toMatchObject({ ok: false, error: { code: "capability_unavailable", message: expect.stringContaining("binding journal") } });
  });

  it("reconstructs an explicit retry from the immutable binding after coordinator restart", async () => {
    const { jobs: first, bindings, root } = await coordinator();
    const submittedRequest = request("cut:restart-source");
    const catalog = motionCapabilityCatalog();
    await expect(bindings.write({
      jobId: submittedRequest.jobId,
      callerId: "cut:workspace",
      capabilityId: submittedRequest.capabilityId,
      descriptorRevision: submittedRequest.descriptorRevision,
      descriptorFingerprint: submittedRequest.descriptorFingerprint,
      requestSchemaId: submittedRequest.requestSchemaId,
      catalogFingerprint: catalog.fingerprint,
      request: submittedRequest.request
    })).resolves.toMatchObject({ ok: true, replayed: false });
    await expect(first.submit({
      jobId: submittedRequest.jobId,
      callerId: "cut:workspace",
      lane: "connector",
      operation: submittedRequest.capabilityId,
      execute: async () => ({ ok: false, error: { code: "job_queue_timeout", message: "capacity busy", retryable: true } })
    })).resolves.toMatchObject({ ok: true });
    await eventually(
      async () => await first.jobView().get({ jobId: submittedRequest.jobId, callerId: "cut:workspace" }),
      (answer) => answer.ok && answer.job.state === "failed"
    );

    const restarted = coordinatorAt(root);
    let resolutions = 0;
    const resolvedFor: string[] = [];
    expect(resolutions).toBe(0);
    await expect(retryCoordinatedJob({
      jobId: submittedRequest.jobId,
      callerId: "cut:workspace",
      newJobId: "cut:restart-retry"
    }, {
      connectorJobBindingJournal: bindings,
      connectorJobReferences: {
        async resolvePath(input) {
          resolutions += 1;
          resolvedFor.push(input.callerId);
          return "/motion-test-missing";
        }
      },
      coordinator: () => restarted
    })).resolves.toMatchObject({ ok: true, value: { jobId: "cut:restart-retry", priorJobId: "cut:restart-source" } });
    await eventually(async () => resolutions, (count) => count === 2);
    expect(resolvedFor).toEqual(["cut:workspace", "cut:workspace"]);
    await expect(bindings.read({ jobId: "cut:restart-retry", callerId: "cut:workspace" }))
      .resolves.toMatchObject({ ok: true, binding: { request: submittedRequest.request } });
    await eventually(
      async () => await restarted.jobView().get({ jobId: "cut:restart-retry", callerId: "cut:workspace" }),
      (answer) => answer.ok && answer.job.lifecycle === "ended"
    );
    const events = await restarted.events({ jobId: "cut:restart-retry", callerId: "cut:workspace" });
    expect(events).toMatchObject({ ok: true, value: { events: expect.arrayContaining([
      expect.objectContaining({ type: "retry_submitted", data: { priorJobId: "cut:restart-source", retryAttempt: 1 } })
    ]) } });
  });
});

describe.runIf(process.platform !== "linux")("generic coordinator connector platform refusal", () => {
  it("refuses a currently Linux-only descriptor before queueing or resolving a handle", async () => {
    const { jobs, bindings } = await coordinator();
    let resolutions = 0;
    await expect(submitCoordinatedConnector(request("cut:unsupported-platform"), {
      jobTrackingDisabled: false,
      callerId: "cut:workspace",
      connectorJobBindingJournal: bindings,
      connectorJobReferences: { async resolvePath() { resolutions += 1; return "/never"; } },
      coordinator: () => jobs,
      unhandled: (error) => ({ ok: false, error: { code: "unhandled", message: String(error) }, warnings: [] })
    })).resolves.toMatchObject({ ok: false, error: { code: "capability_unavailable", message: expect.stringContaining(`unavailable on ${process.platform}`) } });
    expect(resolutions).toBe(0);
    await expect(jobs.jobView().get({ jobId: "cut:unsupported-platform", callerId: "cut:workspace" }))
      .resolves.toMatchObject({ ok: false, code: "job_unknown" });
  });
});
