import { canonicalJsonSha256 } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { gpuFinalReceiptInputHashes } from "./gpu-final-receipt-provenance.js";

const HASH = "a".repeat(64);

describe("fixed glTF PBR final receipt provenance", () => {
  it("binds only the authenticated PBR route identities after terminal cleanup", () => {
    const hashes = gpuFinalReceiptInputHashes({ frameLane: "gpu-pbr", evidence: evidence() } as never);
    expect(hashes).toEqual({
      "scene3d-gltf-pbr-route": HASH,
      "scene3d-gltf-pbr-manifest": HASH,
      "scene3d-gltf-pbr-motion": HASH,
      "scene3d-gltf-pbr-source": HASH,
      "scene3d-gltf-pbr-sidecar": HASH,
      "scene3d-gltf-pbr-sidecar-receipt": HASH,
      "scene3d-gltf-pbr-declaration": HASH,
      "scene3d-gltf-pbr-static-plan": HASH,
      "scene3d-gltf-pbr-frame-plan": HASH,
      "scene3d-gltf-pbr-catalog": HASH,
      "scene3d-gltf-pbr-scene-state": HASH,
      "scene3d-gltf-pbr-adapter": HASH,
      "scene3d-gltf-pbr-frame-sequence": HASH,
      "scene3d-gltf-pbr-frame-plan-sequence": HASH,
      "scene3d-gltf-pbr-producer": expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Object.keys(hashes ?? {})).not.toContain("scene3d-gltf-pbr-raw-rgba");
  });

  it("refuses stale evidence fingerprints, unexpected route keys, and incomplete terminal cleanup", () => {
    const admitted = evidence();
    expect(gpuFinalReceiptInputHashes({ frameLane: "gpu-pbr", evidence: {
      ...admitted,
      readback: { ...admitted.readback, mapOperations: 2 },
    } } as never)).toBeUndefined();
    expect(gpuFinalReceiptInputHashes({ frameLane: "gpu-pbr", evidence: {
      ...admitted,
      inputHashes: { ...admitted.inputHashes, unexpected: HASH },
      fingerprint: fingerprint({ ...admitted, inputHashes: { ...admitted.inputHashes, unexpected: HASH } }),
    } } as never)).toBeUndefined();
    expect(gpuFinalReceiptInputHashes({ frameLane: "gpu-pbr", evidence: {
      ...admitted,
      cleanup: { ...admitted.cleanup, readbackReleased: false },
      fingerprint: fingerprint({ ...admitted, cleanup: { ...admitted.cleanup, readbackReleased: false } }),
    } } as never)).toBeUndefined();
    expect(gpuFinalReceiptInputHashes({ frameLane: "gpu-pbr", evidence: {
      ...admitted,
      sceneStateSha256: "b".repeat(64),
      fingerprint: fingerprint({ ...admitted, sceneStateSha256: "b".repeat(64) }),
    } } as never)).toBeUndefined();
  });
});

function evidence() {
  const base = {
    schema: "shellx-motion/gpu-scene3d-gltf-pbr-streaming-producer@1",
    routeFingerprint: HASH,
    packageId: "pkg-pbr",
    sceneStateSha256: HASH,
    inputHashes: {
      "scene3d-gltf-pbr-manifest": HASH,
      "scene3d-gltf-pbr-motion": HASH,
      "scene3d-gltf-pbr-source": HASH,
      "scene3d-gltf-pbr-sidecar": HASH,
      "scene3d-gltf-pbr-sidecar-receipt": HASH,
      "scene3d-gltf-pbr-declaration": HASH,
      "scene3d-gltf-pbr-static-plan": HASH,
      "scene3d-gltf-pbr-frame-plan": HASH,
      "scene3d-gltf-pbr-catalog": HASH,
      "scene3d-gltf-pbr-scene-state": HASH,
    },
    catalogSha256: HASH,
    runtime: { adapterFingerprint: HASH },
    browser: { version: "test", process: { pid: 1 } },
    frameSequenceSha256: HASH,
    framePlanSequenceSha256: HASH,
    framesRendered: 1,
    retainedFrameCount: 0,
    sessionFrameCacheEntries: 0,
    readback: { reservedReadbackBufferBytes: 1280 * 720 * 4, readbackBufferAllocations: 1, mapOperations: 1, released: true },
    cleanup: { state: "complete", resourceReleased: true, readbackReleased: true, pageClosed: true },
  };
  return { ...base, fingerprint: fingerprint(base) };
}

function fingerprint(value: Record<string, unknown>): string {
  return canonicalJsonSha256({ ...value, fingerprint: undefined });
}
