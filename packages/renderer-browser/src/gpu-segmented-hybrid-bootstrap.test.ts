import { createHash } from "node:crypto";
import { compileGpuSceneStaticPlan, type MotionPackage } from "@shellx-motion/core";
import { describe, expect, it, vi } from "vitest";
import { prepareGpuSegmentedHybridAdmission } from "./gpu-segmented-hybrid-admission";
import { bootstrapGpuSegmentedHybridAdmission } from "./gpu-segmented-hybrid-bootstrap";

const source = Buffer.from("vec4 motionMain(vec2 uv) { return vec4(uv.x, uv.y, 0.0, 1.0); }");
const sourceSha = createHash("sha256").update(source).digest("hex");
const hash = "a".repeat(64);
const state = vi.hoisted(() => ({ closes: 0, opens: 0 }));

vi.mock("@shellx-motion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@shellx-motion/core")>(),
  readVerifiedPackageAsset: async () => ({ bytes: Buffer.from(source), byteLength: source.byteLength, canonicalPath: "/opaque/source.glsl", sha256: sourceSha }),
}));

vi.mock("./gpu-segmented-hybrid-range", () => ({
  openGpuSegmentedHybridRangeCapture(input: { admission: { dynamicTexture: { id: string; width: number; height: number } }; range: { index: number; startFrameIndex: number; endFrameIndexExclusive: number }; schedule: Array<{ index: number; atMs: number; request: { atUs: number; requestFingerprint: string } }> }) {
    state.opens += 1;
    const scheduled = input.schedule[0]!;
    const entry = { index: scheduled.index, atMs: scheduled.atMs, atUs: scheduled.request.atUs, requestFingerprint: scheduled.request.requestFingerprint, resourceId: input.admission.dynamicTexture.id, width: input.admission.dynamicTexture.width, height: input.admission.dynamicTexture.height, pngSha256: hash, decodedRgbaSha256: "b".repeat(64) };
    return {
      identity: {} as never,
      async capture() { return { resourceId: entry.resourceId, width: entry.width, height: entry.height } as never; },
      finish() { return { schema: "shellx-motion/gpu-segmented-hybrid-range-ledger@1", rangeIndex: input.range.index, startFrameIndex: input.range.startFrameIndex, endFrameIndexExclusive: input.range.endFrameIndexExclusive, expectedCaptureCount: 1, captureCount: 1, entries: [entry], sequenceSha256: hash }; },
      async close() { state.closes += 1; return { captureContext: "closed", scratch: "released", dynamicTexture: input.admission.dynamicTexture }; },
    };
  },
}));

describe("GPU segmented hybrid bootstrap", () => {
  it("binds the opened borrowed-runtime version only after a closed canonical bootstrap capture", async () => {
    state.opens = 0; state.closes = 0;
    const pkg = testPackage();
    const staticPlan = compileGpuSceneStaticPlan(pkg.motion);
    if (!staticPlan.ok) throw new Error(staticPlan.failure.message);
    const preparation = await prepareGpuSegmentedHybridAdmission({ pkg, staticPlan: staticPlan.plan, browser: { name: "chromium", executableSha256: hash, runtimePolicy: "borrowed-precontained-chromium-data-only-no-network" } });
    expect("version" in preparation.identity.browser).toBe(false);
    const admission = await bootstrapGpuSegmentedHybridAdmission({ preparation, runtime: { browserVersion: "123.0.0" } as never, job: { admission: "pre-acquired", scratchRoot: "/opaque/scratch", maxProcessTreeRssBytes: 1, signal: new AbortController().signal, watchProcess() {} } as never });
    expect(admission.identity.browser.version).toBe("123.0.0");
    expect(admission.identity.bootstrap).toMatchObject({ resourceId: preparation.dynamicTexture.id, width: 16, height: 16, cleanup: { captureContext: "closed", scratch: "released" } });
    expect(state).toEqual({ opens: 1, closes: 1 });
  });
});

function testPackage(): MotionPackage {
  return {
    root: "/opaque/package-root", manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_b2_bootstrap", name: "B2 bootstrap", motion: "motion.json", assets: ["assets/surface.glsl"], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
    motion: { schema: "shellx-motion/motion@1", id: "motion_b2_bootstrap", name: "B2 bootstrap", durationMs: 1_000, fps: 30, width: 16, height: 16, background: "#000000", layers: [{ id: "shader", type: "shader", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 16, height: 16 }, shader: { schema: "shellx-motion/shader-plugin@1", language: "glsl-es-100-expression", fragmentAssetId: "source", seed: 1, fallbackColor: "#000000" } }], assets: [{ id: "source", type: "shader", source: { path: "assets/surface.glsl", mimeType: "text/x-shellx-motion-glsl" } }] },
  } as MotionPackage;
}
