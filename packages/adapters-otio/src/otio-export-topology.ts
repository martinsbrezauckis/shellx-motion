import { compareCodeUnits, type MotionLayer } from "@shellx-motion/core";

interface OtioTrackGroup {
  layers: MotionLayer[];
}

/** OTIO track children are sequential, so same-track Motion overlaps need a separate lowering. */
export function assertOtioRepresentableTopology(trackGroups: readonly OtioTrackGroup[]): void {
  for (const track of trackGroups) {
    let latestEndMs = Number.NEGATIVE_INFINITY;
    for (const layer of track.layers
      .slice()
      .sort((left, right) => left.startMs - right.startMs || compareCodeUnits(left.id, right.id))) {
      if (layer.startMs < latestEndMs) {
        throw new Error("OTIO export does not support overlapping layers on the same Motion track; place overlapping layers on separate Motion tracks before export.");
      }
      latestEndMs = Math.max(latestEndMs, layer.startMs + layer.durationMs);
    }
  }
}
