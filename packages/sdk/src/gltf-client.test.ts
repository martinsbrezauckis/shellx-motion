import { describe, expect, it } from "vitest";
import { validateGltfOutput } from "./gltf-client.js";

const SHA = "a".repeat(64);

function validOutput(): Record<string, unknown> {
  return {
    packageRoot: "/packages/mesh",
    package: {
      packageId: "pkg_gltf_mesh",
      motionId: "motion_gltf_mesh",
      durationMs: 1_000,
      fps: 30,
      width: 1_920,
      height: 1_080,
      manifestSha256: SHA,
      motionSha256: SHA,
    },
    format: "glb",
    sourcePath: "/packages/mesh/source/input.glb",
    normalizedSourcePath: "/packages/mesh/source/normalized.gltf.json",
    sourceSha256: SHA,
    bufferSha256: [SHA],
    sourceByteLength: 128,
    receipt: {
      schema: "shellx-motion/receipt@1",
      id: "receipt_gltf_mesh",
      packageId: "pkg_gltf_mesh",
      operation: "adapter.lower",
      status: "passed",
      path: "/packages/mesh/receipts/adapter-lowering.receipt.json",
      sha256: SHA,
    },
    warnings: [],
  };
}

describe("typed glTF client response validation", () => {
  it("requires the response container format to match the requested extension", () => {
    const request = { sourcePath: "/input/mesh.glb", outDir: "/packages/mesh" };
    expect(validateGltfOutput("gltfImport", validOutput(), request)).toBeNull();
    expect(validateGltfOutput("gltfImport", { ...validOutput(), format: "gltf" }, request))
      .toMatchObject({ code: "invalid_transport_response" });
  });

  it("rejects accessor-bearing nested transport objects", () => {
    const receipt = { ...validOutput().receipt as Record<string, unknown> };
    Object.defineProperty(receipt, "sha256", { enumerable: true, get: () => SHA });
    const output = { ...validOutput(), receipt };
    expect(validateGltfOutput(
      "gltfImport",
      output,
      { sourcePath: "/input/mesh.glb", outDir: "/packages/mesh" },
    )).toMatchObject({ code: "invalid_transport_response" });
  });
});
