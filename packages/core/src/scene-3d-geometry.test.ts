import { describe, expect, it } from "vitest";
import { scene3dMeshGeometrySha256 } from "./scene-3d-geometry";

describe("scene3d mesh geometry source hash", () => {
  it("binds the exact float32 vertex payload and uint32 index payload", () => {
    const geometry = {
      positions: [0, 0, 0, 0.1, 0, 0, 0, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
    };
    const sourceHash = scene3dMeshGeometrySha256(geometry);
    expect(sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(scene3dMeshGeometrySha256({ ...geometry, positions: [...geometry.positions] })).toBe(sourceHash);
    expect(scene3dMeshGeometrySha256({ ...geometry, positions: [0, 0, 0, Math.fround(0.1), 0, 0, 0, 1, 0] })).toBe(sourceHash);
    expect(scene3dMeshGeometrySha256({ ...geometry, positions: [0, 0, 0, -0, 0, 0, 0, 1, 0] })).not.toBe(sourceHash);
    expect(scene3dMeshGeometrySha256({ ...geometry, indices: [0, 2, 1] })).not.toBe(sourceHash);
  });
});
