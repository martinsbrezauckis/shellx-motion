import { describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index.js";

describe("motion.platform.gpu.probe", () => {
  it("requires render authority because it opens a pre-contained WebGPU browser", async () => {
    const result = await dispatchDebugCommand("motion.platform.gpu.probe", {}, { tier: "read_motion" });
    expect(result).toMatchObject({ ok: false, error: { code: "permission_denied" } });
  });

  it.each([{}, { confirm: false }, { confirm: "true" }, { confirm: true, unrelated: true }])("refuses an unconfirmed or unknown argument shape before any GPU launch", async (args) => {
    let calls = 0;
    const result = await dispatchDebugCommand("motion.platform.gpu.probe", args, {
      tier: "render_motion",
      gpuHardwareProbeRunner: async () => {
        calls += 1;
        throw new Error("the runner must not be reached without exact confirmation");
      }
    });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
  });

  it("returns only the host-issued typed proof, never a caller-provided receipt", async () => {
    let calls = 0;
    const proof = {
      schema: "shellx-motion/gpu-active-host-proof@1",
      capturedAt: "2026-08-13T12:00:00.000Z",
      validForMs: 600_000,
      platform: "linux",
      browser: { source: "path", executableSha256: "a".repeat(64), version: "140.0.0.0" },
      launch: { hardwareArgs: [], chromiumSandbox: true, ignoredDefaultArgs: ["--enable-unsafe-swiftshader"], finalContainment: "precontained-direct-chromium" },
      runtime: { adapterFingerprint: "b".repeat(64) },
      receipt: { operation: "gpu.hardware.probe", lane: "gpu", status: "passed" }
    };
    const result = await dispatchDebugCommand("motion.platform.gpu.probe", { confirm: true }, {
      tier: "render_motion",
      gpuHardwareProbeRunner: async () => {
        calls += 1;
        return { ok: true, proof, frame: { width: 4, height: 4, sha256: "c".repeat(64) } } as never;
      }
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      visibleState: { operation: "gpu.hardware.probe", gpuProofStatus: "passed", frameWidth: 4, frameHeight: 4 },
      result: { proof, frame: { width: 4, height: 4, sha256: "c".repeat(64) } }
    });
  });
});
