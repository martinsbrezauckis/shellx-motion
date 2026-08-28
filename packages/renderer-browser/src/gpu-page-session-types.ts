import type { GpuPageObservation } from "./gpu-runtime-assessment";
import type { GpuRuntimeFailure, InternalGpuFramePlan } from "./gpu-runtime-types";

export type InternalCompositeDraw = Exclude<InternalGpuFramePlan["draws"][number], { kind: "adjustment" | "motionBlurEnd" | "groupEnd" }>;
export type InternalPrimitiveDraw = Exclude<InternalGpuFramePlan["draws"][number], { kind: "adjustment" | "scene3d" | "environment" | "material" | "motionBlurStart" | "motionBlurEnd" | "groupStart" | "groupEnd" }>;
/** Compile-time-only no-module view used by the byte-stable legacy page renderer. */
export type InternalGpuLegacyFramePlan = Omit<InternalGpuFramePlan, "draws"> & {
  draws: Exclude<InternalGpuFramePlan["draws"][number], { kind: "effectModule" }>[];
};
export type InternalGpuLegacyPrimitiveDraw = Exclude<InternalGpuLegacyFramePlan["draws"][number], { kind: "adjustment" | "scene3d" | "environment" | "material" | "motionBlurStart" | "motionBlurEnd" | "groupStart" | "groupEnd" }>;

export type GpuPageSessionOpenOutput =
  | { ok: true; runtime: GpuPageObservation }
  | { ok: false; failure: GpuRuntimeFailure };

export type GpuPageSessionFrameOutput =
  | { ok: true; bytesPerRow: number; paddedBase64: string }
  | { ok: false; failure: GpuRuntimeFailure };

export type GpuPageSessionImageOutput =
  | { ok: true; uploaded: number; decoded: readonly { id: string; sourceSha256: string; decodedSha256: string; width: number; height: number }[] }
  | { ok: false; failure: GpuRuntimeFailure };

export type GpuPageSessionImageInput =
  | { id: string; width: number; height: number; rgbaBase64: string; sourceSha256: string; /** Required SHA-256 of these exact decoded RGBA bytes. */ decodedSha256: string; replace?: true }
  | { id: string; width: number; height: number; bytesBase64: string; mimeType: "image/jpeg" | "image/webp" | "image/svg+xml"; sourceSha256: string; staticSvg?: true; replace?: true };

/** A texture is allocated once from these scalar facts; it contains no frame until replacement. */
export interface GpuPageSessionDynamicImageReservation {
  id: string;
  width: number;
  height: number;
  sourceSha256: string;
}

export type GpuPageSessionDynamicImageReservationOutput =
  | { ok: true; reserved: number }
  | { ok: false; failure: GpuRuntimeFailure };

export type GpuPageSessionDynamicImageReplacementOutput =
  | { ok: true; replaced: number; decoded: readonly { id: string; sourceSha256: string; decodedSha256: string; width: number; height: number }[] }
  | { ok: false; failure: GpuRuntimeFailure };
