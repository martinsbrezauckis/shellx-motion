import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MotionConnectorJobBindingJournal,
  MotionJobCoordinator,
  MotionJobLeaseDirectory,
  MotionJobRegistry,
  motionCapabilityCatalog
} from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";

vi.mock("@shellx-motion/connectors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shellx-motion/connectors")>();
  return { ...actual, executePreparedMotionConnectorJob: vi.fn() };
});

import { executePreparedMotionConnectorJob } from "@shellx-motion/connectors";
import { submitCoordinatedConnector } from "./coordinator-connector-submit-handler.js";

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(executePreparedMotionConnectorJob).mockReset();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for committed connector terminal state.");
}

describe.runIf(process.platform === "linux")("connector coordinator committed-failure adapter", () => {
  it("forwards the normalized authenticated failure marker into the single Core lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-connector-committed-adapter-"));
    roots.push(root);
    const callerId = "cut:connector-committed";
    const jobId = "cut:connector-committed-job";
    const jobs = new MotionJobCoordinator({
      leases: new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") }),
      records: new MotionJobRegistry({ recordRoot: join(root, "records") }),
      eventsRoot: join(root, "events")
    });
    const bindings = new MotionConnectorJobBindingJournal({ bindingRoot: join(root, "bindings") });
    const descriptor = motionCapabilityCatalog().descriptors.find((candidate) => candidate.id === "connector.template-to-cut@1");
    if (!descriptor) throw new Error("Template-to-Cut descriptor missing.");
    vi.mocked(executePreparedMotionConnectorJob).mockResolvedValueOnce({
      ok: false,
      binding: {} as never,
      committed: true,
      error: { code: "publication_commit_uncertain", message: "connector delivery may have completed", retryable: true }
    } as never);
    const anchor = await createTrustedWorkspaceAnchor(root);
    const submitted = await withTrustedWorkspaceAnchor(anchor, async () => await submitCoordinatedConnector({
      jobId,
      capabilityId: descriptor.id,
      descriptorRevision: descriptor.revision,
      descriptorFingerprint: descriptor.fingerprint,
      requestSchemaId: descriptor.request.id,
      request: { input: "input_ref", output: "output_ref" }
    }, {
      jobTrackingDisabled: false,
      callerId,
      connectorJobReferences: { async resolvePath() { throw new Error("adapter must not resolve after a normalized failure"); } },
      connectorJobBindingJournal: bindings,
      coordinator: () => jobs,
      unhandled: (error) => ({ ok: false, error: { code: "unhandled", message: String(error) }, warnings: [] })
    }));
    expect(submitted).toMatchObject({ ok: true, result: { jobId } });
    const status = await eventually(
      async () => await withTrustedWorkspaceAnchor(anchor, async () => await jobs.jobView().get({ jobId, callerId })),
      (answer) => answer.ok && answer.job.state === "failed"
    );
    expect(status).toMatchObject({ ok: true, job: { outcome: "failed", state: "failed", committed: true } });
    if (!status.ok) throw new Error("committed connector terminal unavailable");
    await expect(withTrustedWorkspaceAnchor(anchor, async () => await jobs.events({ jobId, callerId }))).resolves.toMatchObject({
      ok: true,
      value: { events: expect.arrayContaining([expect.objectContaining({ type: "failed", data: expect.objectContaining({ committed: true }) })]) }
    });
  });
});
