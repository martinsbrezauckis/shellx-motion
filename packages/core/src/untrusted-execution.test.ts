import { describe, expect, it } from "vitest";
import {
  assertDataOnlyForUntrustedExecution,
  classifyMotionPackageExecutionTrust,
  requireEnforcedLinuxBubblewrap,
  UntrustedMotionExecutionRefusal,
} from "./untrusted-execution";

describe("enforced untrusted execution policy", () => {
  it("classifies executable layer kinds, never package provenance, as active content", () => {
    const dataOnly = {
      layers: [{ id: "title", type: "text" }],
      provenance: { sourceApp: "foreign-package", createdBy: "claim:trusted-local-agent" },
      // This is deliberately ignored: package data cannot select a host execution policy.
      untrustedExecution: "enforced",
    } as any;
    const active = {
      layers: [{ id: "panel", type: "web" }, { id: "legacy-html", type: "html" }, { id: "paint", type: "canvas" }],
      provenance: { sourceApp: "foreign-package", createdBy: "claim:trusted-local-agent" },
      untrustedExecution: "enforced",
    } as any;

    expect(classifyMotionPackageExecutionTrust(dataOnly)).toEqual({ classification: "data-only", activeLayerIds: [] });
    expect(classifyMotionPackageExecutionTrust(active)).toEqual({
      classification: "active-content",
      activeLayerIds: ["panel", "legacy-html", "paint"],
    });
    let refusal: unknown;
    try {
      assertDataOnlyForUntrustedExecution(active);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(UntrustedMotionExecutionRefusal);
    expect(refusal).toMatchObject({
      code: "active_content_refused",
      detail: { activeLayerIds: ["panel", "legacy-html", "paint"] },
    });
  });

  it("requires one available, hash-bound Linux Bubblewrap provider", async () => {
    const capability = await requireEnforcedLinuxBubblewrap({
      probe: async () => ({
        schema: "shellx-motion/sandbox-capability@1",
        platform: "linux",
        provider: "linux-bubblewrap",
        status: "available",
        required: false,
        appliedToWorkers: false,
        policy: { network: "denied", filesystem: "read-only-host-probe", process: "new-session" },
        executable: { path: "/usr/bin/bwrap", sha256: "a".repeat(64), versionStatus: "reported", version: "bubblewrap 0.9.0" },
        probe: { kind: "executed", exitCode: 0, outputSha256: "b".repeat(64) },
        createdAt: "2026-08-08T20:00:00.000Z",
      }),
    });

    expect(capability).toEqual({
      provider: "linux-bubblewrap",
      platform: "linux",
      executable: { path: "/usr/bin/bwrap", sha256: "a".repeat(64), version: "bubblewrap 0.9.0" },
      probe: { kind: "executed", exitCode: 0, outputSha256: "b".repeat(64) },
    });
  });

  it("fails closed when no Linux provider is available or the platform is unsupported", async () => {
    const unavailable = requireEnforcedLinuxBubblewrap({
      probe: async () => ({
        schema: "shellx-motion/sandbox-capability@1",
        platform: "linux",
        provider: "linux-bubblewrap",
        status: "unavailable",
        required: false,
        appliedToWorkers: false,
        policy: { network: "not-probed", filesystem: "not-probed", process: "not-probed" },
        probe: { kind: "not-found" },
        reasonCode: "binary_not_found",
        createdAt: "2026-08-08T20:00:00.000Z",
      }),
    });
    await expectRefusalCode(unavailable, "sandbox_unavailable");

    const unsupported = requireEnforcedLinuxBubblewrap({
      probe: async () => ({
        schema: "shellx-motion/sandbox-capability@1",
        platform: "win32",
        provider: "windows-appcontainer",
        status: "unavailable",
        required: false,
        appliedToWorkers: false,
        policy: { network: "not-probed", filesystem: "not-probed", process: "not-probed" },
        probe: { kind: "not-implemented" },
        reasonCode: "provider_not_implemented",
        createdAt: "2026-08-08T20:00:00.000Z",
      }),
    });
    await expectRefusalCode(unsupported, "unsupported_platform");
  });
});

async function expectRefusalCode(
  promise: Promise<unknown>,
  code: UntrustedMotionExecutionRefusal["code"]
): Promise<void> {
  let refusal: unknown;
  try {
    await promise;
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(UntrustedMotionExecutionRefusal);
  expect(refusal).toMatchObject({ code });
}
