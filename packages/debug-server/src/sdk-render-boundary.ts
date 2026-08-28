/** Host-root admission for path-bearing operations on the authenticated SDK transport. */
import {
  admitConfiguredRenderInputFile,
  assertConfiguredRenderOutputDirectory,
  assertConfiguredRenderOutputFile,
  assertConfiguredRenderPackageRoot,
  renderFilesystemRootPolicy,
  type MotionDebugContext
} from "@shellx-motion/debug-api";
import type { MotionSdkOperation } from "@shellx-motion/sdk";
import { dirname, resolve } from "node:path";

export interface SdkRenderPathRefusal {
  code: "render_path_not_approved";
  message: string;
}

/** Refuse caller-selected SDK filesystem paths before the local transport can observe or create them. */
export async function refuseSdkRenderPaths(
  operation: MotionSdkOperation,
  input: Record<string, unknown>,
  requiredTier: MotionDebugContext["tier"],
  context: MotionDebugContext
): Promise<SdkRenderPathRefusal | null> {
  const policy = renderFilesystemRootPolicy(context);
  try {
    if (isSdkPackageReadTier(requiredTier) && typeof input.packageRoot === "string") {
      await assertConfiguredRenderPackageRoot(input.packageRoot, policy, `Motion SDK ${operation} packageRoot`);
    }

    if (operation === "preview") {
      await assertConfiguredRenderOutputDirectory(String(input.outDir ?? ""), policy, "Motion SDK preview outDir");
      await admitOptionalPreviewWorkflow(input.workflowPath, input.packageRoot, context.scratchRoot, policy);
    }

    if (operation === "renderCachePlan") {
      await assertConfiguredRenderOutputFile(String(input.outputPath ?? ""), policy, "Motion SDK renderCachePlan outputPath");
      await admitOptionalInput(input.workflowPath, policy, "Motion SDK renderCachePlan workflowPath");
      await admitOptionalInput(input.qualityManifestPath, policy, "Motion SDK renderCachePlan qualityManifestPath");
    }

    if (operation === "render") {
      const outputPath = String(input.outputPath ?? "");
      const artifactRoot = typeof input.artifactRoot === "string" ? input.artifactRoot : dirname(resolve(outputPath));
      await assertConfiguredRenderOutputFile(outputPath, policy, "Motion SDK render outputPath");
      await assertConfiguredRenderOutputDirectory(artifactRoot, policy, "Motion SDK render artifactRoot");
      if (typeof input.receiptsRoot === "string") {
        await assertConfiguredRenderOutputDirectory(input.receiptsRoot, policy, "Motion SDK render receiptsRoot");
      }
      await admitOptionalInput(input.workflowPath, policy, "Motion SDK render workflowPath");
      await admitOptionalInput(input.qualityManifestPath, policy, "Motion SDK render qualityManifestPath");
    }
    return null;
  } catch (error) {
    return {
      code: "render_path_not_approved",
      message: error instanceof Error ? error.message : "Motion SDK render filesystem authority is unavailable."
    };
  }
}

/**
 * Preview's inner command contract accepts a workflow beside the admitted package, in the
 * host-owned scratch root, or in an external render-input root. Rebuild exactly that union from
 * already admitted host authority; never derive a root from workflowPath itself.
 */
async function admitOptionalPreviewWorkflow(
  value: unknown,
  packageRoot: unknown,
  scratchRoot: string | undefined,
  policy: Parameters<typeof admitConfiguredRenderInputFile>[1]
): Promise<void> {
  if (typeof value !== "string") return;
  await admitConfiguredRenderInputFile(value, {
    ...policy,
    inputRoots: [
      ...(policy.inputRoots ?? []),
      ...(typeof packageRoot === "string" ? [packageRoot] : []),
      ...(scratchRoot ? [scratchRoot] : [])
    ]
  }, "Motion SDK preview workflowPath");
}

async function admitOptionalInput(
  value: unknown,
  policy: Parameters<typeof admitConfiguredRenderInputFile>[1],
  subject: string
): Promise<void> {
  if (typeof value === "string") await admitConfiguredRenderInputFile(value, policy, subject);
}

function isSdkPackageReadTier(tier: MotionDebugContext["tier"]): boolean {
  return tier === "read_motion" || tier === "draft_motion" || tier === "render_motion";
}
