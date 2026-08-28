import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HDR10_CLAMP_NITS,
  HDR10_RGBA16FLOAT_BYTES,
  SCENE3D_GLTF_PBR_HDR10_ADMISSION,
  SCENE3D_GLTF_PBR_HDR10_ADMISSION_FINGERPRINT,
  linearSrgbD65ToRec2020Nits,
  rec2020NitsToPq,
} from "./scene-3d-gltf-pbr-hdr10-contract";
import {
  hasScene3dGltfPbrHdr10FinalLocator,
  resolveScene3dGltfPbrHdr10FinalRoute,
  scene3dGltfPbrHdr10FinalLocatorManifestData,
} from "./scene-3d-gltf-pbr-hdr10-final-route";
import { deriveScene3dGltfPbrHdr10StaticPlan } from "./scene-3d-gltf-pbr-hdr10-plan";
import type { Scene3dGltfPbrFinalRoute } from "./scene-3d-gltf-material-final-route";
import type { MotionPackage } from "./types";

const mocks = vi.hoisted(() => ({ loadPackage: vi.fn(), loadedHashes: vi.fn(), resolveSdr: vi.fn() }));
vi.mock("./package", () => ({ loadMotionPackage: mocks.loadPackage }));
vi.mock("./package-loaded-inputs", () => ({ requiredLoadedPackageDocumentHashes: mocks.loadedHashes }));
vi.mock("./scene-3d-gltf-material-final-route", () => ({ resolveScene3dGltfPbrFinalRoute: mocks.resolveSdr }));

const HASH = "a".repeat(64);
beforeEach(() => { mocks.loadPackage.mockReset(); mocks.loadedHashes.mockReset(); mocks.resolveSdr.mockReset(); });

describe("private static glTF PBR HDR10 contract", () => {
  it("pins the fixed Rec.2020/PQ/Main10 contract and immutable no-feature identity", () => {
    expect(SCENE3D_GLTF_PBR_HDR10_ADMISSION_FINGERPRINT).toBe("7f2ace036507ca86cbb8eb58f5f3894eac37fa69bbe0700e6810210f5d28ca27");
    expect(SCENE3D_GLTF_PBR_HDR10_ADMISSION).toMatchObject({
      source: { primaries: "srgb-d65", transfer: "linear", textureFormat: "rgba8unorm-srgb" },
      working: { primaries: "rec2020-d65", referenceWhiteNits: 203, clampNits: 1000, targetFormat: "rgba16float" },
      readback: { format: "rgba16float-le", byteLength: HDR10_RGBA16FLOAT_BYTES, maxChunkBytes: 65_536 },
      output: { transfer: "smpte2084", primaries: "bt2020", matrix: "bt2020nc", range: "tv", pixelFormat: "yuv420p10le", encoder: "libx265", encoderClass: "software-only", profile: "main10", container: "mp4", codecTag: "hvc1", contentLight: "not-signaled", ffmpegSignal: { colorPrimaries: "bt2020", colorTransfer: "smpte2084", colorSpace: "bt2020nc", colorRange: "tv" } },
    });
    expect(Object.isFrozen(SCENE3D_GLTF_PBR_HDR10_ADMISSION)).toBe(true);
    expect(Object.isFrozen(SCENE3D_GLTF_PBR_HDR10_ADMISSION.source.toWorkingMatrix)).toBe(true);
  });

  it("converts only finite linear sRGB values through the fixed reference-white clamp and PQ", () => {
    for (const channel of linearSrgbD65ToRec2020Nits([1, 1, 1])) expect(channel).toBeCloseTo(203, 12);
    expect(linearSrgbD65ToRec2020Nits([10, 10, 10])).toEqual([HDR10_CLAMP_NITS, HDR10_CLAMP_NITS, HDR10_CLAMP_NITS]);
    expect(rec2020NitsToPq(0)).toBe(0);
    expect(rec2020NitsToPq(203)).toBeCloseTo(0.580688881, 8);
    expect(() => linearSrgbD65ToRec2020Nits([-1, 0, 0])).toThrow(/finite non-negative/);
    expect(() => rec2020NitsToPq(1_001)).toThrow(/0..1000-nit/);
  });

  it("derives a frozen HDR static identity only from an opaque, hash-bound SDR route", () => {
    const plan = deriveScene3dGltfPbrHdr10StaticPlan(route());
    expect(plan.fingerprint).toBe("de6358c2a56b2fa679d8c9b438c895825c1370a57d583a015a3d9ec767872ebd");
    expect(plan.resourceFacts).toEqual({
      staticGpuBytes: 1_024, rgba16floatTargetBytes: 7_372_800, depthTargetBytes: 3_686_400,
      rgba16floatReadbackBytes: 7_372_800, frameGpuBytes: 11_060_224, peakGpuBytes: 18_433_024,
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.resourceFacts)).toBe(true);
  });

  it("refuses transparent, stale, non-PBR, and over-ceiling inherited routes", () => {
    const transparent = route(Buffer.from([0x11, 0x22, 0x33, 0x00]));
    expect(() => deriveScene3dGltfPbrHdr10StaticPlan(transparent)).toThrow(/opaque/);
    const stale = route();
    (stale.renderPlan.textures[0]!.rgba as Buffer)[0] = 0;
    expect(() => deriveScene3dGltfPbrHdr10StaticPlan(stale)).toThrow(/decoded identity/);
    const divergentStatic = route();
    (divergentStatic.renderPlan.staticPlan.textures[0] as { decodedRgbaSha256: string }).decodedRgbaSha256 = "0".repeat(64);
    expect(() => deriveScene3dGltfPbrHdr10StaticPlan(divergentStatic)).toThrow(/does not match its inherited SDR static plan/);
    const alteredFactor = route();
    (alteredFactor.renderPlan.staticPlan.primitives[0]!.material.baseColorFactor as unknown as number[])[3] = 0.5;
    expect(() => deriveScene3dGltfPbrHdr10StaticPlan(alteredFactor)).toThrow(/finite opaque/);
    const overCeiling = route();
    (overCeiling.renderPlan.staticPlan.budget as { gpuResourceBytes: number }).gpuResourceBytes = 48 * 1024 * 1024 + 1;
    expect(() => deriveScene3dGltfPbrHdr10StaticPlan(overCeiling)).toThrow(/static GPU resources exceed/);
  });

  it("keeps an authenticated absent marker on the legacy branch without requiring HDR catalogs", async () => {
    const pkg = packageFixture({ adapter: {} }); authenticate(pkg, pkg);
    await expect(resolveScene3dGltfPbrHdr10FinalRoute(pkg, { sdrRendererCatalogSha256: "bad", hdr10RendererCatalogSha256: "bad" })).resolves.toEqual({ kind: "absent" });
    const marker = scene3dGltfPbrHdr10FinalLocatorManifestData("gltf-scene");
    expect(marker).toEqual({ scene3dGltfPbrHdr10Final: { schema: "shellx-motion/scene3d-gltf-pbr-hdr10-final-locator@1", sceneLayerId: "gltf-scene" } });
    expect(hasScene3dGltfPbrHdr10FinalLocator({ adapter: marker })).toBe(true);
    expect(hasScene3dGltfPbrHdr10FinalLocator({ adapter: {} })).toBe(false);
  });

  it("refuses a stale or malformed present marker before the SDR route can provide a fallback", async () => {
    const stale = packageFixture({ adapter: {} }), changed = packageFixture({ adapter: scene3dGltfPbrHdr10FinalLocatorManifestData("gltf-scene") });
    authenticate(stale, changed);
    await expect(resolveScene3dGltfPbrHdr10FinalRoute(stale, catalogs())).rejects.toThrow(/package bytes changed/);
    const malformed = packageFixture({ adapter: { scene3dGltfPbrHdr10Final: { schema: "wrong", sceneLayerId: "gltf-scene" } } }); authenticate(malformed, malformed);
    await expect(resolveScene3dGltfPbrHdr10FinalRoute(malformed, catalogs())).rejects.toThrow(/locator is invalid/);
    expect(mocks.resolveSdr).not.toHaveBeenCalled();
  });
});

function route(rgba = Buffer.from([0x11, 0x22, 0x33, 0xff])): Scene3dGltfPbrFinalRoute {
  const decodedRgbaSha256 = hash(rgba);
  return {
    schema: "shellx-motion/scene3d-gltf-pbr-final-route@1", packageId: "pkg_hdr10", locator: { schema: "shellx-motion/scene3d-gltf-pbr-final-locator@1", sceneLayerId: "gltf-scene" },
    sceneStateSha256: HASH, rendererCatalogSha256: "b".repeat(64), fingerprint: "c".repeat(64), inputHashes: {},
    renderPlan: {
      staticPlan: {
        schema: "shellx-motion/scene3d-gltf-material-render-static@1", source: { format: "gltf", sha256: "d".repeat(64) }, sceneStateSha256: HASH,
        fingerprint: "e".repeat(64), pbr: { abi: "shellx-motion/browser-scene3d-gltf-pbr-sdr@1", baseColorTextureFormat: "rgba8unorm-srgb", baseColorTextureTransfer: "srgb-to-linear-hardware", factorSpace: "linear-gltf", brdf: "ggx-smith-schlick-directional@1", ambient: "bounded-diffuse@1", outputTransfer: "linear-to-srgb-explicit" },
        textures: [{ resourceId: "texture-a", decodedRgbaByteLength: rgba.byteLength, decodedRgbaSha256 }],
        primitives: [{ material: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0.5, roughnessFactor: 0.5, emissiveFactor: [0, 0, 0], textureResourceId: "texture-a" } }],
        budget: { gpuResourceBytes: 1_024 },
      },
      framePlan: { schema: "shellx-motion/scene3d-gltf-material-render-frame@1", staticFingerprint: "e".repeat(64), sceneStateSha256: HASH, pbrAbi: "shellx-motion/browser-scene3d-gltf-pbr-sdr@1", fingerprint: "f".repeat(64) },
      textures: [{ resourceId: "texture-a", rgba, decodedRgbaByteLength: rgba.byteLength, decodedRgbaSha256 }],
    },
  } as unknown as Scene3dGltfPbrFinalRoute;
}
function hash(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function catalogs() { return { sdrRendererCatalogSha256: "1".repeat(64), hdr10RendererCatalogSha256: "2".repeat(64) }; }
function packageFixture(data: unknown): MotionPackage { return { root: "/package", manifest: { id: "pkg_hdr10", motion: "motion.json", data }, motion: {} } as unknown as MotionPackage; }
function authenticate(caller: MotionPackage, reopened: MotionPackage): void {
  mocks.loadPackage.mockResolvedValue(reopened);
  mocks.loadedHashes.mockImplementation((pkg: MotionPackage) => ({ "manifest.json": pkg === caller ? "a".repeat(64) : "b".repeat(64), "motion.json": pkg === caller ? "c".repeat(64) : "d".repeat(64) }));
  if (caller === reopened) mocks.loadedHashes.mockImplementation(() => ({ "manifest.json": "a".repeat(64), "motion.json": "c".repeat(64) }));
}
