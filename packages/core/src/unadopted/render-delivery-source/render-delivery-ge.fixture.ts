/** Synthetic GE-shaped delivery fixture. It never invokes UE or reads a provider filesystem. */

import { renderDeliveryFrameSequenceSha256, renderDeliveryScheduleSha256 } from "./render-delivery-identity";
import type { MotionRenderDelivery } from "./render-delivery-types";

const hash = (digit: string): string => digit.repeat(64);

export function syntheticGeRenderDelivery(): MotionRenderDelivery {
  const rate = { numerator: 30, denominator: 1 } as const;
  const schedule = [
    { index: 0, presentationTime: { numerator: 0, denominator: 1 } },
    { index: 1, presentationTime: { numerator: 1, denominator: 30 } },
    { index: 2, presentationTime: { numerator: 1, denominator: 15 } },
  ] as const;
  const frames = [{ index: 0, sha256: hash("1") }, { index: 1, sha256: hash("2") }, { index: 2, sha256: hash("3") }] as const;
  return {
    schema: "motion.render-delivery/v1",
    provider: { id: "shellx-ge", version: "ge-provider-v1", capabilitySnapshotSha256: hash("4") },
    terminal: { jobId: "mars-approach-01", outcome: "passed", revalidation: "passed", cleanup: { state: "closed", succeeded: true } },
    identity: { sceneSha256: hash("5"), shotSha256: hash("6"), assetManifestSha256: hash("7"), scheduleSha256: renderDeliveryScheduleSha256(rate, schedule), providerReceiptSha256: hash("8") },
    conventions: { timing: "frame-index-rational-seconds", coordinates: "screen-pixel-top-left", alpha: "straight", depth: "not-provided" },
    rate,
    schedule,
    passes: [{ kind: "beauty", id: "beauty", format: "png", alphaMode: "straight", width: 1_920, height: 1_080, frames, frameSequenceSha256: renderDeliveryFrameSequenceSha256(frames) }],
    anchors: { schema: "motion.render-provider-anchor-payload/v1", sha256: hash("9"), frameCount: 3, convention: "screen-pixel-top-left-q1024" },
  };
}

export function syntheticGeImportSources(): { readonly beauty: readonly { readonly index: number; readonly providerLocalPath: string }[]; readonly anchors: { readonly providerLocalPath: string } } {
  return {
    beauty: [0, 1, 2].map((index) => ({ index, providerLocalPath: `C:\\ge-private\\jobs\\mars-approach-01\\beauty\\${String(index).padStart(6, "0")}.png` })),
    anchors: { providerLocalPath: "C:\\ge-private\\jobs\\mars-approach-01\\anchors.json" },
  };
}
