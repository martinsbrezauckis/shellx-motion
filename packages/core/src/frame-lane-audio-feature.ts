/**
 * Whether a capability gap concerns audio only, so a visual frame producer can leave its muxing
 * to a compatible final-delivery lane without advertising unsupported visual work.
 */
export function isAudioOnlyFrameLaneUnsupported(feature: string): boolean {
  return feature === "layer.type:audio"
    || feature === "volume"
    || feature === "pan"
    || feature === "keyframe.volume"
    || feature === "keyframe.pan"
    || feature.startsWith("audio.");
}
