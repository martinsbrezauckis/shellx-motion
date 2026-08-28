import { describe, expect, it } from "vitest";
import { dispatchDomainCommand } from "./router.js";

describe("browser workflow path fences", () => {
  it("refuses preview and capture workflow files outside trusted roots before any read or render", async () => {
    let calls = 0;
    const services = {
      scratchRoot: "/trusted/scratch",
      qualityInputRoots: ["/trusted/quality"],
      isPathInsideTrustedRoot: async () => false,
      readJson: async () => { calls += 1; return {}; },
      packageLoader: async () => { calls += 1; throw new Error("must not load"); },
      browserFrameRenderer: async () => { calls += 1; throw new Error("must not render"); },
      ensureDirectory: async () => { calls += 1; },
      publishJsonSidecar: async () => { calls += 1; }
    };

    expect(await dispatchDomainCommand("render", "motion.preview.frame", {
      packageRoot: "/trusted/package",
      workflowPath: "/outside/workflow.json"
    }, services)).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "motion.preview.frame workflowPath must be inside packageRoot or a trusted debug input root." }
    });
    expect(await dispatchDomainCommand("integration", "motion.browser.workflow.capture", {
      packageRoot: "/trusted/package",
      workflowPath: "/outside/workflow.json"
    }, services)).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "motion.browser.workflow.capture workflowPath must be inside packageRoot or a trusted debug input root." }
    });
    expect(calls).toBe(0);
  });
});
