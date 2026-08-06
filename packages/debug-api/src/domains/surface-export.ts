/** Export and platform-verification read surfaces. */
import { hashBuffer, type MotionPackage } from "@shellx-motion/core";
import {
  checkMotionPlatformRequirements,
  listMotionExportPresets,
  motionOperationReadiness,
  MOTION_REQUIREMENT_OPERATIONS,
  readMotionExportPreset,
  type FfmpegRunner,
  type MotionExportPreset,
  type MotionRequirementOperation
} from "@shellx-motion/renderer-ffmpeg";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { booleanArg, objectArg, stringArg, stringArrayArg } from "./args.js";

export interface PlatformVerificationView {
  status: unknown;
  platformReceiptCount: number;
  hostReceiptCount: number;
  aggregateReceiptCount: number;
  missingHosts: unknown[];
  failedHosts: unknown[];
}

export interface ExportPanelView {
  cards: Array<{ supportsAlpha: boolean; verification?: { status?: unknown } }>;
  groups: unknown[];
  defaultPreset: unknown;
  recommendedPresets: unknown;
}

export interface ExportPlanView {
  preset: unknown;
  target: unknown;
  preflight: unknown[];
  warningCount: number;
  recommendedLane: unknown;
  recommendedPipeline?: { lanes: unknown };
  packageId?: unknown;
  warnings: string[];
}

export interface SurfaceExportServices {
  receiptsRoot?: string;
  /**
   * The runner Motion RENDERS with, so readiness describes the executable that would actually do
   * the work.
   *
   * An embedded host injects `MotionDebugContext.ffmpegRunner` to render through a bundled,
   * sandboxed or otherwise custom FFmpeg. Until this was threaded through,
   * `motion.platform.requirements` probed the machine's PATH instead, so such a host could be told
   * rendering was unavailable while the engine rendered fine — or, worse, told it was available
   * when the injected runner was the broken one (the readiness-parity invariant). The runner is the seam
   * rather than a pre-built answer on purpose: a per-host, differently-shaped readiness object is
   * what let the CLI and MCP surfaces disagree in the first place.
   */
  ffmpegRunner?: FfmpegRunner;
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  listPlatformReceiptEntries?: (root: string) => Promise<unknown[]>;
  summarizePlatformVerification?: (entries: unknown[], requiredHosts?: string[]) => PlatformVerificationView;
  buildExportPanel?: (verification?: PlatformVerificationView & { receiptsRoot: string }) => ExportPanelView;
  buildExportPlan?: (input: {
    pkg?: MotionPackage;
    target: string;
    preset: MotionExportPreset;
    outputPath?: string;
    qualityManifestPath?: string;
    needsAlpha: boolean;
    needsAudio: boolean;
    platformVerification?: PlatformVerificationView & { receiptsRoot?: string };
  }) => ExportPlanView;
  chooseExportPreset?: (input: { target: string; needsAlpha: boolean }) => MotionExportPreset;
  missingPlatformVerification?: (requiredHosts: string[] | null) => PlatformVerificationView | undefined;
}

export async function dispatchSurfaceExportCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: SurfaceExportServices
): Promise<MotionDebugResult | null> {
  if (command === "motion.export.presets") return presets();
  if (command === "motion.export.panel") return panel(args, services);
  if (command === "motion.export.plan") return plan(args, services);
  if (command === "motion.platform.requirements") return await platformRequirements(services, args);
  if (command === "motion.platform.verification.panel") return platformPanel(args, services);
  return null;
}

function presets(): MotionDebugResult {
  const values = listMotionExportPresets();
  return {
    ok: true,
    receiptId: `export-presets-${hashBuffer(Buffer.from(JSON.stringify(values), "utf8")).slice(0, 16)}`,
    visibleState: { panel: "export", presetCount: values.length },
    result: { ok: true, defaultPreset: "mp4-h264", presets: values }, warnings: []
  };
}

async function panel(args: unknown, services: SurfaceExportServices): Promise<MotionDebugResult> {
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const requiredHosts = requiredHostsArg(args, "motion.export.panel");
  if (isResult(requiredHosts)) return requiredHosts;
  if (!services.buildExportPanel) return capabilityUnavailable("Export panel construction is unavailable.");
  let verification: (PlatformVerificationView & { receiptsRoot: string }) | undefined;
  if (receiptsRoot) {
    if (!services.listPlatformReceiptEntries || !services.summarizePlatformVerification) {
      return capabilityUnavailable("Platform verification receipt reading is unavailable.");
    }
    verification = {
      receiptsRoot,
      ...services.summarizePlatformVerification(await services.listPlatformReceiptEntries(receiptsRoot), requiredHosts ?? undefined)
    };
  }
  const result = services.buildExportPanel(verification);
  const verifiedAlphaPresetCount = verification
    ? result.cards.filter((card) => card.supportsAlpha && card.verification?.status === "passed").length
    : undefined;
  return {
    ok: true,
    receiptId: `export-panel-${hashBuffer(Buffer.from(JSON.stringify(result), "utf8")).slice(0, 16)}`,
    visibleState: {
      panel: "export", operation: "export.panel", presetCount: result.cards.length,
      groupCount: result.groups.length, defaultPreset: result.defaultPreset,
      recommendedPresets: result.recommendedPresets,
      ...(verification ? { platformVerificationStatus: verification.status, verifiedAlphaPresetCount } : {})
    },
    result: { ok: true, ...result }, warnings: []
  };
}

async function plan(args: unknown, services: SurfaceExportServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const target = stringArg(args, "target") ?? "delivery";
  const presetArg = stringArg(args, "preset");
  const outputPath = stringArg(args, "outputPath") ?? stringArg(args, "out") ?? undefined;
  const qualityManifestPath = stringArg(args, "qualityManifestPath") ?? stringArg(args, "manifestPath") ?? undefined;
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const requiredHosts = requiredHostsArg(args, "motion.export.plan");
  const needsAlpha = booleanArg(args, "needsAlpha") ?? false;
  const needsAudio = booleanArg(args, "needsAudio") ?? false;
  if (isResult(requiredHosts)) return requiredHosts;
  const explicitPreset = presetArg ? readMotionExportPreset(presetArg) : null;
  if (presetArg && !explicitPreset) return invalidArgs(`Unsupported export preset: ${presetArg}.`);
  if (!services.buildExportPlan || !services.chooseExportPreset || !services.missingPlatformVerification) {
    return capabilityUnavailable("Export planning is unavailable.");
  }
  if (packageRoot && !services.packageLoader) return capabilityUnavailable("Motion package loading is unavailable.");
  if (receiptsRoot && (!services.listPlatformReceiptEntries || !services.summarizePlatformVerification)) {
    return capabilityUnavailable("Platform verification receipt reading is unavailable.");
  }
  try {
    const pkg = packageRoot ? await services.packageLoader!(packageRoot) : undefined;
    const verification = receiptsRoot
      ? { receiptsRoot, ...services.summarizePlatformVerification!(await services.listPlatformReceiptEntries!(receiptsRoot), requiredHosts ?? undefined) }
      : services.missingPlatformVerification(requiredHosts);
    const result = services.buildExportPlan({
      ...(pkg ? { pkg } : {}), target,
      preset: explicitPreset ?? services.chooseExportPreset({ target, needsAlpha }),
      ...(outputPath ? { outputPath } : {}), ...(qualityManifestPath ? { qualityManifestPath } : {}),
      needsAlpha, needsAudio, ...(verification ? { platformVerification: verification } : {})
    });
    return {
      ok: true,
      receiptId: `export-plan-${hashBuffer(Buffer.from(JSON.stringify(result), "utf8")).slice(0, 16)}`,
      visibleState: {
        panel: "export", operation: "export.plan", preset: result.preset, target: result.target,
        preflightCount: result.preflight.length, warningCount: result.warningCount,
        recommendedLane: result.recommendedLane,
        ...(result.recommendedPipeline ? { recommendedPipeline: result.recommendedPipeline.lanes } : {}),
        ...(result.packageId ? { packageId: result.packageId } : {})
      },
      result, warnings: result.warnings
    };
  } catch (error) {
    return { ok: false, error: { code: "export_plan_failed", message: error instanceof Error ? error.message : String(error) }, warnings: [] };
  }
}

async function platformPanel(args: unknown, services: SurfaceExportServices): Promise<MotionDebugResult> {
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const requiredHosts = requiredHostsArg(args, "motion.platform.verification.panel");
  if (!receiptsRoot) return invalidArgs("motion.platform.verification.panel requires receiptsRoot.");
  if (isResult(requiredHosts)) return requiredHosts;
  if (!services.listPlatformReceiptEntries || !services.summarizePlatformVerification) {
    return capabilityUnavailable("Platform verification receipt reading is unavailable.");
  }
  const result = services.summarizePlatformVerification(await services.listPlatformReceiptEntries(receiptsRoot), requiredHosts ?? undefined);
  return {
    ok: true,
    visibleState: {
      panel: "receipts", operation: "platform.verification.panel", status: result.status,
      platformReceiptCount: result.platformReceiptCount, hostReceiptCount: result.hostReceiptCount,
      aggregateReceiptCount: result.aggregateReceiptCount, missingHostCount: result.missingHosts.length,
      failedHostCount: result.failedHosts.length
    },
    result: { ok: true, receiptsRoot, ...result }, warnings: []
  };
}

function requiredHostsArg(args: unknown, command: string): string[] | null | MotionDebugResult {
  const record = objectArg(args);
  const values = stringArrayArg(args, "requiredHosts");
  if (record && Object.hasOwn(record, "requiredHosts") && values === null) {
    return invalidArgs(`${command} requiredHosts must be an array of strings.`);
  }
  return values;
}

function isResult(value: string[] | null | MotionDebugResult): value is MotionDebugResult {
  return !Array.isArray(value) && value !== null;
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}


/**
 * Which external tools Motion needs, and whether this machine has them.
 *
 * Exists because `ffmpeg_not_configured` is where a host lands when nothing renders, and neither a
 * user nor an agent could previously find out that the cause was a missing program rather than a
 * broken engine. Every missing tool carries platform-specific install commands, so a host UI can
 * offer the fix rather than the error.
 */
async function platformRequirements(services: SurfaceExportServices, args: unknown): Promise<MotionDebugResult> {
  const operation = readRequirementOperation(args);
  if (operation instanceof Error) return invalidArgs(operation.message);

  // The SAME call `shellx-motion doctor` makes, returning the SAME object (the readiness-parity invariant).
  //
  // A per-host injected, differently-shaped, FFmpeg-only probe is precisely what let this command
  // and the CLI drift into two incompatible answers: it had no `satisfied`, no `status`, no raw
  // `detail`, and no concept of FFprobe, so an MCP caller and a CLI caller on the same machine were
  // told different things. The probe is shared instead, and the test seam moved with it —
  // `checkMotionPlatformRequirements` takes a runner.
  //
  // That runner is the host's RENDER runner. Answering with the PATH build while the engine renders
  // through an injected one is the second half of the same defect: the readiness answer would then
  // describe an executable that has nothing to do with the render it is gating.
  const requirements = await checkMotionPlatformRequirements(
    services.ffmpegRunner ? { runner: services.ffmpegRunner } : {}
  );
  const scoped = operation ? motionOperationReadiness(requirements, operation) : undefined;
  const satisfied = scoped ? scoped.satisfied : requirements.satisfied;
  const blocking = requirements.tools.filter((tool) => tool.status !== "ready");
  return {
    // `ok` says the probe ran. `satisfied` says the machine is ready — two different questions.
    ok: true,
    visibleState: {
      panel: "platform",
      operation: "platform.requirements",
      missingCount: requirements.missingCount,
      satisfied,
      ...(scoped ? { requestedOperation: scoped.operation } : {})
    },
    result: {
      ok: true,
      // `satisfied` is the single boolean a host branches on before offering a render.
      satisfied,
      missingCount: requirements.missingCount,
      ...(scoped ? { operation: scoped } : {}),
      // The shared result verbatim. `requirements` keeps its historical name so a host pinned to
      // the previous field keeps reading a tool array; `platform` is the whole typed answer.
      requirements: requirements.tools,
      platform: requirements
    },
    warnings: blocking.map((tool) => `${tool.tool} is not available (${tool.status}): ${tool.problem ?? "not found"}`)
  };
}

/** Read the optional `operation` argument, or an Error naming the accepted values. */
function readRequirementOperation(args: unknown): MotionRequirementOperation | undefined | Error {
  const record = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : null;
  const value = record?.operation;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !MOTION_REQUIREMENT_OPERATIONS.includes(value as MotionRequirementOperation)) {
    return new Error(`motion.platform.requirements operation must be one of: ${MOTION_REQUIREMENT_OPERATIONS.join(", ")}.`);
  }
  return value as MotionRequirementOperation;
}
