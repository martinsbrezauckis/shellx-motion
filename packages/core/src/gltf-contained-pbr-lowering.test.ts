import { describe, expect, it } from "vitest";
import { parseGltfContainer } from "./gltf-container";
import {
  admitGltfContainedPbrLowering,
  lowerAdmittedGltfContainedPbrToMotion,
  type GltfContainedPbrLoweringAuthority,
} from "./gltf-contained-pbr-lowering";
import { lowerGltfToMotion, type GltfLoweringInput } from "./gltf-lowering";
import { encodeRgbaPng } from "./quality";
import { buildScene3dGltfMaterialAssetPlan } from "./scene-3d-gltf-material-assets-build";

describe("contained glTF PBR lowering authority", () => {
  it("admits an exact contained-PNG route only after the public lowerer has refused it", () => {
    const container = parsed(gltf());
    const input = loweringInput(container);
    expect(() => lowerGltfToMotion(input)).toThrow(/glTF textures are not supported/);

    const admission = admitGltfContainedPbrLowering({ container, packageId: input.normalizedPackagePath, createdAt: input.createdAt });
    const lowered = lowerAdmittedGltfContainedPbrToMotion(input, admission.authority);

    expect(admission.plan.document.texturedPrimitives).toHaveLength(1);
    expect(lowered.motion.layers[0]?.scene3d?.objects).toHaveLength(1);
    const object = lowered.motion.layers[0]?.scene3d?.objects[0];
    expect(object?.primitive).toBe("mesh");
    if (!object || object.primitive !== "mesh") throw new Error("expected mesh");
    expect(object.source.materialIndex).toBe(0);
  });

  it("refuses a forged authority and an admission whose qualified source has changed", () => {
    const container = parsed(gltf());
    const input = loweringInput(container);
    const admission = admitGltfContainedPbrLowering({ container, packageId: input.normalizedPackagePath, createdAt: input.createdAt });

    expect(() => lowerAdmittedGltfContainedPbrToMotion(input, {} as GltfContainedPbrLoweringAuthority))
      .toThrow(/opaque authority/);
    expect(() => lowerAdmittedGltfContainedPbrToMotion({ ...input, sourceText: "{}" }, admission.authority))
      .toThrow(/does not match its admitted normalized source/);
    ((container.json.materials as Record<string, unknown>[])[0]!.pbrMetallicRoughness as Record<string, unknown>).metallicFactor = 0.25;
    expect(() => lowerAdmittedGltfContainedPbrToMotion(input, admission.authority))
      .toThrow(/no longer matches its admitted material plan/);
  });

  it("preflights the selected scene before material expansion and bounds unselected descriptors", () => {
    const selectedOverflow = gltf();
    const selectedPrimitive = ((selectedOverflow.meshes as Record<string, unknown>[])[0]!.primitives as Record<string, unknown>[])[0]!;
    ((selectedOverflow.meshes as Record<string, unknown>[])[0]!.primitives as Record<string, unknown>[]) = Array.from(
      { length: 17 },
      (_, index) => index === 16
        ? { ...structuredClone(selectedPrimitive), attributes: { POSITION: 0, TEXCOORD_0: 999 } }
        : structuredClone(selectedPrimitive)
    );
    expect(() => admitGltfContainedPbrLowering({ container: parsed(selectedOverflow), packageId: "pkg_selected_overflow" }))
      .toThrow(/exceeds 16 mesh primitives/);
    expect(() => buildScene3dGltfMaterialAssetPlan({ container: parsed(selectedOverflow), packageId: "pkg_builder_selected_overflow" }))
      .toThrow(/exceeds 16 mesh primitives/);

    const changedAfterAdmission = parsed(gltf());
    const changedInput = loweringInput(changedAfterAdmission);
    const changedAdmission = admitGltfContainedPbrLowering({
      container: changedAfterAdmission,
      packageId: changedInput.normalizedPackagePath,
      createdAt: changedInput.createdAt
    });
    const changedPrimitive = ((changedAfterAdmission.json.meshes as Record<string, unknown>[])[0]!.primitives as Record<string, unknown>[])[0]!;
    ((changedAfterAdmission.json.meshes as Record<string, unknown>[])[0]!.primitives as Record<string, unknown>[]) = Array.from(
      { length: 17 },
      (_, index) => index === 16
        ? { ...structuredClone(changedPrimitive), attributes: { POSITION: 0, TEXCOORD_0: 999 } }
        : structuredClone(changedPrimitive)
    );
    expect(() => lowerAdmittedGltfContainedPbrToMotion(changedInput, changedAdmission.authority))
      .toThrow(/exceeds 16 mesh primitives/);

    const unselectedOverflow = gltf();
    const sourcePrimitive = ((unselectedOverflow.meshes as Record<string, unknown>[])[0]!.primitives as Record<string, unknown>[])[0]!;
    (unselectedOverflow.meshes as Record<string, unknown>[]).push({
      primitives: Array.from({ length: 16 }, (_, index) => index === 15
        ? { ...structuredClone(sourcePrimitive), attributes: { POSITION: 0, TEXCOORD_0: 999 } }
        : structuredClone(sourcePrimitive))
    });
    expect(() => admitGltfContainedPbrLowering({ container: parsed(unselectedOverflow), packageId: "pkg_unselected_overflow" }))
      .toThrow(/textured primitive descriptors exceed 16 primitives/);
  });

  it("rejects declared and undeclared extensions plus extras on every admitted glTF object family", () => {
    for (const [family, target] of extensionTargets()) {
      for (const [kind, key] of [["undeclared extension", "extensions"], ["declared extension", "extensions"], ["extras", "extras"]] as const) {
        const source = gltf();
        if (kind === "declared extension") source.extensionsUsed = ["VENDOR_contained_pbr_test"];
        target(source)[key] = key === "extensions" ? { VENDOR_contained_pbr_test: {} } : { test: true };
        const container = parsed(source);
        expect(
          () => admitGltfContainedPbrLowering({ container, packageId: "pkg_contained_pbr", createdAt: "2026-08-16T00:00:00.000Z" }),
          `${family} ${kind}`,
        ).toThrow(/extensions or extras/);
      }
    }
  });
});

function loweringInput(container: ReturnType<typeof parseGltfContainer>): GltfLoweringInput {
  return {
    adapterId: "adapter.gltf", sourcePath: "source/normalized.gltf.json", sourceText: container.jsonText,
    normalizedPackagePath: "pkg_contained_pbr", container, createdBy: "test", createdAt: "2026-08-16T00:00:00.000Z",
  };
}

function parsed(source: Record<string, unknown>) { return parseGltfContainer(Buffer.from(JSON.stringify(source), "utf8"), "gltf"); }

function extensionTargets(): ReadonlyArray<readonly [string, (source: Record<string, unknown>) => Record<string, unknown>]> {
  return [
    ["asset", (source) => source.asset as Record<string, unknown>],
    ["scene", (source) => (source.scenes as Record<string, unknown>[])[0]!],
    ["node", (source) => (source.nodes as Record<string, unknown>[])[0]!],
    ["mesh", (source) => (source.meshes as Record<string, unknown>[])[0]!],
    ["primitive", (source) => ((source.meshes as Record<string, unknown>[])[0]!.primitives as Record<string, unknown>[])[0]!],
    ["attribute map", (source) => (((source.meshes as Record<string, unknown>[])[0]!.primitives as Record<string, unknown>[])[0]!.attributes as Record<string, unknown>)],
    ["material", (source) => (source.materials as Record<string, unknown>[])[0]!],
    ["PBR block", (source) => ((source.materials as Record<string, unknown>[])[0]!.pbrMetallicRoughness as Record<string, unknown>)],
    ["base-color texture info", (source) => (((source.materials as Record<string, unknown>[])[0]!.pbrMetallicRoughness as Record<string, unknown>).baseColorTexture as Record<string, unknown>)],
    ["texture", (source) => (source.textures as Record<string, unknown>[])[0]!],
    ["image", (source) => (source.images as Record<string, unknown>[])[0]!],
    ["sampler", (source) => ((source.samplers ??= [{ magFilter: 9729 }]) as Record<string, unknown>[])[0]!],
    ["accessor", (source) => (source.accessors as Record<string, unknown>[])[0]!],
    ["sparse accessor", (source) => (((source.accessors as Record<string, unknown>[])[0]!.sparse ??= sparse()) as Record<string, unknown>)],
    ["sparse indices", (source) => ((((source.accessors as Record<string, unknown>[])[0]!.sparse ??= sparse()) as Record<string, unknown>).indices as Record<string, unknown>)],
    ["sparse values", (source) => ((((source.accessors as Record<string, unknown>[])[0]!.sparse ??= sparse()) as Record<string, unknown>).values as Record<string, unknown>)],
    ["bufferView", (source) => (source.bufferViews as Record<string, unknown>[])[0]!],
    ["buffer", (source) => (source.buffers as Record<string, unknown>[])[0]!],
    ["camera", (source) => ((source.cameras ??= [{ type: "perspective", perspective: { yfov: 0.5, znear: 0.1 } }]) as Record<string, unknown>[])[0]!],
    ["camera perspective", (source) => (((source.cameras ??= [{ type: "perspective", perspective: { yfov: 0.5, znear: 0.1 } }]) as Record<string, unknown>[])[0]!.perspective as Record<string, unknown>)],
    ["camera orthographic", (source) => (((source.cameras ??= [{ type: "orthographic", orthographic: { xmag: 1, ymag: 1, znear: 0.1, zfar: 1 } }]) as Record<string, unknown>[])[0]!.orthographic as Record<string, unknown>)],
    ["skin", (source) => ((source.skins ??= [{ joints: [0] }]) as Record<string, unknown>[])[0]!],
    ["animation", (source) => animation(source)],
    ["animation channel", (source) => (animation(source).channels as Record<string, unknown>[])[0]!],
    ["animation sampler", (source) => (animation(source).samplers as Record<string, unknown>[])[0]!],
    ["animation target", (source) => ((animation(source).channels as Record<string, unknown>[])[0]!.target as Record<string, unknown>)],
  ];
}

function sparse(): Record<string, unknown> { return { count: 1, indices: { bufferView: 0, componentType: 5121 }, values: { bufferView: 0 } }; }
function animation(source: Record<string, unknown>): Record<string, unknown> {
  return ((source.animations ??= [{ channels: [{ sampler: 0, target: { node: 0, path: "translation" } }], samplers: [{ input: 0, output: 0 }] }]) as Record<string, unknown>[])[0]!;
}

function gltf(): Record<string, unknown> {
  const geometry = Buffer.alloc(42);
  [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0].forEach((value, index) => geometry.writeFloatLE(value, index * 4));
  [0, 1, 2].forEach((value, index) => geometry.writeUInt16LE(value, 36 + index * 2));
  const uv = Buffer.from([0, 0, 0, 0, 255, 0, 0, 0, 128, 255, 0, 0]);
  const binary = Buffer.concat([geometry, Buffer.alloc(2), uv]);
  const image = encodeRgbaPng(1, 1, Buffer.from([0x11, 0x22, 0x33, 0xff]));
  return {
    asset: { version: "2.0" }, buffers: [{ byteLength: binary.byteLength, uri: `data:application/octet-stream;base64,${binary.toString("base64")}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }, { buffer: 0, byteOffset: 44, byteLength: uv.byteLength, byteStride: 4 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }, { bufferView: 2, componentType: 5121, normalized: true, count: 3, type: "VEC2" }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0.5, roughnessFactor: 0.5 } }],
    textures: [{ source: 0 }], images: [{ uri: `data:image/png;base64,${image.toString("base64")}` }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 2 }, indices: 1, material: 0 }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  };
}
