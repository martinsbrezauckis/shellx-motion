import type { MotionPackage } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { directGpuHybridTopologyPreflight } from "./streaming-final-adapter-execution.js";
import { prepareAdmittedGpuDelivery, preflightGpuDelivery } from "./streaming-final-gpu.js";

describe("direct GPU hybrid no-pixel preflight", () => {
  it.each([htmlPackage(), restrictedShaderPackage()])("lowers $name without claiming its synthetic topology source as an input", async ({ pkg, producer }) => {
    const input = { pkg, frameLane: "gpu" as const, outputPath: "/not-opened/direct-hybrid.mp4" };
    const staticPlan = preflightGpuDelivery(input);
    expect(staticPlan.ok).toBe(true); if (!staticPlan.ok) return;
    const topology = directGpuHybridTopologyPreflight(staticPlan.staticPlan);
    expect(topology?.sourceSnapshot.producer).toBe(producer);
    const prepared = await prepareAdmittedGpuDelivery(input, staticPlan.staticPlan, {
      job: {
        admission: "pre-acquired", jobId: "direct-hybrid-preflight", scratchRoot: "/not-opened/direct-hybrid-scratch",
        maxProcessTreeRssBytes: 512 * 1024 * 1024, signal: new AbortController().signal, watchProcess() {}, reportSandbox() {}
      },
      runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      hybridTopologyPreflight: topology
    });
    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok || !topology) return;
    expect(Object.values(prepared.delivery.resources.inputHashes)).not.toContain(topology.sourceSnapshot.sourceSnapshotSha256);
    expect(Object.values(prepared.delivery.resources.inputHashes)).not.toContain(topology.sourceSnapshot.captureContractSha256);
    await prepared.delivery.release();
  });
});

function htmlPackage() {
  return packageFor({ id: "surface", type: "html", source: "surface.html", startMs: 0, durationMs: 1_000 }, "strict-data-only-html");
}

function restrictedShaderPackage() {
  return packageFor({ id: "shader", type: "shader", startMs: 0, durationMs: 1_000, transform: { width: 16, height: 8 }, shader: { schema: "shellx-motion/shader-plugin@1", language: "glsl-es-100-expression", fragmentAssetId: "fragment", seed: 1, fallbackColor: "#000000" } }, "isolated-restricted-glsl", [{ id: "fragment", source: { path: "shaders/fragment.glsl", mimeType: "text/x-shellx-motion-glsl" } }]);
}

function packageFor(layer: MotionPackage["motion"]["layers"][number], producer: "strict-data-only-html" | "isolated-restricted-glsl", assets: MotionPackage["motion"]["assets"] = []) {
  const pkg: MotionPackage = {
    root: "/not-opened/direct-hybrid-package",
    manifest: { schema: "shellx-motion/package-manifest@1", id: `direct-${producer}`, name: "direct", motion: "motion.json", assets: producer === "strict-data-only-html" ? ["surface.html"] : ["shaders/fragment.glsl"], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
    motion: { schema: "shellx-motion/motion@1", id: `motion-${producer}`, name: "direct", durationMs: 1_000, fps: 2, width: 16, height: 8, layers: [layer], assets, provenance: { sourceApp: "test", createdBy: "test" } }
  };
  return { name: producer, pkg, producer };
}
