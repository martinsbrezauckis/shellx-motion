import { canonicalJsonSha256 } from "@shellx-motion/core";
import type { Scene3dGltfPbrFinalRoute } from "@shellx-motion/core/internal/scene3d-gltf-pbr-final";
import { describe, expect, it } from "vitest";
import { GPU_PAGE_SCENE3D_GLTF_PBR_CATALOG } from "./gpu-page-scene3d-gltf-pbr-contract";
import { createGpuScene3dGltfPbrStreamingProducer } from "./gpu-scene3d-gltf-pbr-streaming-producer";

const HASH = "a".repeat(64);

describe("immutable glTF PBR streaming producer route", () => {
  it("requires one matching canonical scene-state identity before Browser resources can be opened", () => {
    const producer = createGpuScene3dGltfPbrStreamingProducer(route(), { width: 1280, height: 720, fps: 30, durationMs: 1_000 });
    expect(producer.evidence).toMatchObject({ sceneStateSha256: HASH, readback: { readbackBufferAllocations: 0 } });

    const stale = route();
    (stale.renderPlan as { staticPlan: { sceneStateSha256: string } }).staticPlan.sceneStateSha256 = "b".repeat(64);
    expect(() => createGpuScene3dGltfPbrStreamingProducer(stale, { width: 1280, height: 720, fps: 30, durationMs: 1_000 }))
      .toThrow(/exact immutable canonical-scene/);
  });
});

function route(): Scene3dGltfPbrFinalRoute {
  const inputHashes = {
    "scene3d-gltf-pbr-manifest": HASH,
    "scene3d-gltf-pbr-motion": HASH,
    "scene3d-gltf-pbr-source": HASH,
    "scene3d-gltf-pbr-sidecar": HASH,
    "scene3d-gltf-pbr-sidecar-receipt": HASH,
    "scene3d-gltf-pbr-declaration": HASH,
    "scene3d-gltf-pbr-static-plan": HASH,
    "scene3d-gltf-pbr-frame-plan": HASH,
    "scene3d-gltf-pbr-catalog": GPU_PAGE_SCENE3D_GLTF_PBR_CATALOG.sha256,
    "scene3d-gltf-pbr-scene-state": HASH,
  };
  const base = {
    schema: "shellx-motion/scene3d-gltf-pbr-final-route@1",
    packageId: "pkg-pbr",
    locator: { schema: "shellx-motion/scene3d-gltf-pbr-final-locator@1", sceneLayerId: "gltf-scene" },
    sceneStateSha256: HASH,
    inputHashes,
    rendererCatalogSha256: GPU_PAGE_SCENE3D_GLTF_PBR_CATALOG.sha256,
  };
  return {
    ...base,
    renderPlan: { staticPlan: { fingerprint: HASH, sceneStateSha256: HASH }, framePlan: { fingerprint: HASH, staticFingerprint: HASH, sceneStateSha256: HASH } },
    fingerprint: canonicalJsonSha256(base),
  } as unknown as Scene3dGltfPbrFinalRoute;
}
