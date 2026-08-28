import { createHash } from "node:crypto";
import { compileGpuSceneStaticPlan, type MotionPackage } from "@shellx-motion/core";
import { describe, expect, it, vi } from "vitest";
import { prepareGpuSegmentedHybridAdmission } from "./gpu-segmented-hybrid-admission";
import { gpuSegmentedHybridAdmissionIdentityProblem } from "./gpu-segmented-hybrid-admission-identity";

const browser = Object.freeze({
  name: "chromium" as const,
  executableSha256: "a".repeat(64),
  runtimePolicy: "borrowed-precontained-chromium-data-only-no-network" as const,
});
const SOURCE = Buffer.from("vec4 motionMain(vec2 uv) { return vec4(uv.x, uv.y, 0.0, 1.0); }");
const SOURCE_SHA256 = createHash("sha256").update(SOURCE).digest("hex");

vi.mock("@shellx-motion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@shellx-motion/core")>(),
  readVerifiedPackageAsset: async () => ({
    bytes: Buffer.from(SOURCE),
    byteLength: SOURCE.byteLength,
    canonicalPath: "/opaque/source.glsl",
    sha256: SOURCE_SHA256,
  }),
}));

describe("GPU segmented hybrid pre-store admission", () => {
  it("accepts a no-version preparation and retains only the immutable source identity", async () => {
    const pkg = await testPackage();
    const staticPlan = strictStaticPlan(pkg);
    const preparation = await prepareGpuSegmentedHybridAdmission({ pkg, staticPlan, browser });

    expect(preparation.identity).toMatchObject({
      schema: "shellx-motion/gpu-segmented-hybrid-preparation@1",
      browser,
      dynamicTexture: { width: 1600, height: 900, bytes: 1600 * 900 * 4 },
    });
    expect("version" in preparation.identity.browser).toBe(false);
    expect(Object.keys(preparation)).toEqual(["identity", "dynamicTexture"]);
  });

  it("refuses a stale caller plan before reading a source or opening Chromium", async () => {
    const pkg = await testPackage();
    const staticPlan = strictStaticPlan(pkg);
    await expect(prepareGpuSegmentedHybridAdmission({
      pkg,
      staticPlan: { ...staticPlan, fingerprint: "0".repeat(64) },
      browser,
    })).rejects.toThrow(/stale or forged Core static plan fingerprint/);
  });

  it("does not let an unrelated hidden hybrid source turn one visible descriptor into two", async () => {
    const pkg = structuredClone(await testPackage()) as MotionPackage;
    const source = pkg.motion.layers.find((layer) => layer.type === "shader");
    if (!source) throw new Error("B2 fixture has no restricted shader layer.");
    (pkg.motion.layers as Array<typeof source>).push({ ...structuredClone(source), id: "hidden-second-surface", visible: false });
    const preparation = await prepareGpuSegmentedHybridAdmission({ pkg, staticPlan: strictStaticPlan(pkg), browser });
    expect(preparation.identity.descriptor.layerId).toBe(source.id);
  });

  it("refuses more than one visible governed hybrid candidate", async () => {
    const pkg = structuredClone(await testPackage()) as MotionPackage;
    const source = pkg.motion.layers.find((layer) => layer.type === "shader");
    if (!source) throw new Error("B2 fixture has no restricted shader layer.");
    (pkg.motion.layers as Array<typeof source>).push({ ...structuredClone(source), id: "second-visible-surface" });
    const compiled = compileGpuSceneStaticPlan(pkg.motion);
    expect(compiled).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
  });

  it("reuses the same frozen source snapshot deterministically without retaining a package-root handle", async () => {
    const pkg = await testPackage();
    const staticPlan = strictStaticPlan(pkg);
    const first = await prepareGpuSegmentedHybridAdmission({ pkg, staticPlan, browser });
    const second = await prepareGpuSegmentedHybridAdmission({ pkg, staticPlan, browser });
    expect(second.identity.sourceSnapshot).toEqual(first.identity.sourceSnapshot);
    expect(second.identity.captureContractSha256).toBe(first.identity.captureContractSha256);
    expect("root" in second).toBe(false);
  });

  it("recomputes finalized admission policy, capture contract, bootstrap, and dynamic-slot binding", async () => {
    const pkg = await testPackage();
    const exact = await prepareGpuSegmentedHybridAdmission({ pkg, staticPlan: strictStaticPlan(pkg), browser });
    const identity = {
      schema: "shellx-motion/gpu-segmented-hybrid-admission@1" as const,
      staticPlanFingerprint: exact.identity.staticPlanFingerprint,
      descriptor: exact.identity.descriptor,
      sourceSnapshot: exact.identity.sourceSnapshot,
      captureContractSha256: exact.identity.captureContractSha256,
      browser: { ...browser, version: "123.0.0" },
      dynamicTexture: exact.identity.dynamicTexture,
      policy: exact.identity.policy,
      bootstrap: { index: 0, atMs: 0, atUs: 0, requestFingerprint: "a".repeat(64), resourceId: exact.dynamicTexture.id, width: exact.dynamicTexture.width, height: exact.dynamicTexture.height, pngSha256: "b".repeat(64), decodedRgbaSha256: "c".repeat(64), cleanup: { captureContext: "closed" as const, scratch: "released" as const, dynamicTexture: exact.dynamicTexture } },
    };
    expect(gpuSegmentedHybridAdmissionIdentityProblem(identity)).toBeNull();
    expect(gpuSegmentedHybridAdmissionIdentityProblem({ ...identity, captureContractSha256: "0".repeat(64) })).toMatch(/capture contract/i);
    expect(gpuSegmentedHybridAdmissionIdentityProblem({ ...identity, policy: { ...identity.policy, network: "egress" } })).toMatch(/policy/i);
    expect(gpuSegmentedHybridAdmissionIdentityProblem({ ...identity, bootstrap: { ...identity.bootstrap, resourceId: "other" } })).toMatch(/bootstrap/i);
  });
});

function strictStaticPlan(pkg: MotionPackage) {
  const compiled = compileGpuSceneStaticPlan(pkg.motion);
  if (!compiled.ok) throw new Error(compiled.failure.message);
  return compiled.plan;
}

async function testPackage(): Promise<MotionPackage> {
  return {
    root: "/opaque/package-root",
    manifest: {
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_b2_admission_test",
      name: "B2 admission test",
      motion: "motion.json",
      assets: ["assets/surface.glsl"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["gpu"], hosts: ["motion"] },
    },
    motion: {
      schema: "shellx-motion/motion@1",
      id: "motion_b2_admission_test",
      name: "B2 admission test",
      durationMs: 1_000,
      fps: 30,
      width: 1600,
      height: 900,
      background: "#000000",
      layers: [{
        id: "shader-surface",
        type: "shader",
        startMs: 0,
        durationMs: 1_000,
        transform: { x: 0, y: 0, width: 1600, height: 900 },
        shader: {
          schema: "shellx-motion/shader-plugin@1",
          language: "glsl-es-100-expression",
          fragmentAssetId: "surface-fragment",
          seed: 7,
          fallbackColor: "#000000",
        },
      }],
      assets: [{ id: "surface-fragment", type: "shader", source: { path: "assets/surface.glsl", mimeType: "text/x-shellx-motion-glsl" } }],
    },
  } as MotionPackage;
}
