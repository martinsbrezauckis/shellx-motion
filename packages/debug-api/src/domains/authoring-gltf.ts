import type { writeStaticGltfPackage } from "./authoring-gltf-package.js";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { stringArg } from "./args.js";

export interface GltfAuthoringServices {
  gltfPackageWriter?: typeof writeStaticGltfPackage;
  authoringInputRoots?: string[];
  authoringOutputRoots?: string[];
}

export async function dispatchGltfAuthoringCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: GltfAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (command !== "motion.scene3d.gltf.import") return null;
  const sourcePath = stringArg(args, "sourcePath");
  const outputRoot = stringArg(args, "outDir");
  const createdBy = stringArg(args, "createdBy") ?? undefined;
  const createdAt = stringArg(args, "createdAt") ?? undefined;
  if (!sourcePath) return invalidArgs("motion.scene3d.gltf.import requires sourcePath.");
  if (!outputRoot) return invalidArgs("motion.scene3d.gltf.import requires outDir.");
  if (!services.gltfPackageWriter) return unavailable("glTF package authoring is unavailable.");
  if (!services.authoringInputRoots?.length || !services.authoringOutputRoots?.length) {
    return unavailable("glTF package authoring requires host-approved input and output roots.");
  }
  try {
    const result = await services.gltfPackageWriter({
      sourcePath,
      outputRoot,
      inputRoots: services.authoringInputRoots,
      outputRoots: services.authoringOutputRoots,
      ...(createdBy ? { createdBy } : {}),
      ...(createdAt ? { createdAt } : {}),
    });
    return {
      ok: true,
      receiptId: result.loweringReceipt.id,
      visibleState: {
        panel: "packages",
        operation: "scene3d.gltf.import",
        packageId: result.package.manifest.id,
        packageRoot: result.packageRoot,
        format: result.format,
      },
      result,
      warnings: result.loweringReceipt.warnings,
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "gltf_import_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      warnings: [],
    };
  }
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function unavailable(message: string): MotionDebugResult {
  return {
    ok: false,
    error: {
      code: "capability_unavailable",
      message,
      suggestedAction: "Configure trusted local authoring roots and retry.",
    },
    warnings: [],
  };
}
