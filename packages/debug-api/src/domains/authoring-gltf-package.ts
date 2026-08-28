import { extname, join } from "node:path";
import {
  MAX_GLTF_SOURCE_BYTES,
  hashBuffer,
  loadMotionPackage,
  lowerGltfToMotion,
  parseGltfContainer,
  type GltfSourceFormat,
  type GltfLoweringResult,
  type ParsedGltfContainer,
} from "@shellx-motion/core";
import {
  admitGltfContainedPbrLowering,
  lowerAdmittedGltfContainedPbrToMotion,
  prepareScene3dGltfMaterialRenderPlanFromAuthenticatedPackage,
  scene3dGltfMaterialAssetManifestData,
} from "@shellx-motion/core/internal/scene3d-gltf-material";
import {
  resolveScene3dGltfPbrFinalRoute,
  scene3dGltfPbrFinalLocatorManifestData,
} from "@shellx-motion/core/internal/scene3d-gltf-pbr-final";
import {
  writeStaticVectorPackage,
  type StaticVectorPackageOptions,
  type WrittenStaticVectorPackage,
} from "./authoring-vector-package.js";

export interface WriteStaticGltfPackageOptions extends StaticVectorPackageOptions {}

export interface WrittenStaticGltfPackage extends WrittenStaticVectorPackage {
  format: GltfSourceFormat;
  normalizedSourcePath: string;
  bufferSha256: string[];
  sourceByteLength: number;
  loweringReceipt: GltfLoweringResult["receipt"];
}

/** Preserves and atomically lowers one bounded, static glTF 2.0 or GLB source. */
export async function writeStaticGltfPackage(
  options: WriteStaticGltfPackageOptions,
): Promise<WrittenStaticGltfPackage> {
  const format = sourceFormat(options.sourcePath);
  const sourceFileName = format === "glb" ? "input.glb" : "input.gltf";
  const primaryPath = `source/${sourceFileName}`;
  const normalizedPath = "source/normalized.gltf.json";
  let container: ParsedGltfContainer | undefined;
  let lowering: GltfLoweringResult | undefined;
  let materialPlan: ReturnType<typeof admitGltfContainedPbrLowering>["plan"] | undefined;
  let materialAuthority: ReturnType<typeof admitGltfContainedPbrLowering>["authority"] | undefined;
  const written = await writeStaticVectorPackage({
    adapterId: "adapter.gltf",
    formatLabel: format === "glb" ? "GLB" : "glTF",
    sourceApp: format,
    sourceFileName,
    packagePrefix: "pkg_gltf",
    maxSourceBytes: MAX_GLTF_SOURCE_BYTES,
    prepareSource: (bytes) => {
      container = parseGltfContainer(bytes, format);
      const normalizedBytes = Buffer.from(container.jsonText, "utf8");
      const normalizedSha256 = hashBuffer(normalizedBytes);
      return {
        primaryPath,
        primarySha256: container.sourceSha256,
        loweringPath: normalizedPath,
        loweringText: container.jsonText,
        files: [
          { path: primaryPath, bytes, sha256: container.sourceSha256 },
          { path: normalizedPath, bytes: normalizedBytes, sha256: normalizedSha256 },
        ],
        manifestData: {
          container: {
            schema: "shellx-motion/gltf-source@1",
            format,
            sourceByteLength: container.byteLength,
            bufferSha256: container.bufferSha256,
            resourcePolicy: {
              network: "denied",
              externalBuffers: "denied",
              extensions: "denied",
              animations: "not-imported",
              textures: "not-imported",
              geometry: "bounded-static-triangles",
            },
          },
        },
      };
    },
    lower: (input) => {
      if (!container) throw new Error("glTF container preparation did not complete before lowering.");
      if (!hasTexturePayload(container)) {
        // Keep the established lowerer call and its byte-level output intact for every legacy package.
        lowering = lowerGltfToMotion({ ...input, adapterId: "adapter.gltf", container });
        return lowering;
      }
      const admission = admitGltfContainedPbrLowering({ container, packageId: input.normalizedPackagePath, createdAt: input.createdAt });
      lowering = lowerAdmittedGltfContainedPbrToMotion({ ...input, adapterId: "adapter.gltf", container }, admission.authority);
      const objectCount = lowering.motion.layers[0]?.scene3d?.objects.length;
      if (admission.plan.document.texturedPrimitives.length !== objectCount) {
        throw new Error("Contained glTF PBR package admission requires every lowered scene primitive to carry the verified base-color material route.");
      }
      materialPlan = admission.plan;
      materialAuthority = admission.authority;
      return lowering;
    },
    packageCompatibility: () => materialPlan
      ? { lanes: ["gpu"], hosts: ["shellx-motion"] }
      : { lanes: ["browser", "ffmpeg", "cut"], hosts: ["shellx-motion", "shellx-canvas", "shellx-cut"] },
    augmentPrepared: ({ packageId, prepared }) => {
      if (!materialPlan || !materialAuthority) return;
      if (packageId !== materialPlan.declaration.packageId) throw new Error("glTF material sidecar package identity does not match the transaction package identity.");
      prepared.packageFiles = [
        ...(prepared.packageFiles ?? []),
        ...materialPlan.files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
      ];
      prepared.manifestAssets = [...new Set([...(prepared.manifestAssets ?? []), ...materialPlan.manifestAssets])].sort();
      const containerMetadata = prepared.manifestData?.container as Record<string, unknown> | undefined;
      if (!containerMetadata || !prepared.manifestData) throw new Error("glTF transaction lost its bounded container metadata before material-sidecar staging.");
      prepared.manifestData.container = {
        ...containerMetadata,
        resourcePolicy: { ...(containerMetadata.resourcePolicy as Record<string, unknown>), textures: "sdr-pbr-png-webgpu-direct-final" },
      };
      Object.assign(
        prepared.manifestData,
        scene3dGltfMaterialAssetManifestData(materialPlan),
        scene3dGltfPbrFinalLocatorManifestData("gltf-scene"),
      );
    },
    validateAugmentedPackage: async (packageRoot) => {
      if (!materialPlan || !materialAuthority) return;
      await prepareScene3dGltfMaterialRenderPlanFromAuthenticatedPackage(packageRoot);
      const pkg = await loadMotionPackage(packageRoot);
      const route = await resolveScene3dGltfPbrFinalRoute(pkg, "0".repeat(64));
      if (route.kind !== "present") throw new Error("Contained glTF PBR transaction did not retain its authenticated final-route marker.");
    },
  }, options);
  if (!container || !lowering) throw new Error("glTF container preparation or lowering did not complete.");
  return {
    ...written,
    format,
    normalizedSourcePath: join(written.packageRoot, normalizedPath),
    bufferSha256: container.bufferSha256,
    sourceByteLength: container.byteLength,
    loweringReceipt: lowering.receipt,
  };
}

function hasTexturePayload(container: ParsedGltfContainer): boolean {
  return [container.json.textures, container.json.images].some((value) => Array.isArray(value) && value.length > 0);
}

function sourceFormat(sourcePath: string): GltfSourceFormat {
  const extension = extname(sourcePath).toLowerCase();
  if (extension === ".gltf") return "gltf";
  if (extension === ".glb") return "glb";
  throw new Error("glTF package source must use a .gltf or .glb extension.");
}
