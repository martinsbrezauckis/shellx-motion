export interface BrowserRecordingManifestFrame {
  index: number;
  atMs: number;
  path: string;
  sha256: string;
  width: number;
  height: number;
  format: "png" | "jpeg";
}

export interface BrowserRecordingManifest {
  schema: "shellx-motion/browser-recording-manifest@1";
  mode: "deterministic-browser-frame-samples";
  packageId: string;
  motionId: string;
  lane: "browser";
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  sampleCount: number;
  frames: BrowserRecordingManifestFrame[];
  browser: { name: string; version: string };
  viewport: { width: number; height: number; deviceScaleFactor: number };
  captureReadiness?: BrowserRecordingCaptureReadiness;
  deterministic: {
    network: "blocked-unless-declared" | "allow";
    animations: "disabled";
    caret: "hide";
    deviceScaleFactor: number;
  };
  workflow?: {
    hash?: string;
    tracePath?: string;
    catalogPath?: string;
  };
  encodePlan: {
    pipeline: ["browser", "ffmpeg"];
    frameLane: "browser";
    finalLane: "ffmpeg";
    suggestedArgs: {
      render: string[];
      debugRender: string[];
    };
  };
}

export interface BrowserRecordingCaptureReadiness {
  schema: "shellx-motion/browser-capture-readiness@1";
  page?: "loaded";
  stylesheets?: "settled";
  fonts?: "ready" | "unsupported" | "timeout" | "error";
  animationPolicy?: "screenshot-disabled";
  media?: "settled-after-time-seek";
  waitMs?: number;
  diagnostics?: {
    stylesheetLinkCount?: number;
    fontFaceCount?: number;
    fontFaceLoadAttemptCount?: number;
    fontFaceLoadedCount?: number;
    finiteAnimationCount?: number;
    finiteAnimationMaxMs?: number;
    finiteTransitionCount?: number;
    finiteTransitionMaxMs?: number;
  };
}

export interface BuildBrowserRecordingManifestInput {
  packageId: string;
  motionId: string;
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  frames: BrowserRecordingManifestFrame[];
  browser: BrowserRecordingManifest["browser"];
  viewport: BrowserRecordingManifest["viewport"];
  deterministic: BrowserRecordingManifest["deterministic"];
  captureReadiness?: BrowserRecordingManifest["captureReadiness"];
  workflow?: BrowserRecordingManifest["workflow"];
}

export function browserRecordingSampleTimes(input: { durationMs: number; sampleCount: number }): number[] {
  const durationMs = Math.max(0, Math.round(input.durationMs));
  const sampleCount = Math.max(1, Math.floor(input.sampleCount));
  if (sampleCount === 1) return [0];
  return Array.from({ length: sampleCount }, (_value, index) =>
    Math.round((durationMs * index) / (sampleCount - 1))
  );
}

export function buildBrowserRecordingManifest(input: BuildBrowserRecordingManifestInput): BrowserRecordingManifest {
  return {
    schema: "shellx-motion/browser-recording-manifest@1",
    mode: "deterministic-browser-frame-samples",
    packageId: input.packageId,
    motionId: input.motionId,
    lane: "browser",
    width: input.width,
    height: input.height,
    durationMs: input.durationMs,
    fps: input.fps,
    sampleCount: input.frames.length,
    frames: input.frames,
    browser: input.browser,
    viewport: input.viewport,
    ...(input.captureReadiness ? { captureReadiness: input.captureReadiness } : {}),
    deterministic: input.deterministic,
    ...(input.workflow ? { workflow: input.workflow } : {}),
    encodePlan: {
      pipeline: ["browser", "ffmpeg"],
      frameLane: "browser",
      finalLane: "ffmpeg",
      suggestedArgs: {
        render: ["render", input.packageId, "--frame-lane", "browser", "--preset", "mp4-h264"],
        debugRender: ["debug", "render-final", "--package", input.packageId, "--frame-lane", "browser", "--preset", "mp4-h264"]
      }
    }
  };
}
