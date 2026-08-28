import {
  canonicalJsonSha256,
  hashAttestedRenderReuseExternalInputInsideRoot,
  hashBuffer,
  readAttestedRenderReuseExternalInput,
  type AttestedRenderReuseInputs,
} from "@shellx-motion/core";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const MAX_ATTESTED_REUSE_QUALITY_BASELINES = 64;

/** Derive the complete bounded quality-input closure used by an opt-in reuse entry. */
export async function deriveAttestedRenderReuseQualityInputs(
  manifestPath: string,
): Promise<Pick<AttestedRenderReuseInputs, "qualityManifestSha256" | "qualityBaselinesSha256">> {
  const manifestBytes = await readAttestedRenderReuseExternalInput(manifestPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("attested-reuse quality manifest contains invalid JSON");
  }
  const manifest = objectRecord(parsed);
  if (!manifest || manifest.schema !== "shellx-motion/quality-manifest@1" || !Array.isArray(manifest.samples) || manifest.samples.length === 0) {
    throw new Error("attested-reuse quality manifest must be a non-empty shellx-motion/quality-manifest@1 samples array");
  }

  const manifestRoot = await realpath(dirname(resolve(manifestPath)));
  const baselines: Array<{ sampleIndex: number; sha256: string }> = [];
  for (let sampleIndex = 0; sampleIndex < manifest.samples.length; sampleIndex += 1) {
    const sample = objectRecord(manifest.samples[sampleIndex]);
    if (!sample) throw new Error(`attested-reuse quality manifest sample ${sampleIndex + 1} must be an object`);
    if (typeof sample.baseline !== "string" || !sample.baseline.trim()) continue;
    if (baselines.length >= MAX_ATTESTED_REUSE_QUALITY_BASELINES) {
      throw new Error(`attested-reuse quality manifest exceeds its ${MAX_ATTESTED_REUSE_QUALITY_BASELINES}-baseline fingerprint budget`);
    }
    const baseline = sample.baseline.trim();
    baselines.push({
      sampleIndex,
      sha256: await hashAttestedRenderReuseExternalInputInsideRoot({
        root: manifestRoot,
        path: isAbsolute(baseline) ? baseline : resolve(manifestRoot, baseline),
        label: `attested-reuse quality manifest baseline ${sampleIndex + 1}`,
      }),
    });
  }

  return {
    qualityManifestSha256: hashBuffer(manifestBytes),
    qualityBaselinesSha256: canonicalJsonSha256({
      schema: "shellx-motion/attested-render-quality-baselines@1",
      baselines,
    }),
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
