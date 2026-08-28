import type { MotionDebugResult } from "../command-registry.js";

interface QualityPathPolicyServices {
  qualityInputRoots?: string[];
  qualityOutputRoots?: string[];
  isQualityPathInsideRoots?: (path: string, roots: string[]) => Promise<boolean>;
}

export async function qualityPathPolicyFailure(input: {
  services: QualityPathPolicyServices;
  manifestPath: string | null;
  framePath: string | null;
  baselinePath: string | null;
  outDir?: string;
  receiptsRoot?: string;
}): Promise<MotionDebugResult | null> {
  const inputRoots = input.services.qualityInputRoots ?? [];
  const outputRoots = input.services.qualityOutputRoots ?? [];
  const checks: Array<{ path: string | null | undefined; roots: string[]; label: string }> = [
    { path: input.manifestPath, roots: inputRoots, label: "manifestPath" },
    { path: input.framePath, roots: inputRoots, label: "framePath" },
    { path: input.baselinePath, roots: inputRoots, label: "baselinePath" },
    { path: input.outDir, roots: outputRoots, label: "outDir" },
    { path: input.receiptsRoot, roots: outputRoots, label: "receiptsRoot" }
  ];
  for (const check of checks) {
    if (!check.path) continue;
    if (check.roots.length === 0 || !await input.services.isQualityPathInsideRoots!(check.path, check.roots)) {
      return invalidArgs(`motion.quality.check ${check.label} must be inside a trusted quality ${check.label === "outDir" || check.label === "receiptsRoot" ? "output" : "input"} root.`);
    }
  }
  return null;
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}
