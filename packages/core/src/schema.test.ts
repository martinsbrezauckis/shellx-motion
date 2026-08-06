import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadSchema, validateDocument } from "./validate";

describe("schemas", () => {
  it("validates render job handoff contracts for queued/running leased runners", async () => {
    const schema = await loadSchema("renderJobHandoff");
    expect(schema).toMatchObject({
      name: "renderJobHandoff",
      schema: "shellx-motion/render-job-handoff@1"
    });

    const handoff = {
      schema: "shellx-motion/render-job-handoff@1",
      jobId: "render-retry-panel",
      receiptId: "render-retry-panel",
      receiptPath: "/tmp/receipts/retry.receipt.json",
      operation: "render.retry",
      packageId: "pkg_queue",
      lane: "ffmpeg",
      state: "pending",
      createdAt: "2026-07-01T00:00:00.000Z",
      inputHashes: { motion: "a".repeat(64) },
      sourceReceiptId: "render-failed-panel",
      eventReplay: {
        schema: "shellx-motion/job-event-replay@1",
        eventLogPath: "/tmp/receipts/events/render-retry-panel.events.jsonl",
        eventCount: 4,
        lastSeq: 4,
        lastEventAt: "2026-07-01T00:00:04.000Z",
        reconnectCursor: { receiptId: "render-retry-panel", sinceSeq: 4 }
      },
      retryAttempt: 1
    };

    expect(await validateDocument(schema, handoff)).toEqual({ ok: true });
    expect(await validateDocument(schema, {
      ...handoff,
      state: "succeeded",
      retryAttempt: 0,
      inputHashes: [],
      eventReplay: {
        schema: "shellx-motion/job-event-replay@1",
        eventCount: -1,
        lastSeq: -1,
        reconnectCursor: { receiptId: "", sinceSeq: -1 }
      }
    })).toEqual({
      ok: false,
      errors: [
        { path: "/inputHashes", message: "must be an object" },
        { path: "/state", message: "must be pending or running" },
        { path: "/retryAttempt", message: "must be a positive integer" },
        { path: "/eventReplay/eventCount", message: "must be a non-negative integer" },
        { path: "/eventReplay/lastSeq", message: "must be a non-negative integer" },
        { path: "/eventReplay/reconnectCursor/receiptId", message: "must be a non-empty string" },
        { path: "/eventReplay/reconnectCursor/sinceSeq", message: "must be a non-negative integer" }
      ]
    });
  });

  it("validates prompt job handoff contracts for queued/running local agents", async () => {
    const schema = await loadSchema("promptJobHandoff");
    expect(schema).toMatchObject({
      name: "promptJobHandoff",
      schema: "shellx-motion/prompt-job-handoff@1"
    });

    const handoff = {
      schema: "shellx-motion/prompt-job-handoff@1",
      jobId: "prompt-retry-panel",
      receiptId: "prompt-retry-panel",
      receiptPath: "/tmp/receipts/prompt-retry.receipt.json",
      operation: "prompt.retry",
      packageId: "pkg_prompt_queue",
      lane: "agent",
      state: "pending",
      createdAt: "2026-07-01T00:00:00.000Z",
      inputHashes: { prompt: "a".repeat(64) },
      request: "edit the title and preview",
      agentId: "codex",
      sourceReceiptId: "prompt-failed-panel",
      eventReplay: {
        schema: "shellx-motion/job-event-replay@1",
        eventLogPath: "/tmp/receipts/events/prompt-retry-panel.events.jsonl",
        eventCount: 3,
        lastSeq: 3,
        lastEventAt: "2026-07-01T00:00:03.000Z",
        reconnectCursor: { receiptId: "prompt-retry-panel", sinceSeq: 3 }
      },
      retryAttempt: 1
    };

    expect(await validateDocument(schema, handoff)).toEqual({ ok: true });
    expect(await validateDocument(schema, {
      ...handoff,
      state: "succeeded",
      retryAttempt: 0,
      inputHashes: [],
      request: "",
      eventReplay: {
        schema: "shellx-motion/job-event-replay@1",
        eventCount: -1,
        lastSeq: -1,
        reconnectCursor: { receiptId: "", sinceSeq: -1 }
      }
    })).toEqual({
      ok: false,
      errors: [
        { path: "/request", message: "must be a non-empty string" },
        { path: "/inputHashes", message: "must be an object" },
        { path: "/state", message: "must be pending or running" },
        { path: "/retryAttempt", message: "must be a positive integer" },
        { path: "/eventReplay/eventCount", message: "must be a non-negative integer" },
        { path: "/eventReplay/lastSeq", message: "must be a non-negative integer" },
        { path: "/eventReplay/reconnectCursor/receiptId", message: "must be a non-empty string" },
        { path: "/eventReplay/reconnectCursor/sinceSeq", message: "must be a non-negative integer" }
      ]
    });
  });

  it("validates package manifest contracts for portable Motion packages", async () => {
    const schema = await loadSchema("packageManifest");
    expect(schema).toMatchObject({
      name: "packageManifest",
      schema: "shellx-motion/package-manifest@1"
    });

    const manifest = {
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_lower_third",
      name: "Lower Third Fixture",
      motion: "motion.json",
      template: "template.json",
      assets: ["assets/headshot.png"],
      sourceApp: "shellx-motion",
      compatibility: {
        lanes: ["native", "browser", "ffmpeg"],
        hosts: ["shellx-motion", "shellx-canvas", "shellx-cut"]
      },
      quality: { maxFontFallbacks: 0 },
      workflow: "template-controls",
      selectedFrameId: "frame_story_hero"
    };

    expect(await validateDocument(schema, manifest)).toEqual({ ok: true });
    expect(await validateDocument(schema, {
      ...manifest,
      id: "",
      motion: "",
      assets: ["assets/headshot.png", 42],
      sourceApp: "",
      quality: { maxFontFallbacks: -1 },
      compatibility: { lanes: ["native", 99], hosts: "shellx-motion" }
    })).toEqual({
      ok: false,
      errors: [
        { path: "/id", message: "must be a non-empty string" },
        { path: "/motion", message: "must be a non-empty string" },
        { path: "/sourceApp", message: "must be a non-empty string" },
        { path: "/assets/1", message: "must be a string" },
        { path: "/quality/maxFontFallbacks", message: "must be a non-negative integer" },
        { path: "/compatibility/lanes/1", message: "must be a string" },
        { path: "/compatibility/hosts", message: "must be an array" }
      ]
    });
  });

  it("validates quality manifests for final render gates", async () => {
    const schema = await loadSchema("qualityManifest");
    expect(schema).toMatchObject({
      name: "qualityManifest",
      schema: "shellx-motion/quality-manifest@1"
    });

    const manifest = {
      schema: "shellx-motion/quality-manifest@1",
      audio: {
        expect: true,
        minPeakDb: -50,
        minMeanDb: -35,
        maxPeakDb: -1,
        minIntegratedLoudnessLufs: -24,
        maxIntegratedLoudnessLufs: -20,
        maxTruePeakDbtp: -1,
        maxLoudnessRangeLu: 12
      },
      samples: [
        {
          id: "title_safe",
          atMs: 800,
          baseline: "baselines/title_safe.png",
          minBrightPixels: 2000,
          minEdgePixels: 1000,
          minLumaRange: 48,
          minChromaPixels: 1500,
          minTransparentPixels: 0,
          minNonTransparentPixels: 2000,
          maxChangedPixels: 921600,
          maxMeanDiff: 3,
          minPsnrDb: 35,
          minSsim: 0.98,
          compareAlpha: false,
          regions: [
            { id: "title", x: 0, y: 0, width: 1280, height: 720, minBrightPixels: 1000 }
          ]
        }
      ]
    };

    expect(await validateDocument(schema, manifest)).toEqual({ ok: true });
    expect(await validateDocument(schema, {
      ...manifest,
      audio: { expect: "yes", minPeakDb: "quiet" },
      samples: [
        {
          id: "",
          atMs: -1,
          minSsim: 1.1,
          minBrightPixels: "lots",
          minLumaRange: -1,
          minChromaPixels: -1,
          minChangedPixelsFromPrevious: -1,
          compareAlpha: "no",
          regions: [
            { id: "", x: -1, y: 0, width: 0, height: 10 }
          ]
        }
      ]
    })).toEqual({
      ok: false,
      errors: [
        { path: "/audio/expect", message: "must be a boolean" },
        { path: "/audio/minPeakDb", message: "must be a finite number" },
        { path: "/samples/0/id", message: "must be a non-empty string" },
        { path: "/samples/0/atMs", message: "must be a non-negative finite number" },
        { path: "/samples/0/minBrightPixels", message: "must be a non-negative finite number" },
        { path: "/samples/0/minLumaRange", message: "must be a non-negative finite number" },
        { path: "/samples/0/minChromaPixels", message: "must be a non-negative finite number" },
        { path: "/samples/0/minChangedPixelsFromPrevious", message: "must be a non-negative finite number" },
        { path: "/samples/0/minSsim", message: "must be a finite number between 0 and 1" },
        { path: "/samples/0/compareAlpha", message: "must be a boolean" },
        { path: "/samples/0/regions/0/id", message: "must be a non-empty string" },
        { path: "/samples/0/regions/0/x", message: "must be a non-negative integer" },
        { path: "/samples/0/regions/0/width", message: "must be a positive integer" }
      ]
    });
    expect(await validateDocument(schema, {
      ...manifest,
      samples: [{ id: "first", atMs: 0, minChangedPixelsFromPrevious: 1, minMeanDiffFromPrevious: 0.1 }]
    })).toEqual({
      ok: false,
      errors: [
        { path: "/samples/0/minChangedPixelsFromPrevious", message: "cannot require motion before the first sample" },
        { path: "/samples/0/minMeanDiffFromPrevious", message: "cannot require motion before the first sample" }
      ]
    });
    expect(await validateDocument(schema, {
      ...manifest,
      audio: {
        minIntegratedLoudnessLufs: -16,
        maxIntegratedLoudnessLufs: -24,
        maxLoudnessRangeLu: -1
      }
    })).toEqual({
      ok: false,
      errors: [
        { path: "/audio/maxLoudnessRangeLu", message: "must be a non-negative finite number" },
        { path: "/audio/maxIntegratedLoudnessLufs", message: "must be greater than or equal to minIntegratedLoudnessLufs" }
      ]
    });
  });

  it("validates expected preview fixture contracts", async () => {
    const schema = await loadSchema("expectedPreview");
    expect(schema).toMatchObject({
      name: "expectedPreview",
      schema: "shellx-motion/expected-preview@1"
    });

    const expected = {
      schema: "shellx-motion/expected-preview@1",
      renderer: "@shellx-motion/renderer-native",
      fixture: "lower-third",
      atMs: 0,
      width: 1920,
      height: 1080,
      sha256: "6f7376be48e7228bf25e1ee84864d376434e429d6158a295bdebd4207bc6efec"
    };

    expect(await validateDocument(schema, expected)).toEqual({ ok: true });
    expect(await validateDocument(schema, {
      ...expected,
      renderer: "",
      fixture: "",
      atMs: -1,
      width: 0,
      height: "1080",
      sha256: "bad"
    })).toEqual({
      ok: false,
      errors: [
        { path: "/renderer", message: "must be a non-empty string" },
        { path: "/fixture", message: "must be a non-empty string" },
        { path: "/atMs", message: "must be a non-negative finite number" },
        { path: "/width", message: "must be a positive finite number" },
        { path: "/height", message: "must be a positive finite number" },
        { path: "/sha256", message: "must be a 64-character hex string" }
      ]
    });
  });

  it("validates deterministic browser workflow replay plans", async () => {
    const schema = await loadSchema("browserWorkflow");
    expect(schema).toMatchObject({
      name: "browserWorkflow",
      schema: "shellx-motion/browser-workflow@1"
    });

    const workflow = {
      schema: "shellx-motion/browser-workflow@1",
      viewport: { width: 640, height: 360, deviceScaleFactor: 1 },
      networkPolicy: "blocked-unless-declared",
      steps: [
        { action: "wait", ms: 100 },
        { action: "click", selector: "#swap" },
        { action: "type", selector: "#prompt", text: "launch" },
        { action: "press", selector: "#prompt", key: "Enter" },
        { action: "scroll", x: 0, y: 240 },
        { action: "verify", selector: "#state", text: "Ready" }
      ],
      cursor: { visible: true, path: [{ x: 10, y: 20, atMs: 0 }] }
    };

    expect(await validateDocument(schema, workflow)).toEqual({ ok: true });
    expect(await validateDocument(schema, {
      ...workflow,
      viewport: { width: 0, height: "large", deviceScaleFactor: -1 },
      networkPolicy: "internet",
      steps: [
        { action: "wait", ms: -1 },
        { action: "click", selector: 42 },
        { action: "type", selector: "#prompt" },
        { action: "press", selector: "#prompt", key: "" },
        { action: "scroll", x: "left", y: 0 },
        { action: "verify", selector: 42, text: 99 },
        { action: "screenshot" }
      ],
      cursor: { visible: "yes", path: [{ x: "left", y: 20, atMs: -1 }] }
    })).toEqual({
      ok: false,
      errors: [
        { path: "/viewport/width", message: "must be a positive finite number" },
        { path: "/viewport/height", message: "must be a positive finite number" },
        { path: "/viewport/deviceScaleFactor", message: "must be a positive finite number" },
        { path: "/networkPolicy", message: "must be blocked-unless-declared or allow" },
        { path: "/steps/0/ms", message: "must be a non-negative finite number" },
        { path: "/steps/1/selector", message: "must be a non-empty string" },
        { path: "/steps/2/text", message: "required" },
        { path: "/steps/3/key", message: "must be a non-empty string" },
        { path: "/steps/4/x", message: "must be a finite number" },
        { path: "/steps/5/selector", message: "must be a non-empty string" },
        { path: "/steps/5/text", message: "must be a string" },
        { path: "/steps/6/action", message: "unsupported browser workflow action" },
        { path: "/cursor/visible", message: "must be a boolean" },
        { path: "/cursor/path/0/x", message: "must be a finite number" },
        { path: "/cursor/path/0/atMs", message: "must be a non-negative finite number" }
      ]
    });
  });

  it("bounds deterministic browser workflow waits", async () => {
    const schema = await loadSchema("browserWorkflow");
    const maxStepWaitMs = 30_000;
    const maxTotalWaitMs = 120_000;
    const workflow = {
      schema: "shellx-motion/browser-workflow@1",
      steps: [
        { action: "wait", ms: maxStepWaitMs + 1 },
        { action: "wait", ms: maxStepWaitMs },
        { action: "wait", ms: maxStepWaitMs },
        { action: "wait", ms: maxStepWaitMs }
      ]
    };

    expect(await validateDocument(schema, workflow)).toEqual({
      ok: false,
      errors: [
        { path: "/steps/0/ms", message: `must be no more than ${maxStepWaitMs} milliseconds` },
        { path: "/steps", message: `total wait time must be no more than ${maxTotalWaitMs} milliseconds` }
      ]
    });
  });

  it("validates redacted browser workflow trace receipts", async () => {
    const schema = await loadSchema("browserWorkflowTrace");
    expect(schema).toMatchObject({
      name: "browserWorkflowTrace",
      schema: "shellx-motion/browser-workflow-trace@1"
    });

    const trace = {
      schema: "shellx-motion/browser-workflow-trace@1",
      workflowHash: "b".repeat(64),
      stepCount: 2,
      steps: [
        { index: 0, action: { action: "click", selector: "#swap" }, status: "passed" },
        {
          index: 1,
          action: { action: "verify", selector: "#state", hasText: true },
          status: "failed",
          error: {
            code: "text_mismatch",
            message: "Expected selector text to contain requested workflow text.",
            selector: "#state",
            expectedTextLength: 5,
            actualTextLength: 3,
            actualTextSha256: "c".repeat(64)
          }
        }
      ],
      cursor: { visible: true, pointCount: 1 },
      captureReadiness: {
        schema: "shellx-motion/browser-capture-readiness@1",
        page: "loaded",
        stylesheets: "settled",
        fonts: "ready",
        animationPolicy: "screenshot-disabled",
        media: "settled-after-time-seek",
        waitMs: 12,
        diagnostics: {
          stylesheetLinkCount: 1,
          fontFaceCount: 2,
          fontFaceLoadAttemptCount: 2,
          fontFaceLoadedCount: 2,
          finiteAnimationCount: 1,
          finiteAnimationMaxMs: 1200,
          finiteTransitionCount: 1,
          finiteTransitionMaxMs: 650
        }
      }
    };

    expect(await validateDocument(schema, trace)).toEqual({ ok: true });
    expect(await validateDocument(schema, {
      ...trace,
      workflowHash: "",
      stepCount: -1,
      steps: [
        { index: -1, action: [], status: "done", error: { code: "oops", message: "" } }
      ],
      cursor: { visible: "yes", pointCount: -1 },
      captureReadiness: {
        schema: "bad",
        page: "loaded",
        stylesheets: "settled",
        fonts: "missing",
        animationPolicy: "screenshot-disabled",
        media: "settled-after-time-seek",
        waitMs: -1,
        diagnostics: {
          stylesheetLinkCount: -1,
          fontFaceCount: 0,
          fontFaceLoadAttemptCount: 0,
          fontFaceLoadedCount: 0,
          finiteAnimationCount: 0,
          finiteAnimationMaxMs: -1,
          finiteTransitionCount: 0,
          finiteTransitionMaxMs: 0
        }
      }
    })).toEqual({
      ok: false,
      errors: [
        { path: "/workflowHash", message: "must be a non-empty string" },
        { path: "/stepCount", message: "must be a non-negative integer" },
        { path: "/steps/0/index", message: "must be a non-negative integer" },
        { path: "/steps/0/action", message: "must be an object" },
        { path: "/steps/0/status", message: "must be passed or failed" },
        { path: "/steps/0/error/code", message: "must be action_failed or text_mismatch" },
        { path: "/steps/0/error/message", message: "must be a non-empty string" },
        { path: "/cursor/visible", message: "must be a boolean" },
        { path: "/cursor/pointCount", message: "must be a non-negative integer" },
        { path: "/captureReadiness/schema", message: "must equal shellx-motion/browser-capture-readiness@1" },
        { path: "/captureReadiness/fonts", message: "must be ready, unsupported, timeout, or error" },
        { path: "/captureReadiness/waitMs", message: "must be a non-negative finite number" },
        { path: "/captureReadiness/diagnostics/stylesheetLinkCount", message: "must be a non-negative integer" },
        { path: "/captureReadiness/diagnostics/finiteAnimationMaxMs", message: "must be a non-negative finite number" }
      ]
    });
    expect(await validateDocument(schema, {
      ...trace,
      steps: [
        { index: 0, action: { action: "type", selector: "#prompt", text: "secret prompt", textLength: 13 }, status: "passed" },
        { index: 1, action: { action: "verify", selector: "#state", text: "Ready", hasText: true }, status: "passed" }
      ]
    })).toEqual({
      ok: false,
      errors: [
        { path: "/steps/0/action/text", message: "must be redacted from workflow traces" },
        { path: "/steps/1/action/text", message: "must be redacted from workflow traces" }
      ]
    });
  });

  it("validates deterministic browser workflow drift catalogs", async () => {
    const schema = await loadSchema("browserWorkflowCatalog");
    expect(schema).toMatchObject({
      name: "browserWorkflowCatalog",
      schema: "shellx-motion/browser-workflow-catalog@1"
    });

    const snapshot = {
      capturedAt: "2026-07-02T08:00:00.000Z",
      outputSha256: "b".repeat(64),
      outputPath: "/tmp/frame.png",
      receiptPath: "/tmp/capture.receipt.json",
      tracePath: "/tmp/workflow.trace.json",
      browser: { name: "chromium", version: "test" },
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      workflow: { stepCount: 2, networkPolicy: "blocked-unless-declared" }
    };
    const catalog = {
      schema: "shellx-motion/browser-workflow-catalog@1",
      entries: [
        {
          key: "pkg_web:".concat("a".repeat(64), ":750"),
          packageId: "pkg_web",
          workflowHash: "a".repeat(64),
          atMs: 750,
          firstSeenAt: "2026-07-02T08:00:00.000Z",
          updatedAt: "2026-07-02T08:01:00.000Z",
          baseline: snapshot,
          latest: { ...snapshot, capturedAt: "2026-07-02T08:01:00.000Z" },
          drift: {
            status: "matched",
            key: "pkg_web:".concat("a".repeat(64), ":750"),
            baselineOutputSha256: "b".repeat(64),
            previousOutputSha256: "b".repeat(64),
            currentOutputSha256: "b".repeat(64)
          },
          history: [snapshot]
        }
      ]
    };

    expect(await validateDocument(schema, catalog)).toEqual({ ok: true });
    expect(await validateDocument(schema, { schema: "shellx-motion/browser-workflow-catalog@1", entries: [] })).toEqual({ ok: true });
    expect(await validateDocument(schema, {
      ...catalog,
      entries: [
        {
          ...catalog.entries[0],
          key: "",
          packageId: "",
          workflowHash: "bad",
          atMs: -1,
          firstSeenAt: "",
          updatedAt: "",
          baseline: {
            ...snapshot,
            capturedAt: "",
            outputSha256: "bad",
            outputPath: "",
            receiptPath: "",
            tracePath: 42,
            browser: { name: 42, version: 42 },
            viewport: { width: 0, height: "720", deviceScaleFactor: -1 },
            workflow: { stepCount: -1, networkPolicy: 42 }
          },
          latest: 42,
          drift: { status: "drifted", key: "other", baselineOutputSha256: "bad", currentOutputSha256: "" },
          history: [42]
        },
        42
      ]
    })).toEqual({
      ok: false,
      errors: [
        { path: "/entries/0/key", message: "must be a non-empty string" },
        { path: "/entries/0/packageId", message: "must be a non-empty string" },
        { path: "/entries/0/workflowHash", message: "must be a 64-character hex string" },
        { path: "/entries/0/atMs", message: "must be a non-negative finite number" },
        { path: "/entries/0/firstSeenAt", message: "must be a non-empty string" },
        { path: "/entries/0/updatedAt", message: "must be a non-empty string" },
        { path: "/entries/0/baseline/capturedAt", message: "must be a non-empty string" },
        { path: "/entries/0/baseline/outputSha256", message: "must be a 64-character hex string" },
        { path: "/entries/0/baseline/outputPath", message: "must be a non-empty string" },
        { path: "/entries/0/baseline/receiptPath", message: "must be a non-empty string" },
        { path: "/entries/0/baseline/tracePath", message: "must be a string" },
        { path: "/entries/0/baseline/browser/name", message: "must be a string" },
        { path: "/entries/0/baseline/browser/version", message: "must be a string" },
        { path: "/entries/0/baseline/viewport/width", message: "must be a positive finite number" },
        { path: "/entries/0/baseline/viewport/height", message: "must be a positive finite number" },
        { path: "/entries/0/baseline/viewport/deviceScaleFactor", message: "must be a positive finite number" },
        { path: "/entries/0/baseline/workflow/stepCount", message: "must be a non-negative integer" },
        { path: "/entries/0/baseline/workflow/networkPolicy", message: "must be a string" },
        { path: "/entries/0/latest", message: "must be an object" },
        { path: "/entries/0/drift/status", message: "must be new, matched, or changed" },
        { path: "/entries/0/drift/key", message: "must equal entry key" },
        { path: "/entries/0/drift/baselineOutputSha256", message: "must be a 64-character hex string" },
        { path: "/entries/0/drift/currentOutputSha256", message: "must be a 64-character hex string" },
        { path: "/entries/0/history/0", message: "must be an object" },
        { path: "/entries/1", message: "must be an object" }
      ]
    });
  });

  it("validates Canvas package resource catalogs", async () => {
    const schema = await loadSchema("resourceCatalog");
    expect(schema).toMatchObject({
      name: "resourceCatalog",
      schema: "shellx-motion/resource-catalog@1"
    });

    const catalog = {
      schema: "shellx-motion/resource-catalog@1",
      packageId: "pkg_canvas_launch_campaign_frame_story_hero",
      sourceApp: "shellx-canvas",
      resources: [
        {
          id: "asset_product_retouched",
          ref: "assets/product-retouched.png",
          kind: "image",
          mimeType: "image/png",
          sha256: "a".repeat(64),
          source: {
            app: "shellx-canvas/image-editor",
            sourceFrameId: "frame_story_hero",
            receiptId: "canvas-export-frame_story_hero"
          }
        }
      ]
    };

    expect(await validateDocument(schema, catalog)).toEqual({ ok: true });
    expect(await validateDocument(schema, { ...catalog, resources: [] })).toEqual({ ok: true });
    expect(await validateDocument(schema, {
      ...catalog,
      packageId: "",
      sourceApp: "",
      resources: [
        {
          id: "",
          ref: 42,
          kind: "",
          mimeType: 42,
          sha256: "bad",
          source: { app: "", sourceFrameId: 42, receiptId: "" }
        },
        42
      ]
    })).toEqual({
      ok: false,
      errors: [
        { path: "/packageId", message: "must be a non-empty string" },
        { path: "/sourceApp", message: "must be a non-empty string" },
        { path: "/resources/0/id", message: "must be a non-empty string" },
        { path: "/resources/0/ref", message: "must be a non-empty string" },
        { path: "/resources/0/kind", message: "must be a non-empty string" },
        { path: "/resources/0/mimeType", message: "must be a non-empty string" },
        { path: "/resources/0/sha256", message: "must be a 64-character hex string" },
        { path: "/resources/0/source/app", message: "must be a non-empty string" },
        { path: "/resources/0/source/sourceFrameId", message: "must be a non-empty string" },
        { path: "/resources/0/source/receiptId", message: "must be a non-empty string" },
        { path: "/resources/1", message: "must be an object" }
      ]
    });
  });

  it("validates operation receipt envelopes and artifact evidence", async () => {
    const schema = await loadSchema("receipt");
    const receipt = {
      schema: "shellx-motion/receipt@1",
      id: "render-final-lower-third",
      operation: "render.final",
      status: "passed",
      packageId: "pkg_lower_third",
      inputHashes: { motion: "a".repeat(64), manifest: "b".repeat(64) },
      createdAt: "2026-07-01T00:00:00.000Z",
      lane: "ffmpeg",
      output: { outputPath: "/tmp/out/lower-third.mp4" },
      artifacts: [
        {
          role: "rendered_media",
          path: "/tmp/out/lower-third.mp4",
          status: "available",
          label: "Lower third",
          mediaType: "video/mp4",
          primary: true
        }
      ],
      warnings: []
    };

    expect(await validateDocument(schema, receipt)).toEqual({ ok: true });
    expect(await validateDocument(schema, {
      ...receipt,
      id: "",
      status: "done",
      packageId: "",
      inputHashes: { motion: "", manifest: 42 },
      createdAt: "",
      lane: "",
      artifacts: [
        { role: "", path: 42, status: "missing", label: 42, mediaType: 42, primary: "yes" },
        42
      ],
      warnings: ["ok", 42]
    })).toEqual({
      ok: false,
      errors: [
        { path: "/id", message: "must be a non-empty string" },
        { path: "/status", message: "unsupported receipt status" },
        { path: "/packageId", message: "must be a non-empty string" },
        { path: "/inputHashes/motion", message: "must be a non-empty string" },
        { path: "/inputHashes/manifest", message: "must be a non-empty string" },
        { path: "/createdAt", message: "must be a non-empty string" },
        { path: "/lane", message: "must be a non-empty string" },
        { path: "/artifacts/0/role", message: "must be a non-empty string" },
        { path: "/artifacts/0/path", message: "must be a non-empty string" },
        { path: "/artifacts/0/status", message: "unsupported artifact status" },
        { path: "/artifacts/0/label", message: "must be a string" },
        { path: "/artifacts/0/mediaType", message: "must be a string" },
        { path: "/artifacts/0/primary", message: "must be a boolean" },
        { path: "/artifacts/1", message: "must be an object" },
        { path: "/warnings/1", message: "must be a string" }
      ]
    });
  });

  it("accepts an optional actor block and rejects a malformed one", async () => {
    const schema = await loadSchema("receipt");
    const base = {
      schema: "shellx-motion/receipt@1",
      id: "template-apply-mcp",
      operation: "template.apply",
      status: "passed",
      packageId: "pkg_mcp",
      inputHashes: {},
      createdAt: "2026-07-22T12:00:00.000Z",
      lane: "template",
      output: {},
      warnings: []
    };

    // A fully-populated, well-formed actor validates.
    expect(await validateDocument(schema, {
      ...base,
      actor: {
        kind: "agent",
        label: "claude-code/1.0",
        transport: "mcp",
        clientInfo: "claude-code/1.0",
        sessionId: "srv-ab12:ws-3c4d",
        grantedTier: "render_motion"
      }
    })).toEqual({ ok: true });

    // A receipt with NO actor stays valid (backward compatible — the field is optional).
    expect(await validateDocument(schema, base)).toEqual({ ok: true });

    // A malformed actor is reported field-by-field: bad kind, empty label, unknown transport, non-string session.
    expect(await validateDocument(schema, {
      ...base,
      actor: { kind: "robot", label: "", transport: "carrier-pigeon", sessionId: 42 }
    })).toEqual({
      ok: false,
      errors: [
        { path: "/actor/kind", message: "unsupported actor kind" },
        { path: "/actor/label", message: "must be a non-empty string" },
        { path: "/actor/transport", message: "unsupported actor transport" },
        { path: "/actor/sessionId", message: "must be a string" }
      ]
    });
  });

  it("validates Cut import plan contracts for connector handoff", async () => {
    const schema = await loadSchema("cutImportPlan");
    expect(schema).toMatchObject({
      name: "cutImportPlan",
      schema: "shellx-motion/cut-import-plan@1"
    });

    const receipt = {
      schema: "shellx-motion/receipt@1",
      id: "cut-import-rendered",
      operation: "cut.import.plan",
      status: "passed",
      packageId: "pkg_lower_third",
      inputHashes: { motion: "a".repeat(64), targetCapabilities: "b".repeat(64) },
      createdAt: "2026-07-01T00:00:00.000Z",
      lane: "cut",
      output: { mode: "rendered_media", operationCount: 1, unsupportedCount: 0 },
      warnings: []
    };
    const plan = {
      schema: "shellx-motion/cut-import-plan@1",
      ok: true,
      packageId: "pkg_lower_third",
      motionId: "motion_lower_third",
      targetId: "cut-fixture",
      mode: "rendered_media",
      operations: [
        {
          verb: "cut.media.import_rendered",
          source: { packageId: "pkg_lower_third", motionId: "motion_lower_third", render: "artifact" },
          startMs: 0,
          durationMs: 4000,
          media: { width: 1920, height: 1080, fps: 30 },
          renderedMedia: {
            dryRun: false,
            handle: {
              schema: "shellx-motion/artifact-handle-ref@1",
              id: "artifact-0123456789abcdef01234567",
              operationHash: "d".repeat(64),
              rootRelativePath: "artifacts/rendered-media.artifact.json",
              sha256: "c".repeat(64),
              packageLineage: {
                schema: "shellx-motion/package-render-lineage@1",
                manifestSha256: "e".repeat(64),
                motionSha256: "f".repeat(64)
              }
            }
          }
        },
        {
          verb: "cut.timeline.marker.create",
          sourceMarkerId: "marker_intro",
          atMs: 500,
          durationMs: 100,
          payload: { label: "Intro" }
        }
      ],
      unsupported: [],
      document: { width: 1920, height: 1080, fps: 30, durationMs: 4000, background: "#101820" },
      timeline: {
        markers: [{ id: "marker_intro", atMs: 500, label: "Intro" }]
      },
      receipt
    };

    expect(await validateDocument(schema, plan)).toEqual({ ok: true });
    const dryRunPlan: any = structuredClone(plan);
    dryRunPlan.operations[0].source.render = "dry_run";
    dryRunPlan.operations[0].renderedMedia = { dryRun: true, plannedPath: "/tmp/render.mp4", receiptPath: "/tmp/render.receipt.json" };
    expect(await validateDocument(schema, dryRunPlan)).toEqual({ ok: true });
    dryRunPlan.operations[0].renderedMedia = { dryRun: true, path: "/tmp/stale.mp4", receiptPath: "/tmp/render.receipt.json" } as any;
    expect(await validateDocument(schema, dryRunPlan)).toEqual({
      ok: false,
      errors: [{ path: "/operations/0/renderedMedia/plannedPath", message: "must be a non-empty string" }]
    });
    const publishedSchema = JSON.parse(await readFile(new URL("../../../schemas/cut-import-plan.schema.json", import.meta.url), "utf8"));
    expect(publishedSchema.$defs.renderedMedia.oneOf[0]).toMatchObject({ required: ["dryRun", "plannedPath", "receiptPath"] });
    expect(publishedSchema.$defs.renderedMedia.oneOf[1]).toMatchObject({ required: ["dryRun", "handle"] });
    expect(await validateDocument(schema, {
      ...plan,
      ok: "yes",
      packageId: "",
      motionId: "",
      targetId: "",
      mode: "auto",
      operations: [
        {
          verb: "cut.media.import_rendered",
          source: { packageId: "", motionId: "", render: "soon" },
          startMs: -1,
          durationMs: 0,
          media: { width: 0, height: "1080", fps: 0 },
          renderedMedia: { dryRun: false, handle: { schema: "wrong", id: "", operationHash: "bad", rootRelativePath: "../escape.json", sha256: "bad", packageLineage: { schema: "wrong" } } }
        },
        { verb: "cut.unknown" }
      ],
      unsupported: [{ layerId: "", feature: 42, reason: "" }],
      document: { width: 0, height: 0, fps: 0, durationMs: -1, background: 42 },
      receipt: { ...receipt, status: "done" }
    })).toEqual({
      ok: false,
      errors: [
        { path: "/ok", message: "must be a boolean" },
        { path: "/packageId", message: "must be a non-empty string" },
        { path: "/motionId", message: "must be a non-empty string" },
        { path: "/targetId", message: "must be a non-empty string" },
        { path: "/mode", message: "must be rendered_media, live_overlay, editable_lowering, or null" },
        { path: "/operations/0/source/packageId", message: "must be a non-empty string" },
        { path: "/operations/0/source/motionId", message: "must be a non-empty string" },
        { path: "/operations/0/source/render", message: "must be required, dry_run, or artifact" },
        { path: "/operations/0/startMs", message: "must be a non-negative finite number" },
        { path: "/operations/0/durationMs", message: "must be a positive finite number" },
        { path: "/operations/0/media/width", message: "must be a positive finite number" },
        { path: "/operations/0/media/height", message: "must be a positive finite number" },
        { path: "/operations/0/media/fps", message: "must be a positive finite number" },
        { path: "/operations/0/renderedMedia/handle/schema", message: "must be shellx-motion/artifact-handle-ref@1" },
        { path: "/operations/0/renderedMedia/handle/id", message: "must be an artifact handle id" },
        { path: "/operations/0/renderedMedia/handle/operationHash", message: "must be a lowercase sha256 hash" },
        { path: "/operations/0/renderedMedia/handle/rootRelativePath", message: "must be a canonical root-relative path" },
        { path: "/operations/0/renderedMedia/handle/sha256", message: "must be a lowercase sha256 hash" },
        { path: "/operations/0/renderedMedia/handle/packageLineage", message: "must be a valid package render lineage" },
        { path: "/operations/1/verb", message: "unsupported cut import operation" },
        { path: "/unsupported/0/layerId", message: "must be a non-empty string" },
        { path: "/unsupported/0/feature", message: "must be a non-empty string" },
        { path: "/unsupported/0/reason", message: "must be a non-empty string" },
        { path: "/document/width", message: "must be a positive finite number" },
        { path: "/document/height", message: "must be a positive finite number" },
        { path: "/document/fps", message: "must be a positive finite number" },
        { path: "/document/durationMs", message: "must be a positive finite number" },
        { path: "/document/background", message: "must be a string" },
        { path: "/receipt/status", message: "unsupported receipt status" }
      ]
    });
  });

  it("validates redacted support bundle diagnostics", async () => {
    const schema = await loadSchema("supportBundle");
    expect(schema).toMatchObject({
      name: "supportBundle",
      schema: "shellx-motion/support-bundle@1"
    });

    const bundle = {
      schema: "shellx-motion/support-bundle@1",
      createdAt: "2026-07-01T00:00:00.000Z",
      package: {
        id: "pkg_debug_timeline",
        name: "Debug Timeline",
        motionId: "motion_debug_timeline",
        sourceApp: "shellx-motion",
        compatibility: { lanes: ["native", "ffmpeg"], hosts: ["shellx-motion"] },
        motion: { durationMs: 4000, fps: 30, width: 1920, height: 1080 },
        layerCount: 1,
        assetCount: 0,
        timeline: { trackCount: 1, sceneCount: 1, markerCount: 2 },
        inputHashes: { "manifest.json": "a".repeat(64), "motion.json": "b".repeat(64) }
      },
      receipts: {
        receiptsRoot: "/tmp/receipts",
        receiptCount: 1,
        receipts: [
          {
            id: "render-final-debug",
            operation: "render.final",
            status: "passed",
            packageId: "pkg_debug_timeline",
            lane: "ffmpeg",
            createdAt: "2026-07-01T00:00:01.000Z",
            path: "/tmp/receipts/render.receipt.json",
            outputPath: "/tmp/final.mp4",
            warnings: []
          }
        ]
      },
      platformVerification: {
        receiptCount: 1,
        receipts: [
          {
            schema: "shellx-motion/platform-verification@1",
            path: "/tmp/receipts/linux.platform.json",
            hostId: "linux",
            status: "passed",
            dryRun: false,
            commandCount: 1,
            failedCommandCount: 0
          }
        ]
      },
      debug: {
        commandCount: 2,
        commands: ["motion.support.bundle", "motion.package.patch"],
        actionCount: 1,
        actions: [
          { id: "motion.support.bundle", permission: "write_local", mutates: false, calls: ["motion.support.bundle"], surfaces: ["debug-api"] }
        ]
      },
      runtime: { node: "v24.0.0", platform: "linux", arch: "x64" },
      redactions: { envValues: "omitted" }
    };

    expect(await validateDocument(schema, bundle)).toEqual({ ok: true });
    expect(await validateDocument(schema, {
      ...bundle,
      createdAt: "",
      receipts: {
        receiptCount: -1,
        receipts: [
          { id: "", operation: 42, status: "", packageId: "", lane: "", createdAt: "", path: "", warnings: ["ok", 42] }
        ]
      },
      debug: {
        commandCount: -1,
        commands: ["motion.support.bundle", 42],
        actionCount: -1,
        actions: [
          { id: "", permission: "", mutates: "yes", calls: ["motion.support.bundle", 42], surfaces: "debug-api" }
        ]
      },
      runtime: { node: "", platform: 42, arch: "" },
      redactions: { envValues: "leaked" }
    })).toEqual({
      ok: false,
      errors: [
        { path: "/createdAt", message: "must be a non-empty string" },
        { path: "/receipts/receiptCount", message: "must be a non-negative integer" },
        { path: "/receipts/receipts/0/id", message: "must be a non-empty string" },
        { path: "/receipts/receipts/0/operation", message: "must be a non-empty string" },
        { path: "/receipts/receipts/0/status", message: "must be a non-empty string" },
        { path: "/receipts/receipts/0/packageId", message: "must be a non-empty string" },
        { path: "/receipts/receipts/0/lane", message: "must be a non-empty string" },
        { path: "/receipts/receipts/0/createdAt", message: "must be a non-empty string" },
        { path: "/receipts/receipts/0/path", message: "must be a non-empty string" },
        { path: "/receipts/receipts/0/warnings/1", message: "must be a string" },
        { path: "/debug/commandCount", message: "must be a non-negative integer" },
        { path: "/debug/commands/1", message: "must be a string" },
        { path: "/debug/actionCount", message: "must be a non-negative integer" },
        { path: "/debug/actions/0/id", message: "must be a non-empty string" },
        { path: "/debug/actions/0/permission", message: "must be a non-empty string" },
        { path: "/debug/actions/0/mutates", message: "must be a boolean" },
        { path: "/debug/actions/0/calls/1", message: "must be a string" },
        { path: "/debug/actions/0/surfaces", message: "must be an array" },
        { path: "/runtime/node", message: "must be a non-empty string" },
        { path: "/runtime/platform", message: "must be a non-empty string" },
        { path: "/runtime/arch", message: "must be a non-empty string" },
        { path: "/redactions/envValues", message: "must equal omitted" }
      ]
    });
  });

  it("validates Cut Generate scripted-video handoff contracts", async () => {
    const schema = await loadSchema("scriptedVideo");
    expect(schema).toMatchObject({
      name: "scriptedVideo",
      schema: "shellx-motion/scripted-video@1"
    });

    const scripted = {
      schema: "shellx-motion/scripted-video@1",
      id: "launch-demo",
      name: "Launch Demo",
      sourceApp: "shellx-cut",
      workflow: "generate",
      width: 1280,
      height: 720,
      fps: 24,
      frames: [
        { id: "hook", title: "Hook", body: "Show the new workflow", durationMs: 1000, background: "#0f172a", accent: "#38bdf8" },
        { id: "cta", title: "Cut edits it", caption: "Rendered by Motion", durationMs: 1500, background: "#111827", accent: "#22c55e" }
      ]
    };

    expect(await validateDocument(schema, scripted)).toEqual({ ok: true });
    expect(await validateDocument(schema, {
      ...scripted,
      intent: "data-viz",
      synopsis: "Turn source material into a reviewed multi-scene video.",
      review: { status: "ready-for-review", required: true },
      frames: [
        {
          id: "hook",
          title: "Hook",
          body: "Show the new workflow",
          durationMs: 1000,
          reviewStatus: "approved",
          agentNote: "Open with the strongest claim.",
          assetRefs: ["assets/logo.png"],
          sourceRefs: [{ type: "article", title: "Launch note", url: "https://example.test/launch" }],
          tags: ["intro"],
          template: { id: "frame-bold-signal", engine: "hyperframes", variables: { mood: "confident" } },
          engine: { id: "hyperframes", mode: "base" },
          effects: [
            { type: "rain", intensity: 8, speed: 1.2, opacity: 0.32, angle: -12, color: "#bfdbfe", seed: "storm-a" },
            { type: "signalPulse", intensity: 0.55 },
            { type: "cameraPush", scale: 1.035, x: -18, y: -12 },
            { type: "particleField", intensity: 6, speed: 1.4, opacity: 0.42, color: "#f8fafc", seed: "spark-a", shape: "ellipse" },
            { type: "scanSweep", intensity: 0.45, speed: 1.2, opacity: 0.3, angle: -14, color: "#ffffff" }
          ]
        }
      ]
    })).toEqual({ ok: true });
    expect(await validateDocument(schema, {
      ...scripted,
      id: "",
      name: "",
      sourceApp: "",
      workflow: "",
      width: 15,
      height: 4321,
      fps: 121,
      frames: [
        { id: "", title: "", body: 42, caption: 42, durationMs: 99, background: 42, accent: 42 },
        42
      ]
    })).toEqual({
      ok: false,
      errors: [
        { path: "/id", message: "must be a non-empty string" },
        { path: "/name", message: "must be a non-empty string" },
        { path: "/sourceApp", message: "must be a non-empty string" },
        { path: "/workflow", message: "must be a non-empty string" },
        { path: "/width", message: "must be an integer between 16 and 7680" },
        { path: "/height", message: "must be an integer between 16 and 4320" },
        { path: "/fps", message: "must be an integer between 1 and 120" },
        { path: "/frames/0/id", message: "must be a non-empty string" },
        { path: "/frames/0/title", message: "must be a non-empty string" },
        { path: "/frames/0/body", message: "must be a string" },
        { path: "/frames/0/caption", message: "must be a string" },
        { path: "/frames/0/durationMs", message: "must be an integer between 100 and 60000" },
        { path: "/frames/0/background", message: "must be a string" },
        { path: "/frames/0/accent", message: "must be a string" },
        { path: "/frames/1", message: "must be an object" }
      ]
    });
    expect(await validateDocument(schema, {
      ...scripted,
      intent: 42,
      synopsis: 42,
      review: { status: "", required: "yes" },
      frames: [
        {
          id: "hook",
          title: "Hook",
          durationMs: 1000,
          reviewStatus: 42,
          agentNote: 42,
          assetRefs: ["assets/logo.png", 42],
          sourceRefs: [{ type: "", title: 42, url: 42 }, 42],
          tags: ["intro", 42],
          template: { id: "", engine: "", variables: "bad" },
          engine: { id: "", mode: 42 },
          effects: [
            { type: "rain", intensity: 80, speed: 0, opacity: 1.5, angle: -60, color: 42, seed: 42 },
            { type: "particleField", intensity: 80, shape: "hexagon" },
            { type: "scanSweep", intensity: 2 },
            { type: "glitchWarp" },
            42
          ]
        }
      ]
    })).toEqual({
      ok: false,
      errors: [
        { path: "/intent", message: "must be a string" },
        { path: "/synopsis", message: "must be a string" },
        { path: "/review/status", message: "must be a non-empty string" },
        { path: "/review/required", message: "must be a boolean" },
        { path: "/frames/0/reviewStatus", message: "must be a string" },
        { path: "/frames/0/agentNote", message: "must be a string" },
        { path: "/frames/0/assetRefs/1", message: "must be a string" },
        { path: "/frames/0/sourceRefs/0/type", message: "must be a non-empty string" },
        { path: "/frames/0/sourceRefs/0/title", message: "must be a string" },
        { path: "/frames/0/sourceRefs/0/url", message: "must be a string" },
        { path: "/frames/0/sourceRefs/1", message: "must be an object" },
        { path: "/frames/0/tags/1", message: "must be a string" },
        { path: "/frames/0/template/id", message: "must be a non-empty string" },
        { path: "/frames/0/template/engine", message: "must be a non-empty string" },
        { path: "/frames/0/template/variables", message: "must be an object" },
        { path: "/frames/0/engine/id", message: "must be a non-empty string" },
        { path: "/frames/0/engine/mode", message: "must be a string" },
        { path: "/frames/0/effects/0/intensity", message: "must be an integer between 1 and 48" },
        { path: "/frames/0/effects/0/speed", message: "must be a finite number between 0.1 and 8" },
        { path: "/frames/0/effects/0/opacity", message: "must be a finite number between 0 and 1" },
        { path: "/frames/0/effects/0/angle", message: "must be a finite number between -45 and 45" },
        { path: "/frames/0/effects/0/color", message: "must be a string" },
        { path: "/frames/0/effects/0/seed", message: "must be a string" },
        { path: "/frames/0/effects/1/intensity", message: "must be an integer between 1 and 48" },
        { path: "/frames/0/effects/1/shape", message: "must be rect, ellipse, or star" },
        { path: "/frames/0/effects/2/intensity", message: "must be a finite number between 0.1 and 1" },
        { path: "/frames/0/effects/3/type", message: "must be rain, signalPulse, cameraPush, particleField, or scanSweep" },
        { path: "/frames/0/effects/4", message: "must be an object" }
      ]
    });
    expect(await validateDocument(schema, {
      ...scripted,
      frames: Array.from({ length: 121 }, (_entry, index) => ({ id: `frame-${index}`, title: `Frame ${index}`, durationMs: 100 }))
    })).toEqual({
      ok: false,
      errors: [{ path: "/frames", message: "must contain at most 120 frames" }]
    });
    expect(await validateDocument(schema, {
      ...scripted,
      frames: [
        { id: "a-b", title: "First", durationMs: 1000 },
        { id: "a_b", title: "Second", durationMs: 1000 }
      ]
    })).toEqual({
      ok: false,
      errors: [{ path: "/frames/1/id", message: "must be unique after sanitization" }]
    });
  });

  it("validates batch data row contracts for deterministic expansion", async () => {
    const schema = await loadSchema("dataRows");
    expect(schema).toMatchObject({
      name: "dataRows",
      schema: "shellx-motion/data-rows@1"
    });

    const rows = {
      schema: "shellx-motion/data-rows@1",
      rows: [
        { id: "ada", name: "Ada", background: "#0f172a", replace: { text: { title: "Hello Ada" } } },
        { id: "grace", name: "Grace", background: "#111827", locale: "en" }
      ]
    };

    expect(await validateDocument(schema, rows)).toEqual({ ok: true });
    expect(await validateDocument(schema, { ...rows, rows: [] })).toEqual({
      ok: false,
      errors: [{ path: "/rows", message: "must include at least one row" }]
    });
    expect(await validateDocument(schema, {
      ...rows,
      rows: [
        { id: "a-b", title: "First" },
        { id: "a_b", title: "Second" },
        42
      ]
    })).toEqual({
      ok: false,
      errors: [
        { path: "/rows/1/id", message: "must be unique after sanitization" },
        { path: "/rows/2", message: "must be an object" }
      ]
    });
  });

  it("validates duration policy contracts for timeline-safe resizing", async () => {
    const schema = await loadSchema("durationPolicy");
    expect(schema).toMatchObject({
      name: "durationPolicy",
      schema: "shellx-motion/duration-policy@1"
    });

    const policy = {
      schema: "shellx-motion/duration-policy@1",
      minDurationMs: 500,
      maxDurationMs: 2000,
      resizeMode: "stretch-middle",
      protectedRegions: [
        { id: "intro", label: "Intro lock", role: "intro", startMs: 0, durationMs: 120 },
        { id: "outro", label: "Outro lock", role: "outro", startMs: 420, durationMs: 80 }
      ]
    };

    expect(await validateDocument(schema, policy)).toEqual({ ok: true });
    expect(await validateDocument(schema, {
      ...policy,
      minDurationMs: "short",
      maxDurationMs: -1,
      resizeMode: "elastic",
      protectedRegions: [
        { id: "", label: 42, role: 42, startMs: -1, durationMs: 0 },
        42
      ]
    })).toEqual({
      ok: false,
      errors: [
        { path: "/minDurationMs", message: "must be a non-negative finite number" },
        { path: "/maxDurationMs", message: "must be a non-negative finite number" },
        { path: "/resizeMode", message: "must be stretch-middle, ripple, or fixed" },
        { path: "/protectedRegions/0/id", message: "must be a non-empty string" },
        { path: "/protectedRegions/0/label", message: "must be a string" },
        { path: "/protectedRegions/0/role", message: "must be a string" },
        { path: "/protectedRegions/0/startMs", message: "must be a non-negative finite number" },
        { path: "/protectedRegions/0/durationMs", message: "must be a positive finite number" },
        { path: "/protectedRegions/1", message: "must be an object" }
      ]
    });
    expect(await validateDocument(schema, { ...policy, minDurationMs: 900, maxDurationMs: 500 })).toEqual({
      ok: false,
      errors: [{ path: "/minDurationMs", message: "must be less than or equal to maxDurationMs" }]
    });
    expect(await validateDocument(schema, {
      ...policy,
      protectedRegions: [
        { id: "intro", startMs: 0, durationMs: 100 },
        { id: "intro", startMs: 200, durationMs: 100 }
      ]
    })).toEqual({
      ok: false,
      errors: [{ path: "/protectedRegions/1/id", message: "must be unique" }]
    });
  });

  it("validates persisted timeline control state contracts", async () => {
    const schema = await loadSchema("timelineState");
    expect(schema).toMatchObject({
      name: "timelineState",
      schema: "shellx-motion/timeline-state@1"
    });

    const state = {
      schema: "shellx-motion/timeline-state@1",
      packageId: "pkg_debug_timeline",
      motionId: "motion_debug_timeline",
      durationMs: 500,
      playheadMs: 250,
      selectedRange: { startMs: 100, endMs: 350 },
      viewport: { startMs: 0, endMs: 500, zoom: 1.5, pixelsPerSecond: 80 },
      updatedAt: "2026-07-01T00:00:00.000Z"
    };

    expect(await validateDocument(schema, state)).toEqual({ ok: true });
    expect(await validateDocument(schema, {
      schema: "shellx-motion/timeline-state@1",
      packageId: "pkg_debug_timeline",
      motionId: "motion_debug_timeline",
      durationMs: 500,
      playheadMs: 0,
      updatedAt: "2026-07-01T00:00:00.000Z"
    })).toEqual({ ok: true });
    expect(await validateDocument(schema, {
      ...state,
      packageId: "",
      motionId: "",
      playheadMs: -1,
      selectedRange: { startMs: -1, endMs: 600 },
      viewport: { startMs: 200, endMs: 100, zoom: 0, pixelsPerSecond: "fast" },
      updatedAt: ""
    })).toEqual({
      ok: false,
      errors: [
        { path: "/packageId", message: "must be a non-empty string" },
        { path: "/motionId", message: "must be a non-empty string" },
        { path: "/playheadMs", message: "must be a non-negative finite number" },
        { path: "/selectedRange/startMs", message: "must be a non-negative finite number" },
        { path: "/selectedRange/endMs", message: "must be less than or equal to durationMs" },
        { path: "/viewport/endMs", message: "must be greater than startMs" },
        { path: "/viewport/zoom", message: "must be a positive finite number" },
        { path: "/viewport/pixelsPerSecond", message: "must be a positive finite number" },
        { path: "/updatedAt", message: "must be a non-empty string" }
      ]
    });
    expect(await validateDocument(schema, { ...state, playheadMs: 600 })).toEqual({
      ok: false,
      errors: [{ path: "/playheadMs", message: "must be less than or equal to durationMs" }]
    });
  });

  it("validates shipped action and debug registry aggregates", async () => {
    const actionsSchema = await loadSchema("actions");
    const debugContractsSchema = await loadSchema("debugContracts");
    expect(actionsSchema).toMatchObject({
      name: "actions",
      schema: "shellx-motion/actions@1"
    });
    expect(debugContractsSchema).toMatchObject({
      name: "debugContracts",
      schema: "shellx-motion/debug-contracts@1"
    });

    const action = {
      id: "motion.actions.find",
      aliases: ["find action"],
      permission: "read_motion",
      mutates: false,
      calls: ["motion.actions.find"],
      verify: ["Returns a matching action id or null."],
      surfaces: ["prompt"]
    };
    const actions = {
      schema: "shellx-motion/actions@1",
      actionSchema: "shellx-motion/action@1",
      generatedBy: "scripts/generate-public-contracts.ts",
      actionCount: 1,
      permissions: ["read_motion"],
      surfaces: ["prompt"],
      actions: [action]
    };
    const debugContract = {
      command: "motion.state",
      permission: "read_motion",
      mutates: false,
      argsSchema: { type: "object", required: ["packageRoot"], properties: {} },
      expectedReceipts: [
        { operation: "preview.frame", mode: "emits", required: true, artifactRoles: ["preview_frame"] }
      ]
    };
    const debugContracts = {
      schema: "shellx-motion/debug-contracts@1",
      debugSchema: "shellx-motion/debug@1",
      generatedBy: "scripts/generate-public-contracts.ts",
      commandCount: 1,
      permissions: ["read_motion"],
      commands: ["motion.state"],
      contracts: [debugContract]
    };

    expect(await validateDocument(actionsSchema, actions)).toEqual({ ok: true });
    expect(await validateDocument(debugContractsSchema, debugContracts)).toEqual({ ok: true });
    expect(await validateDocument(actionsSchema, {
      ...actions,
      actionSchema: "shellx-motion/action@2",
      generatedBy: "",
      actionCount: 3,
      permissions: ["read_motion", 42],
      surfaces: "prompt",
      actions: [
        { ...action, id: "", aliases: "find", permission: "admin", mutates: "yes", calls: ["motion.actions.find", 42], verify: ["ok", 42], surfaces: ["prompt", 42] },
        42
      ]
    })).toEqual({
      ok: false,
      errors: [
        { path: "/actionSchema", message: "must equal shellx-motion/action@1" },
        { path: "/generatedBy", message: "must be a non-empty string" },
        { path: "/actionCount", message: "must equal actions length" },
        { path: "/permissions/1", message: "must be a string" },
        { path: "/surfaces", message: "must be an array" },
        { path: "/actions/0/id", message: "must be a non-empty string" },
        { path: "/actions/0/aliases", message: "must be an array" },
        { path: "/actions/0/permission", message: "unsupported permission tier" },
        { path: "/actions/0/mutates", message: "must be a boolean" },
        { path: "/actions/0/calls/1", message: "must be a string" },
        { path: "/actions/0/verify/1", message: "must be a string" },
        { path: "/actions/0/surfaces/1", message: "must be a string" },
        { path: "/actions/1", message: "must be an object" }
      ]
    });
    expect(await validateDocument(debugContractsSchema, {
      ...debugContracts,
      debugSchema: "shellx-motion/debug@2",
      generatedBy: "",
      commandCount: 3,
      permissions: ["read_motion", 42],
      commands: ["motion.state", 42],
      contracts: [
        {
          ...debugContract,
          command: "",
          permission: "admin",
          mutates: "no",
          argsSchema: { type: "array", required: ["packageRoot", 42], properties: [] },
          expectedReceipts: [
            { operation: "", mode: "writes", required: "yes", artifactRoles: ["preview_frame", 42] },
            42
          ]
        },
        42
      ]
    })).toEqual({
      ok: false,
      errors: [
        { path: "/debugSchema", message: "must equal shellx-motion/debug@1" },
        { path: "/generatedBy", message: "must be a non-empty string" },
        { path: "/commandCount", message: "must equal contracts length" },
        { path: "/permissions/1", message: "must be a string" },
        { path: "/commands/1", message: "must be a string" },
        { path: "/contracts/0/command", message: "must be a non-empty string" },
        { path: "/contracts/0/permission", message: "unsupported permission tier" },
        { path: "/contracts/0/mutates", message: "must be a boolean" },
        { path: "/contracts/0/argsSchema/type", message: "must equal object" },
        { path: "/contracts/0/argsSchema/required/1", message: "must be a string" },
        { path: "/contracts/0/argsSchema/properties", message: "must be an object" },
        { path: "/contracts/0/expectedReceipts/0/operation", message: "must be a non-empty string" },
        { path: "/contracts/0/expectedReceipts/0/mode", message: "must be emits or reads" },
        { path: "/contracts/0/expectedReceipts/0/required", message: "must be a boolean" },
        { path: "/contracts/0/expectedReceipts/0/artifactRoles/1", message: "must be a string" },
        { path: "/contracts/0/expectedReceipts/1", message: "must be an object" },
        { path: "/contracts/1", message: "must be an object" }
      ]
    });
  });

  it("requires action surfaces for host-generated action contracts", async () => {
    const schema = await loadSchema("action");
    const action = {
      id: "motion.actions.find",
      aliases: ["find action"],
      permission: "read_motion",
      mutates: false,
      calls: ["motion.actions.find"],
      verify: ["Returns a matching action id or null."],
      surfaces: ["prompt"]
    };

    expect(await validateDocument(schema, action)).toEqual({ ok: true });

    const withoutSurfaces = { ...action };
    delete (withoutSurfaces as Partial<typeof action>).surfaces;
    expect(await validateDocument(schema, withoutSurfaces)).toEqual({
      ok: false,
      errors: [{ path: "/surfaces", message: "required" }]
    });

    expect(await validateDocument(schema, { ...action, surfaces: ["prompt", 42] })).toEqual({
      ok: false,
      errors: [{ path: "/surfaces/1", message: "must be a string" }]
    });
  });

  it("validates single-host platform verification receipts", async () => {
    const schema = await loadSchema("platformVerification");
    const result = await validateDocument(schema, {
      schema: "shellx-motion/platform-verification@1",
      status: "passed",
      dryRun: false,
      host: {
        id: "linux",
        hostname: "linux.example.test",
        platform: "linux",
        arch: "x64",
        release: "6.8.0",
        node: "v24.0.0"
      },
      hostMatrix: {
        required: ["linux", "windows", "macos"],
        current: "linux",
        currentRequired: true,
        satisfied: ["linux"],
        missing: ["windows", "macos"],
        complete: false,
        status: "partial"
      },
      repoRoot: "/workspace/ShellX Motion",
      startedAt: "2026-07-03T10:00:00.000Z",
      finishedAt: "2026-07-03T10:20:00.000Z",
      commands: [
        { id: "typecheck", command: ["pnpm", "typecheck"], required: true, category: "core", status: "passed", durationMs: 1000 },
        { id: "connector:canvas-cut-smoke", command: ["pnpm", "run", "connector:canvas-cut-smoke"], required: false, category: "connector", status: "skipped", skipReason: "Missing required environment variables: SHELLX_CANVAS_ROOT." }
      ]
    });

    expect(result).toEqual({ ok: true });
  });

  it("rejects malformed platform verification receipts", async () => {
    const schema = await loadSchema("platformVerification");
    const result = await validateDocument(schema, {
      schema: "shellx-motion/platform-verification@1",
      status: "ok",
      dryRun: "false",
      host: { id: "" },
      repoRoot: "",
      startedAt: "",
      commands: [
        { id: "", command: "pnpm test", required: "yes", status: "done" }
      ]
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/status", message: "unsupported platform verification status" },
        { path: "/dryRun", message: "must be a boolean" },
        { path: "/host/id", message: "must be a non-empty string" },
        { path: "/repoRoot", message: "must be a non-empty string" },
        { path: "/startedAt", message: "must be a non-empty string" },
        { path: "/commands/0/id", message: "must be a non-empty string" },
        { path: "/commands/0/command", message: "must be an array" },
        { path: "/commands/0/required", message: "must be a boolean" },
        { path: "/commands/0/status", message: "unsupported platform command status" }
      ]
    });
  });

  it("validates aggregate platform verification receipts", async () => {
    const schema = await loadSchema("platformVerificationAggregate");
    const result = await validateDocument(schema, {
      schema: "shellx-motion/platform-verification-aggregate@1",
      status: "passed",
      dryRun: false,
      repoRoot: "/workspace/ShellX Motion",
      startedAt: "2026-07-03T10:30:00.000Z",
      finishedAt: "2026-07-03T10:30:00.000Z",
      requiredHosts: ["linux", "windows", "macos"],
      requiredCommands: ["typecheck", "test"],
      summary: {
        requiredHostCount: 3,
        satisfiedHostCount: 3,
        missingHosts: [],
        failedHosts: [],
        invalidReceiptCount: 0
      },
      receipts: [
        {
          path: "/tmp/linux.receipt.json",
          hostId: "linux",
          schemaOk: true,
          status: "passed",
          dryRun: false,
          ok: true,
          failures: [],
          requiredCommands: { total: 2, passed: 2, missing: [], failed: [] }
        }
      ]
    });

    expect(result).toEqual({ ok: true });
  });

  it("rejects inconsistent aggregate platform verification evidence", async () => {
    const schema = await loadSchema("platformVerificationAggregate");
    const result = await validateDocument(schema, {
      schema: "shellx-motion/platform-verification-aggregate@1",
      status: "passed",
      dryRun: false,
      repoRoot: "/workspace/ShellX Motion",
      startedAt: "2026-07-03T10:30:00.000Z",
      requiredHosts: ["linux", "windows", "macos"],
      requiredCommands: ["typecheck"],
      summary: {
        requiredHostCount: 2,
        satisfiedHostCount: 1,
        missingHosts: ["windows", "macos"],
        failedHosts: ["windows"],
        invalidReceiptCount: 1
      },
      receipts: [
        {
          path: "/tmp/windows.receipt.json",
          hostId: "windows",
          schemaOk: true,
          status: "failed",
          dryRun: true,
          ok: false,
          failures: ["receipt is dry-run/planned evidence"],
          requiredCommands: { total: 1, passed: 0, missing: [], failed: ["typecheck"] }
        }
      ]
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/summary/requiredHostCount", message: "must equal requiredHosts length" },
        { path: "/status", message: "passed aggregate cannot have missing, failed, or invalid host evidence" },
        { path: "/receipts/0", message: "passed aggregate cannot contain failed receipt summaries" }
      ]
    });
  });

  it("accepts the lower-third motion fixture", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, {
      schema: "shellx-motion/motion@1",
      id: "motion_lower_third",
      name: "Lower Third",
      durationMs: 4000,
      fps: 30,
      width: 1920,
      height: 1080,
      layers: [
        {
          id: "title",
          type: "text",
          text: "Anna",
          startMs: 0,
          durationMs: 4000,
          transform: { x: 120, y: 820, scale: 1, rotation: 0 },
          style: { fontFamily: "Inter", fontSize: 64, color: "#ffffff" }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    });

    expect(result).toEqual({ ok: true });
  });

  it("validates bounded package font-face assets", async () => {
    const schema = await loadSchema("motion");
    const valid = motionWithDocumentFields({
      assets: [{
        id: "font-inter-regular",
        type: "font",
        family: "ShellX Inter",
        source: { path: "assets/fonts/inter.woff2", mimeType: "font/woff2" },
        weight: 400,
        style: "normal",
      }],
    });
    expect(await validateDocument(schema, valid)).toEqual({ ok: true });

    const invalid = motionWithDocumentFields({
      assets: [
        { id: "font-a", type: "font", family: "Unsafe;src:url(x)", source: { path: "font.ttf", mimeType: "application/octet-stream" }, weight: 0, style: "sideways" },
        { id: "font-a", type: "font", family: "Unsafe;src:url(x)", source: { path: "font.ttf", mimeType: "font/ttf" } },
      ],
    });
    const result = await validateDocument(schema, invalid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      { path: "/assets/0/family", message: "must be a safe ASCII font-family alias" },
      { path: "/assets/0/source/mimeType", message: "must be font/woff2, font/woff, font/ttf, or font/otf" },
      { path: "/assets/0/weight", message: "must be an integer from 1 to 1000" },
      { path: "/assets/0/style", message: "must be normal, italic, or oblique" },
      { path: "/assets/1/id", message: "must be unique among font assets" },
    ]));
  });

  it("accepts image source crop rectangles", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      id: "product",
      type: "image",
      assetId: "asset_product",
      crop: { x: 80, y: 20, width: 320, height: 240 }
    }));

    expect(result).toEqual({ ok: true });
  });

  it("accepts video source crop rectangles", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      id: "clip",
      type: "video",
      source: "assets/clip.mp4",
      crop: { x: 80, y: 20, width: 320, height: 240 }
    }));

    expect(result).toEqual({ ok: true });
  });

  it("accepts layer visibility flags", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      id: "title",
      type: "text",
      visible: false
    }));

    expect(result).toEqual({ ok: true });
  });

  it("accepts layer lock flags", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      id: "title",
      type: "text",
      locked: true
    }));

    expect(result).toEqual({ ok: true });
  });

  it("returns path-specific errors for missing required fields", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, {
      schema: "shellx-motion/motion@1",
      id: "bad_motion"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({ path: "/name", message: "required" });
      expect(result.errors).toContainEqual({ path: "/layers", message: "required" });
    }
  });

  it("rejects root schema values that do not match the shipped const", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, {
      schema: 42,
      id: "bad_schema",
      name: "Bad Schema",
      durationMs: 1000,
      fps: 30,
      width: 1920,
      height: 1080,
      layers: [],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    });

    expect(result).toEqual({
      ok: false,
      errors: [{ path: "/schema", message: "must equal shellx-motion/motion@1" }]
    });
  });

  it("accepts supported layer keyframes", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithKeyframes({
      "transform.x": [
        { atMs: 0, value: 0, easing: "ease-out" },
        { atMs: 1000, value: 120 }
      ],
      "transform.y": [{ atMs: 0, value: 820 }],
      "transform.scale": [{ atMs: 0, value: 1 }],
      "transform.rotation": [{ atMs: 0, value: 0 }],
      "transform.width": [
        { atMs: 0, value: 120, easing: "cubic-bezier(0.2, -0.5, 0.8, 1.5)" },
        { atMs: 500, value: 180 }
      ],
      "transform.height": [{ atMs: 0, value: 48 }],
      "transform.originX": [
        { atMs: 0, value: 20, easing: "linear" },
        { atMs: 500, value: 0 }
      ],
      "transform.originY": [
        { atMs: 0, value: 10, easing: "linear" },
        { atMs: 500, value: 0 }
      ],
      "style.fontSize": [
        { atMs: 0, value: 24, easing: "linear" },
        { atMs: 500, value: 48 }
      ],
      "style.fontWeight": [
        { atMs: 0, value: 400, easing: "linear" },
        { atMs: 500, value: 900 }
      ],
      "style.letterSpacing": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 24 }
      ],
      "style.textAlign": [
        { atMs: 0, value: "left", easing: "hold" },
        { atMs: 500, value: "right" }
      ],
      "style.verticalAlign": [
        { atMs: 0, value: "top", easing: "hold" },
        { atMs: 500, value: "bottom" }
      ],
      "style.alignY": [
        { atMs: 0, value: "top", easing: "hold" },
        { atMs: 500, value: "middle" }
      ],
      "style.width": [
        { atMs: 0, value: 80, easing: "linear" },
        { atMs: 500, value: 160 }
      ],
      "style.height": [
        { atMs: 0, value: 40, easing: "linear" },
        { atMs: 500, value: 80 }
      ],
      "style.radius": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 16 }
      ],
      "style.borderRadius": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 16 }
      ],
      "style.padding": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 16 }
      ],
      "style.paddingX": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 16 }
      ],
      "style.paddingY": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 16 }
      ],
      "style.paddingTop": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 16 }
      ],
      "style.paddingRight": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 16 }
      ],
      "style.paddingBottom": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 16 }
      ],
      "style.paddingLeft": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 16 }
      ],
      "style.lineHeight": [
        { atMs: 0, value: 1.1, easing: "linear" },
        { atMs: 500, value: 1.6 }
      ],
      fill: [
        { atMs: 0, value: "#003366", easing: "linear" },
        { atMs: 500, value: "#66ccff" }
      ],
      "style.fill": [
        { atMs: 0, value: "#111827", easing: "linear" },
        { atMs: 500, value: "#f8fafc" }
      ],
      "style.color": [
        { atMs: 0, value: "#ffffff", easing: "linear" },
        { atMs: 500, value: "#111827" }
      ],
      "style.stroke": [
        { atMs: 0, value: "#111827", easing: "linear" },
        { atMs: 500, value: "#f8fafc" }
      ],
      "style.borderColor": [
        { atMs: 0, value: "#111827", easing: "linear" },
        { atMs: 500, value: "#f8fafc" }
      ],
      "style.backgroundColor": [
        { atMs: 0, value: "#111827", easing: "linear" },
        { atMs: 500, value: "#f8fafc" }
      ],
      "style.background": [
        { atMs: 0, value: "#111827", easing: "linear" },
        { atMs: 500, value: "#f8fafc" }
      ],
      "style.strokeWidth": [
        { atMs: 0, value: 2, easing: "linear" },
        { atMs: 500, value: 8 }
      ],
      "style.borderWidth": [
        { atMs: 0, value: 2, easing: "linear" },
        { atMs: 500, value: 8 }
      ],
      "style.shadow.x": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 16 }
      ],
      "style.shadow.offsetX": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 16 }
      ],
      "style.shadow.offsetY": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 16 }
      ],
      "style.shadow.blurRadius": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 4 }
      ],
      "style.shadow.spreadRadius": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 4 }
      ],
      "style.shadow.color": [
        { atMs: 0, value: "#00000000", easing: "linear" },
        { atMs: 500, value: "#000000" }
      ],
      "style.textShadow.blur": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 4 }
      ],
      "style.textShadow.offsetX": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 16 }
      ],
      "style.textShadow.offsetY": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 16 }
      ],
      "style.textShadow.blurRadius": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 4 }
      ],
      "style.textShadow.color": [
        { atMs: 0, value: "transparent", easing: "linear" },
        { atMs: 500, value: "black" }
      ],
      "mask.inset.top": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 12 }
      ],
      "mask.inset.right": [
        { atMs: 0, value: 80, easing: "linear" },
        { atMs: 500, value: 0 }
      ],
      "mask.inset.bottom": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 12 }
      ],
      "mask.inset.left": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 80 }
      ],
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 1 }
      ],
      volume: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 0.8 }
      ],
      pan: [
        { atMs: 0, value: -1, easing: "linear" },
        { atMs: 500, value: 1 }
      ],
      blendMode: [
        { atMs: 0, value: "normal", easing: "hold" },
        { atMs: 500, value: "multiply" }
      ],
      playbackRate: [
        { atMs: 0, value: 1, easing: "linear" },
        { atMs: 500, value: 1.5 }
      ],
      "effects.blur": [
        { atMs: 0, value: 0, easing: "ease-in-out" },
        { atMs: 500, value: 8 }
      ],
      "effects.brightness": [
        { atMs: 0, value: 1 },
        { atMs: 500, value: 0.6 }
      ],
      "effects.contrast": [
        { atMs: 0, value: 1 },
        { atMs: 500, value: 1.4 }
      ],
      "effects.saturate": [
        { atMs: 0, value: 1 },
        { atMs: 500, value: 0.8 }
      ],
      "effects.grayscale": [
        { atMs: 0, value: 0 },
        { atMs: 500, value: 1 }
      ]
    }));

    expect(result).toEqual({ ok: true });
  });

  it("accepts image crop keyframes on image layers", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      id: "product",
      type: "image",
      assetId: "asset_product",
      crop: { x: 0, y: 0, width: 320, height: 180 },
      keyframes: {
        "crop.x": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 500, value: 80 }
        ],
        "crop.y": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 500, value: 20 }
        ],
        "crop.width": [
          { atMs: 0, value: 320, easing: "linear" },
          { atMs: 500, value: 240 }
        ],
        "crop.height": [
          { atMs: 0, value: 180, easing: "linear" },
          { atMs: 500, value: 120 }
        ]
      }
    }));

    expect(result).toEqual({ ok: true });
  });

  it("accepts video crop keyframes on video layers", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      id: "clip",
      type: "video",
      source: "assets/clip.mp4",
      crop: { x: 0, y: 0, width: 320, height: 180 },
      keyframes: {
        "crop.x": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 500, value: 80 }
        ],
        "crop.width": [
          { atMs: 0, value: 320, easing: "linear" },
          { atMs: 500, value: 240 }
        ]
      }
    }));

    expect(result).toEqual({ ok: true });
  });

  it("accepts expressive named easing presets in keyframes and transitions", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      keyframes: {
        "transform.x": [
          { atMs: 0, value: 0, easing: "back-out" },
          { atMs: 1000, value: 120 }
        ],
        opacity: [
          { atMs: 0, value: 0, easing: "steps(4, end)" },
          { atMs: 1000, value: 1 }
        ]
      },
      transitions: {
        in: { type: "slide", durationMs: 300, direction: "up", distance: 24, easing: "back-out" },
        out: { type: "fade", durationMs: 250, easing: "step-end" }
      }
    }));

    expect(result).toEqual({ ok: true });
  });

  it("accepts timeline scenes tracks markers and layer track refs", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithDocumentFields({
      tracks: [
        { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"], locked: false, muted: false, solo: false, volume: 0.75, pan: -0.25, fadeInMs: 120, fadeOutMs: 240 }
      ],
      scenes: [
        { id: "intro", name: "Intro", startMs: 0, durationMs: 1000, layerIds: ["title"], trackIds: ["overlay"], markerIds: ["beat"] }
      ],
      markers: [
        { id: "beat", atMs: 500, label: "Beat", type: "beat", durationMs: 120, color: "#38bdf8" }
      ],
      layers: [
        {
          id: "title",
          type: "text",
          text: "Anna",
          trackId: "overlay",
          startMs: 0,
          durationMs: 1000
        }
      ]
    }));

    expect(result).toEqual({ ok: true });
  });

  it("rejects prototype-pollution keys while preserving x-prefixed host extensions", async () => {
    const schema = await loadSchema("motion");
    const document = JSON.parse(JSON.stringify(motionWithDocumentFields({
      "x-shellx-canvas": { frameId: "frame_1" },
      tracks: [
        { id: "overlay", type: "overlay", layerIds: ["title"], "x-shellx-cut": { trackKind: "overlay" } }
      ],
      layers: [
        {
          id: "title",
          type: "text",
          text: "Anna",
          trackId: "overlay",
          startMs: 0,
          durationMs: 1000,
          "x-shellx-cut": { op: "title" }
        }
      ]
    })));
    document.constructor = { polluted: true };
    Object.defineProperty(document.layers[0], "__proto__", {
      value: { polluted: true },
      enumerable: true,
      configurable: true
    });

    const result = await validateDocument(schema, document);

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/__proto__", message: "unsafe object key" },
        { path: "/constructor", message: "unsafe object key" }
      ]
    });
  });

  it("rejects invalid motion scalars and duplicate layer ids", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithDocumentFields({
      id: "",
      name: "",
      durationMs: 0,
      fps: 0,
      width: 1920.5,
      height: -1,
      provenance: "generator",
      layers: [
        {
          id: "title",
          type: "text",
          startMs: 0,
          durationMs: 1000
        },
        {
          id: "title",
          type: "shape",
          startMs: 100,
          durationMs: 900
        },
        {
          id: "",
          type: "",
          startMs: -1,
          durationMs: 0
        }
      ]
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/id", message: "must be a non-empty string" },
        { path: "/name", message: "must be a non-empty string" },
        { path: "/durationMs", message: "must be a positive finite number" },
        { path: "/fps", message: "must be a positive finite number" },
        { path: "/width", message: "must be a positive integer" },
        { path: "/height", message: "must be a positive integer" },
        { path: "/provenance", message: "must be an object" },
        { path: "/layers/1/id", message: "duplicate layer id" },
        { path: "/layers/2/id", message: "required" },
        { path: "/layers/2/type", message: "required" },
        { path: "/layers/2/startMs", message: "must be a non-negative finite number" },
        { path: "/layers/2/durationMs", message: "must be a positive finite number" }
      ]
    });
  });

  it("rejects malformed image source crop rectangles", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      id: "product",
      type: "image",
      crop: { x: -1, y: "0", width: 0, height: Number.NaN }
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/crop/x", message: "must be a non-negative finite number" },
        { path: "/layers/0/crop/y", message: "must be a non-negative finite number" },
        { path: "/layers/0/crop/width", message: "must be a positive finite number" },
        { path: "/layers/0/crop/height", message: "must be a positive finite number" }
      ]
    });
  });

  it("rejects source crop rectangles on non-media layers", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      type: "text",
      text: "No crop",
      crop: { x: 0, y: 0, width: 100, height: 50 }
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/crop", message: "supported only on image or video layers" }
      ]
    });
  });

  it("rejects malformed timeline scenes tracks markers and missing refs", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithDocumentFields({
      tracks: [
        { id: "", type: "", order: "first", layerIds: ["missing-layer"], locked: "no", muted: "no", solo: "yes", volume: -0.1, pan: 1.25, fadeInMs: -1, fadeOutMs: "late" },
        { id: "overlay", type: "overlay" },
        { id: "overlay", type: "overlay" }
      ],
      scenes: [
        { id: "", name: 123, startMs: -1, durationMs: 0, layerIds: ["missing-layer"], trackIds: ["missing-track"], markerIds: ["missing-marker"] },
        { id: "late", startMs: 900, durationMs: 200 }
      ],
      markers: [
        { id: "", atMs: -1, durationMs: -1, label: 123 },
        { id: "dup", atMs: 100 },
        { id: "dup", atMs: 2000 }
      ],
      layers: [
        {
          id: "title",
          type: "text",
          text: "Anna",
          trackId: "missing-track",
          startMs: 0,
          durationMs: 1000
        }
      ]
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/tracks/0/id", message: "required" },
        { path: "/tracks/0/type", message: "required" },
        { path: "/tracks/0/order", message: "must be a finite number" },
        { path: "/tracks/0/layerIds/0", message: "must reference an existing layer id" },
        { path: "/tracks/0/locked", message: "must be a boolean" },
        { path: "/tracks/0/muted", message: "must be a boolean" },
        { path: "/tracks/0/solo", message: "must be a boolean" },
        { path: "/tracks/0/volume", message: "must be a non-negative finite number" },
        { path: "/tracks/0/pan", message: "must be a finite number between -1 and 1" },
        { path: "/tracks/0/fadeInMs", message: "must be a non-negative finite number" },
        { path: "/tracks/0/fadeOutMs", message: "must be a non-negative finite number" },
        { path: "/tracks/2/id", message: "duplicate track id" },
        { path: "/scenes/0/id", message: "required" },
        { path: "/scenes/0/name", message: "must be a string" },
        { path: "/scenes/0/startMs", message: "must be a non-negative finite number" },
        { path: "/scenes/0/durationMs", message: "must be a positive finite number" },
        { path: "/scenes/0/trackIds/0", message: "must reference an existing track id" },
        { path: "/scenes/0/markerIds/0", message: "must reference an existing marker id" },
        { path: "/scenes/0/layerIds/0", message: "must reference an existing layer id" },
        { path: "/scenes/1", message: "must fit within document durationMs" },
        { path: "/markers/0/id", message: "required" },
        { path: "/markers/0/atMs", message: "must be a non-negative finite number" },
        { path: "/markers/0/durationMs", message: "must be a non-negative finite number" },
        { path: "/markers/0/label", message: "must be a string" },
        { path: "/markers/2/id", message: "duplicate marker id" },
        { path: "/markers/2/atMs", message: "must fit within document durationMs" },
        { path: "/layers/0/trackId", message: "must reference an existing track id" }
      ]
    });
  });

  it("rejects non-boolean layer visibility flags", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      id: "title",
      type: "text",
      visible: "no"
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/visible", message: "must be a boolean" }
      ]
    });
  });

  it("rejects non-string layer display names", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      id: "title",
      type: "text",
      name: 123
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/name", message: "must be a string" }
      ]
    });
  });

  it("rejects non-boolean layer lock flags", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      id: "title",
      type: "text",
      locked: "yes"
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/locked", message: "must be a boolean" }
      ]
    });
  });

  it("rejects unsupported keyframe targets", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithKeyframes({
      "transform.scaleZ": [{ atMs: 0, value: 1 }]
    }));

    expect(result).toEqual({
      ok: false,
      errors: [{ path: "/layers/0/keyframes/transform.scaleZ", message: "unsupported keyframe target" }]
    });
  });

  it("rejects malformed keyframes", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithKeyframes({
      "transform.x": { atMs: 0, value: 1 },
      opacity: [
        { atMs: "0", value: 0 },
        { atMs: 1000, value: "1", easing: "steps(0, end)" }
      ]
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/keyframes/transform.x", message: "must be an array" },
        { path: "/layers/0/keyframes/opacity/0/atMs", message: "must be a finite number" },
        { path: "/layers/0/keyframes/opacity/1/value", message: "must be a finite number" },
        { path: "/layers/0/keyframes/opacity/1/easing", message: "unsupported easing" }
      ]
    });
  });

  it("accepts spring easing objects and spring preset aliases on keyframes", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithKeyframes({
      opacity: [
        { atMs: 0, value: 0, easing: { type: "spring", stiffness: 180, damping: 12, mass: 1 } },
        { atMs: 500, value: 0.5, easing: "spring-gentle" },
        { atMs: 1000, value: 1 }
      ]
    }));

    expect(result).toEqual({ ok: true });
  });

  it("rejects malformed spring easing objects with field-specific messages", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithKeyframes({
      opacity: [
        { atMs: 0, value: 0, easing: { type: "spring", stiffness: -1, damping: 26 } },
        { atMs: 1000, value: 1, easing: { type: "spring", stiffness: 170, damping: 0 } }
      ]
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/keyframes/opacity/0/easing", message: "spring stiffness must be a positive finite number" },
        { path: "/layers/0/keyframes/opacity/1/easing", message: "spring damping must be a positive finite number" }
      ]
    });
  });

  it("accepts host-editable template controls", async () => {
    const schema = await loadSchema("template");
    const result = await validateDocument(schema, {
      schema: "shellx-motion/template@1",
      id: "template_lower_third",
      name: "Editable Lower Third",
      motion: "motion.json",
      compatibleLanes: ["browser", "ffmpeg"],
      compatibleHosts: ["shellx-motion", "shellx-cut", "shellx-canvas"],
      metadata: {
        inputSchema: {
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string", maxLength: 80 },
            accent: { type: "string", format: "color" }
          }
        },
        inputExamples: [
          { title: "Anna Valdez", accent: "#13d3ff" }
        ],
        outputBounds: {
          minWidth: 720,
          maxWidth: 3840,
          minHeight: 405,
          maxHeight: 2160,
          minDurationMs: 1200,
          maxDurationMs: 8000,
          aspectRatios: ["16:9", "9:16"]
        },
        suitability: {
          bestFor: ["speaker IDs", "product demos"],
          notFor: ["full-screen scene replacements"]
        },
        license: {
          id: "shellx-sample",
          label: "ShellX Sample Assets",
          attribution: "ShellX Motion fixture",
          spdxId: "Apache-2.0",
          attributionRequired: false,
          redistributionAllowed: true,
          commercialUse: true,
          notes: "Fixture is safe for generated samples."
        },
        provenance: {
          source: "shellx-motion-fixture",
          sourceUrl: "https://example.com/templates/lower-third",
          sourceHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          generatedBy: "test"
        },
        assetsAttribution: [
          {
            name: "Inter font",
            license: "SIL-OFL-1.1",
            author: "Rasmus Andersson",
            url: "https://rsms.me/inter/",
            path: "assets/fonts/inter.woff2"
          }
        ],
        preview: {
          poster: "preview/poster.png",
          loop: "preview/loop.mp4",
          thumbnail: "preview/thumb.webp"
        },
        performance: {
          recommendedLane: "browser",
          renderCost: "medium",
          previewFps: 30,
          notes: ["Uses text and shape layers only."]
        },
        story: {
          kind: "speaker-intro",
          beats: [
            {
              id: "identify",
              intent: "Identify the speaker while preserving the main scene.",
              startMs: 0,
              durationMs: 1400,
              layerIds: ["title", "portrait"],
              mediaParamIds: ["portrait"],
              cameraIntent: "Hold the source framing."
            }
          ]
        },
        mediaSlots: [
          {
            paramId: "portrait",
            role: "speaker-portrait",
            acceptedKinds: ["image", "video"],
            fit: "cover",
            minWidth: 720,
            minHeight: 720,
            minDurationMs: 1400,
            maxDurationMs: 8000,
            rightsRequired: true
          }
        ],
        qualityTargets: {
          manifest: "quality/representative-frames.json",
          representativeFramesMs: [100, 700, 1300],
          minDistinctFrames: 3,
          maxBlankFrames: 0,
          minEdgePixels: 800,
          minLumaRange: 32,
          requireTextFit: true,
          requireSafeAreas: true
        }
      },
      groups: [
        { id: "content", label: "Content", order: 1 }
      ],
      params: [
        { id: "title", label: "Title", type: "text", defaultValue: "Anna", group: "content", order: 1 },
        { id: "accent", label: "Accent", type: "color", defaultValue: "#13d3ff", group: "content", order: 2 },
        { id: "scale", label: "Scale", type: "number", defaultValue: 1, min: 0.5, max: 2, step: 0.1 },
        { id: "portrait", label: "Portrait", type: "media", defaultValue: "assets/portrait.png" }
      ],
      controls: [
        { paramId: "title", widget: "text", label: "Title" },
        { paramId: "accent", widget: "color", label: "Accent color" },
        { paramId: "scale", widget: "slider", label: "Scale" },
        { paramId: "portrait", widget: "media", label: "Portrait" }
      ],
      bindings: [
        { paramId: "title", target: { kind: "motion_path", path: "/layers/0/text" } },
        { paramId: "accent", target: { kind: "motion_path", path: "/layers/1/fill" } },
        { paramId: "scale", target: { kind: "motion_path", path: "/layers/0/transform/scale" } },
        { paramId: "portrait", target: { kind: "motion_path", path: "/layers/1/source" } }
      ]
    });

    expect(result).toEqual({ ok: true });
  });

  it("exports rich template metadata in the public JSON schema contract", async () => {
    const schema = JSON.parse(await readFile(new URL("../../../schemas/template.schema.json", import.meta.url), "utf8"));

    expect(schema.required).toEqual(["schema", "id", "name", "motion", "compatibleLanes", "params", "controls", "bindings"]);
    expect(schema.properties.metadata.properties).toMatchObject({
      inputExamples: {
        type: "array",
        items: { type: "object" }
      },
      assetsAttribution: {
        type: "array",
        items: expect.objectContaining({
          required: ["name"],
          properties: expect.objectContaining({
            name: { type: "string", minLength: 1 },
            license: { type: "string" },
            author: { type: "string" },
            url: { type: "string", pattern: "^https?://" },
            path: { type: "string" }
          })
        })
      },
      preview: {
        type: "object",
        properties: {
          poster: { type: "string" },
          loop: { type: "string" },
          thumbnail: { type: "string" }
        }
      },
      story: {
        type: "object",
        required: ["beats"]
      },
      mediaSlots: {
        type: "array",
        maxItems: 16
      },
      qualityTargets: {
        type: "object",
        required: ["representativeFramesMs"],
        properties: expect.objectContaining({
          manifest: { type: "string", pattern: "^quality/(?!.*\\.\\.)[^/].*$" }
        })
      }
    });
    expect(schema.properties.metadata.properties.license.properties).toMatchObject({
      spdxId: { type: "string" },
      attributionRequired: { type: "boolean" },
      redistributionAllowed: { type: "boolean" },
      commercialUse: { type: "boolean" },
      notes: { type: "string" }
    });
  });

  it("rejects malformed host-editable template controls", async () => {
    const schema = await loadSchema("template");
    const result = await validateDocument(schema, {
      schema: "shellx-motion/template@1",
      id: "template_bad",
      name: "Bad",
      motion: "motion.json",
      compatibleLanes: [],
      metadata: {
        inputExamples: ["bad", 42],
        outputBounds: { minWidth: -1, maxDurationMs: 0, aspectRatios: ["wide"] },
        suitability: { bestFor: ["ok", 42], notFor: "long-form" },
        license: {
          id: "",
          spdxId: 42,
          attributionRequired: "yes",
          redistributionAllowed: "yes",
          commercialUse: "no"
        },
        provenance: { sourceUrl: "file:///tmp/private", sourceHash: "not-a-hash" },
        assetsAttribution: [
          { name: "", license: 42, url: "file:///tmp/private" },
          "bad"
        ],
        preview: { poster: 42, loop: false, thumbnail: [] },
        performance: { renderCost: "huge", previewFps: 0, notes: ["ok", 42] },
        story: {
          kind: 42,
          beats: [
            {
              id: "",
              intent: "",
              startMs: -1,
              durationMs: 0,
              layerIds: "bad",
              mediaParamIds: ["missing"],
              cameraIntent: 42
            }
          ]
        },
        mediaSlots: [
          {
            paramId: "title",
            role: "",
            acceptedKinds: ["audio"],
            fit: "crop",
            minWidth: 0,
            rightsRequired: "yes"
          }
        ],
        qualityTargets: {
          manifest: "../escape.json",
          representativeFramesMs: [100, 100, -1],
          minDistinctFrames: 4,
          maxBlankFrames: -1,
          minEdgePixels: -1,
          minLumaRange: -1,
          requireTextFit: "yes",
          requireSafeAreas: "yes"
        }
      },
      params: [
        { id: "title", type: "text", defaultValue: "Anna" },
        { id: "title", type: "number", defaultValue: "large", min: "small", max: 1, step: 0 },
        { id: "mode", type: "select", defaultValue: "big", options: [{ label: "Small" }] }
      ],
      controls: [
        { paramId: "missing", widget: "text" }
      ],
      bindings: [
        { paramId: "accent", target: { kind: "motion_path", path: "layers/0/fill" } },
        { paramId: "title", target: { kind: "motion_path" } }
      ]
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/compatibleLanes", message: "must contain at least one lane" },
        { path: "/params/1/id", message: "duplicate param id" },
        { path: "/params/1/defaultValue", message: "must match param type number" },
        { path: "/params/1/min", message: "must be a finite number" },
        { path: "/params/1/step", message: "must be a positive finite number" },
        { path: "/params/2/options/0/value", message: "required" },
        { path: "/params/2/defaultValue", message: "must match one select option value" },
        { path: "/controls/0/paramId", message: "must reference an existing param id" },
        { path: "/bindings/0/paramId", message: "must reference an existing param id" },
        { path: "/bindings/0/target/path", message: "must be a JSON pointer" },
        { path: "/bindings/1/target/path", message: "required" },
        { path: "/metadata/inputExamples/0", message: "must be an object" },
        { path: "/metadata/inputExamples/1", message: "must be an object" },
        { path: "/metadata/outputBounds/minWidth", message: "must be a positive finite number" },
        { path: "/metadata/outputBounds/maxDurationMs", message: "must be a positive finite number" },
        { path: "/metadata/outputBounds/aspectRatios/0", message: "must be WIDTH:HEIGHT" },
        { path: "/metadata/suitability/bestFor/1", message: "must be a string" },
        { path: "/metadata/suitability/notFor", message: "must be an array" },
        { path: "/metadata/license/id", message: "must be a non-empty string" },
        { path: "/metadata/license/spdxId", message: "must be a string" },
        { path: "/metadata/license/attributionRequired", message: "must be a boolean" },
        { path: "/metadata/license/redistributionAllowed", message: "must be a boolean" },
        { path: "/metadata/license/commercialUse", message: "must be a boolean" },
        { path: "/metadata/provenance/sourceUrl", message: "must be an http(s) URL" },
        { path: "/metadata/provenance/sourceHash", message: "must be a sha256 hex string" },
        { path: "/metadata/assetsAttribution/0/name", message: "must be a non-empty string" },
        { path: "/metadata/assetsAttribution/0/license", message: "must be a string" },
        { path: "/metadata/assetsAttribution/0/url", message: "must be an http(s) URL" },
        { path: "/metadata/assetsAttribution/1", message: "must be an object" },
        { path: "/metadata/preview/poster", message: "must be a string" },
        { path: "/metadata/preview/loop", message: "must be a string" },
        { path: "/metadata/preview/thumbnail", message: "must be a string" },
        { path: "/metadata/performance/renderCost", message: "must be low, medium, or high" },
        { path: "/metadata/performance/previewFps", message: "must be a positive finite number" },
        { path: "/metadata/performance/notes/1", message: "must be a string" },
        { path: "/metadata/story/kind", message: "must be a string" },
        { path: "/metadata/story/beats/0/id", message: "must be a non-empty string" },
        { path: "/metadata/story/beats/0/intent", message: "must be a non-empty string" },
        { path: "/metadata/story/beats/0/cameraIntent", message: "must be a string" },
        { path: "/metadata/story/beats/0/startMs", message: "must be a non-negative finite number" },
        { path: "/metadata/story/beats/0/durationMs", message: "must be a positive finite number" },
        { path: "/metadata/story/beats/0/layerIds", message: "must be an array with at most 64 items" },
        { path: "/metadata/story/beats/0/mediaParamIds/0", message: "must reference an existing media param id" },
        { path: "/metadata/mediaSlots/0/paramId", message: "must reference an existing media param id" },
        { path: "/metadata/mediaSlots/0/role", message: "must be a non-empty string" },
        { path: "/metadata/mediaSlots/0/acceptedKinds/0", message: "must be image or video" },
        { path: "/metadata/mediaSlots/0/fit", message: "must be cover, contain, or fill" },
        { path: "/metadata/mediaSlots/0/minWidth", message: "must be a positive finite number" },
        { path: "/metadata/mediaSlots/0/rightsRequired", message: "must be a boolean" },
        { path: "/metadata/qualityTargets/manifest", message: "must be a package-local quality/ path" },
        { path: "/metadata/qualityTargets/representativeFramesMs/1", message: "must be strictly increasing" },
        { path: "/metadata/qualityTargets/representativeFramesMs/2", message: "must be a non-negative finite number" },
        { path: "/metadata/qualityTargets/minDistinctFrames", message: "cannot exceed representative frame count" },
        { path: "/metadata/qualityTargets/maxBlankFrames", message: "must be a non-negative integer" },
        { path: "/metadata/qualityTargets/minEdgePixels", message: "must be a non-negative finite number" },
        { path: "/metadata/qualityTargets/minLumaRange", message: "must be a non-negative finite number" },
        { path: "/metadata/qualityTargets/requireTextFit", message: "must be a boolean" },
        { path: "/metadata/qualityTargets/requireSafeAreas", message: "must be a boolean" }
      ]
    });
  });

  it("rejects negative volume keyframe values", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithKeyframes({
      volume: [
        { atMs: 0, value: 0.5 },
        { atMs: 1000, value: -0.1 }
      ]
    }));

    expect(result).toEqual({
      ok: false,
      errors: [{ path: "/layers/0/keyframes/volume/1/value", message: "must be a non-negative finite number" }]
    });
  });

  it("rejects invalid audio pan keyframe values", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithKeyframes({
      pan: [
        { atMs: 0, value: -1 },
        { atMs: 500, value: 1.25 },
        { atMs: 1000, value: "right" }
      ]
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/keyframes/pan/1/value", message: "must be a finite number between -1 and 1" },
        { path: "/layers/0/keyframes/pan/2/value", message: "must be a finite number between -1 and 1" }
      ]
    });
  });

  it("rejects invalid effect and playback keyframe values", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithKeyframes({
      "effects.blur": [{ atMs: 0, value: -1 }],
      "effects.brightness": [{ atMs: 0, value: "dim" }],
      "effects.contrast": [{ atMs: 0, value: -0.5 }],
      "effects.saturate": [{ atMs: 0, value: -0.5 }],
      "effects.grayscale": [{ atMs: 0, value: -0.5 }],
      playbackRate: [{ atMs: 0, value: 0 }],
      "style.fontSize": [{ atMs: 0, value: 0 }],
      "style.fontWeight": [{ atMs: 0, value: 0 }],
      "style.lineHeight": [{ atMs: 0, value: 0 }],
      "style.width": [{ atMs: 0, value: -1 }],
      "style.height": [{ atMs: 0, value: -1 }],
      "style.radius": [{ atMs: 0, value: -1 }],
      "style.borderRadius": [{ atMs: 0, value: -1 }],
      "style.padding": [{ atMs: 0, value: -1 }],
      "style.paddingX": [{ atMs: 0, value: -1 }],
      "style.paddingY": [{ atMs: 0, value: -1 }],
      "style.paddingTop": [{ atMs: 0, value: -1 }],
      "style.paddingRight": [{ atMs: 0, value: -1 }],
      "style.paddingBottom": [{ atMs: 0, value: -1 }],
      "style.paddingLeft": [{ atMs: 0, value: -1 }],
      "style.strokeWidth": [{ atMs: 0, value: -1 }],
      "style.borderWidth": [{ atMs: 0, value: "wide" }],
      "style.shadow.blur": [{ atMs: 0, value: -1 }],
      "style.shadow.spread": [{ atMs: 0, value: -1 }],
      "style.shadow.blurRadius": [{ atMs: 0, value: -1 }],
      "style.shadow.spreadRadius": [{ atMs: 0, value: -1 }],
      "style.textShadow.blur": [{ atMs: 0, value: -1 }],
      "style.textShadow.blurRadius": [{ atMs: 0, value: -1 }]
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/keyframes/effects.blur/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/effects.brightness/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/effects.contrast/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/effects.saturate/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/effects.grayscale/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/playbackRate/0/value", message: "must be a positive finite number" },
        { path: "/layers/0/keyframes/style.fontSize/0/value", message: "must be a positive finite number" },
        { path: "/layers/0/keyframes/style.fontWeight/0/value", message: "must be a positive finite number" },
        { path: "/layers/0/keyframes/style.lineHeight/0/value", message: "must be a positive finite number" },
        { path: "/layers/0/keyframes/style.width/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/style.height/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/style.radius/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/style.borderRadius/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/style.padding/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/style.paddingX/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/style.paddingY/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/style.paddingTop/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/style.paddingRight/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/style.paddingBottom/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/style.paddingLeft/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/style.strokeWidth/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/style.borderWidth/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/style.shadow.blur/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/style.shadow.spread/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/style.shadow.blurRadius/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/style.shadow.spreadRadius/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/style.textShadow.blur/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/style.textShadow.blurRadius/0/value", message: "must be a non-negative finite number" }
      ]
    });
  });

  it("rejects invalid text alignment keyframe values", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithKeyframes({
      "style.textAlign": [{ atMs: 0, value: "justify" }],
      "style.verticalAlign": [{ atMs: 0, value: "baseline" }],
      "style.alignY": [{ atMs: 0, value: 1 }]
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/keyframes/style.textAlign/0/value", message: "must be one of: left, center, right" },
        { path: "/layers/0/keyframes/style.verticalAlign/0/value", message: "must be one of: top, middle, center, bottom" },
        { path: "/layers/0/keyframes/style.alignY/0/value", message: "must be one of: top, middle, center, bottom" }
      ]
    });
  });

  it("rejects invalid color keyframe values", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithKeyframes({
      fill: [{ atMs: 0, value: 42 }],
      "style.fill": [{ atMs: 0, value: "not a color" }],
      "style.color": [{ atMs: 0, value: "" }],
      "style.stroke": [{ atMs: 0, value: "not a color" }],
      "style.borderColor": [{ atMs: 0, value: "" }],
      "style.backgroundColor": [{ atMs: 0, value: "not a color" }],
      "style.background": [{ atMs: 0, value: "not a color" }],
      "style.shadow.color": [{ atMs: 0, value: "not a color" }],
      "style.textShadow.color": [{ atMs: 0, value: "" }]
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/keyframes/fill/0/value", message: "must be a supported color string" },
        { path: "/layers/0/keyframes/style.fill/0/value", message: "must be a supported color string" },
        { path: "/layers/0/keyframes/style.color/0/value", message: "must be a supported color string" },
        { path: "/layers/0/keyframes/style.stroke/0/value", message: "must be a supported color string" },
        { path: "/layers/0/keyframes/style.borderColor/0/value", message: "must be a supported color string" },
        { path: "/layers/0/keyframes/style.backgroundColor/0/value", message: "must be a supported color string" },
        { path: "/layers/0/keyframes/style.background/0/value", message: "must be a supported color string" },
        { path: "/layers/0/keyframes/style.shadow.color/0/value", message: "must be a supported color string" },
        { path: "/layers/0/keyframes/style.textShadow.color/0/value", message: "must be a supported color string" }
      ]
    });
  });

  it("rejects invalid CSS hex color keyframe lengths", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithKeyframes({
      fill: [{ atMs: 0, value: "#12345" }],
      "style.color": [{ atMs: 0, value: "#1234567" }]
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/keyframes/fill/0/value", message: "must be a supported color string" },
        { path: "/layers/0/keyframes/style.color/0/value", message: "must be a supported color string" }
      ]
    });
  });

  it("accepts audio trim loop and volume controls", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithAudioLayer({
      trimStartMs: 250,
      trimDurationMs: 1500,
      loop: true,
      volume: 0.35,
      pan: -0.35,
      muted: false,
      fadeInMs: 250,
      fadeOutMs: 300,
      normalizeLoudness: true
    }));

    expect(result).toEqual({ ok: true });
  });

  it("accepts audio ducking controls for sidechain-style mixes", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithDocumentFields({
      layers: [
        {
          id: "music",
          type: "audio",
          source: "assets/music.wav",
          startMs: 0,
          durationMs: 2000,
          ducking: {
            triggerLayerIds: ["voice"],
            duckToVolume: 0.28,
            attackMs: 120,
            releaseMs: 240
          }
        },
        {
          id: "voice",
          type: "audio",
          source: "assets/voice.wav",
          startMs: 500,
          durationMs: 700
        }
      ]
    }));

    expect(result).toEqual({ ok: true });
  });

  it("rejects malformed audio ducking controls", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithDocumentFields({
      layers: [
        {
          id: "music",
          type: "audio",
          source: "assets/music.wav",
          startMs: 0,
          durationMs: 2000,
          ducking: {
            triggerLayerIds: ["missing", 42],
            duckToVolume: -0.1,
            attackMs: -1,
            releaseMs: "slow"
          }
        }
      ]
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/ducking/triggerLayerIds/0", message: "must reference an existing layer id" },
        { path: "/layers/0/ducking/triggerLayerIds/1", message: "must reference an existing layer id" },
        { path: "/layers/0/ducking/duckToVolume", message: "must be a non-negative finite number" },
        { path: "/layers/0/ducking/attackMs", message: "must be a non-negative finite number" },
        { path: "/layers/0/ducking/releaseMs", message: "must be a non-negative finite number" }
      ]
    });
  });

  it("accepts fade transition controls", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      transitions: {
        in: { type: "fade", durationMs: 250, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
        out: { type: "slide", direction: "right", distance: 120, durationMs: 300, easing: "linear" }
      }
    }));

    expect(result).toEqual({ ok: true });
  });

  it("accepts wipe transition controls", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      transitions: {
        in: { type: "wipe", direction: "left", durationMs: 250, easing: "ease-out" },
        out: { type: "wipe", direction: "right", durationMs: 300, easing: "linear" }
      }
    }));

    expect(result).toEqual({ ok: true });
  });

  it("accepts supported blend modes for layer compositing", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      blendMode: "multiply"
    }));

    expect(result).toEqual({ ok: true });
  });

  it("rejects unsupported blend modes", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      blendMode: "scripted-composite"
    }));

    expect(result).toEqual({
      ok: false,
      errors: [{ path: "/layers/0/blendMode", message: "unsupported blend mode" }]
    });
  });

  it("rejects unsupported blend mode keyframe values", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithKeyframes({
      blendMode: [
        { atMs: 0, value: "normal" },
        { atMs: 500, value: "scripted-composite" },
        { atMs: 1000, value: 1 }
      ]
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/keyframes/blendMode/1/value", message: "unsupported blend mode" },
        { path: "/layers/0/keyframes/blendMode/2/value", message: "unsupported blend mode" }
      ]
    });
  });

  it("accepts numeric transform origins for layer-local anchors", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      transform: { x: 120, y: 820, width: 320, height: 120, scale: 1.5, originX: 0, originY: 0 }
    }));

    expect(result).toEqual({ ok: true });
  });

  it("rejects malformed transform origins", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      transform: { originX: "left", originY: Number.NaN }
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/transform/originX", message: "must be a finite number" },
        { path: "/layers/0/transform/originY", message: "must be a finite number" }
      ]
    });
  });

  it("accepts rectangular mask controls", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      mask: {
        type: "rect",
        inset: { top: 0, right: 80, bottom: 0, left: 0 },
        radius: 12
      }
    }));

    expect(result).toEqual({ ok: true });
  });

  it("accepts visual effect controls", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      effects: {
        blur: 4,
        brightness: 0.75,
        contrast: 1.2,
        saturate: 0.8,
        grayscale: 1,
        glow: { radius: 18, color: "rgba(0,212,255,0.85)" }
      },
      keyframes: {
        "effects.glow.radius": [{ atMs: 0, value: 4 }, { atMs: 1000, value: 24 }],
        "effects.glow.color": [{ atMs: 0, value: "#ff006e" }, { atMs: 1000, value: "#00d4ff" }]
      }
    }));

    expect(result).toEqual({ ok: true });
  });

  it("accepts bounded rectangular gradients and animated linear angles", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      type: "shape",
      shape: "rounded-rect",
      gradient: {
        type: "linear",
        angle: 25,
        stops: [
          { offset: 0, color: "#14002f" },
          { offset: 0.45, color: "rgba(255,0,128,0.8)" },
          { offset: 1, color: "#00d4ff" }
        ]
      },
      keyframes: {
        "gradient.angle": [
          { atMs: 0, value: 25, easing: "ease-in-out" },
          { atMs: 1000, value: 205 }
        ]
      }
    }));

    expect(result).toEqual({ ok: true });
  });

  it("rejects unsafe or ambiguous gradients", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      type: "shape",
      shape: "ellipse",
      gradient: {
        type: "mesh",
        angle: "spin",
        centerX: 2,
        stops: [
          { offset: 0.8, color: "url(https://evil.example/paint)" },
          { offset: 0.2, color: "#ffffff" }
        ]
      },
      keyframes: { "gradient.angle": [{ atMs: 0, value: 90 }] }
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/keyframes/gradient.angle", message: "requires a linear layer gradient" },
        { path: "/layers/0/gradient", message: "is currently supported only on rectangular shape layers" },
        { path: "/layers/0/gradient/type", message: "must be linear or radial" },
        { path: "/layers/0/gradient/angle", message: "must be a finite number" },
        { path: "/layers/0/gradient/centerX", message: "must be a finite number between 0 and 1" },
        { path: "/layers/0/gradient/stops/0/color", message: "must be a supported color string" },
        { path: "/layers/0/gradient/stops/1/offset", message: "must be ordered by offset" }
      ]
    });
  });

  it("rejects gradient parameters that do not affect the selected gradient type", async () => {
    const schema = await loadSchema("motion");
    const stops = [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }];

    expect(await validateDocument(schema, motionWithLayerFields({
      type: "shape",
      shape: "rect",
      gradient: { type: "radial", angle: 45, centerX: 0.25, centerY: 0.75, stops }
    }))).toEqual({
      ok: false,
      errors: [{ path: "/layers/0/gradient/angle", message: "is supported only for linear gradients" }]
    });
    expect(await validateDocument(schema, motionWithLayerFields({
      type: "shape",
      shape: "rect",
      gradient: { type: "linear", centerX: 0.25, stops }
    }))).toEqual({
      ok: false,
      errors: [{ path: "/layers/0/gradient/centerX", message: "is supported only for radial gradients" }]
    });
  });

  it("accepts bounded deterministic particle emitters", async () => {
    const schema = await loadSchema("motion");
    expect(await validateDocument(schema, motionWithLayerFields({
      type: "particles",
      transform: { x: 0, y: 0, width: 640, height: 360 },
      emitter: {
        seed: 424242,
        count: 180,
        lifetimeMs: 2400,
        shape: "circle",
        color: "#ff006e",
        secondaryColor: "#00d4ff",
        minSize: 2,
        maxSize: 12,
        minSpeed: 30,
        maxSpeed: 180,
        direction: -90,
        spread: 70,
        gravity: 120,
        fadeOut: true
      }
    }))).toEqual({ ok: true });
  });

  it("rejects unbounded or executable particle emitter values", async () => {
    const schema = await loadSchema("motion");
    expect(await validateDocument(schema, motionWithLayerFields({
      type: "particles",
      emitter: {
        seed: -1,
        count: 1001,
        lifetimeMs: 0,
        shape: "script",
        color: "url(https://evil.example/particle)",
        minSize: 20,
        maxSize: 10,
        minSpeed: 2500,
        maxSpeed: 10,
        direction: "up",
        spread: 361,
        gravity: 6000,
        fadeOut: "yes"
      }
    }))).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/emitter/seed", message: "must be an integer between 0 and 4294967295" },
        { path: "/layers/0/emitter/count", message: "must be an integer between 1 and 1000" },
        { path: "/layers/0/emitter/lifetimeMs", message: "must be a finite number between 0 and 60000" },
        { path: "/layers/0/emitter/shape", message: "must be circle or square" },
        { path: "/layers/0/emitter/color", message: "must be a supported color string" },
        { path: "/layers/0/emitter/maxSize", message: "must be greater than or equal to minSize" },
        { path: "/layers/0/emitter/minSpeed", message: "must be a finite number between 0 and 2000" },
        { path: "/layers/0/emitter/maxSpeed", message: "must be greater than or equal to minSpeed" },
        { path: "/layers/0/emitter/direction", message: "must be a finite number" },
        { path: "/layers/0/emitter/spread", message: "must be a finite number between 0 and 360" },
        { path: "/layers/0/emitter/gravity", message: "must be a finite number between -5000 and 5000" },
        { path: "/layers/0/emitter/fadeOut", message: "must be a boolean" }
      ]
    });
  });

  it("validates document safe-area metadata", async () => {
    const schema = await loadSchema("motion");
    const accepted = await validateDocument(schema, {
      ...motionWithDocumentFields({}),
      safeAreas: {
        title: { top: 96, right: 128, bottom: 108, left: 128 },
        action: { top: 48, right: 64, bottom: 64, left: 64 }
      }
    });
    const rejected = await validateDocument(schema, {
      ...motionWithDocumentFields({}),
      safeAreas: {
        title: { top: -1, right: 128, bottom: 108, left: "wide" },
        action: "full"
      }
    });

    expect(accepted).toEqual({ ok: true });
    expect(rejected).toEqual({
      ok: false,
      errors: [
        { path: "/safeAreas/title/top", message: "must be a non-negative finite number" },
        { path: "/safeAreas/title/left", message: "must be a non-negative finite number" },
        { path: "/safeAreas/action", message: "must be an object" }
      ]
    });
  });

  it("validates explicit rendered text-fit intent against document safe areas", async () => {
    const schema = await loadSchema("motion");
    const accepted = await validateDocument(schema, motionWithDocumentFields({
      safeAreas: { title: { top: 80, right: 64, bottom: 80, left: 64 } },
      layers: [
        {
          id: "safe-title",
          type: "text",
          text: "Readable",
          startMs: 0,
          durationMs: 1000,
          textFit: { policy: "safe", safeAreaId: "title" }
        },
        {
          id: "auto-title",
          type: "caption",
          text: "Shrink when localized",
          startMs: 0,
          durationMs: 1000,
          textFit: { policy: "auto-fit", safeAreaId: "title", minFontSize: 18 }
        },
        {
          id: "decorative-title",
          type: "text",
          text: "CROP",
          startMs: 0,
          durationMs: 1000,
          textFit: { policy: "allow-crop" }
        }
      ]
    }));
    const rejected = await validateDocument(schema, motionWithDocumentFields({
      safeAreas: { title: { top: 80, right: 64, bottom: 80, left: 64 } },
      layers: [
        {
          id: "missing-area",
          type: "text",
          startMs: 0,
          durationMs: 1000,
          textFit: { policy: "safe" }
        },
        {
          id: "unknown-area",
          type: "caption",
          startMs: 0,
          durationMs: 1000,
          textFit: { policy: "auto-fit", safeAreaId: "action", minFontSize: 0 }
        },
        {
          id: "wrong-layer",
          type: "shape",
          startMs: 0,
          durationMs: 1000,
          textFit: { policy: "safe", safeAreaId: "title" }
        },
        {
          id: "wrong-policy",
          type: "text",
          startMs: 0,
          durationMs: 1000,
          textFit: { policy: "clip", safeAreaId: "title" }
        },
        {
          id: "crop-unknown-area",
          type: "text",
          startMs: 0,
          durationMs: 1000,
          textFit: { policy: "allow-crop", safeAreaId: "action" }
        }
      ]
    }));

    expect(accepted).toEqual({ ok: true });
    expect(rejected).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/textFit/safeAreaId", message: "required for safe and auto-fit policies" },
        { path: "/layers/1/textFit/safeAreaId", message: "must reference an existing motion.safeAreas entry" },
        { path: "/layers/1/textFit/minFontSize", message: "must be a positive finite number" },
        { path: "/layers/2/textFit", message: "is supported only on text and caption layers" },
        { path: "/layers/3/textFit/policy", message: "must be safe, allow-crop, or auto-fit" },
        { path: "/layers/4/textFit/safeAreaId", message: "must reference an existing motion.safeAreas entry" }
      ]
    });
  });

  it("accepts video trim loop and playback-rate controls", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithVideoLayer({
      trimStartMs: 250,
      trimDurationMs: 1500,
      loop: true,
      playbackRate: 1.5,
      includeAudio: true,
      volume: 0.45,
      pan: 0.25,
      muted: false,
      fadeInMs: 80,
      fadeOutMs: 120,
      normalizeLoudness: true
    }));

    expect(result).toEqual({ ok: true });
  });

  it("rejects malformed audio trim loop and volume controls", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithAudioLayer({
      trimStartMs: -1,
      trimDurationMs: 0,
      loop: "yes",
      volume: -0.1,
      pan: 1.25,
      muted: "yes",
      fadeInMs: -1,
      fadeOutMs: "late",
      normalizeLoudness: "yes"
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/trimStartMs", message: "must be a non-negative finite number" },
        { path: "/layers/0/trimDurationMs", message: "must be a positive finite number" },
        { path: "/layers/0/loop", message: "must be a boolean" },
        { path: "/layers/0/volume", message: "must be a non-negative finite number" },
        { path: "/layers/0/pan", message: "must be a finite number between -1 and 1" },
        { path: "/layers/0/muted", message: "must be a boolean" },
        { path: "/layers/0/fadeInMs", message: "must be a non-negative finite number" },
        { path: "/layers/0/fadeOutMs", message: "must be a non-negative finite number" },
        { path: "/layers/0/normalizeLoudness", message: "must be a boolean" }
      ]
    });
  });

  it("rejects malformed video trim loop and playback-rate controls", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithVideoLayer({
      trimStartMs: -1,
      trimDurationMs: 0,
      loop: "yes",
      playbackRate: 0,
      includeAudio: true,
      volume: -0.1,
      pan: 1.25,
      muted: "yes",
      fadeInMs: -1,
      fadeOutMs: "late",
      normalizeLoudness: "yes"
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/trimStartMs", message: "must be a non-negative finite number" },
        { path: "/layers/0/trimDurationMs", message: "must be a positive finite number" },
        { path: "/layers/0/loop", message: "must be a boolean" },
        { path: "/layers/0/playbackRate", message: "must be a positive finite number" },
        { path: "/layers/0/volume", message: "must be a non-negative finite number" },
        { path: "/layers/0/pan", message: "must be a finite number between -1 and 1" },
        { path: "/layers/0/muted", message: "must be a boolean" },
        { path: "/layers/0/fadeInMs", message: "must be a non-negative finite number" },
        { path: "/layers/0/fadeOutMs", message: "must be a non-negative finite number" },
        { path: "/layers/0/normalizeLoudness", message: "must be a boolean" }
      ]
    });
  });

  it("rejects malformed transition controls", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      transitions: {
        in: { type: "wipe", direction: "diagonal", durationMs: 0, easing: "cubic-bezier(0.42, nope, 0.58, 1)" },
        out: { type: "slide", direction: "diagonal", distance: -1, durationMs: 200 }
      }
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/transitions/in/durationMs", message: "must be a positive finite number" },
        { path: "/layers/0/transitions/in/easing", message: "unsupported easing" },
        { path: "/layers/0/transitions/in/direction", message: "unsupported wipe direction" },
        { path: "/layers/0/transitions/out/direction", message: "unsupported slide direction" },
        { path: "/layers/0/transitions/out/distance", message: "must be a non-negative finite number" }
      ]
    });
  });

  it("rejects cubic-bezier easing with out-of-range x control points", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithKeyframes({
      opacity: [
        { atMs: 0, value: 0, easing: "cubic-bezier(-0.1, 0, 0.58, 1)" },
        { atMs: 1000, value: 1, easing: "cubic-bezier(0.42, 0, 1.2, 1)" }
      ]
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/keyframes/opacity/0/easing", message: "unsupported easing" },
        { path: "/layers/0/keyframes/opacity/1/easing", message: "unsupported easing" }
      ]
    });
  });

  it("rejects transition cubic-bezier easing with out-of-range x control points", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      transitions: {
        in: { type: "fade", durationMs: 250, easing: "cubic-bezier(-0.1, 0, 0.58, 1)" },
        out: { type: "fade", durationMs: 250, easing: "cubic-bezier(0.42, 0, 1.2, 1)" }
      }
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/transitions/in/easing", message: "unsupported easing" },
        { path: "/layers/0/transitions/out/easing", message: "unsupported easing" }
      ]
    });
  });

  it("rejects malformed mask controls", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      mask: {
        type: "circle",
        inset: { top: -1, right: "half" },
        radius: -4
      }
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/mask/type", message: "unsupported mask type" },
        { path: "/layers/0/mask/inset/top", message: "must be a non-negative finite number" },
        { path: "/layers/0/mask/inset/right", message: "must be a non-negative finite number" },
        { path: "/layers/0/mask/radius", message: "must be a non-negative finite number" }
      ]
    });
  });

  it("accepts bounded path masks and rejects ambiguous or malformed path-mask fields", async () => {
    const schema = await loadSchema("motion");
    const valid = await validateDocument(schema, motionWithLayerFields({
      mask: { type: "path", path: "M 0 0 L 100 0 L 50 100 Z", viewBox: "0 0 100 100", fillRule: "evenodd" }
    }));
    const invalid = await validateDocument(schema, motionWithLayerFields({
      mask: {
        type: "path",
        path: "M 0 0 L nope",
        viewBox: "0 0 0 100",
        fillRule: "winding",
        inset: { left: 1 },
        radius: 4
      },
      transitions: { in: { type: "wipe", durationMs: 100, direction: "left" } }
    }));

    expect(valid).toEqual({ ok: true });
    expect(invalid).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        { path: "/layers/0/mask/inset", message: "not supported on path masks" },
        { path: "/layers/0/mask/radius", message: "not supported on path masks" },
        { path: "/layers/0/mask/path", message: "Path mask contains unsupported path syntax." },
        { path: "/layers/0/mask/viewBox", message: "Path mask viewBox must contain finite x/y and positive width/height." },
        { path: "/layers/0/mask/fillRule", message: "must be nonzero or evenodd" },
        { path: "/layers/0/transitions/in/type", message: "wipe transitions cannot yet be combined with path masks" }
      ])
    });
  });

  it("validates explicit static-shape matte bindings and rejects ambiguous sources", async () => {
    const schema = await loadSchema("motion");
    const valid = await validateDocument(schema, motionWithDocumentFields({
      layers: [
        { id: "matte", type: "shape", shape: "ellipse", startMs: 0, durationMs: 1000, transform: { x: 0, y: 0, width: 100, height: 100 } },
        { id: "consumer", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, matte: { type: "alpha-inverted", sourceLayerId: "matte" } },
        { id: "luma-consumer", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, matte: { type: "luma-inverted", sourceLayerId: "matte" } }
      ]
    }));
    const invalid = await validateDocument(schema, motionWithDocumentFields({
      layers: [
        { id: "matte", type: "text", text: "not supported", startMs: 0, durationMs: 1000, transform: { rotation: 15 } },
        { id: "consumer", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, matte: { type: "chroma", sourceLayerId: "matte" }, transform: { scale: 2 } },
        { id: "self", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, matte: { type: "alpha", sourceLayerId: "self" } },
        { id: "missing", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, matte: { type: "alpha", sourceLayerId: "nope" } }
      ]
    }));

    expect(valid).toEqual({ ok: true });
    expect(invalid).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        { path: "/layers/1/matte/type", message: "must be alpha, alpha-inverted, luma, or luma-inverted" },
        { path: "/layers/0/type", message: "matte sources currently require a shape layer" },
        { path: "/layers/1/transform/scale", message: "consumer scale is not yet supported with mattes" },
        { path: "/layers/2/matte/sourceLayerId", message: "cannot reference the consumer layer" },
        { path: "/layers/3/matte/sourceLayerId", message: "must reference an existing layer id" }
      ])
    });
  });

  it("rejects invalid mask inset keyframe values", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithKeyframes({
      "mask.inset.top": [{ atMs: 0, value: -1 }],
      "mask.inset.right": [{ atMs: 0, value: "wide" }],
      "mask.inset.bottom": [{ atMs: 0, value: -0.5 }],
      "mask.inset.left": [{ atMs: 0, value: Number.NaN }]
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/keyframes/mask.inset.top/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/mask.inset.right/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/mask.inset.bottom/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/mask.inset.left/0/value", message: "must be a non-negative finite number" }
      ]
    });
  });

  it("rejects invalid image crop keyframe values", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      id: "product",
      type: "image",
      assetId: "asset_product",
      crop: { x: 0, y: 0, width: 320, height: 180 },
      keyframes: {
        "crop.x": [{ atMs: 0, value: -1 }],
        "crop.y": [{ atMs: 0, value: "high" }],
        "crop.width": [{ atMs: 0, value: 0 }],
        "crop.height": [{ atMs: 0, value: Number.NaN }]
      }
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/keyframes/crop.x/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/crop.y/0/value", message: "must be a non-negative finite number" },
        { path: "/layers/0/keyframes/crop.width/0/value", message: "must be a positive finite number" },
        { path: "/layers/0/keyframes/crop.height/0/value", message: "must be a positive finite number" }
      ]
    });
  });

  it("rejects media crop keyframes on non-media layers", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      type: "text",
      text: "No crop",
      keyframes: {
        "crop.x": [{ atMs: 0, value: 0 }],
        "crop.width": [{ atMs: 0, value: 100 }]
      }
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/keyframes/crop.x", message: "supported only on image or video layers" },
        { path: "/layers/0/keyframes/crop.width", message: "supported only on image or video layers" }
      ]
    });
  });

  it("rejects image crop keyframes without a base crop rectangle", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      id: "product",
      type: "image",
      assetId: "asset_product",
      keyframes: {
        "crop.x": [{ atMs: 0, value: 0 }]
      }
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/keyframes/crop.x", message: "requires /layers/0/crop" }
      ]
    });
  });

  it("rejects malformed visual effect controls", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithLayerFields({
      effects: {
        blur: -1,
        brightness: "high",
        grayscale: -0.1,
        glow: { radius: 129, color: "url(https://evil.example/glow)" }
      }
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/effects/blur", message: "must be a non-negative finite number" },
        { path: "/layers/0/effects/brightness", message: "must be a non-negative finite number" },
        { path: "/layers/0/effects/grayscale", message: "must be a non-negative finite number" },
        { path: "/layers/0/effects/glow/radius", message: "must be a finite number between 0 and 128" },
        { path: "/layers/0/effects/glow/color", message: "must be a supported color string" }
      ]
    });
  });

  it("validates bounded temporal motion blur controls and concurrent cost", async () => {
    const schema = await loadSchema("motion");
    const valid = await validateDocument(schema, motionWithLayerFields({
      type: "shape",
      shape: "ellipse",
      effects: { motionBlur: { samples: 8, shutterAngle: 180 } },
      keyframes: { "transform.x": [{ atMs: 0, value: 0 }, { atMs: 1000, value: 400 }] }
    }));
    const invalid = await validateDocument(schema, motionWithLayerFields({
      type: "audio",
      effects: { motionBlur: { samples: 1.5, shutterAngle: 0 } }
    }));
    const invalidVideo = await validateDocument(schema, motionWithLayerFields({
      type: "video",
      effects: { motionBlur: { samples: 8, shutterAngle: 180 } }
    }));
    const overBudget = await validateDocument(schema, motionWithDocumentFields({
      layers: Array.from({ length: 9 }, (_value, index) => ({
        id: `blur-${index}`,
        type: "shape",
        shape: "rect",
        startMs: 0,
        durationMs: 1000,
        effects: { motionBlur: { samples: 8, shutterAngle: 180 } }
      }))
    }));
    const overVideoBudget = await validateDocument(schema, motionWithDocumentFields({
      layers: Array.from({ length: 5 }, (_value, index) => ({
        id: `video-blur-${index}`,
        type: "video",
        startMs: 0,
        durationMs: 1000,
        effects: { motionBlur: { samples: 4, shutterAngle: 180 } }
      }))
    }));

    expect(valid).toEqual({ ok: true });
    expect(invalid).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/effects/motionBlur/samples", message: "must be an integer between 2 and 8" },
        { path: "/layers/0/effects/motionBlur/shutterAngle", message: "must be a finite number greater than 0 and at most 360" },
        { path: "/layers/0/effects/motionBlur", message: "is supported only on generated visual layers" }
      ]
    });
    expect(overBudget).toEqual({
      ok: false,
      errors: [{ path: "/layers", message: "concurrent motion blur sample budget 72 exceeds 64" }]
    });
    expect(invalidVideo).toEqual({
      ok: false,
      errors: [{ path: "/layers/0/effects/motionBlur/samples", message: "video layers support at most 4 samples" }]
    });
    expect(overVideoBudget).toEqual({
      ok: false,
      errors: [{ path: "/layers", message: "concurrent video motion blur sample budget 20 exceeds 16" }]
    });
  });

  it("rejects temporal motion blur on matte consumers until sampled matte definitions are supported", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithDocumentFields({
      layers: [
        { id: "matte", type: "shape", shape: "ellipse", startMs: 0, durationMs: 1000 },
        {
          id: "consumer",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          matte: { type: "alpha", sourceLayerId: "matte" },
          effects: { motionBlur: { samples: 4, shutterAngle: 180 } }
        }
      ]
    }));

    expect(result).toEqual({
      ok: false,
      errors: [{ path: "/layers/1/effects/motionBlur", message: "consumer motion blur is not yet supported with mattes" }]
    });
  });

  it("validates bounded topmost film-look adjustment layers", async () => {
    const schema = await loadSchema("motion");
    const valid = await validateDocument(schema, motionWithDocumentFields({
      layers: [
        { id: "subject", type: "shape", shape: "rect", startMs: 0, durationMs: 1000 },
        {
          id: "film-look",
          type: "adjustment",
          startMs: 0,
          durationMs: 1000,
          effects: {
            vignette: { amount: 0.8, softness: 0.65, color: "#000000" },
            filmGrain: { amount: 0.35, size: 2, seed: 42 }
          }
        }
      ]
    }));
    const invalid = await validateDocument(schema, motionWithDocumentFields({
      layers: [
        {
          id: "film-look",
          type: "adjustment",
          startMs: 0,
          durationMs: 1000,
          text: "not content",
          transform: { opacity: 0.5 },
          effects: {
            blur: 2,
            vignette: { amount: 1.1, softness: -0.1, color: "url(evil)" },
            filmGrain: { amount: -1, size: 9, seed: -1 }
          }
        },
        { id: "late-subject", type: "shape", shape: "rect", startMs: 0, durationMs: 1000 }
      ]
    }));
    const tooMany = await validateDocument(schema, motionWithDocumentFields({
      layers: Array.from({ length: 9 }, (_value, index) => ({
        id: `adjustment-${index}`,
        type: "adjustment",
        startMs: 0,
        durationMs: 1000,
        effects: { vignette: { amount: 0.5, softness: 0.5, color: "#000000" } }
      }))
    }));

    expect(valid).toEqual({ ok: true });
    expect(invalid).toEqual({
      ok: false,
      errors: [
        { path: "/layers/1/type", message: "non-adjustment layers must precede adjustment layers" },
        { path: "/layers/0/text", message: "is not supported on adjustment layers" },
        { path: "/layers/0/transform", message: "is not supported on adjustment layers" },
        { path: "/layers/0/effects/blur", message: "is not supported on adjustment layers" },
        { path: "/layers/0/effects/vignette/amount", message: "must be a finite number between 0 and 1" },
        { path: "/layers/0/effects/vignette/softness", message: "must be a finite number between 0 and 1" },
        { path: "/layers/0/effects/vignette/color", message: "must be a supported color string" },
        { path: "/layers/0/effects/filmGrain/amount", message: "must be a finite number between 0 and 1" },
        { path: "/layers/0/effects/filmGrain/size", message: "must be an integer between 1 and 8" },
        { path: "/layers/0/effects/filmGrain/seed", message: "must be an unsigned 32-bit integer" }
      ]
    });
    expect(tooMany).toEqual({
      ok: false,
      errors: [{ path: "/layers/8/type", message: "at most 8 adjustment layers are supported" }]
    });
  });

  it("accepts one transform-only keyframed 2D camera", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithDocumentFields({
      layers: [
        {
          id: "camera-main",
          type: "camera",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 0, y: 0, scale: 1, rotation: 0, originX: 960, originY: 540 },
          keyframes: {
            "transform.x": [{ atMs: 0, value: 0 }, { atMs: 1000, value: 40 }],
            "transform.y": [{ atMs: 0, value: 0 }, { atMs: 1000, value: 15 }],
            "transform.scale": [{ atMs: 0, value: 1 }, { atMs: 1000, value: 1.35 }],
            "transform.rotation": [{ atMs: 0, value: 0 }, { atMs: 1000, value: 5 }]
          }
        },
        { id: "subject", type: "shape", shape: "rect", startMs: 0, durationMs: 1000 }
      ]
    }));

    expect(result).toEqual({ ok: true });
  });

  it("rejects multiple cameras and camera-only contract violations", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWithDocumentFields({
      layers: [
        {
          id: "camera-main",
          type: "camera",
          startMs: 0,
          durationMs: 1000,
          text: "not visual content",
          style: { color: "#ffffff" },
          transform: { scale: 0 },
          keyframes: {
            opacity: [{ atMs: 0, value: 1 }],
            "transform.scale": [{ atMs: 0, value: 101 }]
          }
        },
        { id: "camera-second", type: "camera", startMs: 0, durationMs: 1000 }
      ]
    }));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/1/type", message: "only one camera layer is supported" },
        { path: "/layers/0/text", message: "is not supported on camera layers" },
        { path: "/layers/0/style", message: "is not supported on camera layers" },
        { path: "/layers/0/transform/scale", message: "must be a positive finite number on camera layers" },
        { path: "/layers/0/keyframes/opacity", message: "unsupported camera transform keyframe" },
        { path: "/layers/0/keyframes/transform.scale/0/value", message: "must be between 0.001 and 100 on camera layers" }
      ]
    });
  });

  it("validates bounded all-layer depth planes behind one camera", async () => {
    const schema = await loadSchema("motion");
    const valid = await validateDocument(schema, motionWithDocumentFields({
      layers: [
        { id: "camera-main", type: "camera", startMs: 0, durationMs: 1000, transform: { x: 0, y: 0, scale: 1 } },
        { id: "background", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, depth: -0.75 },
        { id: "subject", type: "image", startMs: 0, durationMs: 1000, depth: 0 },
        { id: "foreground", type: "text", text: "Near", startMs: 0, durationMs: 1000, depth: 1.5 }
      ]
    }));
    const invalid = await validateDocument(schema, motionWithDocumentFields({
      layers: [
        { id: "too-near", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, depth: 4 },
        { id: "missing-depth", type: "text", text: "Flat", startMs: 0, durationMs: 1000 }
      ]
    }));

    expect(valid).toEqual({ ok: true });
    expect(invalid).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/depth", message: "must be a finite number between -0.9 and 3" },
        { path: "/layers/0/depth", message: "requires a camera layer" },
        { path: "/layers/1/depth", message: "is required on every generated visual layer in a depth composition" }
      ]
    });
  });

  it("validates versioned package-local restricted shader plugins", async () => {
    const schema = await loadSchema("motion");
    const valid = await validateDocument(schema, motionWithDocumentFields({
      layers: [{
        id: "plasma",
        type: "shader",
        startMs: 0,
        durationMs: 1000,
        transform: { x: 0, y: 0, width: 320, height: 180 },
        shader: {
          schema: "shellx-motion/shader-plugin@1",
          language: "glsl-es-100-expression",
          fragmentAssetId: "shader_plasma",
          seed: 42,
          uniforms: { u_speed: 1.5 },
          fallbackColor: "#111827"
        },
        keyframes: {
          "shader.uniforms.u_speed": [
            { atMs: 0, value: 0.25, easing: "linear" },
            { atMs: 1000, value: 2 }
          ]
        }
      }],
      assets: [{
        id: "shader_plasma",
        type: "shader",
        source: { path: "assets/plasma.glsl", mimeType: "text/x-shellx-motion-glsl" }
      }]
    }));
    const invalid = await validateDocument(schema, motionWithDocumentFields({
      layers: [{
        id: "bad-shader",
        type: "shader",
        startMs: 0,
        durationMs: 1000,
        source: "https://evil.example/shader.glsl",
        shader: {
          schema: "shader@latest",
          language: "javascript",
          fragmentAssetId: "missing",
          seed: -1,
          uniforms: { u_time: 1, "bad-name": Number.POSITIVE_INFINITY },
          fallbackColor: "url(evil)"
        },
        keyframes: {
          "shader.uniforms.u_missing": [
            { atMs: 0, value: 0 },
            { atMs: 1000, value: 2_000_000 }
          ]
        }
      }],
      assets: [{
        id: "shader_bad",
        type: "shader",
        source: { path: "assets/bad.glsl", mimeType: "text/javascript" }
      }]
    }));

    expect(valid).toEqual({ ok: true });
    expect(invalid).toEqual({
      ok: false,
      errors: [
        { path: "/assets/0/source/mimeType", message: "must be text/x-shellx-motion-glsl" },
        { path: "/layers/0/shader/schema", message: "must be shellx-motion/shader-plugin@1" },
        { path: "/layers/0/shader/language", message: "must be glsl-es-100-expression" },
        { path: "/layers/0/shader/fragmentAssetId", message: "must reference a shader asset" },
        { path: "/layers/0/shader/seed", message: "must be an unsigned 32-bit integer" },
        { path: "/layers/0/shader/fallbackColor", message: "must be a supported color string" },
        { path: "/layers/0/shader/uniforms/u_time", message: "has an unsafe or reserved uniform name" },
        { path: "/layers/0/shader/uniforms/bad-name", message: "has an unsafe or reserved uniform name" },
        { path: "/layers/0/shader/uniforms/bad-name", message: "must be a finite number between -1000000 and 1000000" },
        { path: "/layers/0/source", message: "is not supported on shader layers" },
        { path: "/layers/0/keyframes/shader.uniforms.u_missing", message: "unsupported keyframe target" }
      ]
    });
  });
});

function motionWithKeyframes(keyframes: Record<string, unknown>): Record<string, unknown> {
  return motionWithLayerFields({ keyframes });
}

function motionWithLayerFields(fields: Record<string, unknown>): Record<string, unknown> {
  return motionWithDocumentFields({
    layers: [
      {
        id: "title",
        type: "text",
        text: "Anna",
        startMs: 0,
        durationMs: 1000,
        transform: { x: 120, y: 820, scale: 1, rotation: 0 },
        style: { fontFamily: "Inter", fontSize: 64, color: "#ffffff" },
        ...fields
      }
    ]
  });
}

function motionWithDocumentFields(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "shellx-motion/motion@1",
    id: "motion_keyframed",
    name: "Keyframed",
    durationMs: 1000,
    fps: 30,
    width: 1920,
    height: 1080,
    layers: [],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" },
    ...fields
  };
}

function motionWithAudioLayer(audioFields: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "shellx-motion/motion@1",
    id: "motion_audio",
    name: "Audio",
    durationMs: 2000,
    fps: 30,
    width: 1920,
    height: 1080,
    layers: [
      {
        id: "music",
        type: "audio",
        source: "assets/music.wav",
        startMs: 0,
        durationMs: 2000,
        ...audioFields
      }
    ],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" }
  };
}

function motionWithVideoLayer(videoFields: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "shellx-motion/motion@1",
    id: "motion_video",
    name: "Video",
    durationMs: 2000,
    fps: 30,
    width: 1920,
    height: 1080,
    layers: [
      {
        id: "clip",
        type: "video",
        assetId: "asset_clip",
        startMs: 0,
        durationMs: 2000,
        ...videoFields
      }
    ],
    assets: [
      {
        schema: "shellx-motion/asset@1",
        id: "asset_clip",
        kind: "video",
        source: { path: "assets/clip.mp4", mimeType: "video/mp4" },
        hash: { sha256: "sample" }
      }
    ],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" }
  };
}
