import { describe, expect, it } from "vitest";
import { isExpectedGpuHttpRefusal } from "./workbench-gpu-http-refusal";

describe("Workbench active GPU proof HTTP refusals", () => {
  it("accepts typed GPU failures at their actual raw Debug API status", () => {
    expect(isExpectedGpuHttpRefusal(503, false, "gpu_hardware_unavailable")).toBe(true);
    expect(isExpectedGpuHttpRefusal(503, false, "gpu_browser_unavailable")).toBe(true);
    expect(isExpectedGpuHttpRefusal(500, false, "gpu_execution_refused")).toBe(true);
  });

  it("rejects status/code mismatches, untyped failures, and non-GPU 503s", () => {
    expect(isExpectedGpuHttpRefusal(500, false, "gpu_hardware_unavailable")).toBe(false);
    expect(isExpectedGpuHttpRefusal(503, false, "gpu_execution_refused")).toBe(false);
    expect(isExpectedGpuHttpRefusal(503, false, "gpu_unknown_unavailable")).toBe(false);
    expect(isExpectedGpuHttpRefusal(503, false, "capability_unavailable")).toBe(false);
    expect(isExpectedGpuHttpRefusal(503, true, "gpu_hardware_unavailable")).toBe(false);
    expect(isExpectedGpuHttpRefusal(503, null, "gpu_hardware_unavailable")).toBe(false);
    expect(isExpectedGpuHttpRefusal(502, false, "gpu_hardware_unavailable")).toBe(false);
  });
});
