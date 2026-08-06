import type { AdapterDiagnosticFeature, AdapterDiagnosticResult } from "./adapter-diagnostics";
import type { GltfSourceFormat } from "./gltf-types";
import type { OperationReceipt } from "./types";

export interface GltfDiagnosticInput {
  adapterId: "adapter.gltf";
  sourcePath: string;
  normalizedPackagePath: string;
  sourceSha256: string;
  format: GltfSourceFormat;
  objectCount: number;
  warnings: string[];
  createdAt?: string;
}

export function buildGltfDiagnostics(input: GltfDiagnosticInput): AdapterDiagnosticResult {
  const supported: AdapterDiagnosticFeature[] = [
    "gltf.mesh.triangles",
    "gltf.node.trs",
    "gltf.material.baseColor",
    "gltf.material.emissive",
  ].map((feature) => ({
    path: "/",
    feature,
    status: "supported",
    reason: "Lowered to bounded scene3d data.",
  }));
  const warningFeatures = input.warnings.map((reason, index) => ({
    path: `/meshes/${index}`,
    feature: "gltf.normal.generated",
    status: "warning" as const,
    reason,
  }));
  const lossiness = {
    level: warningFeatures.length ? "low" as const : "none" as const,
    budget: "static meshes, TRS, base color, and emissive only",
    unsupportedCount: 0,
    warningCount: warningFeatures.length,
    supportedCount: supported.length,
  };
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1",
    id: `adapter-diagnostics-gltf-${input.sourceSha256.slice(0, 16)}`,
    operation: "adapter.diagnostics",
    status: warningFeatures.length ? "warning" : "passed",
    packageId: input.normalizedPackagePath,
    inputHashes: { source: input.sourceSha256 },
    createdAt: input.createdAt ?? new Date().toISOString(),
    lane: "adapter",
    output: {
      adapterId: input.adapterId,
      format: input.format,
      objectCount: input.objectCount,
      lossiness,
    },
    warnings: input.warnings,
  };
  return {
    schema: "shellx-motion/adapter-diagnostics@1",
    adapterId: input.adapterId,
    format: "gltf",
    source: { path: input.sourcePath, sha256: input.sourceSha256 },
    normalizedPackagePath: input.normalizedPackagePath,
    supportedFeatures: supported,
    warningFeatures,
    unsupportedFeatures: [],
    recommendedFallbackLane: "browser",
    lossiness,
    suggestedNextAction: "Review material simplification, camera framing, and generated normals before final render.",
    receipt,
  };
}
