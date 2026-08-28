import { describe, expect, it } from "vitest";
import {
  MOTION_JOB_FAILURE_ACTION_MAX_CHARS,
  motionJobFailure,
  motionJobFailureFromException,
  parseMotionJobFailure
} from "./job-failure";

describe("Motion job failure convergence", () => {
  it("keeps the authored policy for known codes instead of trusting a throw site", () => {
    expect(motionJobFailure({ code: "job_queue_timeout", message: "busy", retryable: false, remedy: "change_input" }, {
      code: "invalid_args", message: "fallback"
    })).toEqual({ code: "job_queue_timeout", message: "busy", retryable: true, remedy: "wait" });
  });

  it("preserves a future typed code and its bounded retry metadata", () => {
    const failure = motionJobFailure({
      code: "connector_future_backpressure",
      message: "future executor is saturated",
      retryable: true,
      remedy: "wait",
      retryAfterMs: 2_500,
      suggestedAction: "Wait for the future executor, then retry the same immutable binding."
    }, { code: "connector_failed", message: "connector failed" });
    expect(failure).toEqual({
      code: "connector_future_backpressure",
      message: "future executor is saturated",
      retryable: true,
      remedy: "wait",
      retryAfterMs: 2_500,
      suggestedAction: "Wait for the future executor, then retry the same immutable binding."
    });
    expect(parseMotionJobFailure(failure)).toEqual(failure);
  });

  it("rejects contradictory or unbounded durable metadata", () => {
    expect(parseMotionJobFailure({ code: "job_queue_timeout", message: "busy", retryable: false })).toBeNull();
    expect(parseMotionJobFailure({
      code: "connector_future_backpressure", message: "busy", retryable: true,
      suggestedAction: "x".repeat(MOTION_JOB_FAILURE_ACTION_MAX_CHARS + 1)
    })).toBeNull();
  });

  it("uses the safe fallback when a producer supplies an invalid code", () => {
    expect(motionJobFailure({ code: "../../unsafe", message: "failure", retryable: true }, {
      code: "connector_failed", message: "connector failed"
    })).toMatchObject({ code: "connector_failed", message: "failure", retryable: true });
  });

  it("preserves only bounded typed metadata from an exception", () => {
    const error = Object.assign(new Error("future executor is saturated"), {
      code: "connector_future_backpressure",
      retryable: true,
      remedy: "wait",
      retryAfterMs: 2_500,
      suggestedAction: "Wait, then retry the same immutable binding.",
      detail: { privatePath: "/private/connector/input.json" }
    });
    error.stack = "Error: future executor is saturated\n    at /private/connector/stack.ts:1:1";

    expect(motionJobFailureFromException(error, {
      code: "invalid_args", message: "Motion job execution failed."
    })).toEqual({
      code: "connector_future_backpressure",
      message: "future executor is saturated",
      retryable: true,
      remedy: "wait",
      retryAfterMs: 2_500,
      suggestedAction: "Wait, then retry the same immutable binding."
    });
  });

  it("falls back rather than exposing an untyped exception path or stack", () => {
    const error = new Error("Could not open /private/connector/input.json");
    error.stack = "Error: Could not open /private/connector/input.json\n    at /private/connector/stack.ts:1:1";

    expect(motionJobFailureFromException(error, {
      code: "invalid_args", message: "Motion job execution failed."
    })).toEqual({ code: "invalid_args", message: "Motion job execution failed.", retryable: false, remedy: "change_input" });
  });

  it("keeps a typed exception category while replacing path-bearing metadata", () => {
    const error = Object.assign(new Error("Could not open /private/connector/input.json"), {
      code: "connector_future_backpressure",
      retryable: true,
      suggestedAction: "Inspect /private/connector/input.json, then retry."
    });
    const failure = motionJobFailureFromException(error, {
      code: "invalid_args", message: "Motion job execution failed."
    });

    expect(failure).toEqual({
      code: "connector_future_backpressure",
      message: "Motion job execution failed.",
      retryable: true
    });
    expect(JSON.stringify(failure)).not.toContain("/private/connector");
  });

  it("replaces relative and key-value path-shaped exception text", () => {
    for (const message of ["Could not open assets/input.json", "input=/private/input.json", "Could not open ..\\private\\input.json"]) {
      expect(motionJobFailureFromException(Object.assign(new Error(message), {
        code: "connector_future_backpressure",
        retryable: true
      }), {
        code: "invalid_args", message: "Motion job execution failed."
      })).toEqual({
        code: "connector_future_backpressure",
        message: "Motion job execution failed.",
        retryable: true
      });
    }
  });

  it("keeps a typed exception category while replacing a stack-shaped message", () => {
    const error = Object.assign(new Error("future executor failed\n    at connector-worker:1:1"), {
      code: "connector_future_backpressure",
      retryable: true
    });

    expect(motionJobFailureFromException(error, {
      code: "invalid_args", message: "Motion job execution failed."
    })).toEqual({
      code: "connector_future_backpressure",
      message: "Motion job execution failed.",
      retryable: true
    });
  });
});
