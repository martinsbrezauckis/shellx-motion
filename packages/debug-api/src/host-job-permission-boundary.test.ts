import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

const priorLeaseRoot = process.env.SHELLX_MOTION_LEASE_ROOT;
const priorRecordRoot = process.env.SHELLX_MOTION_JOB_RECORD_ROOT;

afterEach(() => {
  if (priorLeaseRoot === undefined) delete process.env.SHELLX_MOTION_LEASE_ROOT;
  else process.env.SHELLX_MOTION_LEASE_ROOT = priorLeaseRoot;
  if (priorRecordRoot === undefined) delete process.env.SHELLX_MOTION_JOB_RECORD_ROOT;
  else process.env.SHELLX_MOTION_JOB_RECORD_ROOT = priorRecordRoot;
});

describe("tracked render permission boundary", () => {
  it("refuses under-tier renders without creating leases or terminal records", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-denied-host-job-"));
    const leaseRoot = join(root, "leases");
    const recordRoot = join(root, "records");
    process.env.SHELLX_MOTION_LEASE_ROOT = leaseRoot;
    process.env.SHELLX_MOTION_JOB_RECORD_ROOT = recordRoot;

    try {
      for (const command of ["motion.render.final", "motion.render.batch"] as const) {
        const result = await dispatchDebugCommand(command, { jobId: `denied-${command.split(".").at(-1)}` }, { tier: "read_motion" });
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "permission_denied",
            detail: { requiredTier: "render_motion", grantedTier: "read_motion", resolvedBy: "host_operator" }
          },
          warnings: []
        });
        expect("jobId" in result).toBe(false);
      }
      await expect(readdir(leaseRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readdir(recordRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps authorized render failures in the ordinary host-job lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-authorized-host-job-"));
    const leaseRoot = join(root, "leases");
    const recordRoot = join(root, "records");
    process.env.SHELLX_MOTION_LEASE_ROOT = leaseRoot;
    process.env.SHELLX_MOTION_JOB_RECORD_ROOT = recordRoot;

    try {
      const result = await dispatchDebugCommand("motion.render.final", {}, { tier: "render_motion" });
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" }, jobId: expect.any(String) });
      expect(await readdir(leaseRoot)).toEqual([]);
      expect(await readdir(recordRoot)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
