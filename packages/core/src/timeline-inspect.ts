import type { MotionDocument, MotionMarker, MotionScene, MotionTrack } from "./types";

export interface MotionLayerTrackRef {
  layerId: string;
  trackId: string;
}

export interface MotionTimelineInspection {
  trackCount: number;
  sceneCount: number;
  markerCount: number;
  tracks: MotionTrack[];
  scenes: MotionScene[];
  markers: MotionMarker[];
  layerTrackRefs: MotionLayerTrackRef[];
}

export function inspectMotionTimeline(motion: MotionDocument): MotionTimelineInspection {
  const tracks = motion.tracks ? motion.tracks.map((track) => ({ ...track })) : [];
  const scenes = motion.scenes ? motion.scenes.map((scene) => ({ ...scene })) : [];
  const markers = motion.markers ? motion.markers.map((marker) => ({ ...marker })) : [];
  const layerTrackRefs = motion.layers
    .filter((layer) => typeof layer.trackId === "string" && layer.trackId.length > 0)
    .map((layer) => ({ layerId: layer.id, trackId: layer.trackId as string }));

  return {
    trackCount: tracks.length,
    sceneCount: scenes.length,
    markerCount: markers.length,
    tracks,
    scenes,
    markers,
    layerTrackRefs
  };
}
