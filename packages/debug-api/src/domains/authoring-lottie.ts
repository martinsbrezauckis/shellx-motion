/**
 * Debug-API surface for importing Lottie and dotLottie sources.
 *
 * Role: Motion carries a complete, tested Lottie/dotLottie lowering stack — precomp flattening,
 * theming, bundled image and font extraction, zip container handling — behind
 * `writeStaticLottiePackage` and `writeStaticDotLottiePackage`. Until this existed those writers
 * were exported as library functions and reachable from no product surface at all: no command,
 * no CLI verb. A capability that ships, is documented, and cannot be invoked is worse than one
 * that is absent, because callers plan around it.
 *
 * This is deliberately the same shape as `authoring-gltf.ts`: same argument names and the same
 * host-approved-roots requirement, so import formats do not each invent their own calling
 * convention. It differs in one respect it cannot control — the shared vector writer returns
 * receipt PATHS where the glTF writer returns receipt objects.
 *
 * Dependencies: the two package writers in this directory. Primary caller: the debug command
 * router in `packages/debug-api/src/index.ts`.
 */
import type { writeStaticLottiePackage } from "./authoring-lottie-package.js";
import type { writeStaticDotLottiePackage } from "./authoring-dotlottie-package.js";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { stringArg } from "./args.js";

export interface LottieAuthoringServices {
  lottiePackageWriter?: typeof writeStaticLottiePackage;
  dotLottiePackageWriter?: typeof writeStaticDotLottiePackage;
  authoringInputRoots?: string[];
  authoringOutputRoots?: string[];
}

export async function dispatchLottieAuthoringCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: LottieAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (command !== "motion.lottie.import" && command !== "motion.dotlottie.import") return null;
  const isDotLottie = command === "motion.dotlottie.import";
  const sourcePath = stringArg(args, "sourcePath");
  const outputRoot = stringArg(args, "outDir");
  const createdBy = stringArg(args, "createdBy") ?? undefined;
  const createdAt = stringArg(args, "createdAt") ?? undefined;
  // A .lottie container may hold several animations and several themes; naming neither is valid
  // and selects the container's declared defaults.
  const animationId = isDotLottie ? stringArg(args, "animationId") ?? undefined : undefined;
  const themeId = isDotLottie ? stringArg(args, "themeId") ?? undefined : undefined;
  if (!sourcePath) return invalidArgs(`${command} requires sourcePath.`);
  if (!outputRoot) return invalidArgs(`${command} requires outDir.`);
  const writer = isDotLottie ? services.dotLottiePackageWriter : services.lottiePackageWriter;
  if (!writer) return unavailable(`${isDotLottie ? "dotLottie" : "Lottie"} package authoring is unavailable.`);
  if (!services.authoringInputRoots?.length || !services.authoringOutputRoots?.length) {
    return unavailable(`${isDotLottie ? "dotLottie" : "Lottie"} package authoring requires host-approved input and output roots.`);
  }
  try {
    const result = await writer({
      sourcePath,
      outputRoot,
      inputRoots: services.authoringInputRoots,
      outputRoots: services.authoringOutputRoots,
      ...(createdBy ? { createdBy } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(animationId ? { animationId } : {}),
      ...(themeId ? { themeId } : {}),
    });
    // The vector writer returns receipt PATHS rather than receipt objects (unlike the glTF
    // writer), so the caller is handed the paths and reads them if it wants the attestations.
    return {
      ok: true,
      visibleState: {
        panel: "packages",
        operation: isDotLottie ? "dotlottie.import" : "lottie.import",
        packageId: result.package.manifest.id,
        packageRoot: result.packageRoot,
        loweringReceiptPath: result.loweringReceiptPath,
        diagnosticsReceiptPath: result.diagnosticsReceiptPath,
      },
      result,
      warnings: [],
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: isDotLottie ? "dotlottie_import_failed" : "lottie_import_failed",
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
