export type MotionSdkSpatialTangentMode = "linear" | "smooth" | "broken" | "auto";
export interface MotionSdkSpatialHandle { x: number; y: number }
export interface MotionSdkSpatialInterpolation {
  mode: MotionSdkSpatialTangentMode;
  in: MotionSdkSpatialHandle;
  out: MotionSdkSpatialHandle;
}

export type MotionSdkTimelineEdit =
  | { kind: "rich.set"; layerId: string; path: string; value: string | number | boolean }
  | { kind: "keyframe.upsert"; layerId: string; target: string; atMs: number; value: string | number; easing?: string }
  | { kind: "keyframe.delete"; layerId: string; target: string; atMs: number }
  | { kind: "keyframe.range.delete"; layerId: string; target: string; startMs?: number; endMs?: number }
  | { kind: "keyframe.move"; layerId: string; target: string; fromMs: number; toMs: number }
  | { kind: "keyframe.easing.apply"; layerId: string; target: string; easing: string; atMs?: number; startMs?: number; endMs?: number }
  | { kind: "keyframe.shift"; layerId: string; target: string; deltaMs: number; startMs?: number; endMs?: number }
  | { kind: "keyframe.scale"; layerId: string; target: string; scale: number; originMs: number; startMs?: number; endMs?: number }
  | { kind: "keyframe.duplicate"; layerId: string; target: string; deltaMs: number; startMs?: number; endMs?: number }
  | { kind: "keyframe.distribute"; layerId: string; target: string; startMs?: number; endMs?: number }
  | { kind: "keyframe.reverse"; layerId: string; target: string; startMs?: number; endMs?: number }
  | { kind: "keyframe.snap"; layerId: string; target: string; fps?: number; mode?: "nearest" | "floor" | "ceil"; startMs?: number; endMs?: number }
  | { kind: "spatial.position.upsert"; layerId: string; atMs: number; x: number; y: number; easing?: string; spatial?: MotionSdkSpatialInterpolation }
  | { kind: "spatial.position.move"; layerId: string; fromMs: number; toMs: number }
  | { kind: "spatial.position.delete"; layerId: string; atMs: number };

export type MotionSdkTimelineReceiptOperation =
  | "timeline.keyframe.upsert" | "timeline.keyframe.delete" | "timeline.keyframe.range.delete"
  | "timeline.keyframe.move" | "timeline.keyframe.easing.apply" | "timeline.keyframe.shift"
  | "timeline.keyframe.scale" | "timeline.keyframe.duplicate" | "timeline.keyframe.distribute"
  | "timeline.keyframe.reverse" | "timeline.keyframe.snap" | "timeline.layer.rich.set"
  | "timeline.spatial.position.upsert" | "timeline.spatial.position.move" | "timeline.spatial.position.delete";

export interface MotionSdkTimelineEditRequest {
  packageRoot: string;
  outDir: string;
  receiptsRoot?: string;
  createdBy?: string;
  edit: MotionSdkTimelineEdit;
}

export interface MotionSdkTimelineEditResponse {
  packageRoot: string;
  package: MotionSdkPackageIdentity;
  edit: MotionSdkTimelineEdit;
  receipt: MotionSdkPersistedReceipt<MotionSdkTimelineReceiptOperation>;
  warnings: string[];
}
import type { MotionSdkPackageIdentity, MotionSdkPersistedReceipt } from "./package-types.js";
