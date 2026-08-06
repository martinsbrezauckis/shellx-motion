import { extname, join } from "node:path";
import {
  MAX_GLTF_SOURCE_BYTES,
  hashBuffer,
  lowerGltfToMotion,
  parseGltfContainer,
  type GltfSourceFormat,
  type GltfLoweringResult,
  type ParsedGltfContainer,
} from "@shellx-motion/core";
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
      lowering = lowerGltfToMotion({ ...input, adapterId: "adapter.gltf", container });
      return lowering;
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

function sourceFormat(sourcePath: string): GltfSourceFormat {
  const extension = extname(sourcePath).toLowerCase();
  if (extension === ".gltf") return "gltf";
  if (extension === ".glb") return "glb";
  throw new Error("glTF package source must use a .gltf or .glb extension.");
}
