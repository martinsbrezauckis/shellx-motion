import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const browserResolver = vi.hoisted(() => ({
  resolve: vi.fn(),
  verificationProblem: vi.fn(),
  refusals: vi.fn()
}));

vi.mock("@shellx-motion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shellx-motion/core")>()),
  resolveMotionBrowserExecutable: browserResolver.resolve,
  motionBrowserExecutableVerificationProblem: browserResolver.verificationProblem,
  untrustedMotionBrowserCaches: browserResolver.refusals
}));

import { motionToolReport, probeMotionTool } from "./index.js";

describe("Chromium cache revalidation diagnostics", () => {
  beforeEach(() => {
    browserResolver.resolve.mockReturnValue({
      executable: "/cache/chromium-1234/chrome-linux64/chrome",
      source: "path",
      autoDiscoveredCache: true
    });
    browserResolver.verificationProblem.mockReturnValue(
      "the auto-discovered Playwright cache executable no longer passes canonical-path, ownership, mode, and regular-file checks"
    );
    browserResolver.refusals.mockReturnValue([{
      path: "/cache/chromium-1234",
      label: "chromium-1234 in the Playwright cache under HOME/.cache",
      reason: "it is group-writable"
    }]);
  });

  afterEach(() => { vi.clearAllMocks(); });

  it("keeps a fresh cache refusal visible when revalidation prevents a browser probe", async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: "must not run", stderr: "" }));

    const probe = await probeMotionTool("chromium", runner);

    expect(runner).not.toHaveBeenCalled();
    expect(probe).toMatchObject({
      tool: "chromium",
      status: "broken",
      problem: "the auto-discovered Playwright cache executable no longer passes canonical-path, ownership, mode, and regular-file checks",
      notes: ["Motion did not use chromium-1234 in the Playwright cache under HOME/.cache because it is group-writable."]
    });
    expect(motionToolReport(probe).problem).toContain("chromium-1234 in the Playwright cache under HOME/.cache because it is group-writable");
  });
});
