import { describe, expect, it } from "vitest";
import { gpuResumeContainmentCeiling } from "./render-segment-gpu-resume-ceiling.js";

const GIB = 1024 ** 3;
const manifest = (maxProcessTreeRssBytes: unknown): unknown => ({
  producer: { identity: { hostVerdict: { containment: { maxProcessTreeRssBytes } } } }
});

describe("segmented GPU resume containment ceiling", () => {
  it("reuses an exact stored ceiling only as a safe bound below the current governor", () => {
    expect(gpuResumeContainmentCeiling(manifest(20 * GIB), 21 * GIB)).toBe(20 * GIB);
    expect(gpuResumeContainmentCeiling(manifest(20 * GIB), 20 * GIB)).toBe(20 * GIB);
  });

  it("refuses a stored escalation, malformed value, or missing identity", () => {
    expect(() => gpuResumeContainmentCeiling(manifest(21 * GIB), 20 * GIB)).toThrow("exceeds");
    expect(() => gpuResumeContainmentCeiling(manifest("20 GiB"), 20 * GIB)).toThrow("invalid");
    expect(() => gpuResumeContainmentCeiling({}, 20 * GIB)).toThrow("invalid");
  });
});
