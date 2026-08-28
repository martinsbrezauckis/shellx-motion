import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import {
  compileGpuHybridTextureRequests,
  createGpuHybridTextureResourceBinding,
  createGpuHybridTextureSourceSnapshot,
  deriveGpuHybridTextureStaticDescriptor,
  gpuHybridTextureRequestProblem,
  gpuHybridTextureResourceBindingProblem,
  type GpuHybridTextureRequest,
  type GpuHybridTextureStaticDescriptor
} from "./gpu-hybrid-texture-request";
import { loadSchema, validateDocument } from "./validate";
import { validateMotionDocumentInStages } from "./motion-validation";
import type { MotionDocument, MotionLayer } from "./types";

const HASH_A = "a".repeat(64), HASH_B = "b".repeat(64), HASH_C = "c".repeat(64);

function document(layers: MotionLayer[], overrides: Partial<MotionDocument> = {}): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "hybrid-texture", name: "Hybrid texture", durationMs: 2_000, fps: 10, width: 320, height: 180,
    background: "transparent", assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers, ...overrides
  };
}
function web(id = "surface", startMs = 0, durationMs = 2_000): MotionLayer {
  return { id, type: "html", source: "surfaces/card.html", startMs, durationMs, transform: { width: 160, height: 90 } };
}
function descriptor(motion: MotionDocument, id = "surface"): GpuHybridTextureStaticDescriptor {
  const layer = motion.layers.find((candidate) => candidate.id === id);
  if (!layer) throw new Error(`missing layer ${id}`);
  const value = deriveGpuHybridTextureStaticDescriptor(motion, layer);
  if (!value) throw new Error(`missing descriptor ${id}`);
  return value;
}
function snapshot(value: GpuHybridTextureStaticDescriptor) {
  return createGpuHybridTextureSourceSnapshot({ descriptor: value, sourceSnapshotSha256: HASH_A, sourceByteLength: value.producer === "strict-data-only-html" ? 64 : 32, captureContractSha256: HASH_B });
}
function requestAt(motion: MotionDocument, atUs: number, id = "surface"): GpuHybridTextureRequest {
  const value = descriptor(motion, id);
  const result = compileGpuHybridTextureRequests({ motion, atUs, snapshots: new Map([[id, snapshot(value)]]) });
  expect(result).toMatchObject({ ok: true });
  if (!result.ok || result.requests.length !== 1) throw new Error("expected one request");
  return result.requests[0];
}
function strictResources(request: GpuHybridTextureRequest) {
  const binding = createGpuHybridTextureResourceBinding({ request, resourceId: `texture-${request.layerId}`, decodedRgbaSha256: HASH_C });
  return { hybridTextureRequests: new Map([[request.layerId, request]]), hybridTextures: new Map([[request.layerId, binding]]) };
}

describe("GPU governed hybrid texture requests", () => {
  it("derives a closed root descriptor, mints deterministic integer-us requests, and preserves generic browser compatibility", () => {
    const motion = document([web()]);
    const staticPlan = compileGpuSceneStaticPlan(motion);
    expect(staticPlan).toMatchObject({ ok: true, plan: { hybridTextures: [{ producer: "strict-data-only-html", layerId: "surface", assetRef: "surfaces/card.html", width: 320, height: 180 }] } });
    const first = requestAt(motion, 0), replay = requestAt(structuredClone(motion), 0);
    expect(replay).toEqual(first);
    expect(first.atUs).toBe(0);
    expect(JSON.stringify(first)).not.toMatch(/browser|executable|wgsl|javascript/i);
    expect(compileGpuScene2dPlan(motion, 0, strictResources(first))).toMatchObject({ ok: true, plan: { browserSurfaceCount: 1 } });
    expect(compileGpuScene2dPlan(motion, 0, { browserSurfaces: new Map([["surface", { resourceId: "legacy", assetRef: "surfaces/card.html", width: 320, height: 180, sha256: HASH_A }]]) })).toMatchObject({ ok: true, plan: { browserSurfaceCount: 1 } });
  });

  it("uses root exact time while nested group visibility uses the local child clock, including nonzero start and end boundary", () => {
    const child = web("nested", 0, 1_000);
    const motion = document([
      { id: "pack", type: "group", startMs: 1_000, durationMs: 1_000, childLayerIds: ["nested"] },
      child
    ]);
    const before = compileGpuHybridTextureRequests({ motion, atUs: 999_000, snapshots: new Map() });
    expect(before).toEqual({ ok: true, requests: [] });
    const active = requestAt(motion, 1_000_000, "nested");
    expect(active.atUs).toBe(1_000_000);
    expect(compileGpuScene2dPlan(motion, 1_000, strictResources(active))).toMatchObject({ ok: true, plan: { browserSurfaceCount: 1 } });
    const end = compileGpuHybridTextureRequests({ motion, atUs: 2_000_000, snapshots: new Map() });
    expect(end).toEqual({ ok: true, requests: [] });
    expect(compileGpuHybridTextureRequests({ motion, atUs: 2_000_001, snapshots: new Map() })).toMatchObject({ ok: false, failure: { code: "gpu_invalid_time" } });
    expect(compileGpuScene2dPlan(motion, 2_000, { hybridTextureRequests: new Map(), hybridTextures: new Map() })).toMatchObject({ ok: true, plan: { browserSurfaceCount: 0 } });
  });

  it("requires no snapshot while inactive and rejects unknown, missing, forged, or mismatched strict records", () => {
    const motion = document([web("later", 500, 1_000)]);
    expect(compileGpuHybridTextureRequests({ motion, atUs: 499_000, snapshots: new Map() })).toEqual({ ok: true, requests: [] });
    expect(compileGpuHybridTextureRequests({ motion, atUs: 499_000, snapshots: new Map([["later", snapshot(descriptor(motion, "later"))]]) })).toMatchObject({ ok: false, failure: { message: expect.stringContaining("exactly the active") } });
    const request = requestAt(motion, 500_000, "later");
    expect(gpuHybridTextureRequestProblem({ ...request, foreign: true } as unknown as GpuHybridTextureRequest)).toBe("contains unknown or missing fields");
    const missing = { ...request }; delete (missing as Partial<GpuHybridTextureRequest>).requestFingerprint;
    expect(gpuHybridTextureRequestProblem(missing as GpuHybridTextureRequest)).toBe("contains unknown or missing fields");
    const binding = createGpuHybridTextureResourceBinding({ request, resourceId: "texture-later", decodedRgbaSha256: HASH_C });
    expect(gpuHybridTextureResourceBindingProblem({ ...binding, foreign: true } as unknown as typeof binding)).toBe("contains unknown or missing fields");
    expect(compileGpuScene2dPlan(motion, 500, {
      hybridTextureRequests: new Map([["later", request]]),
      hybridTextures: new Map([["later", { ...binding, sourceSnapshotSha256: HASH_B }]])
    })).toMatchObject({ ok: false, failure: { message: expect.stringContaining("does not match the active exact-time request") } });
  });

  it("keeps nonhybrid static-plan@1 shape and fingerprint payload unchanged", () => {
    const motion = document([{ id: "rect", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 2_000, transform: { width: 10, height: 10 } }]);
    const result = compileGpuSceneStaticPlan(motion);
    expect(result).toMatchObject({ ok: true }); if (!result.ok) return;
    expect(result.plan).not.toHaveProperty("hybridTextures");
    expect(result.plan.fingerprint).toBe("55010bb3a014bd14aeb60e474a8515af20a8d4a393b7aa64527de66f9f6910e3");
  });

  it("loads Tideglass fixture JSON semantically and plans a restricted descriptor plus four independent range-compatible exact requests", async () => {
    const root = resolve(import.meta.dirname, "../../../fixtures/packages/gpu-v25b2-tideglass-almanac");
    const [manifest, motionText] = await Promise.all([readFile(resolve(root, "manifest.json"), "utf8"), readFile(resolve(root, "motion.json"), "utf8")]);
    const motion = JSON.parse(motionText) as MotionDocument;
    expect(await validateDocument(await loadSchema("packageManifest"), JSON.parse(manifest))).toEqual({ ok: true });
    expect(await validateMotionDocumentInStages(motion)).toMatchObject({ ok: true });
    const staticPlan = compileGpuSceneStaticPlan(motion);
    expect(staticPlan).toMatchObject({ ok: true, plan: { hybridTextures: [{ layerId: "tideglass-window", producer: "isolated-restricted-glsl", assetRef: "assets/tideglass-almanac.glsl", width: 1_600, height: 900, restrictedShader: { uniformNames: ["u_drift", "u_speed"] } }] } });
    const value = descriptor(motion, "tideglass-window");
    const source = snapshot(value);
    const requests = [0, 3_000_000, 6_000_000, 9_000_000].map((atUs) => compileGpuHybridTextureRequests({ motion, atUs, snapshots: new Map([["tideglass-window", source]]) }));
    expect(requests.every((result) => result.ok && result.requests.length === 1)).toBe(true);
    const fingerprints = requests.map((result) => result.ok ? result.requests[0].requestFingerprint : "");
    expect(new Set(fingerprints).size).toBe(4);
  });
});
