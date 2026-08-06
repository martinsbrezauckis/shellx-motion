import { describe, expect, it } from "vitest";
import { buildBrowserRecordingManifest, browserRecordingSampleTimes } from "./browser-recording-manifest";

describe("browser recording manifest", () => {
  it("samples deterministic browser capture times across the Motion duration", () => {
    expect(browserRecordingSampleTimes({ durationMs: 300, sampleCount: 3 })).toEqual([0, 150, 300]);
    expect(browserRecordingSampleTimes({ durationMs: 300, sampleCount: 1 })).toEqual([0]);
    expect(browserRecordingSampleTimes({ durationMs: 300, sampleCount: 0 })).toEqual([0]);
  });

  it("builds an honest deterministic browser-frame recording contract", () => {
    const manifest = buildBrowserRecordingManifest({
      packageId: "pkg_browser",
      motionId: "motion_browser",
      width: 1280,
      height: 720,
      durationMs: 300,
      fps: 10,
      frames: [
        { index: 0, atMs: 0, path: "frames/000000.png", sha256: "a".repeat(64), width: 1280, height: 720, format: "png" },
        { index: 1, atMs: 150, path: "frames/000001.png", sha256: "b".repeat(64), width: 1280, height: 720, format: "png" },
        { index: 2, atMs: 300, path: "frames/000002.png", sha256: "c".repeat(64), width: 1280, height: 720, format: "png" }
      ],
      browser: { name: "chromium", version: "test" },
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      deterministic: { network: "blocked-unless-declared", animations: "disabled", caret: "hide", deviceScaleFactor: 1 },
      captureReadiness: {
        schema: "shellx-motion/browser-capture-readiness@1",
        page: "loaded",
        stylesheets: "settled",
        fonts: "ready",
        animationPolicy: "screenshot-disabled",
        media: "settled-after-time-seek",
        waitMs: 8,
        diagnostics: {
          stylesheetLinkCount: 1,
          fontFaceCount: 0,
          fontFaceLoadAttemptCount: 0,
          fontFaceLoadedCount: 0,
          finiteAnimationCount: 1,
          finiteAnimationMaxMs: 1200,
          finiteTransitionCount: 0,
          finiteTransitionMaxMs: 0
        }
      },
      workflow: {
        hash: "d".repeat(64),
        tracePath: ".scratch/browser-workflow.trace.json",
        catalogPath: ".scratch/browser-workflows.catalog.json"
      }
    });

    expect(manifest).toMatchObject({
      schema: "shellx-motion/browser-recording-manifest@1",
      mode: "deterministic-browser-frame-samples",
      packageId: "pkg_browser",
      motionId: "motion_browser",
      lane: "browser",
      width: 1280,
      height: 720,
      durationMs: 300,
      fps: 10,
      sampleCount: 3,
      browser: { name: "chromium", version: "test" },
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      deterministic: { network: "blocked-unless-declared", animations: "disabled", caret: "hide", deviceScaleFactor: 1 },
      captureReadiness: {
        schema: "shellx-motion/browser-capture-readiness@1",
        fonts: "ready",
        waitMs: 8,
        diagnostics: {
          stylesheetLinkCount: 1,
          finiteAnimationMaxMs: 1200
        }
      },
      workflow: {
        hash: "d".repeat(64),
        tracePath: ".scratch/browser-workflow.trace.json",
        catalogPath: ".scratch/browser-workflows.catalog.json"
      },
      encodePlan: {
        pipeline: ["browser", "ffmpeg"],
        frameLane: "browser",
        finalLane: "ffmpeg"
      }
    });
    expect(manifest.frames.map((frame) => frame.atMs)).toEqual([0, 150, 300]);
  });
});
