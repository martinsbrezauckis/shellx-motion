/** Caller-controlled package and template root spellings at the transport boundary. */
import { stringArg, stringArrayArg } from "./domains/args.js";
import { assertConfiguredRenderPackageRoot, type RenderRootPolicy } from "./domains/render-root-policy.js";
import type { MotionDebugCommand } from "./command-registry.js";

/** The narrow host context needed for template-root admission. */
export interface CallerPackagePathRolesContext {
  enforceRenderRoots?: boolean;
  /** Catalog/plan roots are distinct from package-browse and render authority. */
  templateRoots?: string[];
}

/** Admit every caller-provided package or template root spelling for the command. */
export async function assertCallerPackagePathRoles(
  command: MotionDebugCommand,
  args: unknown,
  renderPolicy: RenderRootPolicy,
  context: CallerPackagePathRolesContext
): Promise<void> {
  const templateRoots = callerTemplateRoots(command, args);
  if (templateRoots) {
    // Template roots deliberately remain outside the general render policy.
    const templatePolicy = {
      enforce: context.enforceRenderRoots === true || context.templateRoots !== undefined,
      ...(context.templateRoots ? { packageRoots: context.templateRoots } : {})
    };
    for (const root of templateRoots) {
      await assertConfiguredRenderPackageRoot(root, templatePolicy, `${command} template root`);
    }
    return;
  }
  for (const packageRoot of callerPackageRoots(command, args)) {
    await assertConfiguredRenderPackageRoot(packageRoot, renderPolicy, `${command} packageRoot`);
  }
}

/** All package-browser spellings are independently caller-controlled read roots. */
function callerPackageRoots(command: MotionDebugCommand, args: unknown): string[] {
  if (command === "motion.packages.browse") {
    return uniqueStrings([
      ...(stringArrayArg(args, "packageRoots") ?? []),
      stringArg(args, "packageRoot"),
      stringArg(args, "packagesRoot"),
      stringArg(args, "packageBrowserRoot"),
      stringArg(args, "root")
    ]);
  }
  return uniqueStrings([stringArg(args, "packageRoot")]);
}

/** Catalog and plan have an intentionally separate host-owned template-root class. */
function callerTemplateRoots(command: MotionDebugCommand, args: unknown): string[] | null {
  if (command !== "motion.template.catalog" && command !== "motion.template.plan") return null;
  return uniqueStrings([
    ...(stringArrayArg(args, "packageRoots") ?? []),
    stringArg(args, "packageRoot"),
    stringArg(args, "templateRoot"),
    stringArg(args, "templatesRoot"),
    stringArg(args, "root")
  ]);
}

function uniqueStrings(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}
