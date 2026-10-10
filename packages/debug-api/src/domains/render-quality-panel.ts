/** Quality policy inspection behind a bounded manifest-analysis capability. */
import { hashBuffer } from "@shellx-motion/core";
import { lstat, readlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { stringArg } from "./args.js";

interface QualityPanelView {
  counts: { samples: number; regions: number; baselines: number; audioPolicies: number };
  audio?: unknown;
  samples?: unknown;
  warnings: string[];
}

interface LoadedQualityPanel {
  panel: QualityPanelView;
  packageId?: string;
  motionId?: string;
}

export interface RenderQualityPanelServices {
  scratchRoot?: string;
  qualityInputRoots?: string[];
  isPathInsideTrustedRoot?: (root: string, path: string) => Promise<boolean>;
  readQualityPanel?: (input: {
    manifestPath: string;
    trustedRoots: readonly string[];
    inputPath?: string;
    packageRoot?: string;
    preset?: string;
  }) => Promise<LoadedQualityPanel>;
}

export async function dispatchRenderQualityPanelCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: RenderQualityPanelServices
): Promise<MotionDebugResult | null> {
  if (command !== "motion.quality.panel") return null;
  const manifestPath = stringArg(args, "qualityManifestPath") ?? stringArg(args, "manifestPath");
  const inputPath = stringArg(args, "inputPath") ?? undefined;
  const packageRoot = stringArg(args, "packageRoot") ?? undefined;
  const preset = stringArg(args, "preset") ?? undefined;
  if (!manifestPath) return invalidArgs("motion.quality.panel requires qualityManifestPath.");
  if (!services.readQualityPanel) return capabilityUnavailable("Quality manifest analysis is unavailable.");
  if (!services.isPathInsideTrustedRoot) return capabilityUnavailable("Quality panel trusted-path validation is unavailable.");
  const trustedRoots = [services.scratchRoot ?? ".scratch", ...(services.qualityInputRoots ?? []), ...(packageRoot ? [packageRoot] : [])];
  for (const [label, path] of [["qualityManifestPath", manifestPath], ["inputPath", inputPath]] as const) {
    if (!path) continue;
    let trusted = false;
    for (const root of trustedRoots) {
      if (await services.isPathInsideTrustedRoot(root, path)) {
        trusted = true;
        break;
      }
    }
    if (!trusted) return invalidArgs(`motion.quality.panel ${label} must be inside packageRoot or a trusted debug input root.`);
  }
  try {
    const loaded = await services.readQualityPanel({
      manifestPath,
      trustedRoots,
      ...(inputPath ? { inputPath } : {}), ...(packageRoot ? { packageRoot } : {}), ...(preset ? { preset } : {})
    });
    const receiptId = `quality-panel-${hashBuffer(Buffer.from(JSON.stringify({
      manifestPath, inputPath, packageRoot, preset,
      counts: loaded.panel.counts, audio: loaded.panel.audio, samples: loaded.panel.samples
    }), "utf8")).slice(0, 16)}`;
    return {
      ok: true, receiptId,
      visibleState: {
        panel: "quality", operation: "quality.panel",
        ...(loaded.packageId ? { packageId: loaded.packageId } : {}),
        ...(loaded.motionId ? { motionId: loaded.motionId } : {}),
        manifestPath, sampleCount: loaded.panel.counts.samples, regionCount: loaded.panel.counts.regions,
        baselineCount: loaded.panel.counts.baselines, hasAudioPolicy: loaded.panel.counts.audioPolicies > 0,
        ...(preset ? { preset } : {})
      },
      result: loaded.panel, warnings: loaded.panel.warnings
    };
  } catch (error) {
    return invalidArgs(error instanceof Error ? error.message : String(error));
  }
}

/** Admit every resolved baseline before a panel performs its first existence probe. */
export async function assertQualityPanelBaselineRoots(
  samples: readonly { baselinePath?: string }[],
  trustedRoots: readonly string[],
  isPathInsideTrustedRoot: (root: string, path: string) => Promise<boolean>,
): Promise<void> {
  for (const sample of samples) {
    if (!sample.baselinePath) continue;
    let trusted = false;
    try {
      const candidate = await resolveQualityPanelBaseline(sample.baselinePath);
      for (const root of trustedRoots) {
        if (await isPathInsideTrustedRoot(root, candidate)) {
          trusted = true;
          break;
        }
      }
    } catch { /* Inaccessible paths and symlink loops receive the same bounded refusal. */ }
    if (!trusted) throw new Error("motion.quality.panel baseline must be inside packageRoot or a trusted debug input root.");
  }
}

/** Follow symlinks lexically even when their target is absent; realpath alone loses that boundary. */
async function resolveQualityPanelBaseline(path: string, remainingLinks = 40): Promise<string> {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  const canonicalParent = await resolveQualityPanelBaseline(parent, remainingLinks);
  const candidate = join(canonicalParent, basename(absolute));
  const facts = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!facts?.isSymbolicLink()) return candidate;
  if (remainingLinks <= 0) throw new Error("Baseline symlink traversal limit exceeded.");
  return await resolveQualityPanelBaseline(resolve(canonicalParent, await readlink(candidate)), remainingLinks - 1);
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}
