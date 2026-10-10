/**
 * The generated V1 contract must describe the fields the MotionJobStatus projection actually
 * carries. This is deliberately contract-facing: job-view tests cover runtime values, while this
 * test prevents the public source from reintroducing made-up queue/progress/output promises.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JOB_STATUS_CONTRACT } from "./generated/job-status";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const publicReference = readFileSync(resolve(repoRoot, "docs/public/JOB_STATUS.md"), "utf8");

describe("V1 MotionJobStatus projection contract", () => {
  it("uses the runtime field names for live and terminal status", () => {
    const pending = JOB_STATUS_CONTRACT.lifecycle.find((entry) => entry.name === "pending");
    const running = JOB_STATUS_CONTRACT.lifecycle.find((entry) => entry.name === "running");
    const ended = JOB_STATUS_CONTRACT.lifecycle.find((entry) => entry.name === "ended");

    expect(pending?.guaranteed).toEqual([
      "schema", "jobId", "callerId", "lane", "operation", "lifecycle", "outcome", "state",
      "createdAtMs", "cancelRequested", "warnings", "pollAfterMs"
    ]);
    expect(running?.guaranteed).toEqual([
      "schema", "jobId", "callerId", "lane", "operation", "lifecycle", "outcome", "state",
      "createdAtMs", "startedAtMs", "queueWaitMs", "cancelRequested", "warnings", "pollAfterMs"
    ]);
    expect(ended?.guaranteed).toEqual([
      "schema", "jobId", "callerId", "lane", "operation", "lifecycle", "outcome", "state",
      "createdAtMs", "endedAtMs", "durationMs", "queueWaitMs", "cancelRequested", "warnings"
    ]);
  });

  it("keeps retained V1 identity and evidence optional on terminal status", () => {
    const ended = JOB_STATUS_CONTRACT.lifecycle.find((entry) => entry.name === "ended");
    expect(ended?.agentGuidance).toContain("planFingerprint is optional");
    expect(ended?.agentGuidance).toContain("evidence is optional");

    const documentedFields = [
      ...JOB_STATUS_CONTRACT.lifecycle,
      ...JOB_STATUS_CONTRACT.outcomes
    ].flatMap((entry) => [...entry.guaranteed, ...entry.absent]);
    expect(documentedFields).not.toEqual(expect.arrayContaining([
      "queue.position", "aheadEstimatedMs", "progress", "worker", "bytes", "artifacts", "receipts"
    ]));
  });

  it("publishes only real optional fields and keeps process identity internal", () => {
    const optional = new Map(JOB_STATUS_CONTRACT.optionalFields.map((field) => [field.name, field]));
    expect(optional.get("frameLane")?.lifecycle).toEqual(["pending", "running", "ended"]);
    expect(optional.get("planFingerprint")?.lifecycle).toEqual(["pending", "running", "ended"]);
    expect(optional.get("receiptId")?.lifecycle).toEqual(["ended"]);
    expect(optional.get("committed")).toMatchObject({ lifecycle: ["ended"], outcomes: ["failed"] });
    expect(optional.get("committed")?.meaning).toContain("not successful artifact evidence");
    expect(optional.get("producerEvidence")?.lifecycle).toEqual(["ended"]);
    expect(optional.get("lineage")?.lifecycle).toEqual(["ended"]);
    expect(optional.get("receiptPath")).toMatchObject({ lifecycle: ["ended"], deprecated: true });
    expect(optional.get("receiptPath")?.meaning).toContain("host-local");
    expect(optional.get("receiptPath")?.meaning).toContain("not portable receipt or artifact authority");
    expect(JOB_STATUS_CONTRACT.notPublicFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "pid" })
    ]));

    expect(publicReference).toContain("## Optional fields and host-local compatibility");
    expect(publicReference).toContain("`receiptPath`");
    expect(publicReference).toContain("## Internal-only fields");
    expect(publicReference).toContain("`pid`");
  });

  it("defines terminality as immutable lifecycle and outcome, not an immutable record", () => {
    const ended = JOB_STATUS_CONTRACT.lifecycle.find((entry) => entry.name === "ended");
    expect(ended?.meaning).toContain("lifecycle and outcome will not change again");
    expect(ended?.agentGuidance).toContain("not because every status field is frozen");
    expect(ended?.agentGuidance).toContain("receipt linkage");
    expect(ended?.agentGuidance).toContain("fixes its terminal warnings");
    expect(ended?.agentGuidance).toContain("without changing lifecycle or outcome");
  });

  it("describes settled success without universal output attestation", () => {
    const succeeded = JOB_STATUS_CONTRACT.outcomes.find((entry) => entry.name === "succeeded");
    expect(succeeded?.meaning).toContain("coordinator execution settled successfully");
    expect(succeeded?.meaning).toContain("not a universal claim");
    expect(succeeded?.agentGuidance).toContain("root-level artifact or receipt collection");
  });

  it("keeps the generated public reference free of obsolete status promises", () => {
    const stateReference = publicReference.slice(
      publicReference.indexOf("## States in full"),
      publicReference.indexOf("## Query errors")
    );
    for (const field of [
      "callerId", "createdAtMs", "startedAtMs", "queueWaitMs", "endedAtMs", "durationMs", "pollAfterMs"
    ]) {
      expect(stateReference).toContain(`\`${field}\``);
    }
    expect(stateReference).not.toMatch(/queue\.position|aheadEstimatedMs|artifacts\[\]|receipts\[\]|Progress stages/);
    expect(stateReference).toContain("not because every status field is frozen");
  });
});
