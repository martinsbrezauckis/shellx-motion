import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readMotionJobLeaseRecord } from "./job-lease-run-storage";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("persisted job lease boundary", () => {
  it("projects a complete validated record and supplies only the legacy owner default", async () => {
    const path = await leasePath();
    await writeFile(path, JSON.stringify({
      ...validLease(),
      unexpected: "not projected",
      cancelRequested: { requestedBy: "caller-a", requestedAtMs: 1_001, reason: "stop", ignored: true }
    }));

    expect(await readMotionJobLeaseRecord(path, "unattributed")).toEqual({
      ...validLease(),
      callerId: "unattributed",
      cancelRequested: { requestedBy: "caller-a", requestedAtMs: 1_001, reason: "stop" }
    });
  });

  it("rejects incomplete, nonfinite, unsafe and invalid-enum persisted records", async () => {
    const invalidRecords = [
      without(validLease(), "lane"),
      without(validLease(), "operation"),
      { ...validLease(), pid: 1.5 },
      { ...validLease(), startedAtMs: Number.MAX_SAFE_INTEGER + 1 },
      { ...validLease(), heartbeatAtMs: Number.NaN },
      { ...validLease(), admittedAtMs: Number.POSITIVE_INFINITY },
      without(validLease(), "admittedAtMs"),
      { ...validLease(), admitted: false },
      { ...validLease(), visibility: "everyone" },
      { ...validLease(), admitted: "yes" },
      { ...validLease(), cancelRequested: null },
      { ...validLease(), cancelRequested: { requestedBy: "caller-a", requestedAtMs: -1 } }
    ];

    for (const [index, record] of invalidRecords.entries()) {
      const path = await leasePath(index);
      await writeFile(path, JSON.stringify(record));
      expect(await readMotionJobLeaseRecord(path, "unattributed")).toBeNull();
    }
  });
});

function validLease() {
  return {
    schema: "shellx-motion/job-lease@1",
    jobId: "job-a",
    runNonce: "12345678-abcd",
    pid: 123,
    lane: "ffmpeg",
    operation: "render.final",
    visibility: "host",
    startedAtMs: 1_000,
    admittedAtMs: 1_000,
    heartbeatAtMs: 1_001,
    admitted: true
  };
}

function without(value: ReturnType<typeof validLease>, key: keyof ReturnType<typeof validLease>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== key));
}

async function leasePath(index = 0): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-job-lease-boundary-"));
  roots.push(root);
  return join(root, `lease-${index}.json`);
}
