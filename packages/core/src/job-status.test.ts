/**
 * Coverage for the generated job status contract.
 *
 * These assert the rules that make the contract load-bearing rather than documentary: the
 * projection cannot disagree with its axes, retryability is decided by the code, and the
 * vocabularies stay disjoint. A regression here means an agent can be told something untrue
 * about work it requested.
 */
import { describe, expect, it } from "vitest";
import {
  isRetryableJobError,
  isTerminalLifecycle,
  jobOutcomeForReceiptStatus,
  JOB_LIFECYCLES,
  JOB_OUTCOMES,
  JOB_STATES,
  JOB_STATUS_CONTRACT,
  projectJobState,
  remedyForJobError,
  RESERVED_NON_JOB_STATE_WORDS,
  RESERVED_NON_RECEIPT_STATUS_WORDS,
  type JobErrorCode
} from "./generated/job-status";

describe("job lifecycle and outcome axes", () => {
  it("keeps lifecycle closed at three values", () => {
    // Frozen by contract: adding a lifecycle is a breaking change, so this asserts the count.
    expect(JOB_LIFECYCLES).toEqual(["pending", "running", "ended"]);
  });

  it("treats only ended as terminal", () => {
    expect(isTerminalLifecycle("ended")).toBe(true);
    expect(isTerminalLifecycle("pending")).toBe(false);
    expect(isTerminalLifecycle("running")).toBe(false);
  });

  it("projects every axis combination onto an observable state", () => {
    expect(projectJobState("pending", null)).toBe("pending");
    expect(projectJobState("running", null)).toBe("running");
    for (const outcome of JOB_OUTCOMES) {
      expect(projectJobState("ended", outcome)).toBe(outcome);
    }
  });

  it("refuses to project an ended job with no outcome", () => {
    // Silently reporting "ended" would hide which of four different things happened.
    expect(() => projectJobState("ended", null)).toThrow(/must carry an outcome/);
  });

  it("exposes exactly the six observable states", () => {
    expect(JOB_STATES).toEqual(["pending", "running", "succeeded", "failed", "cancelled", "skipped"]);
    // The projection can only ever produce a member of JOB_STATES.
    const projected = new Set([
      projectJobState("pending", null),
      projectJobState("running", null),
      ...JOB_OUTCOMES.map((outcome) => projectJobState("ended", outcome))
    ]);
    expect([...projected].sort()).toEqual([...JOB_STATES].sort());
  });
});

describe("failure codes", () => {
  it("decides retryability from the code, not the call site", () => {
    expect(isRetryableJobError("job_queue_timeout")).toBe(true);
    expect(isRetryableJobError("job_rss_limit_exceeded")).toBe(true);
    expect(isRetryableJobError("unsupported_preset")).toBe(false);
    expect(isRetryableJobError("invalid_args")).toBe(false);
  });

  it("gives every code a remedy a caller can act on", () => {
    const kinds = new Set(JOB_STATUS_CONTRACT.remedyKinds.map((entry) => entry.kind));
    for (const entry of JOB_STATUS_CONTRACT.errorCodes) {
      expect(kinds.has(remedyForJobError(entry.code as JobErrorCode))).toBe(true);
    }
  });

  it("never tells a caller to change input for something only waiting fixes", () => {
    // A retryable error whose remedy is change_input would send an agent to rewrite a correct
    // request; a non-retryable error whose remedy is wait would make it loop forever.
    for (const entry of JOB_STATUS_CONTRACT.errorCodes) {
      if (entry.remedy === "wait") expect(entry.retryable).toBe(true);
      if (entry.remedy === "grant_permission") expect(entry.retryable).toBe(false);
    }
  });
});

describe("receipt status is a different axis from job outcome", () => {
  it("maps a warned receipt onto a successful job", () => {
    // The whole point of keeping the axes separate: the artifact exists, so the request succeeded.
    expect(jobOutcomeForReceiptStatus("warning")).toBe("succeeded");
    expect(jobOutcomeForReceiptStatus("passed")).toBe("succeeded");
    expect(jobOutcomeForReceiptStatus("failed")).toBe("failed");
    expect(jobOutcomeForReceiptStatus("not_run")).toBe("skipped");
  });

  it("returns undefined rather than guessing at an unmapped status", () => {
    expect(jobOutcomeForReceiptStatus("something_else")).toBeUndefined();
  });

  it("keeps the two vocabularies disjoint", () => {
    // This is the mechanical guard against an eighth vocabulary appearing.
    for (const word of RESERVED_NON_JOB_STATE_WORDS) {
      expect(JOB_STATES).not.toContain(word);
    }
    const receiptStatuses = JOB_STATUS_CONTRACT.receiptMapping.map((entry) => entry.receiptStatus);
    for (const word of RESERVED_NON_RECEIPT_STATUS_WORDS) {
      expect(receiptStatuses).not.toContain(word);
    }
  });
});

describe("every state documents what an agent should do", () => {
  it("gives each state a meaning, an action and guidance", () => {
    for (const entry of [...JOB_STATUS_CONTRACT.lifecycle, ...JOB_STATUS_CONTRACT.outcomes]) {
      expect(entry.meaning.length).toBeGreaterThan(20);
      expect(entry.agentAction.length).toBeGreaterThan(0);
      expect(entry.agentGuidance.length).toBeGreaterThan(20);
    }
  });

  it("states the invariant that stops an agent restarting cancelled work", () => {
    const cancelled = JOB_STATUS_CONTRACT.outcomes.find((entry) => entry.name === "cancelled");
    // An agent whose retry policy is `if (job.error?.retryable) retry()` must be structurally
    // incapable of restarting something a human stopped.
    expect(cancelled?.absent).toContain("error");
    const failed = JOB_STATUS_CONTRACT.outcomes.find((entry) => entry.name === "failed");
    expect(failed?.guaranteed).toContain("error");
  });

  it("proves nothing ran when a job was skipped", () => {
    const skipped = JOB_STATUS_CONTRACT.outcomes.find((entry) => entry.name === "skipped");
    // startedAt being absent is the machine-checkable proof.
    expect(skipped?.absent).toContain("startedAt");
    expect(skipped?.absent).toContain("error");
  });

  it("distinguishes a job that does not exist from one that is not visible", () => {
    const codes = JOB_STATUS_CONTRACT.queryErrors.map((entry) => entry.code);
    // Told "unknown" for a job that exists, an agent concludes Motion lost it.
    expect(codes).toContain("job_unknown");
    expect(codes).toContain("job_not_visible");
  });
});
