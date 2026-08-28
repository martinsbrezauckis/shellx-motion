import { resolve } from "node:path";
import { motionLayoutGapAnimationLaneRefusal, motionScene3DAnimationLaneRefusal, resolvePackageAsset } from "@shellx-motion/core";
import type { RenderStreamingFinalInput } from "./streaming-final-adapter-types";

export interface GpuVideoAudioSnapshot {
  sourcePath: string;
  path: string;
  sha256: string;
  root: string;
}

export function bindGpuVideoAudioSnapshots(
  input: RenderStreamingFinalInput,
  snapshots: ReadonlyMap<string, GpuVideoAudioSnapshot>
): {
  audioPath?: string;
  audio?: NonNullable<RenderStreamingFinalInput["audio"]>;
  audioTracks?: NonNullable<RenderStreamingFinalInput["audioTracks"]>;
  inputRoots?: string[];
} {
  const bySourcePath = new Map([...snapshots.values()].map((snapshot) => [snapshot.sourcePath, snapshot]));
  const consumedSourcePaths = new Set<string>();
  const bind = (audio: NonNullable<RenderStreamingFinalInput["audio"]>) => {
    const snapshot = bySourcePath.get(audio.path);
    if (snapshot) consumedSourcePaths.add(snapshot.sourcePath);
    return snapshot
      ? { ...audio, path: snapshot.path, receiptPath: audio.receiptPath ?? audio.path, snapshotSha256: snapshot.sha256 }
      : audio;
  };
  const audio = input.audio ? bind(input.audio) : undefined;
  const audioTracks = input.audioTracks?.map(bind);
  const audioPathSnapshot = input.audioPath ? bySourcePath.get(input.audioPath) : undefined;
  if (audioPathSnapshot) consumedSourcePaths.add(audioPathSnapshot.sourcePath);
  const audioPath = input.audioPath && !audioPathSnapshot ? input.audioPath : undefined;
  const snapshotAudio = audioPathSnapshot
    ? { path: audioPathSnapshot.path, receiptPath: input.audioPath, snapshotSha256: audioPathSnapshot.sha256 }
    : undefined;
  const roots = [...new Set([...(input.inputRoots ?? []), ...[...snapshots.values()].map((snapshot) => snapshot.root)])];
  for (const snapshot of snapshots.values()) {
    if (!consumedSourcePaths.has(snapshot.sourcePath)) throw new Error("GPU video PCM staging did not bind every admitted includeAudio source to the final encoder input.");
  }
  return {
    ...(audioPath ? { audioPath } : {}),
    ...(audio ?? snapshotAudio ? { audio: audio ?? snapshotAudio } : {}),
    ...(audioTracks ? { audioTracks } : {}),
    ...(roots.length ? { inputRoots: roots } : {})
  };
}

/**
 * The pure command planner cannot admit an MP4/MOV video as final audio. GPU video audio is first
 * decoded from the already immutable video snapshot into private PCM; this preliminary pass omits
 * only those deferred inputs and the otherwise temporarily input-less master bus.
 */
export function preliminaryGpuAudio(
  input: Pick<RenderStreamingFinalInput, "pkg" | "audioPath" | "audio" | "audioTracks" | "audioMaster">
): Pick<RenderStreamingFinalInput, "audioPath" | "audio" | "audioTracks" | "audioMaster"> {
  const layoutGapAnimationRefusal = motionLayoutGapAnimationLaneRefusal(input.pkg.motion, "ffmpeg-gpu");
  if (layoutGapAnimationRefusal) throw new PreliminaryGpuAudioRefusal("motion_layout_gap_animation_unavailable", layoutGapAnimationRefusal.message);
  const scene3dAnimationRefusal = motionScene3DAnimationLaneRefusal(input.pkg.motion, "ffmpeg-gpu");
  if (scene3dAnimationRefusal) throw new PreliminaryGpuAudioRefusal("motion_scene3d_animation_unavailable", scene3dAnimationRefusal.message);
  const videoAudioLayers = input.pkg.motion.layers.filter((layer) => layer.type === "video" && layer.includeAudio === true);
  const layerIds = new Set(videoAudioLayers.map((layer) => layer.id));
  const paths = new Set(videoAudioLayers
    .map((layer) => layer.assetRef ?? layer.src)
    .filter((assetRef): assetRef is string => typeof assetRef === "string" && assetRef.length > 0)
    .map((assetRef) => resolve(resolvePackageAsset(input.pkg, assetRef))));
  const deferred = (audio: { path: string; layerId?: string }) =>
    (audio.layerId !== undefined && layerIds.has(audio.layerId)) || paths.has(resolve(audio.path));

  if (input.audioTracks && input.audioTracks.length > 0) {
    const audioTracks = input.audioTracks.filter((audio) => !deferred(audio));
    return {
      ...(audioTracks.length ? { audioTracks } : {}),
      ...(audioTracks.length && input.audioMaster !== undefined ? { audioMaster: input.audioMaster } : {})
    };
  }
  if (input.audio) {
    return deferred(input.audio)
      ? {}
      : { audio: input.audio, ...(input.audioMaster !== undefined ? { audioMaster: input.audioMaster } : {}) };
  }
  if (input.audioPath) {
    return paths.has(resolve(input.audioPath))
      ? {}
      : { audioPath: input.audioPath, ...(input.audioMaster !== undefined ? { audioMaster: input.audioMaster } : {}) };
  }
  return {};
}

export class PreliminaryGpuAudioRefusal extends Error {
  readonly code: "motion_scene3d_animation_unavailable" | "motion_layout_gap_animation_unavailable";
  constructor(code: PreliminaryGpuAudioRefusal["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "PreliminaryGpuAudioRefusal";
    Object.setPrototypeOf(this, PreliminaryGpuAudioRefusal.prototype);
  }
}
