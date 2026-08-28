import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIONS } from "@shellx-motion/actions";
import { buildSourceImportDocument, hashBuffer, loadSchema, platformVerificationCommandContract, validateDocument, type OperationReceipt } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { createFakePromptRuntime } from "@shellx-motion/prompt/test-support";
import * as browserRenderer from "@shellx-motion/renderer-browser";
import {
  BrowserWorkflowReplayError,
  type BrowserFrameResult,
  type MotionBrowserRenderSession
} from "@shellx-motion/renderer-browser";
import {
  clearDefaultEncodePolicyCache,
  resolveFfmpegExecutable,
  type FfmpegCommand,
  type FfmpegRunner
} from "@shellx-motion/renderer-ffmpeg";
import { DEBUG_COMMAND_CONTRACTS, DEBUG_COMMANDS, dispatchDebugCommand as dispatchProductionDebugCommand, type MotionDebugContext } from "./index";
import { withCommandTestAuthoringRoots } from "./authoring-test-context.test-support";
import { expectEncodeThenColorReadback, ffprobeReadbackStdout, isDeliveredColorReadback } from "./ffprobe-readback.test-support";
import { qualityFfmpegInputArgs } from "./quality-ffmpeg-command.test-support";
import { BATCH_STATIC_FIXTURE_STATUS, productFamilyPresent } from "./batch-receipt-status.test-support";
import {
  debugConnectorDeliveredColorRunner,
  debugConnectorStreamingFailureRenderer,
  debugConnectorStreamingRenderer,
  expectDebugConnectorDeliveredColorReadback,
  expectDebugConnectorStreamedReceipt,
  fakeMp4Bytes
} from "./debug-connector-streaming.test-support";
import {
  scriptedVideo,
  storyboardGraphCollisionScriptedVideo,
} from "./debug-storyboard-fixtures.test-support";

function debugContract(command: string): Record<string, unknown> {
  const contract = DEBUG_COMMAND_CONTRACTS.find((entry) => entry.command === command);
  if (!contract) throw new Error(`Missing debug command contract: ${command}`);
  return contract as unknown as Record<string, unknown>;
}

function completedPlatformReceipt(input: { requiredHosts: string[]; complete: boolean }): Record<string, unknown> {
  const commands = platformVerificationCommandContract().map((command) => ({
    id: command.id,
    command: command.command,
    required: command.required,
    status: "passed",
    durationMs: 1,
    exitCode: 0,
    signal: null
  }));
  return {
    schema: "shellx-motion/platform-verification@1",
    status: "passed",
    dryRun: false,
    host: { id: "linux", hostname: "linux.example.test", platform: "linux", arch: "x64", release: "6.8.0", node: "v24.0.0" },
    toolchain: { status: "verified", exact: true, bundledCodecs: false },
    hostMatrix: {
      required: input.requiredHosts,
      current: "linux",
      currentRequired: true,
      satisfied: ["linux"],
      missing: input.requiredHosts.filter((host) => host !== "linux"),
      complete: input.complete,
      status: input.complete ? "complete" : "partial"
    },
    repoRoot: "/workspace/ShellX Motion",
    startedAt: "2026-07-03T10:00:00.000Z",
    finishedAt: "2026-07-03T10:05:00.000Z",
    commandSummary: { total: commands.length, passed: commands.length, failed: 0, skipped: 0, skippedByKind: {} },
    commands
  };
}

function browserColorAlphaContract() {
  return expect.objectContaining({
    sourceEncoding: "sdr-srgb-encoded",
    rasterInput: "unprofiled-srgb-assumed",
    embeddedProfiles: "unsupported-undefined",
    alphaBoundary: "browser-managed-before-png-capture",
    filterDomain: "chromium-managed",
    blendDomain: "chromium-managed",
    crossRendererConformance: false,
    unsupported: ["hdr", "wide-gamut", "icc-profile-conversion", "ocio", "user-selectable-working-space"]
  });
}

async function expectCanvasMp4ClosedTreeRefusal(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-canvas-mp4-platform-refusal-"));
  const outDir = join(root, "out");
  try {
    const result = await dispatchDebugCommand(
      "motion.connector.canvas_to_mp4",
      {
        canvasSelectionPath: "../../fixtures/canvas/shape-text-frame-selection.json",
        outDir,
        dryRunRender: true
      },
      { tier: "write_local" }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "connector_failed",
        message: /closed-tree publication requires a Linux descriptor-relative primitive/i
      }
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).some((name) => name.includes(".shellx-motion-stage-"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function expectCutGenerateClosedTreeRefusal(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-cut-generate-platform-refusal-"));
  const outDir = join(root, "out");
  try {
    const result = await dispatchDebugCommand(
      "motion.connector.cut_generate_to_cut",
      { script: scriptedVideo(), outDir, dryRunRender: true },
      { tier: "write_local" }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "connector_failed",
        message: /closed-tree publication requires a Linux descriptor-relative primitive/i
      }
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).some((name) => name.includes(".shellx-motion-stage-"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function dispatchDebugCommand(command: Parameters<typeof dispatchProductionDebugCommand>[0], args: unknown, context: MotionDebugContext) {
  return await dispatchProductionDebugCommand(command, args, withCommandTestAuthoringRoots(context, command, args) as MotionDebugContext);
}

const itLinux = process.platform === "linux" ? it : it.skip;

// Isolate the shared encode-policy probe cache per test so each render observes a fresh probe.
beforeEach(clearDefaultEncodePolicyCache);
describe("motion debug API", () => {
  it("exports the required command set", () => {
    expect(DEBUG_COMMANDS).toContain("motion.state");
    expect(DEBUG_COMMANDS).toContain("motion.prompt.run");
    expect(DEBUG_COMMANDS).toContain("motion.package.patch");
    expect(DEBUG_COMMANDS).toContain("motion.preview.playhead");
    expect(DEBUG_COMMANDS).toContain("motion.preview.panel");
    expect(DEBUG_COMMANDS).toContain("motion.preview.strip");
    expect(DEBUG_COMMANDS).toContain("motion.script.compile");
    expect(DEBUG_COMMANDS).toContain("motion.render.cancel");
    expect(DEBUG_COMMANDS).toContain("motion.render.retry");
    expect(DEBUG_COMMANDS).toContain("motion.render.queue");
    expect(DEBUG_COMMANDS).toContain("motion.agent.transcript");
    expect(DEBUG_COMMANDS).toContain("motion.prompt.queue");
    expect(DEBUG_COMMANDS).toContain("motion.prompt.cancel");
    expect(DEBUG_COMMANDS).toContain("motion.prompt.retry");
    expect(DEBUG_COMMANDS).toContain("motion.packages.browse");
    expect(DEBUG_COMMANDS).toContain("motion.receipts.panel");
    expect(DEBUG_COMMANDS).toContain("motion.platform.verification.panel");
    expect(DEBUG_COMMANDS).toContain("motion.actions.panel");
    expect(DEBUG_COMMANDS).toContain("motion.assets.panel");
    expect(DEBUG_COMMANDS).toContain("motion.brand.panel");
    expect(DEBUG_COMMANDS).toContain("motion.audio.panel");
    expect(DEBUG_COMMANDS).toContain("motion.media.panel");
    expect(DEBUG_COMMANDS).toContain("motion.storyboard.panel");
    expect(DEBUG_COMMANDS).toContain("motion.storyboard.graph");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.panel");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.inspect");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.playhead.set");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.range.select");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.viewport.set");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.duration.policy");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.duration.policy.set");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.scene.create");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.scene.delete");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.scene.reorder");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.scene.resize");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.scene.name.set");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.marker.upsert");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.marker.delete");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.keyframe.upsert");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.keyframe.delete");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.keyframe.range.delete");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.keyframe.move");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.keyframe.easing.apply");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.keyframe.shift");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.keyframe.scale");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.keyframe.duplicate");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.keyframe.distribute");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.keyframe.reverse");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.keyframe.snap");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.keyframes.panel");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.transitions.panel");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.easing.panel");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.easing.presets");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.animation.presets");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.animation.preset.apply");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.layer.trim");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.layer.split");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.layer.text.set");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.layer.style.set");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.layer.transform.set");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.layer.effect.set");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.layer.blend.set");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.layer.crop.set");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.layer.mask.set");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.layer.fit.set");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.layer.media.set");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.layer.name.set");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.layer.visibility.set");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.layer.lock");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.layer.delete");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.layer.duplicate");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.layer.reorder");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.cleanup");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.track.create");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.track.reorder");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.track.delete");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.track.rename");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.track.lock");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.track.mute");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.track.solo");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.track.volume");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.track.fade");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.track.pan");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.layer.track.assign");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.caption.import");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.caption.upsert");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.transition.upsert");
    expect(DEBUG_COMMANDS).toContain("motion.timeline.transition.delete");
    expect(DEBUG_COMMANDS).toContain("motion.export.presets");
    expect(DEBUG_COMMANDS).toContain("motion.export.panel");
    expect(DEBUG_COMMANDS).toContain("motion.export.plan");
    expect(DEBUG_COMMANDS).toContain("motion.package.archive");
    expect(DEBUG_COMMANDS).toContain("motion.package.extract");
    expect(DEBUG_COMMANDS).toContain("motion.review.html.bundle");
    expect(DEBUG_COMMANDS).toContain("motion.source.import");
    expect(DEBUG_COMMANDS).toContain("motion.source.to_scripted_video");
    expect(DEBUG_COMMANDS).toContain("motion.capabilities.match");
    expect(DEBUG_COMMANDS).toContain("motion.capabilities.panel");
    expect(DEBUG_COMMANDS).toContain("motion.agent.panel");
    expect(DEBUG_COMMANDS).toContain("motion.html.snippet.export");
    expect(DEBUG_COMMANDS).toContain("motion.template.catalog");
    expect(DEBUG_COMMANDS).toContain("motion.template.plan");
    expect(DEBUG_COMMANDS).toContain("motion.template.panel");
    expect(DEBUG_COMMANDS).toContain("motion.template.controls");
    expect(DEBUG_COMMANDS).toContain("motion.template.apply");
    expect(DEBUG_COMMANDS).toContain("motion.template.media.replace");
    expect(DEBUG_COMMANDS).toContain("motion.canvas.bridge_export");
    expect(DEBUG_COMMANDS).toContain("motion.connector.catalog");
    expect(DEBUG_COMMANDS).toContain("motion.connector.panel");
    expect(DEBUG_COMMANDS).toContain("motion.connector.source_to_cut");
    expect(DEBUG_COMMANDS).toContain("motion.quality.panel");
  });

  it("exports debug commands for every first-slice visible action surface", () => {
    expect(DEBUG_COMMANDS).toEqual(expect.arrayContaining([
      "motion.render.final",
      "motion.render.batch",
      "motion.canvas.package",
      "motion.canvas.bridge_export",
      "motion.browser.workflow.capture",
      "motion.connector.panel",
      "motion.connector.canvas_to_mp4",
      "motion.connector.canvas_to_cut",
      "motion.connector.script_to_cut",
      "motion.connector.source_to_cut",
      "motion.connector.cut_generate_to_cut",
      "motion.connector.template_to_cut",
      "motion.media.panel",
      "motion.quality.panel",
      "motion.quality.check",
      "motion.timeline.caption.import",
      "motion.timeline.caption.upsert",
      "motion.timeline.animation.presets",
      "motion.template.media.replace",
      "motion.template.plan",
      "motion.timeline.animation.preset.apply",
      "motion.package.archive",
      "motion.package.extract",
      "motion.html.snippet.export"
    ]));
  });

  it("validates action and debug command contracts against their shipped schemas", async () => {
    const actionSchema = await loadSchema("action");
    const debugSchema = await loadSchema("debug");

    expect(DEBUG_COMMAND_CONTRACTS.map((contract) => contract.command)).toEqual([...DEBUG_COMMANDS]);
    expect(DEBUG_COMMAND_CONTRACTS.find((contract) => contract.command === "motion.packages.browse")).toMatchObject({
      permission: "read_motion",
      mutates: false
    });
    await Promise.all(ACTIONS.map(async (action) => {
      expect(await validateDocument(actionSchema, action)).toEqual({ ok: true });
    }));
    await Promise.all(DEBUG_COMMAND_CONTRACTS.map(async (contract) => {
      expect(await validateDocument(debugSchema, contract)).toEqual({ ok: true });
    }));
  });

  it("ships deterministic public action and debug registry artifacts", async () => {
    const actionsRegistry = JSON.parse(await readFile(resolve("../../schemas/actions.json"), "utf8"));
    const debugRegistry = JSON.parse(await readFile(resolve("../../schemas/debug.json"), "utf8"));
    const actionsRegistrySchema = await loadSchema("actions");
    const debugRegistrySchema = await loadSchema("debugContracts");

    expect(actionsRegistry).toMatchObject({
      schema: "shellx-motion/actions@1",
      actionSchema: "shellx-motion/action@1",
      generatedBy: "scripts/generate-public-contracts.ts",
      actionCount: ACTIONS.length
    });
    expect(actionsRegistry.permissions).toEqual(["read_motion", "draft_motion", "render_motion", "edit_motion", "write_local", "push_remote"]);
    expect(actionsRegistry.surfaces).toContain("prompt");
    expect(actionsRegistry.actions).toEqual(ACTIONS);

    expect(debugRegistry).toMatchObject({
      schema: "shellx-motion/debug-contracts@1",
      debugSchema: "shellx-motion/debug@1",
      generatedBy: "scripts/generate-public-contracts.ts",
      commandCount: DEBUG_COMMAND_CONTRACTS.length
    });
    expect(debugRegistry.permissions).toEqual(["read_motion", "draft_motion", "render_motion", "edit_motion", "write_local", "push_remote"]);
    expect(debugRegistry.commands).toEqual([...DEBUG_COMMANDS]);
    expect(debugRegistry.contracts).toEqual(DEBUG_COMMAND_CONTRACTS);
    expect(await validateDocument(actionsRegistrySchema, actionsRegistry)).toEqual({ ok: true });
    expect(await validateDocument(debugRegistrySchema, debugRegistry)).toEqual({ ok: true });
  });

  it("ships host-form and receipt metadata for high-traffic debug contracts", () => {
    expect(debugContract("motion.preview.frame")).toMatchObject({
      argsSchema: {
        type: "object",
        required: ["packageRoot"],
        properties: {
          packageRoot: { type: "string" },
          atMs: { type: "number", minimum: 0 },
          outDir: { type: "string" },
          outputPath: { type: "string" },
          createdAt: { type: "string" },
          workflowPath: { type: "string" }
        }
      },
      expectedReceipts: [{ operation: "preview.frame", mode: "emits", required: true, artifactRoles: ["preview_frame"] }, { operation: "preview.gpu.frame", mode: "emits", required: false, artifactRoles: ["preview_frame"] }]
    });
    expect(debugContract("motion.render.final")).toMatchObject({
      argsSchema: {
        type: "object",
        required: ["packageRoot", "outputPath"],
        properties: {
          packageRoot: { type: "string" },
          outputPath: { type: "string" },
          preset: { type: "string" },
          frameLane: { type: "string" },
          qualityManifestPath: { type: "string" },
          manifestPath: { type: "string" },
          receiptsRoot: { type: "string" },
          reuseAttested: { type: "boolean", default: false }
        }
      },
      expectedReceipts: [
        { operation: "render.final", mode: "emits", required: true, artifactRoles: ["rendered_media", "render_receipt"] },
        { operation: "render.reuse", mode: "emits", required: false, artifactRoles: ["rendered_media"] },
        { operation: "quality.check", mode: "emits", required: false, artifactRoles: ["quality_receipt"] }
      ]
    });
    expect(debugContract("motion.render.queue")).toMatchObject({
      argsSchema: {
        type: "object",
        properties: {
          receiptsRoot: { type: "string" }
        }
      },
      expectedReceipts: [
        { operation: "render.final", mode: "reads", required: false },
        { operation: "render.cancel", mode: "reads", required: false },
        { operation: "render.retry", mode: "reads", required: false }
      ]
    });
    expect(debugContract("motion.browser.workflow.capture")).toMatchObject({
      argsSchema: {
        type: "object",
        required: ["packageRoot"],
        properties: {
          packageRoot: { type: "string" },
          outDir: { type: "string" },
          outputPath: { type: "string" },
          atMs: { type: "number", minimum: 0 },
          workflow: { type: "object" },
          workflowPath: { type: "string" },
          catalogPath: { type: "string" },
          workflowCatalogPath: { type: "string" },
          recordingManifestPath: { type: "string" },
          recordingFramesDir: { type: "string" },
          recordingSampleCount: { type: "number", minimum: 1 },
          failOnDrift: { type: "boolean" }
        }
      },
      expectedReceipts: [
        { operation: "browser.workflow.capture", mode: "emits", required: true, artifactRoles: ["preview_frame", "preview_receipt"] },
        { operation: "browser.workflow.capture", mode: "emits", required: false, artifactRoles: ["browser_workflow_trace", "browser_workflow_catalog", "browser_recording_manifest"] }
      ]
    });
    expect(debugContract("motion.media.panel")).toMatchObject({
      argsSchema: {
        type: "object",
        required: ["packageRoot"],
        properties: {
          packageRoot: { type: "string" },
          preset: { type: "string" },
          exportPreset: { type: "string" }
        }
      },
      expectedReceipts: [
        { operation: "media.panel", mode: "reads", required: false }
      ]
    });
    expect(debugContract("motion.connector.panel")).toMatchObject({
      argsSchema: {
        type: "object",
        properties: {}
      },
      expectedReceipts: [
        { operation: "connector.panel", mode: "reads", required: false }
      ]
    });
    expect(debugContract("motion.agent.panel")).toMatchObject({
      argsSchema: {
        type: "object",
        properties: {}
      },
      expectedReceipts: [
        { operation: "agent.panel", mode: "reads", required: false }
      ]
    });
    expect(debugContract("motion.canvas.bridge_export")).toMatchObject({
      argsSchema: {
        type: "object",
        required: ["canvasRoot", "outPath"],
        properties: {
          canvasRoot: { type: "string" },
          outPath: { type: "string" },
          path: { type: "string" },
          target: { type: "string" },
          projectName: { type: "string" },
          frameName: { type: "string" },
          selectedIds: { type: "array" },
          generatedAt: { type: "string" },
          durationMs: { type: "number", minimum: 1 },
          fps: { type: "number", minimum: 1 }
        }
      },
      expectedReceipts: [
        { operation: "canvas.bridge_export", mode: "emits", required: true, artifactRoles: ["canvas_bridge", "canvas_frame_selection", "connector_receipt"] }
      ]
    });
    expect((debugContract("motion.canvas.bridge_export").argsSchema as { properties?: Record<string, unknown> }).properties).not.toHaveProperty("trustedCanvasRoots");
    expect(debugContract("motion.review.html.bundle")).toMatchObject({
      argsSchema: {
        type: "object",
        required: ["outDir"],
        properties: {
          packageRoot: { type: "string" },
          outDir: { type: "string" },
          receiptsRoot: { type: "string" },
          title: { type: "string" }
        }
      },
      expectedReceipts: [
        { operation: "render.final", mode: "reads", required: false },
        { operation: "render.batch", mode: "reads", required: false },
        { operation: "quality.check", mode: "reads", required: false },
        { operation: "review.html.bundle", mode: "emits", required: true, artifactRoles: ["review_html_bundle", "review_html_bundle_receipt"] }
      ]
    });
    expect(debugContract("motion.source.import")).toMatchObject({
      argsSchema: {
        type: "object",
        required: ["url", "outDir"],
        properties: {
          url: { type: "string" },
          outDir: { type: "string" },
          markdown: { type: "string" },
          title: { type: "string" },
          kind: { type: "string" },
          maxChars: { type: "number", minimum: 1 },
          createdBy: { type: "string" }
        }
      },
      expectedReceipts: [
        { operation: "source.import", mode: "emits", required: true, artifactRoles: ["source_markdown", "source_import_receipt"] }
      ]
    });
    expect(debugContract("motion.source.to_scripted_video")).toMatchObject({
      argsSchema: {
        type: "object",
        required: ["sourcePath", "outDir"],
        properties: {
          sourcePath: { type: "string" },
          outDir: { type: "string" },
          receiptsRoot: { type: "string" },
          maxFrames: { type: "number", minimum: 1 },
          frameDurationMs: { type: "number", minimum: 500 },
          width: { type: "number", minimum: 16 },
          height: { type: "number", minimum: 16 },
          fps: { type: "number", minimum: 1 },
          createdBy: { type: "string" }
        }
      },
      expectedReceipts: [
        { operation: "source.to_scripted_video", mode: "emits", required: true, artifactRoles: ["scripted_video", "source_storyboard_receipt"] }
      ]
    });
    expect(debugContract("motion.capabilities.match")).toMatchObject({
      argsSchema: {
        type: "object",
        properties: {
          packageRoot: { type: "string" },
          output: { type: "string" },
          target: { type: "string" },
          needsAlpha: { type: "boolean" },
          needsAudio: { type: "boolean" },
          needsSubtitles: { type: "boolean" },
          preferLane: { type: "string" }
        }
      },
      expectedReceipts: [
        { operation: "capabilities.match", mode: "reads", required: false }
      ]
    });
    expect(debugContract("motion.capabilities.panel")).toMatchObject({
      argsSchema: {
        type: "object",
        properties: {
          packageRoot: { type: "string" },
          output: { type: "string" },
          target: { type: "string" },
          needsAlpha: { type: "boolean" },
          needsAudio: { type: "boolean" },
          needsSubtitles: { type: "boolean" },
          preferLane: { type: "string" }
        }
      },
      expectedReceipts: [
        { operation: "capabilities.panel", mode: "reads", required: false }
      ]
    });
    expect(debugContract("motion.quality.panel")).toMatchObject({
      permission: "read_motion",
      mutates: false,
      argsSchema: {
        type: "object",
        required: ["qualityManifestPath"],
        properties: {
          qualityManifestPath: { type: "string" },
          manifestPath: { type: "string" },
          inputPath: { type: "string" },
          packageRoot: { type: "string" },
          preset: { type: "string" }
        }
      },
      expectedReceipts: [
        { operation: "quality.panel", mode: "reads", required: false }
      ]
    });
    expect(debugContract("motion.timeline.keyframes.panel")).toMatchObject({
      permission: "read_motion",
      mutates: false,
      argsSchema: {
        type: "object",
        required: ["packageRoot"],
        properties: {
          packageRoot: { type: "string" },
          layerId: { type: "string" },
          target: { type: "string" },
          includeEmpty: { type: "boolean" }
        }
      },
      expectedReceipts: [
        { operation: "timeline.keyframes.panel", mode: "reads", required: false }
      ]
    });
    expect(debugContract("motion.timeline.transitions.panel")).toMatchObject({
      permission: "read_motion",
      mutates: false,
      argsSchema: {
        type: "object",
        required: ["packageRoot"],
        properties: {
          packageRoot: { type: "string" },
          layerId: { type: "string" },
          edge: { type: "string" },
          includeEmpty: { type: "boolean" }
        }
      },
      expectedReceipts: [
        { operation: "timeline.transitions.panel", mode: "reads", required: false }
      ]
    });
    expect(debugContract("motion.timeline.easing.panel")).toMatchObject({
      permission: "read_motion",
      mutates: false,
      argsSchema: {
        type: "object",
        required: ["packageRoot"],
        properties: {
          packageRoot: { type: "string" },
          sampleCount: { type: "number", minimum: 2 }
        }
      },
      expectedReceipts: [
        { operation: "timeline.easing.panel", mode: "reads", required: false }
      ]
    });
    expect(debugContract("motion.audio.panel")).toMatchObject({
      argsSchema: {
        type: "object",
        required: ["packageRoot"],
        properties: {
          packageRoot: { type: "string" },
          preset: { type: "string" }
        }
      },
      expectedReceipts: [
        { operation: "audio.panel", mode: "reads", required: false }
      ]
    });
    expect(debugContract("motion.storyboard.panel")).toMatchObject({
      argsSchema: {
        type: "object",
        properties: {
          scriptPath: { type: "string" },
          storyboardPath: { type: "string" },
          path: { type: "string" },
          script: { type: "object" },
          storyboard: { type: "object" }
        }
      },
      expectedReceipts: [
        { operation: "storyboard.panel", mode: "reads", required: false }
      ]
    });
    expect(debugContract("motion.storyboard.graph")).toMatchObject({
      argsSchema: {
        type: "object",
        properties: {
          scriptPath: { type: "string" },
          storyboardPath: { type: "string" },
          path: { type: "string" },
          script: { type: "object" },
          storyboard: { type: "object" }
        }
      },
      expectedReceipts: [
        { operation: "storyboard.graph", mode: "reads", required: false }
      ]
    });
    expect(debugContract("motion.html.snippet.export")).toMatchObject({
      argsSchema: {
        type: "object",
        required: ["packageRoot", "outDir"],
        properties: {
          packageRoot: { type: "string" },
          outDir: { type: "string" },
          createdAt: { type: "string" }
        }
      },
      expectedReceipts: [
        { operation: "html.snippet.export", mode: "emits", required: true, artifactRoles: ["html_snippet", "html_snippet_receipt"] }
      ]
    });
    expect(debugContract("motion.html.snippet.import")).toMatchObject({
      argsSchema: {
        type: "object",
        required: ["htmlPath", "packageDir"],
        properties: {
          htmlPath: { type: "string" },
          packageDir: { type: "string" },
          createdAt: { type: "string" }
        }
      },
      expectedReceipts: [
        { operation: "html.snippet.import", mode: "emits", required: true, artifactRoles: ["motion_package", "html_snippet_import_receipt"] }
      ]
    });
    expect(debugContract("motion.template.apply")).toMatchObject({
      argsSchema: {
        type: "object",
        required: ["packageRoot", "outDir", "values"],
        properties: {
          packageRoot: { type: "string" },
          outDir: { type: "string" },
          receiptsRoot: { type: "string" },
          values: { type: "object" },
          createdBy: { type: "string" }
        }
      },
      expectedReceipts: [
        { operation: "template.apply", mode: "emits", required: true, artifactRoles: ["motion_package", "template_apply_receipt"] }
      ]
    });
    expect(debugContract("motion.support.bundle")).toMatchObject({
      argsSchema: {
        type: "object",
        required: ["outDir"],
        properties: {
          packageRoot: { type: "string" },
          outDir: { type: "string" },
          receiptsRoot: { type: "string" }
        }
      },
      expectedReceipts: [
        { operation: "support.bundle", mode: "emits", required: true, artifactRoles: ["support_bundle", "support_receipt"] }
      ]
    });
    expect(debugContract("motion.platform.verification.panel")).toMatchObject({
      argsSchema: {
        type: "object",
        properties: {
          receiptsRoot: { type: "string" },
          requiredHosts: { type: "array" }
        }
      },
      expectedReceipts: [
        { operation: "platform.verification", mode: "reads", required: false },
        { operation: "platform.verification.aggregate", mode: "reads", required: false }
      ]
    });
  });

  it("ships host-form and receipt metadata for connector debug contracts", () => {
    expect(debugContract("motion.connector.canvas_to_mp4")).toMatchObject({
      permission: "write_local",
      argsSchema: {
        type: "object",
        required: ["canvasSelectionPath", "outDir"],
        properties: {
          canvasSelectionPath: { type: "string" },
          outDir: { type: "string" },
          preset: { type: "string" },
          dryRunRender: { type: "boolean" }
        }
      },
      expectedReceipts: [
        { operation: "connector.canvas_to_mp4", mode: "emits", required: true, artifactRoles: ["motion_package", "resource_catalog", "rendered_media", "render_receipt", "connector_receipt"] }
      ]
    });
    expect(debugContract("motion.connector.canvas_to_cut")).toMatchObject({
      argsSchema: {
        type: "object",
        required: ["canvasSelectionPath", "outDir"],
        properties: {
          canvasSelectionPath: { type: "string" },
          outDir: { type: "string" },
          cutImportMode: { type: "string", enum: ["rendered_media"] }
        }
      },
      expectedReceipts: [
        { operation: "connector.canvas_to_cut", mode: "emits", required: true, artifactRoles: ["motion_package", "preview_frame", "preview_receipt", "rendered_media", "artifact_handle", "render_receipt", "cut_plan", "connector_receipt"] }
      ]
    });
    expect(debugContract("motion.connector.script_to_cut")).toMatchObject({
      argsSchema: {
        type: "object",
        required: ["outDir"],
        properties: {
          scriptPath: { type: "string" },
          script: { type: "object" },
          storyboard: { type: "object" },
          outDir: { type: "string" },
          cutImportMode: { type: "string", enum: ["rendered_media"] },
          startMs: { type: "number" },
          durationMs: { type: "number" },
          track: { type: "string" }
        },
        oneOf: expect.arrayContaining([
          expect.objectContaining({ required: ["scriptPath"] }),
          expect.objectContaining({ required: ["script"] }),
          expect.objectContaining({ required: ["storyboard"] })
        ])
      },
      expectedReceipts: [
        { operation: "connector.script_to_cut", mode: "emits", required: true, artifactRoles: ["motion_package", "preview_frame", "preview_receipt", "rendered_media", "artifact_handle", "render_receipt", "cut_plan", "connector_receipt"] }
      ]
    });
    expect(debugContract("motion.connector.source_to_cut")).toMatchObject({
      argsSchema: {
        type: "object",
        required: ["sourcePath", "outDir"],
        properties: {
          sourcePath: { type: "string" },
          outDir: { type: "string" },
          maxFrames: { type: "number" },
          frameDurationMs: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          fps: { type: "number" },
          cutImportMode: { type: "string", enum: ["rendered_media"] }
        }
      },
      expectedReceipts: [
        { operation: "connector.source_to_cut", mode: "emits", required: true, artifactRoles: ["scripted_video", "source_storyboard_receipt", "motion_package", "preview_frame", "preview_receipt", "rendered_media", "artifact_handle", "render_receipt", "cut_plan", "connector_receipt", "source_to_cut_receipt"] }
      ]
    });
    expect(debugContract("motion.connector.cut_generate_to_cut")).toMatchObject({
      argsSchema: {
        type: "object",
        required: ["outDir"],
        properties: {
          scriptPath: { type: "string" },
          script: { type: "object" },
          storyboard: { type: "object" },
          outDir: { type: "string" },
          cutImportMode: { type: "string" },
          dryRunRender: { type: "boolean" },
          createdAt: { type: "string" }
        },
        oneOf: expect.arrayContaining([
          expect.objectContaining({ required: ["scriptPath"] }),
          expect.objectContaining({ required: ["script"] }),
          expect.objectContaining({ required: ["storyboard"] })
        ])
      },
      expectedReceipts: [
        { operation: "connector.cut_generate_to_cut", mode: "emits", required: true, artifactRoles: ["motion_package", "preview_frame", "preview_receipt", "render_receipt", "cut_plan", "connector_receipt"] },
        { operation: "connector.cut_generate_to_cut", mode: "emits", required: false, artifactRoles: ["scripted_video", "rendered_media"] }
      ]
    });
    expect(debugContract("motion.connector.template_to_cut")).toMatchObject({
      argsSchema: {
        type: "object",
        required: ["packageRoot", "outDir", "values"],
        properties: {
          packageRoot: { type: "string" },
          outDir: { type: "string" },
          values: { type: "object" },
          cutImportMode: { type: "string", enum: ["rendered_media"] }
        }
      },
      expectedReceipts: [
        { operation: "connector.template_to_cut", mode: "emits", required: true, artifactRoles: ["motion_package", "template_apply_receipt", "preview_frame", "preview_receipt", "rendered_media", "artifact_handle", "render_receipt", "cut_plan", "connector_receipt"] }
      ]
    });
  });

  it("refuses unknown debug commands instead of returning fake success", async () => {
    const result = await dispatchDebugCommand("motion.future.unregistered" as any, {}, { tier: "read_motion" });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "unknown_command",
        message: "Unknown debug command: motion.future.unregistered."
      },
      warnings: []
    });
  });

  it("refuses mutating commands below permission tier", async () => {
    const result = await dispatchDebugCommand("motion.package.patch", { packageId: "pkg_lower" }, { tier: "read_motion" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("permission_denied");
    }
  });

  it("applies package patches with changed-path and hash receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-package-patch-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.package.patch",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          patch: [
            { op: "replace", path: "/layers/0/text", value: "Updated Title" },
            { op: "add", path: "/layers/0/keyframes/opacity", value: [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 500, value: 1 }
            ] }
          ],
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "package-patch.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0]).toMatchObject({
          text: "Updated Title",
          keyframes: {
            opacity: [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 500, value: 1 }
            ]
          }
        });
        expect(result.visibleState).toEqual({
          panel: "templateInspector",
          operation: "package.patch",
          packageId: "pkg_debug_timeline",
          packageDir: outDir,
          changedPaths: ["/layers/0/text", "/layers/0/keyframes/opacity"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          packageDir: outDir,
          manifestPath: join(outDir, "manifest.json"),
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/0/text", "/layers/0/keyframes/opacity"],
          validation: { ok: true },
          receipt
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "package.patch",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            changedPaths: ["/layers/0/text", "/layers/0/keyframes/opacity"],
            opCount: 2,
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("stamps a first-class actor onto the template.apply host receipt (BY WHO end to end)", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-template-apply-actor-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      // Drive template.apply the way the MCP transport does: an inferred actor rides in the context.
      const result = await dispatchDebugCommand(
        "motion.template.apply",
        {
          packageRoot: "../../fixtures/packages/editable-lower-third",
          outDir,
          receiptsRoot,
          values: { title: "Launch Day" }
        },
        {
          tier: "edit_motion",
          actor: {
            kind: "agent",
            label: "mcp client",
            transport: "mcp",
            clientInfo: "claude-code/1.0",
            sessionId: "srv-1:ws-2",
            grantedTier: "edit_motion"
          }
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        // The engine-room History reads the HOST receipt: it must answer who ran this and how.
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));
        expect(hostReceipt.actor).toEqual({
          kind: "agent",
          label: "mcp client",
          transport: "mcp",
          clientInfo: "claude-code/1.0",
          sessionId: "srv-1:ws-2",
          grantedTier: "edit_motion"
        });
        // The inline result.receipt carries identical attribution (same object, stamped in place).
        const inlineReceipt = (result.result as { receipt?: OperationReceipt }).receipt;
        expect(inlineReceipt?.actor).toEqual(hostReceipt.actor);
        // The persisted receipt still validates against the published receipt schema with the new field.
        expect(await validateDocument(await loadSchema("receipt"), hostReceipt)).toEqual({ ok: true });
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("lets an explicit createdBy claim win the label while still recording the observed transport", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-template-apply-precedence-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.template.apply",
        {
          packageRoot: "../../fixtures/packages/editable-lower-third",
          outDir,
          receiptsRoot,
          values: { title: "Launch Day" },
          createdBy: "release-bot"
        },
        {
          tier: "edit_motion",
          // The observed transport says "mcp client"; the caller CLAIMS "release-bot" via createdBy.
          actor: { kind: "agent", label: "mcp client", transport: "mcp", sessionId: "srv-9:ws-1", grantedTier: "edit_motion" }
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const hostReceipt = JSON.parse(await readFile(join(receiptsRoot, `${result.receiptId}.receipt.json`), "utf8"));
        // The caller's explicit claim wins the LABEL...
        expect(hostReceipt.actor.label).toBe("release-bot");
        // ...but the observed, non-spoofable transport facts are recorded alongside it regardless.
        expect(hostReceipt.actor.transport).toBe("mcp");
        expect(hostReceipt.actor.sessionId).toBe("srv-9:ws-1");
        expect(hostReceipt.actor.grantedTier).toBe("edit_motion");
        expect(hostReceipt.output.createdBy).toBe("release-bot");
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("leaves receipts unattributed when no transport actor was observed (backward compatible)", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-template-apply-legacy-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      // No actor in the context — the pre-existing direct-caller path. The receipt must stay unstamped.
      const result = await dispatchDebugCommand(
        "motion.template.apply",
        { packageRoot: "../../fixtures/packages/editable-lower-third", outDir, receiptsRoot, values: { title: "Launch Day" } },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const hostReceipt = JSON.parse(await readFile(join(receiptsRoot, `${result.receiptId}.receipt.json`), "utf8"));
        expect(hostReceipt.actor).toBeUndefined();
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rolls back package patch installation when host receipt persistence fails", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-package-patch-rollback-"));
    const outDir = join(tempRoot, "output");
    const blockedReceiptsRoot = join(tempRoot, "receipts-file");
    try {
      await mkdir(outDir);
      await writeFile(blockedReceiptsRoot, "not a directory", "utf8");
      const result = await dispatchDebugCommand(
        "motion.package.patch",
        {
          packageRoot,
          outDir,
          receiptsRoot: blockedReceiptsRoot,
          patch: [{ op: "replace", path: "/layers/0/text", value: "Must Roll Back" }]
        },
        { tier: "edit_motion" }
      );
      expect(result).toMatchObject({ ok: false, error: { code: "package_patch_failed" } });
      expect(await readdir(outDir)).toEqual([]);
      expect((await readdir(tempRoot)).filter((name) => name.includes("shellx-edit"))).toEqual([]);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects add and replace package patches without values", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-package-patch-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.package.patch",
        {
          packageRoot,
          outDir,
          patch: [{ op: "replace", path: "/layers/0/text" }]
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "invalid_args",
          message: "motion.package.patch requires patch operations."
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects package patch output paths that would overwrite the source package", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    try {
      const result = await dispatchDebugCommand(
        "motion.package.patch",
        {
          packageRoot,
          outDir: packageRoot,
          patch: [{ op: "replace", path: "/layers/0/text", value: "Unsafe" }]
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "invalid_args",
          message: "motion.package.patch outDir must be outside packageRoot."
        });
      }
      const sourceMotion = JSON.parse(await readFile(join(packageRoot, "motion.json"), "utf8"));
      expect(sourceMotion.layers[0].text).toBe("A");
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("rejects package patch output dirs that already contain files", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-package-patch-non-empty-"));
    const sentinelPath = join(outDir, "sentinel.txt");
    await writeFile(sentinelPath, "keep", "utf8");
    try {
      const result = await dispatchDebugCommand(
        "motion.package.patch",
        {
          packageRoot,
          outDir,
          patch: [{ op: "replace", path: "/layers/0/text", value: "Unsafe" }]
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "invalid_args",
          message: "motion.package.patch outDir must be empty or absent before package copy."
        });
      }
      await expect(readFile(sentinelPath, "utf8")).resolves.toBe("keep");
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it.each(["__proto__", "prototype", "constructor"])(
    "rejects package patch JSON pointers with prototype-polluting %s segments",
    async (unsafeSegment) => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-package-patch-prototype-"));
    const objectPrototype = Object.prototype as Record<string, unknown>;
    delete objectPrototype.motionPatchPolluted;
    try {
      const result = await dispatchDebugCommand(
        "motion.package.patch",
        {
          packageRoot,
          outDir,
          patch: [{ op: "add", path: `/${unsafeSegment}/motionPatchPolluted`, value: "polluted" }]
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "package_patch_failed",
          message: `Patch path contains unsafe segment: ${unsafeSegment}`
        });
      }
      expect(objectPrototype.motionPatchPolluted).toBeUndefined();
    } finally {
      delete objectPrototype.motionPatchPolluted;
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects out-of-bounds package patch array indices without installing output", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-package-patch-index-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.package.patch",
        {
          packageRoot,
          outDir,
          patch: [{ op: "replace", path: "/layers/999999/text", value: "Out of bounds" }]
        },
        { tier: "edit_motion" }
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: "package_patch_failed", message: "Patch array index is out of bounds: 999999" }
      });
      expect(await readdir(outDir)).toEqual([]);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("normalizes relative package patch output paths in responses", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outputParent = await mkdtemp(join(tmpdir(), "shellx-motion-debug-package-patch-relative-"));
    const outDir = join(outputParent, "output");
    const relativeOutDir = relative(process.cwd(), outDir);
    try {
      const result = await dispatchDebugCommand(
        "motion.package.patch",
        {
          packageRoot,
          outDir: relativeOutDir,
          patch: [{ op: "replace", path: "/layers/0/text", value: "Relative" }]
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toMatchObject({
          packageDir: outDir,
          receiptPath: join(outDir, "receipts", "package-patch.receipt.json")
        });
        expect(result.result).toMatchObject({
          packageDir: outDir,
          receiptPath: join(outDir, "receipts", "package-patch.receipt.json")
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outputParent, { recursive: true, force: true });
    }
  });

  itLinux("collects a redacted support bundle with diagnostics and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-support-bundle-"));
    const outDir = join(tempRoot, "bundle");
    const receiptsRoot = join(tempRoot, "input-receipts");
    const previousSecret = process.env.SHELLX_MOTION_TEST_SECRET;
    process.env.SHELLX_MOTION_TEST_SECRET = "do-not-leak-this-value";
    try {
      await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
      await writeFile(
        join(receiptsRoot, "render.receipt.json"),
        `${JSON.stringify(debugReceipt({
          id: "render-final-debug",
          operation: "render.final",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "ffmpeg",
          output: { path: "/tmp/final.mp4" }
        }), null, 2)}\n`,
        "utf8"
      );
      await writeFile(join(receiptsRoot, "linux.platform.json"), `${JSON.stringify(completedPlatformReceipt({ requiredHosts: ["linux", "windows", "macos"], complete: false }), null, 2)}\n`, "utf8");

      const result = await dispatchDebugCommand(
        "motion.support.bundle",
        { packageRoot, outDir, receiptsRoot },
        {
          tier: "write_local",
          scratchRoot: tempRoot,
          receiptsRoot,
          callerId: "test-operator",
          crossCallerJobScope: true
        }
      );

      expect(result.ok, `support bundle failed: ${JSON.stringify(result, null, 2)}`).toBe(true);
      if (result.ok) {
        const bundlePath = join(outDir, "support-bundle.json");
        const receiptPath = join(outDir, "support-bundle.receipt.json");
        const bundleText = await readFile(bundlePath, "utf8");
        const bundle = JSON.parse(bundleText);
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));

        expect(bundleText).not.toContain("do-not-leak-this-value");
        expect(bundleText).not.toContain(tempRoot);
        expect(bundleText).not.toContain("/tmp/final.mp4");
        expect(JSON.stringify(receipt)).not.toContain(tempRoot);
        expect(JSON.stringify(receipt)).not.toContain("/tmp/final.mp4");
        expect(bundle).toMatchObject({
          schema: "shellx-motion/support-bundle@1",
          package: {
            id: "pkg_debug_timeline",
            motionId: "motion_debug_timeline",
            layerCount: 1,
            timeline: { trackCount: 1, sceneCount: 1, markerCount: 2 }
          },
          receipts: {
            receiptCount: 1,
            receipts: [expect.objectContaining({ id: "render-final-debug", operation: "render.final", status: "passed" })]
          },
          platformVerification: {
            receiptCount: 1,
            receipts: [
              expect.objectContaining({
                schema: "shellx-motion/platform-verification@1",
                status: "passed",
                dryRun: false,
                commandCount: expect.any(Number),
                failedCommandCount: 0
              })
            ]
          },
          debug: {
            commands: expect.arrayContaining(["motion.support.bundle", "motion.package.patch"]),
            actions: expect.arrayContaining([
              expect.objectContaining({ id: "motion.support.bundle", permission: "write_local" })
            ])
          },
          redactions: {
            envValues: "omitted",
            hostPaths: "omitted",
            diagnosticPaths: "redacted"
          }
        });
        expect(result.receiptId).toMatch(/^support-bundle-pkg_debug_timeline-/);
        expect(result.visibleState).toEqual({
          panel: "receipts",
          operation: "support.bundle",
          packageId: "pkg_debug_timeline",
          bundlePath,
          receiptPath,
          receiptCount: 1,
          platformReceiptCount: 1
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          bundlePath,
          receiptPath,
          receipt
        });
        expect(receipt).toMatchObject({
          operation: "support.bundle",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            bundle: { file: "support-bundle.json" },
            receipt: { file: "support-bundle.receipt.json" },
            receiptCount: 1,
            platformReceiptCount: 1,
            debugCommandCount: expect.any(Number)
          },
          artifacts: expect.arrayContaining([
            expect.objectContaining({ role: "support_bundle", path: "support-bundle.json", status: "available", primary: true }),
            expect.objectContaining({ role: "support_receipt", path: "support-bundle.receipt.json", status: "available" })
          ])
        });
      }
    } finally {
      if (previousSecret === undefined) {
        delete process.env.SHELLX_MOTION_TEST_SECRET;
      } else {
        process.env.SHELLX_MOTION_TEST_SECRET = previousSecret;
      }
      await rm(packageRoot, { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes a review HTML bundle with copied artifact links through the debug API", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-review-html-bundle-"));
    const receiptsRoot = join(tempRoot, "input-receipts");
    const mediaPath = join(tempRoot, "rendered.mp4");
    const qualityManifestPath = join(tempRoot, "quality", "debug.quality-manifest.json");
    const outDir = join(tempRoot, "review");
    try {
      await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
      await writeFile(mediaPath, "fake media", "utf8");
      await writeFile(
        join(receiptsRoot, "render.receipt.json"),
        `${JSON.stringify(debugReceipt({
          id: "render-final-review-debug",
          operation: "render.final",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "ffmpeg",
          output: {
            path: mediaPath,
            width: 640,
            height: 360,
            durationMs: 1000,
            codec: "h264",
            container: "mp4",
            qualityManifestPath,
            qualityCheck: { status: "passed", receiptId: "quality-check-debug" }
          },
          artifacts: [
            { role: "rendered_media", path: mediaPath, status: "available", mediaType: "video/mp4", primary: true }
          ]
        }), null, 2)}\n`,
        "utf8"
      );

      const result = await dispatchDebugCommand(
        "motion.review.html.bundle",
        { packageRoot, outDir, receiptsRoot, title: "Debug Review" },
        // The media sits beside the receipt store rather than inside it, which is the normal batch
        // layout. A receipt can name any path, so the bundle writer copies only what resolves inside
        // a root the HOST approved -- otherwise a crafted receipt could pull any readable file into a
        // bundle someone then shares. The host approves the directory here; the shipped server passes
        // its own artifact roots, and the CLI takes --artifact-root.
        {
          tier: "write_local",
          artifactRoots: [tempRoot],
          callerId: "test-operator",
          crossCallerJobScope: true
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const htmlPath = join(outDir, "review-html-bundle.html");
        const receiptPath = join(outDir, "review-html-bundle.receipt.json");
        const html = await readFile(htmlPath, "utf8");
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));

        expect(result.receiptId).toMatch(/^review-html-bundle-pkg_debug_timeline-/);
        expect(result.visibleState).toEqual({
          panel: "receipts",
          operation: "review.html.bundle",
          packageId: "pkg_debug_timeline",
          htmlPath,
          receiptPath,
          receiptCount: 1,
          copiedArtifactCount: 1,
          // Surfaced even at zero: a bundle that silently dropped the renders it exists to show
          // would look complete and be useless, so the count travels with every result.
          omittedArtifactCount: 0,
          qualityGateCount: 1,
          failedQualityGateCount: 0
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          htmlPath,
          receiptPath,
          receiptCount: 1,
          copiedArtifactCount: 1,
          qualityGateCount: 1,
          failedQualityGateCount: 0
        });
        expect(html).toContain("Debug Review");
        expect(html).toContain("render.final");
        expect(html).toContain("debug.quality-manifest.json");
        expect(html).toContain("quality-check-debug");
        expect(html).toContain("artifacts/rendered_media-");
        expect(html).not.toContain(tempRoot);
        expect(receipt).toMatchObject({
          operation: "review.html.bundle",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "review",
          output: {
            htmlPath: "review-html-bundle.html",
            receiptPath: "review-html-bundle.receipt.json",
            receiptCount: 1,
            copiedArtifactCount: 1,
            qualityGateCount: 1,
            failedQualityGateCount: 0
          },
          artifacts: expect.arrayContaining([
            expect.objectContaining({ role: "review_html_bundle", path: "review-html-bundle.html", status: "available", primary: true }),
            expect.objectContaining({ role: "review_html_bundle_receipt", path: "review-html-bundle.receipt.json", status: "available" }),
            expect.objectContaining({ role: "review_artifact", status: "available", mediaType: "video/mp4" })
          ])
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("exports a standalone HTML snippet through the debug API", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-html-snippet-"));
    const outDir = join(outRoot, "export");
    try {
      const result = await dispatchDebugCommand(
        "motion.html.snippet.export",
        { packageRoot, outDir, createdAt: "2026-07-04T08:15:00.000Z" },
        { tier: "write_local", authoringInputRoots: [packageRoot], authoringOutputRoots: [outRoot] }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const htmlPath = join(outDir, "index.html");
        const receiptPath = join(outDir, "html-snippet-export.receipt.json");
        const html = await readFile(htmlPath, "utf8");
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));

        expect(result.visibleState).toEqual({
          panel: "receipts",
          operation: "html.snippet.export",
          packageId: "pkg_debug_timeline",
          htmlPath,
          receiptPath,
          exportedLayerCount: expect.any(Number),
          unsupportedFeatureCount: expect.any(Number)
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          htmlPath,
          receiptPath,
          artifacts: expect.arrayContaining([
            expect.objectContaining({ role: "html_snippet", path: htmlPath, status: "available", primary: true }),
            expect.objectContaining({ role: "html_snippet_receipt", path: receiptPath, status: "available" })
          ])
        });
        expect(html).toContain('data-shellx-motion-schema="shellx-motion/html-snippet@1"');
        expect(html).not.toContain(packageRoot);
        expect(receipt).toMatchObject({
          operation: "html.snippet.export",
          packageId: "pkg_debug_timeline",
          output: {
            htmlPath,
            htmlSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
          }
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outRoot, { recursive: true, force: true });
    }
  });

  it("imports HTML snippets through the debug API", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-html-snippet-import-"));
    const htmlPath = join(tempRoot, "incoming.html");
    const packageDir = join(tempRoot, "package");
    try {
      await writeFile(htmlPath, htmlSnippetImportFixture(), "utf8");

      const result = await dispatchDebugCommand(
        "motion.html.snippet.import",
        { htmlPath, packageDir, createdAt: "2026-07-04T08:33:00.000Z" },
        {
          tier: "write_local",
          authoringInputRoots: [tempRoot],
          authoringOutputRoots: [tempRoot],
          actor: { kind: "agent", label: "Debug compile test", transport: "mcp", sessionId: "script-compile-test", grantedTier: "write_local" }
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toEqual({
          panel: "receipts",
          operation: "html.snippet.import",
          packageId: "pkg_html_debug",
          packageRoot: packageDir,
          motionPath: join(packageDir, "motion.json"),
          receiptPath: join(packageDir, "receipts", "html-snippet-import.receipt.json"),
          layerCount: 1,
          warningCount: 0,
          stagedAssetCount: 0
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_html_debug",
          packageDir,
          manifestPath: join(packageDir, "manifest.json"),
          motionPath: join(packageDir, "motion.json"),
          receiptPath: join(packageDir, "receipts", "html-snippet-import.receipt.json")
        });
        const motion = JSON.parse(await readFile(join(packageDir, "motion.json"), "utf8"));
        expect(motion.layers[0]).toMatchObject({ id: "headline", type: "text", text: "Debug HTML" });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("matches renderer capability cards through the debug API", async () => {
    const result = await dispatchDebugCommand(
      "motion.capabilities.match",
      {
        packageRoot: resolve("../../fixtures/packages/web-card"),
        output: "png-frame",
        target: "preview",
        needsAlpha: true
      },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visibleState).toMatchObject({
        panel: "capabilities",
        packageId: "pkg_web_card",
        recommendedLane: "browser",
        output: "png-frame",
        target: "preview"
      });
      expect(result.result).toMatchObject({
        ok: true,
        hostCapacity: {
          schema: "shellx-motion/host-render-capacity@1",
          points: { portablePointsPerLayer: 8_192, maxPointsPerLayer: expect.any(Number) }
        },
        resourceFit: true, pointCapacity: { schema: "shellx-motion/point-capacity@1", status: "fit" },
        recommendedLane: "browser",
        cards: expect.arrayContaining([
          expect.objectContaining({
            id: "renderer.browser",
            lane: "browser",
            outputs: expect.arrayContaining(["png-frame"]),
            alpha: true,
            colorAlpha: browserColorAlphaContract()
          })
        ]),
        matches: expect.arrayContaining([
          expect.objectContaining({ lane: "browser", ok: true, outputOk: true, alphaOk: true }),
          expect.objectContaining({ lane: "native", ok: false })
        ])
      });
    }
  });

  it("explains browser-to-ffmpeg pipelines for final render capability matches", async () => {
    const result = await dispatchDebugCommand(
      "motion.capabilities.match",
      {
        packageRoot: resolve("../../fixtures/packages/lower-third"),
        output: "mp4-h264",
        target: "final",
        needsAudio: true
      },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visibleState).toMatchObject({
        panel: "capabilities",
        operation: "capabilities.match",
        packageId: "pkg_lower_third",
        recommendedLane: "ffmpeg",
        recommendedPipeline: ["browser", "ffmpeg"],
        output: "mp4-h264",
        target: "final"
      });
      expect(result.result).toMatchObject({
        ok: true,
        recommendedLane: "ffmpeg",
        recommendedPipeline: {
          lanes: ["browser", "ffmpeg"],
          frameLane: "browser",
          finalLane: "ffmpeg",
          reason: "Lane ffmpeg requires browser frame capture before final encode."
        },
        matches: expect.arrayContaining([
          expect.objectContaining({ lane: "ffmpeg", ok: true, outputOk: true, targetOk: true, audioOk: true }),
          expect.objectContaining({ lane: "browser", ok: false, audioOk: false })
        ])
      });
    }
  });

  it("summarizes renderer lane capability cards into a panel-ready debug surface", async () => {
    const packageRoot = resolve("../../fixtures/packages/web-card");
    const result = await dispatchDebugCommand(
      "motion.capabilities.panel",
      {
        packageRoot,
        output: "png-frame",
        target: "preview",
        needsAlpha: true
      },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visibleState).toEqual({
        panel: "capabilities",
        operation: "capabilities.panel",
        cardCount: 8,
        categoryCount: 4,
        laneCount: 8,
        packageId: "pkg_web_card",
        recommendedLane: "browser",
        output: "png-frame",
        target: "preview"
      });
      expect(result.result).toMatchObject({
        ok: true,
        packageRoot,
        packageId: "pkg_web_card",
        motionId: "motion_web_card",
        request: {
          output: "png-frame",
          target: "preview",
          needsAlpha: true,
          needsAudio: false,
          needsSubtitles: false
        },
        summary: {
          cardCount: 8,
          laneCount: 8,
          categoryCount: 4,
          supportedCount: 1,
          recommendedLane: "browser"
        },
        categories: expect.arrayContaining([
          { id: "preview", label: "Preview", cardCount: 3, supportedCount: 1, lanes: ["native", "browser", "gpu"] },
          { id: "final", label: "Final", cardCount: 1, supportedCount: 0, lanes: ["ffmpeg"] },
          { id: "connector", label: "Connector", cardCount: 1, supportedCount: 0, lanes: ["connector"] },
          { id: "adapter", label: "Adapter", cardCount: 3, supportedCount: 0, lanes: ["svg-adapter", "lottie-adapter", "rive-adapter"] }
        ]),
        cards: expect.arrayContaining([
          expect.objectContaining({
            id: "renderer.browser",
            lane: "browser",
            category: "preview",
            label: "Deterministic Browser Capture",
            supported: true,
            recommended: true,
            badges: expect.arrayContaining(["alpha", "subtitles", "stable", "medium"]),
            support: { alpha: true, audio: "none", subtitles: true },
            runtime: {
              // The browser is NOT bundled. Its readiness must be resolved by Motion, not by a
              // host running a raw Chromium command that may name a different executable.
              availability: "external-binary",
              requirement: "Chrome or Chromium browser binary (not shipped; see doctor)",
              cost: "local-cpu",
              readiness: { command: "motion.platform.requirements", tools: ["chromium"] },
              setupHint: "Install a Chrome/Chromium browser, or set SHELLX_MOTION_BROWSER to one. Run `doctor` for what this machine is missing."
            },
            outputs: expect.arrayContaining(["png-frame", "jpeg-frame", "png-sequence"]),
            renderTargets: expect.arrayContaining(["preview", "frame-sequence", "deterministic-capture"]),
            colorAlpha: browserColorAlphaContract(),
            suggestedActions: expect.arrayContaining([
              { id: "match", command: "motion.capabilities.match", args: { packageRoot, output: "png-frame", target: "preview", needsAlpha: true } },
              { id: "exportPlan", command: "motion.export.plan", args: { packageRoot, preset: "png-frame", target: "preview", needsAlpha: true } }
            ])
          }),
          expect.objectContaining({
            id: "renderer.native",
            lane: "native",
            supported: false,
            unsupportedCount: 1,
            reasons: expect.arrayContaining(["Lane native does not support web layers."])
          }),
          expect.objectContaining({ id: "renderer.gpu", lane: "gpu", supported: false, unsupportedCount: 1, reasons: expect.arrayContaining(["Lane gpu supports web, html, canvas, and restricted-shader hybrid layers only for governed final video rendering."]) }),
          expect.objectContaining({
            id: "adapter.svg",
            lane: "svg-adapter",
            category: "adapter",
            adapter: {
              formats: ["svg"],
              unsupportedFeatureClasses: expect.arrayContaining(["filters", "masks", "scripts"]),
              expectedLossiness: expect.stringContaining("medium-to-high"),
              previewLaneRequirement: "browser",
              finalLaneRequirement: "ffmpeg",
              hostCompatibility: expect.arrayContaining(["ShellX Motion", "ShellX Cut via rendered media"])
            }
          })
        ]),
        matches: expect.arrayContaining([
          expect.objectContaining({ lane: "browser", ok: true, outputOk: true, alphaOk: true }),
          expect.objectContaining({ lane: "native", ok: false })
        ])
      });
      expect(result.warnings).toEqual([]);
    }
  });

  it("summarizes final-render capability pipelines in the panel surface", async () => {
    const packageRoot = resolve("../../fixtures/packages/lower-third");
    const result = await dispatchDebugCommand(
      "motion.capabilities.panel",
      {
        packageRoot,
        output: "mp4-h264",
        target: "final",
        needsAudio: true
      },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visibleState).toMatchObject({
        panel: "capabilities",
        operation: "capabilities.panel",
        packageId: "pkg_lower_third",
        recommendedLane: "ffmpeg",
        recommendedPipeline: ["browser", "ffmpeg"],
        output: "mp4-h264",
        target: "final"
      });
      expect(result.result).toMatchObject({
        ok: true,
        summary: {
          recommendedLane: "ffmpeg",
          recommendedPipeline: {
            lanes: ["browser", "ffmpeg"],
            frameLane: "browser",
            finalLane: "ffmpeg"
          }
        },
        cards: expect.arrayContaining([
          expect.objectContaining({
            lane: "ffmpeg",
            supported: true,
            recommended: true,
            requiresFrameLane: true,
            runtime: {
              availability: "external-binary",
              requirement: "FFmpeg and FFprobe binaries",
              cost: "local-cpu",
              readiness: { command: "motion.platform.requirements", tools: ["ffmpeg", "ffprobe"] },
              setupHint: "Install FFmpeg with FFprobe available on PATH before final media renders."
            }
          })
        ])
      });
    }
  });

  it("summarizes renderer capability panels without package fit when no package is provided", async () => {
    const result = await dispatchDebugCommand(
      "motion.capabilities.panel",
      {
        output: "png-frame",
        target: "preview",
        needsAlpha: true
      },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visibleState).toEqual({
        panel: "capabilities",
        operation: "capabilities.panel",
        cardCount: 8,
        categoryCount: 4,
        laneCount: 8,
        recommendedLane: "native",
        output: "png-frame",
        target: "preview"
      });
      expect(result.result).toMatchObject({
        ok: true,
        summary: {
          cardCount: 8,
          laneCount: 8,
          categoryCount: 4,
          supportedCount: 3,
          recommendedLane: "native"
        },
        categories: expect.arrayContaining([
          { id: "preview", label: "Preview", cardCount: 3, supportedCount: 3, lanes: ["native", "browser", "gpu"] },
          { id: "final", label: "Final", cardCount: 1, supportedCount: 0, lanes: ["ffmpeg"] },
          { id: "connector", label: "Connector", cardCount: 1, supportedCount: 0, lanes: ["connector"] },
          { id: "adapter", label: "Adapter", cardCount: 3, supportedCount: 0, lanes: ["svg-adapter", "lottie-adapter", "rive-adapter"] }
        ]),
        cards: expect.arrayContaining([
          expect.objectContaining({
            lane: "native",
            supported: true,
            recommended: true,
            unsupportedCount: 0,
            outputOk: true,
            targetOk: true,
            runtime: expect.objectContaining({
              availability: "bundled",
              requirement: "ShellX native raster renderer"
            })
          }),
          expect.objectContaining({
            lane: "browser",
            supported: true,
            recommended: false,
            unsupportedCount: 0,
            outputOk: true,
            targetOk: true
          }),
          expect.objectContaining({
            lane: "ffmpeg",
            supported: false,
            outputOk: true,
            targetOk: false,
            reasons: expect.arrayContaining(["Lane ffmpeg is not intended for preview targets."])
          })
        ]),
        matches: expect.arrayContaining([
          expect.objectContaining({ lane: "native", ok: true, unsupported: [] }),
          expect.objectContaining({ lane: "browser", ok: true, unsupported: [] }),
          expect.objectContaining({ lane: "ffmpeg", ok: false, targetOk: false })
        ])
      });
      expect(result.warnings).toEqual([]);
    }
  });

  it("imports safe prompt source links through the debug API with receipt evidence", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-source-import-"));
    const outDir = join(tempRoot, "source");
    try {
      const result = await dispatchDebugCommand(
        "motion.source.import",
        {
          url: "https://example.com/articles/motion",
          outDir,
          title: "Motion Notes",
          kind: "article",
          markdown: "Alpha\n\nBeta",
          maxChars: 100,
          createdBy: "debug-test"
        },
        { tier: "write_local", authoringOutputRoots: [tempRoot] }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toEqual({
          panel: "receipts",
          operation: "source.import",
          url: "https://example.com/articles/motion",
          kind: "article",
          markdownPath: join(outDir, "source.md"),
          receiptPath: join(outDir, "receipts", "source-import.receipt.json"),
          truncated: false
        });
        expect(result.result).toMatchObject({
          ok: true,
          url: "https://example.com/articles/motion",
          kind: "article",
          markdownPath: join(outDir, "source.md"),
          receiptPath: join(outDir, "receipts", "source-import.receipt.json"),
          artifacts: expect.arrayContaining([
            expect.objectContaining({ role: "source_markdown", path: join(outDir, "source.md"), status: "available", primary: true }),
            expect.objectContaining({ role: "source_import_receipt", path: join(outDir, "receipts", "source-import.receipt.json"), status: "available" })
          ])
        });
        await expect(readFile(join(outDir, "source.md"), "utf8")).resolves.toContain("# Motion Notes");
        const receipt = JSON.parse(await readFile(join(outDir, "receipts", "source-import.receipt.json"), "utf8")) as OperationReceipt;
        expect(receipt).toMatchObject({
          operation: "source.import",
          status: "passed",
          lane: "debug-api",
          output: {
            url: "https://example.com/articles/motion",
            kind: "article",
            markdownPath: join(outDir, "source.md"),
            truncated: false,
            safeFetchPolicy: "public-http-only"
          }
        });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("imports GitHub repository links as repo markdown through the public API", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-source-import-repo-"));
    const outDir = join(tempRoot, "source");
    const requestedUrls: string[] = [];
    const sourceFetcher = async (url: string, init: { resolvedAddress: { address: string; family: 4 | 6 } }) => {
      requestedUrls.push(url);
      expect(init.resolvedAddress).toEqual({ address: "93.184.216.34", family: 4 });
      if (url === "https://api.github.com/repos/nexu-io/html-video") {
        return new Response(JSON.stringify({
          full_name: "nexu-io/html-video",
          description: "HTML becomes video on your laptop",
          language: "TypeScript",
          stargazers_count: 42,
          topics: ["video", "agents"],
          license: { spdx_id: "Apache-2.0" },
          homepage: "https://open-design.ai"
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url === "https://api.github.com/repos/nexu-io/html-video/readme") {
        return new Response("HTML becomes video.\n\nUse local agents and MP4 export.", {
          status: 200,
          headers: { "content-type": "text/markdown" }
        });
      }
      if (url === "https://api.github.com/repos/nexu-io/html-video/contents") {
        return new Response(JSON.stringify([
          { name: "packages", type: "dir" },
          { name: "README.md", type: "file" }
        ]), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("unexpected fetch", { status: 404, statusText: "Not Found" });
    };
    try {
      const result = await dispatchDebugCommand(
        "motion.source.import",
        {
          url: "https://github.com/nexu-io/html-video",
          outDir,
          maxChars: 4000,
          createdBy: "debug-test"
        },
        {
          tier: "write_local",
          sourceFetcher,
          sourceResolver: async () => [{ address: "93.184.216.34", family: 4 }],
          authoringOutputRoots: [tempRoot]
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toMatchObject({
          operation: "source.import",
          url: "https://github.com/nexu-io/html-video",
          kind: "repo",
          truncated: false
        });
        expect(result.result).toMatchObject({
          ok: true,
          title: "nexu-io/html-video",
          kind: "repo",
          markdownPath: join(outDir, "source.md"),
          receipt: expect.objectContaining({
            output: expect.objectContaining({
              title: "nexu-io/html-video",
              kind: "repo",
              safeFetchPolicy: "public-http-only"
            })
          })
        });
        const markdown = await readFile(join(outDir, "source.md"), "utf8");
        expect(markdown).toContain("# nexu-io/html-video");
        expect(markdown).toContain("Kind: repo");
        expect(markdown).toContain("> HTML becomes video on your laptop");
        expect(markdown).toContain("- Language: TypeScript");
        expect(markdown).toContain("- License: Apache-2.0");
        expect(markdown).toContain("## Top-level structure");
        expect(markdown).toContain("- packages/");
        expect(markdown).toContain("## README");
        expect(markdown).toContain("Use local agents and MP4 export.");
        expect(requestedUrls).toEqual([
          "https://api.github.com/repos/nexu-io/html-video",
          "https://api.github.com/repos/nexu-io/html-video/readme",
          "https://api.github.com/repos/nexu-io/html-video/contents"
        ]);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("plans imported source Markdown into scripted-video JSON through the debug API", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-source-storyboard-"));
    const sourcePath = join(tempRoot, "source.md");
    const outDir = join(tempRoot, "storyboard");
    try {
      await writeFile(sourcePath, [
        "# Motion Launch Notes",
        "",
        "Source: https://example.com/articles/motion",
        "Kind: article",
        "",
        "## Problem",
        "Teams need deterministic video exports from promptable source material.",
        "",
        "## Cut handoff",
        "Scripted-video JSON can go directly to Cut without Canvas."
      ].join("\n"), "utf8");

      const result = await dispatchDebugCommand(
        "motion.source.to_scripted_video",
        {
          sourcePath,
          outDir,
          maxFrames: 2,
          frameDurationMs: 2200,
          width: 1280,
          height: 720,
          fps: 30,
          createdBy: "debug-test"
        },
        { tier: "write_local", authoringInputRoots: [tempRoot], authoringOutputRoots: [tempRoot] }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const scriptPath = join(outDir, "scripted-video.json");
        const receiptPath = join(outDir, "receipts", "source-storyboard.receipt.json");
        expect(result.visibleState).toEqual({
          panel: "receipts",
          operation: "source.to_scripted_video",
          sourcePath,
          scriptPath,
          receiptPath,
          frameCount: 2,
          reviewRequired: true
        });
        expect(result.result).toMatchObject({
          ok: true,
          scriptPath,
          receiptPath,
          frameCount: 2,
          artifacts: expect.arrayContaining([
            expect.objectContaining({ role: "scripted_video", path: scriptPath, status: "available", primary: true }),
            expect.objectContaining({ role: "source_storyboard_receipt", path: receiptPath, status: "available" })
          ])
        });
        const scripted = JSON.parse(await readFile(scriptPath, "utf8"));
        expect(scripted).toMatchObject({
          schema: "shellx-motion/scripted-video@1",
          name: "Motion Launch Notes",
          review: { status: "needs-review", required: true },
          frames: [
            expect.objectContaining({ title: "Problem", caption: "Source: example.com" }),
            expect.objectContaining({ title: "Cut handoff" })
          ]
        });
        expect(await validateDocument(await loadSchema("scriptedVideo"), scripted)).toEqual({ ok: true });
        const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as OperationReceipt;
        expect(receipt).toMatchObject({
          operation: "source.to_scripted_video",
          status: "passed",
          lane: "debug-api",
          output: {
            sourcePath,
            scriptPath,
            frameCount: 2,
            reviewRequired: true,
            sourceUrl: "https://example.com/articles/motion"
          }
        });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reviews scripted-video storyboard metadata through a read-only debug panel", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-storyboard-panel-"));
    const scriptPath = join(tempRoot, "scripted-video.json");
    try {
      await writeFile(scriptPath, `${JSON.stringify(storyboardPanelScriptedVideo(), null, 2)}\n`, "utf8");

      const result = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(tempRoot), async () =>
        await dispatchDebugCommand(
          "motion.storyboard.panel",
          { scriptPath },
          { tier: "read_motion", authoringInputRoots: [tempRoot] }
        )
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^storyboard-panel-source-storyboard-demo-/);
        expect(result.visibleState).toEqual({
          panel: "storyboard",
          operation: "storyboard.panel",
          scriptId: "source-storyboard-demo",
          name: "Source Storyboard Demo",
          workflow: "source-to-scripted-video",
          frameCount: 2,
          totalDurationMs: 4200,
          sourceRefCount: 2,
          assetRefCount: 1,
          reviewRequired: true,
          readinessStatus: "needs-review",
          diagnosticCount: 1,
          warningCount: 1
        });
        expect(result.result).toMatchObject({
          ok: true,
          scriptPath,
          scriptId: "source-storyboard-demo",
          name: "Source Storyboard Demo",
          sourceApp: "shellx-motion",
          workflow: "source-to-scripted-video",
          intent: "source_to_storyboard",
          synopsis: "Review source-backed launch notes before compile.",
          review: { status: "needs-review", required: true },
          dimensions: { width: 1280, height: 720, fps: 30 },
          counts: {
            frames: 2,
            sourceRefs: 2,
            assetRefs: 1,
            templateHints: 1,
            engineHints: 1,
            needsReviewFrames: 1
          },
          frames: [
            {
              index: 0,
              id: "problem",
              title: "Problem",
              startMs: 0,
              endMs: 2000,
              durationMs: 2000,
              bodyPreview: "Teams need deterministic video exports.",
              caption: "Source: example.com",
              sourceRefCount: 1,
              sourceRefs: [
                { frameId: "problem", type: "article", title: "Launch notes", url: "https://example.com/articles/motion#problem" }
              ],
              assetRefCount: 1,
              templateId: "lower-third-source",
              engineId: "native-text",
              reviewStatus: "needs-review",
              reviewNote: "Check source claim wording before compile.",
              tags: ["problem"]
            },
            {
              index: 1,
              id: "handoff",
              title: "Cut handoff",
              startMs: 2000,
              endMs: 4200,
              durationMs: 2200,
              sourceRefCount: 1,
              assetRefCount: 0
            }
          ],
          sourceRefs: [
            { frameId: "problem", type: "article", title: "Launch notes", url: "https://example.com/articles/motion#problem" },
            { frameId: "handoff", type: "article", title: "Launch notes", url: "https://example.com/articles/motion#handoff" }
          ],
          suggestedActions: [
            { id: "compile", command: "motion.script.compile", args: { scriptPath } },
            { id: "send-to-cut", command: "motion.connector.script_to_cut", args: { scriptPath } }
          ]
        });
        expect(result.warnings).toEqual(["Storyboard review is required before compile or Cut handoff."]);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("builds a scripted-video source graph through a read-only debug command", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-storyboard-graph-"));
    const scriptPath = join(tempRoot, "scripted-video.json");
    try {
      await writeFile(scriptPath, `${JSON.stringify(storyboardPanelScriptedVideo(), null, 2)}\n`, "utf8");

      const result = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(tempRoot), async () =>
        await dispatchDebugCommand(
          "motion.storyboard.graph",
          { scriptPath },
          { tier: "read_motion", authoringInputRoots: [tempRoot] }
        )
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^storyboard-graph-source-storyboard-demo-/);
        expect(result.visibleState).toEqual({
          panel: "storyboard",
          operation: "storyboard.graph",
          scriptId: "source-storyboard-demo",
          name: "Source Storyboard Demo",
          workflow: "source-to-scripted-video",
          nodeCount: 9,
          edgeCount: 9,
          frameCount: 2,
          sourceRefCount: 2,
          readinessStatus: "needs-review",
          diagnosticCount: 1,
          warningCount: 1
        });
        expect(result.result).toMatchObject({
          ok: true,
          scriptPath,
          scriptId: "source-storyboard-demo",
          name: "Source Storyboard Demo",
          workflow: "source-to-scripted-video",
          counts: {
            nodes: 9,
            edges: 9,
            frames: 2,
            sourceRefs: 2,
            assetRefs: 1,
            templateHints: 1,
            engineHints: 1,
            reviewNodes: 1
          },
          nodes: expect.arrayContaining([
            expect.objectContaining({ id: "storyboard:source-storyboard-demo", type: "storyboard", label: "Source Storyboard Demo" }),
            expect.objectContaining({ id: "frame:problem", type: "frame", label: "Problem", frameId: "problem", startMs: 0, durationMs: 2000 }),
            expect.objectContaining({ id: "source:problem:0", type: "source", label: "Launch notes", frameId: "problem", url: "https://example.com/articles/motion#problem" }),
            expect.objectContaining({ id: "asset:assets-problem-png", type: "asset", label: "assets/problem.png", frameId: "problem" }),
            expect.objectContaining({ id: "template:lower-third-source", type: "template", label: "lower-third-source", frameId: "problem" }),
            expect.objectContaining({ id: "engine:native-text", type: "engine", label: "native-text", frameId: "problem" }),
            expect.objectContaining({ id: "review:source-storyboard-demo", type: "review", label: "Storyboard Review", status: "needs-review" })
          ]),
          edges: expect.arrayContaining([
            expect.objectContaining({ id: "contains:source-storyboard-demo:problem", type: "contains_frame", from: "storyboard:source-storyboard-demo", to: "frame:problem" }),
            expect.objectContaining({ id: "sequence:problem:handoff", type: "sequence", from: "frame:problem", to: "frame:handoff" }),
            expect.objectContaining({ id: "references:problem:0", type: "references", from: "frame:problem", to: "source:problem:0" }),
            expect.objectContaining({ id: "uses-asset:problem:assets-problem-png", type: "uses_asset", from: "frame:problem", to: "asset:assets-problem-png" }),
            expect.objectContaining({ id: "uses-template:problem:lower-third-source", type: "uses_template", from: "frame:problem", to: "template:lower-third-source" }),
            expect.objectContaining({ id: "uses-engine:problem:native-text", type: "uses_engine", from: "frame:problem", to: "engine:native-text" }),
            expect.objectContaining({ id: "needs-review:source-storyboard-demo", type: "needs_review", from: "storyboard:source-storyboard-demo", to: "review:source-storyboard-demo" })
          ]),
          suggestedActions: [
            { id: "review", command: "motion.storyboard.panel", args: { scriptPath } },
            { id: "compile", command: "motion.script.compile", args: { scriptPath } },
            { id: "send-to-cut", command: "motion.connector.script_to_cut", args: { scriptPath } }
          ]
        });
        expect(result.warnings).toEqual(["Storyboard review is required before compile or Cut handoff."]);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports storyboard readiness diagnostics before compile or Cut handoff", async () => {
    const script = storyboardReadinessIssueScriptedVideo();

    const panelResult = await dispatchDebugCommand(
      "motion.storyboard.panel",
      { script },
      { tier: "read_motion" }
    );
    const graphResult = await dispatchDebugCommand(
      "motion.storyboard.graph",
      { script },
      { tier: "read_motion" }
    );

    expect(panelResult.ok).toBe(true);
    expect(graphResult.ok).toBe(true);
    if (panelResult.ok && graphResult.ok) {
      const panelPayload = debugTestRecord(panelResult.result);
      expect(panelResult.visibleState).toMatchObject({
        panel: "storyboard",
        operation: "storyboard.panel",
        scriptId: "source-readiness-issues",
        readinessStatus: "needs-review",
        diagnosticCount: 3
      });
      expect(panelResult.result).toMatchObject({
        ok: true,
        scriptId: "source-readiness-issues",
        readiness: {
          status: "needs-review",
          canCompile: false,
          canSendToCut: false,
          reviewRequired: true,
          counts: { errors: 0, warnings: 3, infos: 0 },
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ severity: "warning", code: "review-required" }),
            expect.objectContaining({ severity: "warning", code: "missing-template-hint", frameId: "intro" }),
            expect.objectContaining({ severity: "warning", code: "missing-engine-hint", frameId: "intro" })
          ])
        }
      });
      expect(panelResult.warnings).toEqual(expect.arrayContaining([
        "Storyboard readiness requires review: review-required, missing-template-hint, missing-engine-hint."
      ]));

      expect(graphResult.visibleState).toMatchObject({
        panel: "storyboard",
        operation: "storyboard.graph",
        scriptId: "source-readiness-issues",
        readinessStatus: "needs-review",
        diagnosticCount: 3
      });
      expect(graphResult.result).toMatchObject({
        ok: true,
        scriptId: "source-readiness-issues",
        readiness: panelPayload.readiness
      });
    }
  });

  it("keeps storyboard graph node and edge ids unique when normalized tokens collide", async () => {
    const script = storyboardGraphCollisionScriptedVideo();

    const result = await dispatchDebugCommand(
      "motion.storyboard.graph",
      { script },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const graph = debugTestRecord(result.result);
      const nodes = debugTestRecordArray(graph.nodes);
      const edges = debugTestRecordArray(graph.edges);
      const nodeIds = nodes.map((node) => debugTestString(node.id));
      const edgeIds = edges.map((edge) => debugTestString(edge.id));

      expect(new Set(nodeIds).size).toBe(nodeIds.length);
      expect(new Set(edgeIds).size).toBe(edgeIds.length);
      expect(nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "frame", label: "First", frameId: "first" }),
        expect.objectContaining({ type: "frame", label: "Second", frameId: "second" }),
        expect.objectContaining({ type: "asset", label: "assets/foo_bar.png", ref: "assets/foo_bar.png" }),
        expect.objectContaining({ type: "asset", label: "assets/foo-bar.png", ref: "assets/foo-bar.png" }),
        expect.objectContaining({ type: "template", label: "tpl_hero" }),
        expect.objectContaining({ type: "template", label: "tpl-hero" }),
        expect.objectContaining({ type: "engine", label: "engine_html" }),
        expect.objectContaining({ type: "engine", label: "engine-html" })
      ]));
      expect(edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "sequence" }),
        expect.objectContaining({ type: "uses_asset" }),
        expect.objectContaining({ type: "uses_template" }),
        expect.objectContaining({ type: "uses_engine" })
      ]));
    }
  });

  it("rejects private source import URLs before writing artifacts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-source-import-private-"));
    const outDir = join(tempRoot, "source");
    try {
      const result = await dispatchDebugCommand(
        "motion.source.import",
        { url: "http://127.0.0.1:3000/private", outDir, markdown: "private" },
        { tier: "write_local", authoringOutputRoots: [tempRoot] }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "refusing to fetch private IP: 127.0.0.1"
        }
      });
      await expect(readFile(join(outDir, "source.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("exports OTIO timelines through the debug API", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-otio-export-"));
    const outPath = join(tempRoot, "timeline.otio");
    try {
      const result = await dispatchDebugCommand(
        "motion.otio.export",
        { packageRoot, outPath, createdAt: "2026-07-04T10:00:00.000Z" },
        { tier: "write_local", authoringInputRoots: [packageRoot], authoringOutputRoots: [tempRoot] }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toEqual({
          panel: "receipts",
          operation: "otio.export",
          packageId: "pkg_debug_timeline",
          otioPath: outPath,
          receiptPath: `${outPath}.receipt.json`,
          trackCount: 1,
          clipCount: 1,
          gapCount: 0,
          warningCount: 0
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          otioPath: outPath,
          receiptPath: `${outPath}.receipt.json`,
          artifacts: expect.arrayContaining([
            expect.objectContaining({ role: "otio_timeline", path: outPath, status: "available", primary: true }),
            expect.objectContaining({ role: "otio_export_receipt", path: `${outPath}.receipt.json`, status: "available" })
          ])
        });
        await expect(readFile(outPath, "utf8")).resolves.toContain('"OTIO_SCHEMA": "Timeline.1"');
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("imports OTIO timelines through the debug API", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-otio-import-"));
    const otioPath = join(tempRoot, "incoming.otio");
    const packageDir = join(tempRoot, "package");
    try {
      await writeFile(otioPath, `${JSON.stringify(debugOtioTimelineFixture(), null, 2)}\n`, "utf8");

      const result = await dispatchDebugCommand(
        "motion.otio.import",
        { otioPath, packageDir, createdAt: "2026-07-04T10:01:00.000Z" },
        { tier: "write_local", authoringInputRoots: [tempRoot], authoringOutputRoots: [tempRoot] }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toEqual({
          panel: "receipts",
          operation: "otio.import",
          packageId: "pkg_otio_debug_otio",
          packageRoot: packageDir,
          motionPath: join(packageDir, "motion.json"),
          receiptPath: join(packageDir, "receipts", "otio-import.receipt.json"),
          layerCount: 1,
          warningCount: 0
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_otio_debug_otio",
          packageDir,
          manifestPath: join(packageDir, "manifest.json"),
          motionPath: join(packageDir, "motion.json"),
          receiptPath: join(packageDir, "receipts", "otio-import.receipt.json")
        });
        const motion = JSON.parse(await readFile(join(packageDir, "motion.json"), "utf8"));
        expect(motion.layers[0]).toMatchObject({ id: "clip_01", type: "video", source: "media/clip01.mp4" });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes a portable package archive with receipt evidence through the debug API", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-package-archive-"));
    const archivePath = join(tempRoot, "debug-timeline.shellxmotion");
    try {
      const result = await dispatchDebugCommand(
        "motion.package.archive",
        { packageRoot, archivePath },
        { tier: "write_local" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const receiptPath = `${archivePath}.receipt.json`;
        const archive = await readFile(archivePath);
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));

        expect(archive.byteLength).toBeGreaterThan(1024);
        expect(result.receiptId).toMatch(/^package-archive-pkg_debug_timeline-/);
        expect(result.visibleState).toEqual({
          panel: "receipts",
          operation: "package.archive",
          packageId: "pkg_debug_timeline",
          archivePath,
          receiptPath,
          fileCount: 2
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          archivePath,
          receiptPath,
          archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          fileCount: 2
        });
        expect(receipt).toMatchObject({
          operation: "package.archive",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "package",
          output: {
            archivePath,
            receiptPath,
            archiveFormat: "tar",
            packageExtension: ".shellxmotion",
            fileCount: 2
          },
          artifacts: expect.arrayContaining([
            expect.objectContaining({ role: "motion_package_archive", path: archivePath, status: "available", primary: true }),
            expect.objectContaining({ role: "package_archive_receipt", path: receiptPath, status: "available" })
          ])
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("extracts portable package archives with receipt evidence through the debug API", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-package-extract-"));
    const archivePath = join(tempRoot, "debug-timeline.shellxmotion");
    const extractedRoot = join(tempRoot, "extracted");
    try {
      await dispatchDebugCommand(
        "motion.package.archive",
        { packageRoot, archivePath },
        { tier: "write_local" }
      );

      const result = await dispatchDebugCommand(
        "motion.package.extract",
        { archivePath, packageRoot: extractedRoot },
        { tier: "write_local" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const receiptPath = `${extractedRoot}.package-extract.receipt.json`;
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));

        expect(result.receiptId).toMatch(/^package-extract-pkg_debug_timeline-/);
        expect(result.visibleState).toEqual({
          panel: "receipts",
          operation: "package.archive.extract",
          packageId: "pkg_debug_timeline",
          archivePath,
          packageRoot: extractedRoot,
          receiptPath,
          fileCount: 2
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          archivePath,
          packageRoot: extractedRoot,
          receiptPath,
          archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          fileCount: 2
        });
        expect(receipt).toMatchObject({
          operation: "package.archive.extract",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "package",
          output: {
            archivePath,
            packageRoot: extractedRoot,
            receiptPath,
            archiveFormat: "tar",
            packageExtension: ".shellxmotion",
            fileCount: 2
          },
          artifacts: expect.arrayContaining([
            expect.objectContaining({ role: "motion_package", path: extractedRoot, status: "available", primary: true }),
            expect.objectContaining({ role: "package_archive_extract_receipt", path: receiptPath, status: "available" })
          ])
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("browses Motion packages with package, asset, brand, and template summaries", async () => {
    const root = await writeDebugPackageBrowserRoot();
    try {
      const result = await dispatchDebugCommand(
        "motion.packages.browse",
        { root },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^packages-browse-/);
        expect(result.visibleState).toEqual({
          panel: "packages",
          operation: "packages.browse",
          rootCount: 1,
          packageCount: 2,
          warningCount: 1,
          templateCount: 1
        });
        expect(result.result).toMatchObject({
          ok: true,
          roots: [root],
          packageCount: 2,
          templateCount: 1,
          warnings: [expect.stringContaining("Broken package was skipped")],
          packages: [
            expect.objectContaining({
              packageId: "pkg_browser_brand",
              packageName: "Browser Brand",
              sourceApp: "shellx-canvas",
              motionId: "motion_browser_brand",
              durationMs: 1200,
              fps: 24,
              size: { width: 1080, height: 1080 },
              layerCount: 1,
              assetCount: 1,
              designTokenGroupCount: 2,
              compatibleHosts: ["shellx-motion", "shellx-canvas"],
              compatibleLanes: ["native", "ffmpeg"],
              hasTemplate: false,
              provenance: expect.objectContaining({
                sourceApp: "shellx-canvas",
                projectId: "canvas_project",
                selectedFrameId: "frame_product"
              }),
              suggestedActions: expect.arrayContaining([
                { id: "inspect", command: "motion.timeline.inspect", args: { packageRoot: join(root, "brand") } },
                { id: "assets", command: "motion.assets.panel", args: { packageRoot: join(root, "brand") } },
                { id: "brand", command: "motion.brand.panel", args: { packageRoot: join(root, "brand") } }
              ])
            }),
            expect.objectContaining({
              packageId: "pkg_browser_template",
              packageName: "Browser Template",
              motionId: "motion_browser_template",
              hasTemplate: true,
              templateId: "template_browser",
              templateName: "Browser Template Controls",
              controlCount: 1,
              suggestedActions: expect.arrayContaining([
                { id: "templateControls", command: "motion.template.controls", args: { packageRoot: join(root, "template") } }
              ])
            })
          ]
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts package browser root aliases and de-dupes direct package roots", async () => {
    const root = await writeDebugPackageBrowserRoot();
    const brandRoot = join(root, "brand");
    const templateRoot = join(root, "template");
    try {
      const directPackage = await dispatchDebugCommand(
        "motion.packages.browse",
        { packageRoot: brandRoot },
        { tier: "read_motion" }
      );
      const directPackages = await dispatchDebugCommand(
        "motion.packages.browse",
        { packageRoot: brandRoot, packageRoots: [brandRoot, templateRoot, brandRoot] },
        { tier: "read_motion" }
      );
      const packagesRoot = await dispatchDebugCommand(
        "motion.packages.browse",
        { packagesRoot: root },
        { tier: "read_motion" }
      );

      expect(directPackage.ok).toBe(true);
      if (directPackage.ok) {
        expect(directPackage.visibleState).toMatchObject({ rootCount: 1, packageCount: 1, warningCount: 0 });
        expect(directPackage.result).toMatchObject({
          roots: [brandRoot],
          packages: [expect.objectContaining({ packageId: "pkg_browser_brand" })]
        });
      }
      expect(directPackages.ok).toBe(true);
      if (directPackages.ok) {
        expect(directPackages.visibleState).toMatchObject({ rootCount: 2, packageCount: 2, warningCount: 0, templateCount: 1 });
        expect(directPackages.result).toMatchObject({
          roots: [brandRoot, templateRoot],
          packageCount: 2
        });
      }
      expect(packagesRoot.ok).toBe(true);
      if (packagesRoot.ok) {
        expect(packagesRoot.visibleState).toMatchObject({ rootCount: 1, packageCount: 2, warningCount: 1, templateCount: 1 });
        expect(packagesRoot.result).toMatchObject({
          roots: [root],
          warnings: [expect.stringContaining("Broken package was skipped")]
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("summarizes package assets and layer usage for asset panels", async () => {
    const packageRoot = await writeDebugPackageWithAssetAndBrandData();
    try {
      const result = await dispatchDebugCommand(
        "motion.assets.panel",
        { packageRoot },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^assets-panel-pkg_debug_assets-/);
        expect(result.visibleState).toEqual({
          panel: "assets",
          operation: "assets.panel",
          packageId: "pkg_debug_assets",
          motionId: "motion_debug_assets",
          declaredAssetCount: 3,
          motionAssetCount: 2,
          referencedAssetCount: 3,
          missingAssetCount: 1,
          unusedDeclaredAssetCount: 1
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_assets",
          motionId: "motion_debug_assets",
          assets: [
            {
              ref: "assets/logo.png",
              exists: true,
              usedByLayerIds: ["logo"],
              sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              sizeBytes: 8
            },
            {
              ref: "assets/music.wav",
              exists: true,
              usedByLayerIds: ["music"],
              sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              sizeBytes: 10
            },
            {
              ref: "assets/missing.png",
              exists: false,
              usedByLayerIds: []
            }
          ],
          motionAssets: [
            { id: "logo", ref: "assets/logo.png", declared: true, usedByLayerIds: ["logo"] },
            { id: "remote", ref: "https://cdn.example.com/remote.png", declared: false, usedByLayerIds: [] }
          ],
          layerRefs: [
            { layerId: "logo", layerType: "image", field: "assetRef", ref: "assets/logo.png", declared: true, exists: true },
            { layerId: "music", layerType: "audio", field: "source", ref: "assets/music.wav", declared: true, exists: true },
            { layerId: "remote", layerType: "image", field: "src", ref: "https://cdn.example.com/remote.png", declared: false, external: true }
          ],
          missingAssets: ["assets/missing.png"],
          unusedDeclaredAssets: ["assets/missing.png"]
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("resolves Canvas-style Motion asset source paths for assetId layer refs", async () => {
    const packageRoot = await writeDebugPackageWithCanvasAssetId();
    try {
      const result = await dispatchDebugCommand(
        "motion.assets.panel",
        { packageRoot },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toEqual({
          panel: "assets",
          operation: "assets.panel",
          packageId: "pkg_debug_canvas_asset",
          motionId: "motion_debug_canvas_asset",
          declaredAssetCount: 1,
          motionAssetCount: 1,
          referencedAssetCount: 1,
          missingAssetCount: 0,
          unusedDeclaredAssetCount: 0
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_canvas_asset",
          motionId: "motion_debug_canvas_asset",
          assets: [
            {
              ref: "assets/product.png",
              exists: true,
              usedByLayerIds: ["product"],
              sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              sizeBytes: 10
            }
          ],
          motionAssets: [
            { id: "asset_product", ref: "assets/product.png", declared: true, usedByLayerIds: ["product"] }
          ],
          layerRefs: [
            { layerId: "product", layerType: "image", field: "assetId", ref: "assets/product.png", declared: true, exists: true }
          ],
          missingAssets: [],
          unusedDeclaredAssets: []
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("summarizes media layer readiness into a read-only media panel", async () => {
    const packageRoot = await writeDebugPackageWithMedia();
    try {
      const result = await dispatchDebugCommand(
        "motion.media.panel",
        { packageRoot, preset: "mp4-h264" },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^media-panel-pkg_debug_media-/);
        expect(result.visibleState).toEqual({
          panel: "media",
          operation: "media.panel",
          packageId: "pkg_debug_media",
          motionId: "motion_debug_media",
          mediaLayerCount: 6,
          imageLayerCount: 3,
          videoLayerCount: 1,
          audioLayerCount: 1,
          webLayerCount: 1,
          missingSourceCount: 1,
          noSourceLayerCount: 1,
          warningCount: 3,
          preset: "mp4-h264"
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageRoot,
          packageId: "pkg_debug_media",
          packageName: "Debug Media",
          motionId: "motion_debug_media",
          counts: {
            mediaLayers: 6,
            imageLayers: 3,
            videoLayers: 1,
            audioLayers: 1,
            webLayers: 1,
            packageSources: 3,
            localSources: 3,
            remoteSources: 1,
            missingSources: 1,
            noSourceLayers: 1,
            trimmedLayers: 1,
            loopedLayers: 1,
            playbackRateLayers: 1,
            includeAudioLayers: 1
          },
          preset: {
            preset: "mp4-h264",
            supportsAudio: true,
            supportsAlpha: false,
            warnings: []
          },
          layers: expect.arrayContaining([
            expect.objectContaining({
              id: "hero",
              type: "image",
              source: "assets/product.png",
              sourceKind: "package",
              exists: true,
              declaredAsset: true,
              readiness: "ready",
              fit: "contain",
              crop: { x: 0, y: 0, width: 640, height: 360 }
            }),
            expect.objectContaining({
              id: "clip",
              type: "video",
              source: "assets/clip.mp4",
              sourceKind: "package",
              exists: true,
              declaredAsset: true,
              trim: { startMs: 250, durationMs: 1000 },
              loop: true,
              playbackRate: 1.25,
              includeAudio: true,
              readiness: "ready"
            }),
            expect.objectContaining({
              id: "music",
              type: "audio",
              source: "assets/missing.wav",
              sourceKind: "missing",
              exists: false,
              readiness: "missing",
              warnings: ["Local media source is missing: assets/missing.wav"]
            }),
            expect.objectContaining({
              id: "web-card",
              type: "web",
              source: "card.html",
              sourceKind: "package",
              exists: true,
              web: { allowedOriginCount: 1, allowedOrigins: ["https://example.com"] },
              readiness: "ready"
            }),
            expect.objectContaining({
              id: "remote",
              type: "image",
              source: "https://cdn.example.com/remote.png",
              sourceKind: "remote",
              readiness: "warning",
              warnings: ["Remote media source cannot be locally verified: https://cdn.example.com/remote.png"]
            }),
            expect.objectContaining({
              id: "placeholder",
              type: "image",
              sourceKind: "no-source",
              readiness: "missing",
              warnings: ["Media layer has no source reference."]
            })
          ]),
          suggestedActions: expect.arrayContaining([
            { id: "assets", command: "motion.assets.panel", args: { packageRoot } },
            { id: "audio", command: "motion.audio.panel", args: { packageRoot, preset: "mp4-h264" } },
            { id: "exportPlan", command: "motion.export.plan", args: { packageRoot, preset: "mp4-h264" } },
            { id: "preview", command: "motion.preview.panel", args: { packageRoot } },
            { id: "setMedia", command: "motion.timeline.layer.media.set", args: { packageRoot } }
          ]),
          warnings: [
            "Local media source is missing: assets/missing.wav",
            "Remote media source cannot be locally verified: https://cdn.example.com/remote.png",
            "Media layer has no source reference."
          ]
        });
        expect(result.warnings).toEqual([
          "Local media source is missing: assets/missing.wav",
          "Remote media source cannot be locally verified: https://cdn.example.com/remote.png",
          "Media layer has no source reference."
        ]);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("summarizes connector workflow readiness into a read-only connector panel", async () => {
    const result = await dispatchDebugCommand(
      "motion.connector.panel",
      {},
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.receiptId).toMatch(/^connector-panel-/);
      expect(result.visibleState).toEqual({
        panel: "connector",
        operation: "connector.panel",
        connectorCount: 6,
        canvasConnectorCount: 2,
        cutConnectorCount: 5,
        independentExportCount: 1,
        renderedMediaCount: 6,
        qualityGateCount: 1,
        warningCount: 0
      });
      expect(result.result).toMatchObject({
        ok: true,
        counts: {
          connectors: 6,
          canvasConnectors: 2,
          cutConnectors: 5,
          independentExports: 1,
          renderedMedia: 6,
          qualityGated: 1,
          requiresSourceImport: 1,
          templateDriven: 1
        },
        cards: expect.arrayContaining([
          expect.objectContaining({
            id: "canvas_to_mp4",
            command: "motion.connector.canvas_to_mp4",
            sourceProduct: "shellx-canvas",
            targetProduct: "shellx-canvas",
            outputKind: "mp4",
            requiredInputs: ["canvasSelectionPath", "outDir"],
            render: expect.objectContaining({ required: true, dryRunSupported: true, defaultFrameLane: "browser" }),
            cutHandoff: { supported: false }
          }),
          expect.objectContaining({
            id: "canvas_to_cut",
            command: "motion.connector.canvas_to_cut",
            sourceProduct: "shellx-canvas",
            targetProduct: "shellx-cut",
            outputKind: "cut-import-plan",
            cutHandoff: expect.objectContaining({
              supported: true,
              importModes: ["rendered_media"]
            })
          }),
          expect.objectContaining({
            id: "source_to_cut",
            command: "motion.connector.source_to_cut",
            requiredInputs: ["sourcePath", "outDir"],
            cutHandoff: expect.objectContaining({ supported: true, importModes: ["rendered_media"] })
          }),
          expect.objectContaining({
            id: "cut_generate_to_cut",
            command: "motion.connector.cut_generate_to_cut",
            sourceProduct: "shellx-cut",
            targetProduct: "shellx-cut",
            qualityGate: expect.objectContaining({ supported: true, defaultEnabled: true }),
            receipts: expect.arrayContaining(["connector_receipt", "render_receipt", "quality_receipt", "cut_plan"])
          }),
          expect.objectContaining({
            id: "template_to_cut",
            command: "motion.connector.template_to_cut",
            requiredInputs: ["packageRoot", "outDir", "values"],
            templateDriven: true
          })
        ]),
        suggestedActions: expect.arrayContaining([
          { id: "canvasMp4", command: "motion.connector.canvas_to_mp4", requiredArgs: ["canvasSelectionPath", "outDir"] },
          { id: "canvasCut", command: "motion.connector.canvas_to_cut", requiredArgs: ["canvasSelectionPath", "outDir"] },
          { id: "scriptCut", command: "motion.connector.script_to_cut", requiredArgs: ["outDir"] },
          { id: "sourceCut", command: "motion.connector.source_to_cut", requiredArgs: ["sourcePath", "outDir"] },
          { id: "cutGenerateCut", command: "motion.connector.cut_generate_to_cut", requiredArgs: ["scriptPath", "outDir"] },
          { id: "templateCut", command: "motion.connector.template_to_cut", requiredArgs: ["packageRoot", "outDir", "values"] }
        ]),
        warnings: []
      });
      expect(result.warnings).toEqual([]);
    }
  });

  it("summarizes design tokens and provenance for brand panels", async () => {
    const packageRoot = await writeDebugPackageWithAssetAndBrandData();
    try {
      const result = await dispatchDebugCommand(
        "motion.brand.panel",
        { packageRoot },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^brand-panel-pkg_debug_assets-/);
        expect(result.visibleState).toEqual({
          panel: "brand",
          operation: "brand.panel",
          packageId: "pkg_debug_assets",
          motionId: "motion_debug_assets",
          hasDesignTokens: true,
          tokenGroupCount: 5,
          colorTokenCount: 2,
          typographyTokenCount: 1,
          logoTokenCount: 2,
          sourceApp: "shellx-canvas",
          projectId: "canvas_project",
          selectedFrameId: "frame_hero"
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_assets",
          motionId: "motion_debug_assets",
          designTokens: {
            color: { accent: "#ff006e", ink: "#101828" },
            typography: { heading: { fontFamily: "Inter", fontWeight: 800 } },
            logo: {
              primary: { assetRef: "assets/logo.png", alt: "ShellX" },
              mark: { assetRef: "https://cdn.example.com/remote.png", alt: "ShellX mark" }
            },
            spacing: { framePadding: 64 },
            radius: { card: 24 }
          },
          tokenGroups: ["color", "typography", "logo", "spacing", "radius"],
          colorTokens: [
            { path: "color.accent", value: "#ff006e" },
            { path: "color.ink", value: "#101828" }
          ],
          typographyTokens: [
            { path: "typography.heading", value: { fontFamily: "Inter", fontWeight: 800 } }
          ],
          logoTokens: [
            { path: "logo.primary", value: { assetRef: "assets/logo.png", alt: "ShellX" } },
            { path: "logo.mark", value: { assetRef: "https://cdn.example.com/remote.png", alt: "ShellX mark" } }
          ],
          provenance: {
            sourceApp: "shellx-canvas",
            createdBy: "test",
            projectId: "canvas_project",
            selectedFrameId: "frame_hero"
          }
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("refuses support bundle collection below local write permission", async () => {
    const result = await dispatchDebugCommand(
      "motion.support.bundle",
      { outDir: ".scratch/support-bundle" },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("permission_denied");
      expect(result.error.message).toBe("motion.support.bundle requires write_local; this session holds read_motion.");
    }
  });

  it("refuses support bundle output paths inside the source package", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    try {
      const result = await dispatchDebugCommand(
        "motion.support.bundle",
        { packageRoot, outDir: packageRoot },
        { tier: "write_local", scratchRoot: dirname(packageRoot) }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "invalid_args",
          message: "motion.support.bundle outDir must be outside packageRoot."
        });
      }
      await expect(readFile(join(packageRoot, "support-bundle.json"), "utf8")).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("refuses support bundle output directories that already exist", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-support-bundle-root-"));
    const outDir = join(tempRoot, "non-empty");
    const sentinelPath = join(outDir, "keep.txt");
    try {
      await mkdir(outDir, { recursive: true });
      await writeFile(sentinelPath, "do not overwrite", "utf8");

      const result = await dispatchDebugCommand(
        "motion.support.bundle",
        { packageRoot, outDir },
        { tier: "write_local", scratchRoot: tempRoot }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalid_args");
        expect(result.error.message).toBe("motion.support.bundle outDir must be absent before bundle collection.");
      }
      expect(await readFile(sentinelPath, "utf8")).toBe("do not overwrite");
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("refuses support bundle output outside the trusted debug scratch root", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const scratchRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-support-trusted-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-support-outside-"));
    const outDir = join(outsideRoot, "bundle");
    try {
      const result = await dispatchDebugCommand(
        "motion.support.bundle",
        { packageRoot, outDir },
        { tier: "write_local", scratchRoot }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalid_args");
        expect(result.error.message).toBe("motion.support.bundle outDir must be inside the trusted debug scratch root.");
      }
      await expect(readFile(join(outDir, "support-bundle.json"), "utf8")).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(scratchRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("refuses scripted-video compilation below local write permission", async () => {
    const result = await dispatchDebugCommand("motion.script.compile", { packageId: "pkg_script" }, { tier: "render_motion" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("permission_denied");
      expect(result.error.message).toBe("motion.script.compile requires write_local; this session holds render_motion.");
    }
  });

  it("returns visible state when opening a panel", async () => {
    const result = await dispatchDebugCommand("motion.open", { panel: "preview" }, { tier: "read_motion" });

    expect(result).toEqual({ ok: true, visibleState: { panel: "preview" }, warnings: [] });
  });

  it("no longer exposes motion.screenshot, which could only ever fake success", async () => {
    // Motion is a headless engine with no panel of its own. The command relayed a request to the
    // host and reported ok:true for something it could not verify. motion.preview.frame and
    // capture-browser produce a real image and a receipt instead.
    const result = await dispatchDebugCommand(
      "motion.screenshot" as never,
      { panel: "preview", format: "png" },
      { tier: "read_motion" }
    );

    expect(result).toMatchObject({ ok: false, error: { code: "unknown_command" } });
  });
  it("returns concrete visible state for selection and highlight commands", async () => {
    await expect(dispatchDebugCommand(
      "motion.select",
      { layerId: "title", packageId: "pkg_debug", motionId: "motion_debug" },
      { tier: "read_motion" }
    )).resolves.toEqual({
      ok: true,
      visibleState: {
        panel: "timeline",
        operation: "select",
        selection: { kind: "layer", id: "title" },
        packageId: "pkg_debug",
        motionId: "motion_debug"
      },
      result: {
        ok: true,
        selection: { kind: "layer", id: "title" },
        packageId: "pkg_debug",
        motionId: "motion_debug"
      },
      warnings: []
    });

    await expect(dispatchDebugCommand(
      "motion.highlight",
      { markerId: "beat", packageId: "pkg_debug", durationMs: 600 },
      { tier: "read_motion" }
    )).resolves.toEqual({
      ok: true,
      visibleState: {
        panel: "timeline",
        operation: "highlight",
        selection: { kind: "marker", id: "beat" },
        packageId: "pkg_debug",
        durationMs: 600
      },
      result: {
        ok: true,
        selection: { kind: "marker", id: "beat" },
        packageId: "pkg_debug",
        durationMs: 600
      },
      warnings: []
    });
  });

  it("rejects selection commands without a selectable target", async () => {
    const result = await dispatchDebugCommand("motion.select", {}, { tier: "read_motion" });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid_args",
        message: "motion.select requires layerId, trackId, markerId, sceneId, or targetId."
      },
      warnings: []
    });
  });

  it("routes action planning through the action catalog", async () => {
    const result = await dispatchDebugCommand("motion.actions.plan", { request: "make title blue and preview it" }, { tier: "read_motion" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({ ok: true, topic: "make title blue and preview it" });
    }
  });

  it("makes root alternatives callable in action guides and plans", async () => {
    const guide = await dispatchDebugCommand("motion.actions.guide", { request: "list motion templates" }, { tier: "read_motion" });
    const plan = await dispatchDebugCommand("motion.actions.plan", { request: "template plan" }, { tier: "read_motion" });

    expect(guide.ok).toBe(true);
    expect(plan.ok).toBe(true);
    if (!guide.ok || !plan.ok) return;
    const guideCatalog = ((guide.result as { steps: Array<{ call: string }> }).steps).find((step) => step.call === "motion.template.catalog");
    const planCatalog = ((plan.result as { steps: Array<{ call: string }> }).steps).find((step) => step.call === "motion.template.catalog");
    const templatePlan = ((plan.result as { steps: Array<{ call: string }> }).steps).find((step) => step.call === "motion.template.plan");
    const rootRequirement = {
      requiredArgGroups: [{
        mode: "anyOf",
        alternatives: [["templateRoot"], ["packageRoot"], ["packageRoots"]]
      }]
    };

    expect(guideCatalog).toMatchObject(rootRequirement);
    expect(guideCatalog).not.toHaveProperty("requiredArgs");
    expect(planCatalog).toMatchObject(rootRequirement);
    expect(planCatalog).not.toHaveProperty("requiredArgs");
    expect(templatePlan).toMatchObject({ requiredArgs: ["request"], ...rootRequirement });
  });

  it("summarizes actions and prompt commands into a panel-ready action surface", async () => {
    const result = await dispatchDebugCommand("motion.actions.panel", {}, { tier: "read_motion" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const promptActionCount = ACTIONS.filter((action) => action.surfaces.includes("prompt")).length;
      const mutatingActionCount = ACTIONS.filter((action) => action.mutates).length;
      const surfaceCount = new Set(ACTIONS.flatMap((action) => action.surfaces)).size;
      expect(result.visibleState).toEqual({
        panel: "actions",
        operation: "actions.panel",
        actionCount: ACTIONS.length,
        promptActionCount,
        mutatingActionCount,
        surfaceCount
      });
      expect(result.result).toMatchObject({
        ok: true,
        actionCount: ACTIONS.length,
        promptActionCount,
        mutatingActionCount,
        readOnlyActionCount: ACTIONS.length - mutatingActionCount,
        surfaces: expect.arrayContaining([
          expect.objectContaining({
            id: "prompt",
            actionIds: expect.arrayContaining(["motion.actions.panel", "motion.template.panel", "motion.render.final"])
          }),
          expect.objectContaining({
            id: "templateInspector",
            actionIds: expect.arrayContaining(["motion.template.panel", "motion.template.apply"])
          })
        ]),
        permissions: expect.arrayContaining([
          expect.objectContaining({ tier: "read_motion", actionIds: expect.arrayContaining(["motion.actions.panel", "motion.template.panel"]) }),
          expect.objectContaining({ tier: "render_motion", actionIds: expect.arrayContaining(["motion.render.final"]) })
        ]),
        actions: expect.arrayContaining([
          expect.objectContaining({
            id: "motion.actions.panel",
            permission: "read_motion",
            mutates: false,
            primarySurface: "prompt",
            callCount: 1
          }),
          expect.objectContaining({
            id: "motion.template.panel",
            permission: "read_motion",
            primarySurface: "templateInspector",
            calls: ["motion.template.panel"]
          }),
          expect.objectContaining({
            id: "motion.render.final",
            permission: "render_motion",
            mutates: true
          })
        ]),
        promptCommands: [
          { id: "find", command: "motion.actions.find", args: { request: "" } },
          { id: "guide", command: "motion.actions.guide", args: { request: "" } },
          { id: "plan", command: "motion.actions.plan", args: { request: "" } },
          { id: "run", command: "motion.prompt.run", args: { request: "" } },
          { id: "agentHealth", command: "motion.agent.health", args: {} }
        ],
        suggestedActions: [
          { id: "plan", command: "motion.actions.plan", args: { request: "describe the Motion task" } },
          { id: "runPrompt", command: "motion.prompt.run", args: { request: "describe the Motion task" } },
          { id: "agentHealth", command: "motion.agent.health", args: {} }
        ]
      });
    }
  });

  it("reports local CLI agent health through the debug API", async () => {
    const result = await dispatchDebugCommand(
      "motion.agent.health",
      {},
      {
        tier: "read_motion",
        agentRuntime: {
          health: async () => [
            {
              agentId: "fake",
              available: true,
              command: "shellx-motion-fake-agent",
              transport: "local-cli",
              billing: "cli-subscription",
              detail: "shellx-motion-fake-agent 0.0.0",
              status: "ready",
              version: "shellx-motion-fake-agent 0.0.0",
              setup: {
                checkCommand: "shellx-motion-fake-agent --version",
                installHint: "Install Fake Agent CLI and ensure shellx-motion-fake-agent is on PATH.",
                authHint: "Authenticate Fake Agent CLI with its local login command before running Motion prompts.",
                quotaHint: "Check Fake Agent CLI subscription quota or retry after the provider limit resets."
              },
              probe: { executable: "shellx-motion-fake-agent", args: ["--version"], shell: false }
            }
          ]
        }
      }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visibleState).toEqual({
        panel: "agent",
        operation: "agent.health",
        agentCount: 1,
        availableCount: 1
      });
      expect(result.result).toEqual({
        ok: true,
        agents: [
          {
            agentId: "fake",
            available: true,
            command: "shellx-motion-fake-agent",
            transport: "local-cli",
            billing: "cli-subscription",
            detail: "shellx-motion-fake-agent 0.0.0",
            status: "ready",
            version: "shellx-motion-fake-agent 0.0.0",
            setup: {
              checkCommand: "shellx-motion-fake-agent --version",
              installHint: "Install Fake Agent CLI and ensure shellx-motion-fake-agent is on PATH.",
              authHint: "Authenticate Fake Agent CLI with its local login command before running Motion prompts.",
              quotaHint: "Check Fake Agent CLI subscription quota or retry after the provider limit resets."
            },
            probe: { executable: "shellx-motion-fake-agent", args: ["--version"], shell: false }
          }
        ]
      });
    }
  });

  it("summarizes local CLI agent readiness policy through a read-only agent panel", async () => {
    const result = await dispatchDebugCommand("motion.agent.panel", {}, { tier: "read_motion" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visibleState).toEqual({
        panel: "agent",
        operation: "agent.panel",
        adapterCount: 4,
        localCliCount: 4,
        cliSubscriptionCount: 4,
        defaultAgentId: "codex",
        promptFollowUpCount: 3,
        warningCount: 0
      });
      expect(result.result).toMatchObject({
        ok: true,
        counts: {
          adapters: 4,
          localCliAdapters: 4,
          cliSubscriptionAdapters: 4,
          promptFollowUps: 3
        },
        selectionPolicy: {
          defaultAgentId: "codex",
          selectedUnavailableFallback: "none",
          defaultMode: "auto-local-cli"
        },
        adapters: [
          {
            agentId: "codex",
            label: "Codex CLI",
            default: true,
            transport: "local-cli",
            billing: "cli-subscription",
            probe: { executable: "codex", args: ["--version"], shell: false },
            prompt: {
              executable: "codex",
              args: [
                "exec", "--json", "--sandbox", "read-only", "--ask-for-approval", "never",
                "--ephemeral"
              ],
              shell: false,
              stdin: "prompt"
            },
            setup: {
              checkCommand: "codex --version",
              installHint: "Install Codex CLI and ensure codex is on PATH.",
              authHint: "Authenticate Codex CLI locally before running Motion prompts.",
              quotaHint: "Check Codex CLI subscription limits or retry after the provider limit resets."
            }
          },
          expect.objectContaining({
            agentId: "claude-code",
            prompt: expect.objectContaining({
              executable: "claude",
              args: [
                "--print", "--output-format", "json", "--permission-mode", "plan", "--safe-mode",
                "--no-chrome", "--no-session-persistence", "--disallowedTools",
                "Bash,Edit,Write,NotebookEdit,Agent,Task,WebFetch,WebSearch"
              ]
            })
          }),
          expect.objectContaining({
            agentId: "grok",
            prompt: expect.objectContaining({
              executable: "grok",
              args: [
                "--output-format", "json", "--permission-mode", "plan", "--no-subagents",
                "--disable-web-search", "--tools=", "--no-memory", "--prompt-file", "<prompt-file>"
              ]
            })
          }),
          // Antigravity carries the prompt in argv as the --print value, not on stdin.
          expect.objectContaining({
            agentId: "antigravity",
            prompt: expect.objectContaining({
              executable: "agy",
              args: ["--sandbox", "--mode", "plan", "--output-format", "json", "--print", "<prompt>"]
            })
          })
        ],
        safety: {
          shell: false,
          envInReceipts: "omitted",
          stdoutStderrRedaction: true,
          noPackageMutationDuringHealth: true
        },
        receipts: {
          promptOperation: "prompt.run",
          agentOperation: "agent.prompt",
          transcriptCommand: "motion.agent.transcript"
        },
        suggestedActions: [
          { id: "health", command: "motion.agent.health", args: {} },
          { id: "run", command: "motion.prompt.run", args: { request: "" } },
          { id: "transcript", command: "motion.agent.transcript", args: { receiptsRoot: "" } }
        ],
        warnings: []
      });
    }
  });

  it("builds and writes an agent revision plan from quality and contact-sheet evidence", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-agent-revision-"));
    const planPath = join(outDir, "revision-plan.json");
    try {
      const denied = await dispatchDebugCommand(
        "motion.agent.revision.plan",
        { packageId: "pkg_debug_revision", planPath },
        { tier: "draft_motion" }
      );
      expect(denied).toMatchObject({
        ok: false,
        error: { code: "permission_denied", message: "motion.agent.revision.plan requires write_local; this session holds draft_motion." }
      });
      await expect(readFile(planPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const result = await dispatchDebugCommand(
        "motion.agent.revision.plan",
        {
          planId: "revision-debug-001",
          packageId: "pkg_debug_revision",
          templateId: "template_launch",
          sourceJobId: "prompt-debug-001",
          createdAt: "2026-07-06T12:15:00.000Z",
          planPath,
          qualityReceipts: [
            debugReceipt({
              id: "quality-debug-blank",
              operation: "quality.check",
              status: "failed",
              packageId: "pkg_debug_revision",
              lane: "quality",
              output: {
                quality: { blankFrames: 1, minEdgePixels: 0 },
                checks: [{ id: "mid", status: "failed", message: "Frame is blank." }]
              },
              warnings: ["Extracted frame is blank or visually empty."]
            })
          ],
          contactSheet: {
            path: join(outDir, "contact-sheet.png"),
            status: "needs_revision",
            notes: ["CTA overlaps the product badge."]
          }
        },
        { tier: "write_local", scratchRoot: outDir }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const writtenPlan = JSON.parse(await readFile(planPath, "utf8"));
      expect(result.visibleState).toEqual({
        panel: "agent",
        operation: "agent.revision.plan",
        packageId: "pkg_debug_revision",
        status: "needs_revision",
        findingCount: 4,
        proposedActionCount: 1,
        planPath
      });
      expect(result.result).toMatchObject({
        ok: true,
        planPath,
        plan: {
          schema: "shellx-motion/agent-revision-plan@1",
          planId: "revision-debug-001",
          packageId: "pkg_debug_revision",
          templateId: "template_launch",
          sourceJobId: "prompt-debug-001",
          status: "needs_revision",
          evidence: {
            qualityReceiptIds: ["quality-debug-blank"],
            contactSheet: { status: "needs_revision" }
          },
          proposedActions: [
            {
              id: "revise-with-agent",
              command: "motion.prompt.run",
              target: { packageId: "pkg_debug_revision", templateId: "template_launch" }
            }
          ]
        }
      });
      expect(writtenPlan).toMatchObject((result.result as { plan: Record<string, unknown> }).plan);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("runs prompt plans through the debug API using the selected local agent runtime", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-prompt-run-"));
    const receiptsRoot = join(outDir, "receipts");
    const calls: Array<Record<string, unknown>> = [];
    try {
      const result = await dispatchDebugCommand(
        "motion.prompt.run",
        {
          request: "preview current package",
          packageId: "pkg_debug_prompt",
          agentId: "fake",
          cwd: "/workspace",
          receiptsRoot
        },
        {
          tier: "render_motion",
          // The host nominates its receipts root; the fence refuses a caller-named path outside it.
          scratchRoot: outDir,
          promptCwdRoots: ["/workspace"],
          promptRuntime: {
            runPrompt: async (input) => {
              calls.push(input as unknown as Record<string, unknown>);
              return {
                ok: true,
                structuredOutput: { accepted: true },
                transcript: {
                  stdout: "{\"accepted\":true}",
                  stderr: "",
                  redacted: true,
                  truncated: false,
                  maxBytes: 65_536
                },
                receipt: {
                  schema: "shellx-motion/receipt@1",
                  id: "agent-debug-001",
                  operation: "agent.prompt",
                  status: "passed",
                  packageId: input.packageId ?? "unknown",
                  inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
                  createdAt: "2026-07-01T00:00:00.000Z",
                  lane: "agent",
                  output: {
                    agentId: input.agentId ?? "fake",
                    label: "Fake Agent",
                    transport: "local-cli",
                    billing: "cli-subscription",
                    command: { executable: "fake", args: ["run"], shell: false },
                    transcript: [],
                    permission: input.permission
                  },
                  warnings: []
                }
              };
            }
          }
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const receiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const agentReceiptPath = join(receiptsRoot, "agent-debug-001.receipt.json");
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const agentReceipt = JSON.parse(await readFile(agentReceiptPath, "utf8"));
        expect(calls).toEqual([
          expect.objectContaining({
            agentId: "fake",
            packageId: "pkg_debug_prompt",
            cwd: "/workspace",
            permission: "render_motion"
          })
        ]);
        expect(result.receiptId).toMatch(/^prompt-/);
        expect(result.visibleState).toEqual({
          panel: "agent",
          operation: "prompt.run",
          packageId: "pkg_debug_prompt",
          status: "passed",
          promptRetentionMode: "summary_only",
          rawRequestRetained: false,
          receiptPath,
          agentReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_prompt",
          receiptPath,
          agentReceiptPath,
          receipt: {
            operation: "prompt.run",
            status: "passed",
            output: {
              agentId: "fake",
              agentReceiptId: "agent-debug-001",
              requestSummary: expect.stringContaining("Motion request classified as"),
              promptRetention: { mode: "summary_only", rawRequestRetained: false },
              debugCommands: expect.arrayContaining(["motion.preview.frame"])
            }
          },
          agent: {
            receipt: { id: "agent-debug-001" },
            structuredOutput: { accepted: true },
            transcript: {
              stdout: "{\"accepted\":true}",
              stderr: "",
              redacted: true,
              truncated: false,
              maxBytes: 65_536
            }
          }
        });
        const publicAgentResult = (result.result as { agent: Record<string, unknown> }).agent;
        expect(publicAgentResult).not.toHaveProperty("stdout");
        expect(publicAgentResult).not.toHaveProperty("stderr");
        expect(receipt).toMatchObject({
          id: result.receiptId,
          operation: "prompt.run",
          status: "passed",
          packageId: "pkg_debug_prompt",
          output: {
            agentId: "fake",
            agentReceiptId: "agent-debug-001",
            requestSummary: expect.stringContaining("Motion request classified as"),
            promptRetention: { mode: "summary_only", rawRequestRetained: false },
            debugCommands: expect.arrayContaining(["motion.preview.frame"])
          }
        });
        expect(JSON.stringify(receipt)).not.toContain("preview current package");
        expect(receipt.output).not.toHaveProperty("request");
        expect(receipt.output).not.toHaveProperty("rawRequest");
        expect(agentReceipt).toMatchObject({
          id: "agent-debug-001",
          operation: "agent.prompt",
          status: "passed",
          output: {
            agentId: "fake",
            command: { executable: "fake", args: ["run"], shell: false },
            transcript: []
          }
        });
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  itLinux("makes explicit raw-prompt retention visible through the governed stable receipt root", async () => {
    const deleteAfter = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const request = "Project Cobalt exact debug replay";
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-raw-retention-"));
    try {
      const retained = await dispatchDebugCommand(
        "motion.prompt.run",
        {
          request,
          packageId: "pkg_retained_prompt",
          agentId: "fake",
          retainRawRequest: true,
          rawRequestDeleteAfter: deleteAfter,
          rawRequestPurpose: "debugging"
        },
        { tier: "render_motion", receiptsRoot, callerId: "test-prompt", promptRuntime: createFakePromptRuntime() }
      );

      expect(retained.ok).toBe(true);
      if (retained.ok) {
        expect(retained.visibleState).toMatchObject({
          panel: "agent",
          operation: "prompt.run",
          promptRetentionMode: "raw_request",
          rawRequestRetained: true,
          rawRequestDeleteAfter: deleteAfter,
          rawRequestPurpose: "debugging"
        });
        expect(retained.result).toMatchObject({
          receipt: {
            output: {
              rawRequest: request,
              promptRetention: {
                mode: "raw_request",
                rawRequestRetained: true,
                purpose: "debugging",
                deleteAfter
              }
            }
          }
        });
        const receiptPaths = retained.visibleState as { receiptPath?: string; agentReceiptPath?: string };
        expect(await readFile(receiptPaths.receiptPath!, "utf8")).toContain(request);
        expect(await readFile(receiptPaths.agentReceiptPath!, "utf8")).not.toContain(request);
      }
    } finally {
      await rm(receiptsRoot, { recursive: true, force: true });
    }
  });

  itLinux("redacts a raw prompt before the production reservation persists its parent after expiry", async () => {
    const createdAt = "2040-01-01T00:00:00.000Z";
    const deleteAfter = "2040-01-01T00:00:01.000Z";
    const request = "debug parent receipt deadline race";
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-raw-retention-deadline-"));
    let now = createdAt;
    try {
      const result = await dispatchDebugCommand(
        "motion.prompt.run",
        { request, packageId: "pkg_deadline", agentId: "fake", retainRawRequest: true, rawRequestDeleteAfter: deleteAfter, rawRequestPurpose: "debugging" },
        {
          tier: "render_motion", receiptsRoot, callerId: "test-prompt", promptRuntime: createFakePromptRuntime(), promptNow: () => now,
          rawPromptReceiptWriteTestHook: (receipt) => { if (receipt.operation === "agent.prompt") now = "2040-01-01T00:00:02.000Z"; }
        }
      );

      expect(result).toMatchObject({ ok: true, visibleState: { rawRequestRetained: false }, result: { receipt: { output: { promptRetention: { rawRequestRetained: false } } } } });
      if (!result.ok) return;
      expect(JSON.stringify((result.result as { receipt?: unknown }).receipt)).not.toContain(request);
      const { receiptPath } = result.visibleState as { receiptPath: string };
      expect(await readFile(receiptPath, "utf8")).not.toContain(request);
    } finally {
      await rm(receiptsRoot, { recursive: true, force: true });
    }
  });

  it("refuses raw-prompt retention without a host-configured receipt root before prompt execution", async () => {
    const request = "raw prompt that must not be returned without governed persistence";
    let runtimeCalls = 0;
    const runtime = createFakePromptRuntime();
    const result = await dispatchDebugCommand(
      "motion.prompt.run",
      {
        request,
        retainRawRequest: true,
        rawRequestDeleteAfter: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        rawRequestPurpose: "debugging"
      },
      {
        tier: "render_motion",
        promptRuntime: {
          runPrompt: async (input) => {
            runtimeCalls += 1;
            return await runtime.runPrompt(input);
          }
        }
      }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable", message: expect.stringContaining("host-configured receipt root") }
    });
    expect(runtimeCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain(request);
  });

  itLinux("refuses raw-prompt retention when the host root does not exist before prompt execution", async () => {
    const parent = await mkdtemp(join(tmpdir(), "shellx-motion-debug-raw-retention-missing-root-"));
    const receiptsRoot = join(parent, "missing-receipts-root");
    let runtimeCalls = 0;
    const runtime = createFakePromptRuntime();
    try {
      const result = await dispatchDebugCommand(
        "motion.prompt.run",
        {
          request: "raw prompt that must not create a receipt root",
          retainRawRequest: true,
          rawRequestDeleteAfter: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          rawRequestPurpose: "debugging"
        },
        {
          tier: "render_motion",
          receiptsRoot,
          promptRuntime: {
            runPrompt: async (input) => {
              runtimeCalls += 1;
              return await runtime.runPrompt(input);
            }
          }
        }
      );

      expect(result).toMatchObject({
        ok: false,
        error: { code: "capability_unavailable", message: expect.stringContaining("existing stable non-symlink") }
      });
      expect(runtimeCalls).toBe(0);
      await expect(stat(receiptsRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects incomplete raw-prompt retention requests", async () => {
    await expect(dispatchDebugCommand(
      "motion.prompt.run",
      { request: "private", retainRawRequest: true, rawRequestPurpose: "debugging" },
      { tier: "render_motion", promptRuntime: createFakePromptRuntime() }
    )).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: expect.stringContaining("rawRequestDeleteAfter") }
    });
  });

  it("executes constrained prompt command proposals into package edit and preview receipts", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-prompt-execute-"));
    const receiptsRoot = join(outDir, "host-receipts");
    const patchedPackageRoot = join(outDir, "patched-package");
    const previewOutDir = join(outDir, "preview");
    const previewPath = join(previewOutDir, "frame.png");
    try {
      const result = await dispatchDebugCommand(
        "motion.prompt.run",
        {
          request: "edit package title and preview it",
          packageId: "pkg_debug_timeline",
          agentId: "fake",
          receiptsRoot,
          executeAgentCommands: true
        },
        {
          tier: "edit_motion",
          callerId: "test-prompt",
          scratchRoot: outDir,
          authoringInputRoots: [packageRoot],
          authoringOutputRoots: [outDir],
          promptRuntime: {
            runPrompt: async (input) => ({
              ok: true,
              structuredOutput: {
                ok: true,
                debugCommands: [
                  {
                    command: "motion.package.patch",
                    args: {
                      packageRoot,
                      outDir: patchedPackageRoot,
                      receiptsRoot,
                      patch: [{ op: "replace", path: "/layers/0/text", value: "Prompt Edited" }],
                      createdBy: "prompt-smoke"
                    }
                  },
                  {
                    command: "motion.preview.frame",
                    args: {
                      packageRoot: patchedPackageRoot,
                      outDir: previewOutDir,
                      outputPath: previewPath,
                      atMs: 0
                    }
                  }
                ]
              },
              transcript: {
                stdout: "[structured agent response]",
                stderr: "",
                redacted: true,
                truncated: false,
                maxBytes: 65_536
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: "agent-prompt-execute-001",
                operation: "agent.prompt",
                status: "passed",
                packageId: input.packageId ?? "unknown",
                inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
                createdAt: "2026-07-03T00:00:00.000Z",
                lane: "agent",
                output: {
                  agentId: input.agentId ?? "fake",
                  label: "Fake Agent",
                  transport: "local-cli",
                  billing: "cli-subscription",
                  command: { executable: "fake", args: ["run"], shell: false },
                  transcript: [],
                  permission: input.permission
                },
                warnings: []
              }
            })
          },
          browserFrameRenderer: async (pkg, options) => {
            await mkdir(options.outDir, { recursive: true });
            await writeFile(options.outputPath ?? previewPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
            const output = {
              path: options.outputPath ?? previewPath,
              sha256: "c".repeat(64),
              format: "png" as const,
              width: pkg.motion.width,
              height: pkg.motion.height,
              atMs: options.atMs,
              browser: { name: "chromium", version: "test" },
              viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
            };
            return {
              ok: true,
              output,
              receipt: debugReceipt({
                id: "preview-frame-prompt-execute",
                operation: "preview.frame",
                status: "passed",
                packageId: pkg.manifest.id,
                lane: "browser",
                output,
                artifacts: [
                  { role: "preview_frame", path: output.path, status: "available", mediaType: "image/png", primary: true }
                ]
              })
            };
          }
        }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const patchedMotion = JSON.parse(await readFile(join(patchedPackageRoot, "motion.json"), "utf8"));
      const promptReceipt = JSON.parse(await readFile(join(receiptsRoot, `${result.receiptId}.receipt.json`), "utf8"));
      const previewReceipt = JSON.parse(await readFile(join(receiptsRoot, "preview-frame-prompt-execute.receipt.json"), "utf8"));

      expect(patchedMotion.layers[0].text).toBe("Prompt Edited");
      expect(previewReceipt).toMatchObject({
        id: "preview-frame-prompt-execute",
        operation: "preview.frame",
        status: "passed",
        artifacts: [
          { role: "preview_frame", path: previewPath, status: "available", mediaType: "image/png", primary: true }
        ]
      });
      expect(result.result).toMatchObject({
        ok: true,
        execution: {
          commandCount: 2,
          receiptIds: [expect.stringMatching(/^package-patch-pkg_debug_timeline-/), "preview-frame-prompt-execute"],
          commands: [
            { command: "motion.package.patch", ok: true, receiptId: expect.stringMatching(/^package-patch-pkg_debug_timeline-/) },
            { command: "motion.preview.frame", ok: true, receiptId: "preview-frame-prompt-execute" }
          ]
        }
      });
      expect(promptReceipt.output).toMatchObject({
        agentReceiptId: "agent-prompt-execute-001",
        executedCommands: [
          { command: "motion.package.patch", ok: true, receiptId: expect.stringMatching(/^package-patch-pkg_debug_timeline-/) },
          { command: "motion.preview.frame", ok: true, receiptId: "preview-frame-prompt-execute" }
        ],
        linkedReceiptIds: [expect.stringMatching(/^package-patch-pkg_debug_timeline-/), "preview-frame-prompt-execute"]
      });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects oversized prompt command proposal batches before executing commands", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-prompt-proposal-limit-"));
    const receiptsRoot = join(outDir, "receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.prompt.run",
        {
          request: "run too many package inspections",
          packageId: "pkg_prompt_limit",
          agentId: "fake",
          receiptsRoot,
          executeAgentCommands: true
        },
        {
          tier: "draft_motion",
          // The host nominates its receipts root; the fence refuses a caller-named path outside it.
          scratchRoot: outDir,
          promptRuntime: {
            runPrompt: async (input) => ({
              ok: true,
              structuredOutput: {
                ok: true,
                debugCommands: Array.from({ length: 26 }, () => ({
                  command: "motion.actions.find",
                  args: { request: "preview" }
                }))
              },
              transcript: {
                stdout: "[structured agent response]",
                stderr: "",
                redacted: true,
                truncated: false,
                maxBytes: 65_536
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: "agent-prompt-proposal-limit",
                operation: "agent.prompt",
                status: "passed",
                packageId: input.packageId ?? "unknown",
                inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
                createdAt: "2026-07-03T00:00:00.000Z",
                lane: "agent",
                output: {
                  agentId: input.agentId ?? "fake",
                  label: "Fake Agent",
                  transport: "local-cli",
                  billing: "cli-subscription",
                  command: { executable: "fake", args: ["run"], shell: false },
                  transcript: [],
                  permission: input.permission
                },
                warnings: []
              }
            })
          }
        }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_prompt_command_proposal",
          message: "Prompt command proposals are limited to 25 commands."
        },
        warnings: ["Prompt command proposals are limited to 25 commands."]
      });
      const promptReceipts = (await readdir(receiptsRoot)).filter((name) => name.startsWith("prompt-"));
      expect(promptReceipts).toHaveLength(1);
      const promptReceipt = JSON.parse(await readFile(join(receiptsRoot, promptReceipts[0]), "utf8"));
      expect(promptReceipt).toMatchObject({
        operation: "prompt.run",
        status: "failed",
        output: {
          agentReceiptId: "agent-prompt-proposal-limit"
        },
        warnings: ["Prompt command proposals are limited to 25 commands."]
      });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  itLinux("summarizes prompt and agent receipts into transcript panel state", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-agent-transcript-"));
    const receiptsRoot = join(tempRoot, "receipts");
    const providerToken = ["sk", "proj", "secret00000000000000000000"].join("-");
    const agent = debugReceipt({
      id: "agent-transcript-001",
      operation: "agent.prompt",
      status: "passed",
      packageId: "pkg_transcript",
      lane: "agent",
      output: {
        callerId: "test-prompt",
        agentId: "fake",
        label: "Fake Agent",
        transport: "local-cli",
        billing: "cli-subscription",
        command: { executable: "fake", args: ["run"], shell: false },
        transcript: [
          { role: "user", contentSha256: "a".repeat(64) },
          { role: "agent", content: `Preview rendered without leaking ${providerToken}` },
          { role: "stderr", content: "warning: transient retry" }
        ],
        permission: "render_motion"
      }
    });
    const prompt = debugReceipt({
      id: "prompt-transcript-001",
      operation: "prompt.run",
      status: "passed",
      packageId: "pkg_transcript",
      lane: "agent",
      output: {
        callerId: "test-prompt",
        agentId: "fake",
        agentReceiptId: "agent-transcript-001",
        debugCommands: ["motion.preview.frame", "motion.receipts.read"],
        planTopic: "preview current package"
      }
    });
    try {
      await mkdir(receiptsRoot, { recursive: true });
      await writeFile(join(receiptsRoot, "agent.receipt.json"), `${JSON.stringify(agent, null, 2)}\n`);
      await writeFile(join(receiptsRoot, "prompt.receipt.json"), `${JSON.stringify(prompt, null, 2)}\n`);

      const result = await dispatchDebugCommand(
        "motion.agent.transcript",
        { receiptsRoot, receiptId: "prompt-transcript-001" },
        { tier: "read_motion", callerId: "test-prompt" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toEqual({
          panel: "agent",
          operation: "agent.transcript",
          sessionCount: 1,
          messageCount: 3
        });
        expect(result.result).toMatchObject({
          ok: true,
          receiptsRoot,
          sessionCount: 1,
          messageCount: 3,
          sessions: [
            {
              promptReceiptId: "prompt-transcript-001",
              agentReceiptId: "agent-transcript-001",
              packageId: "pkg_transcript",
              status: "passed",
              planTopic: "preview current package",
              debugCommands: ["motion.preview.frame", "motion.receipts.read"],
              agent: {
                agentId: "fake",
                label: "Fake Agent",
                transport: "local-cli",
                billing: "cli-subscription",
                permission: "render_motion"
              },
              transcript: {
                messageCount: 3,
                roles: { user: 1, agent: 1, stderr: 1 },
                messages: [
                  { role: "user", contentSha256: "a".repeat(64) },
                  { role: "agent", content: expect.not.stringContaining("sk-proj-secret"), charCount: expect.any(Number) },
                  { role: "stderr", content: "warning: transient retry", charCount: 24 }
                ]
              }
            }
          ]
        });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  itLinux("summarizes prompt queue jobs with available actions and handoff evidence", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-prompt-queue-"));
    const receiptsRoot = join(tempRoot, "receipts");
    const queued = debugReceipt({
      id: "prompt-run-queued-panel",
      operation: "prompt.run",
      status: "not_run",
      packageId: "pkg_prompt_queue",
      lane: "agent",
      output: {
        callerId: "test-prompt",
        request: "edit the title and preview",
        agentId: "codex",
        permission: "edit_motion"
      }
    });
    const failed = debugReceipt({
      id: "prompt-run-failed-panel",
      operation: "prompt.run",
      status: "failed",
      packageId: "pkg_prompt_queue",
      lane: "agent",
      output: {
        callerId: "test-prompt",
        request: "render preview with local agent",
        agentId: "codex",
        error: { code: "agent_unavailable", message: "Codex unavailable." }
      }
    });
    const cancel = debugReceipt({
      id: "prompt-cancel-panel",
      operation: "prompt.cancel",
      status: "passed",
      packageId: "pkg_prompt_queue",
      lane: "debug-api",
      output: {
        callerId: "test-prompt",
        targetReceiptId: "prompt-run-queued-panel",
        targetState: "pending",
        reason: "user stopped queued prompt"
      }
    });
    const retry = debugReceipt({
      id: "prompt-retry-panel",
      operation: "prompt.retry",
      status: "not_run",
      packageId: "pkg_prompt_queue",
      lane: "agent",
      output: {
        callerId: "test-prompt",
        sourceReceiptId: "prompt-run-failed-panel",
        sourceReceiptPath: join(receiptsRoot, "failed.receipt.json"),
        request: "render preview with local agent",
        agentId: "codex",
        eventLogPath: join(receiptsRoot, "events", "prompt-retry-panel.events.jsonl"),
        eventCount: 3,
        lastEventSeq: 3,
        lastEventAt: "2026-07-01T00:00:03.000Z",
        retryAttempt: 1,
        reason: "retry after auth refresh"
      }
    });

    try {
      await mkdir(receiptsRoot, { recursive: true });
      await writeFile(join(receiptsRoot, "queued.receipt.json"), `${JSON.stringify(queued, null, 2)}\n`);
      await writeFile(join(receiptsRoot, "failed.receipt.json"), `${JSON.stringify(failed, null, 2)}\n`);
      await writeFile(join(receiptsRoot, "cancel.receipt.json"), `${JSON.stringify(cancel, null, 2)}\n`);
      await writeFile(join(receiptsRoot, "retry.receipt.json"), `${JSON.stringify(retry, null, 2)}\n`);

      const result = await dispatchDebugCommand(
        "motion.prompt.queue",
        { receiptsRoot },
        { tier: "read_motion", callerId: "test-prompt" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toEqual({
          panel: "agent",
          operation: "prompt.queue",
          jobCount: 3,
          actionableCount: 3,
          failedCount: 1,
          stateCounts: { pending: 1, running: 0, succeeded: 0, failed: 1, cancelled: 1, skipped: 0 }
        });
        expect(result.result).toMatchObject({
          ok: true,
          receiptsRoot,
          jobs: expect.arrayContaining([
            expect.objectContaining({
              receiptId: "prompt-run-queued-panel",
              operation: "prompt.run",
              state: "cancelled",
              request: "edit the title and preview",
              availableActions: [{ id: "retry", command: "motion.prompt.retry", receiptId: "prompt-run-queued-panel" }],
              control: expect.objectContaining({ cancelReceiptId: "prompt-cancel-panel", reason: "user stopped queued prompt" })
            }),
            expect.objectContaining({
              receiptId: "prompt-run-failed-panel",
              operation: "prompt.run",
              state: "failed",
              availableActions: [{ id: "retry", command: "motion.prompt.retry", receiptId: "prompt-run-failed-panel" }]
            }),
            expect.objectContaining({
              receiptId: "prompt-retry-panel",
              operation: "prompt.retry",
              state: "pending",
              request: "render preview with local agent",
              handoff: {
                schema: "shellx-motion/prompt-job-handoff@1",
                jobId: "prompt-retry-panel",
                receiptId: "prompt-retry-panel",
                receiptPath: join(receiptsRoot, "retry.receipt.json"),
                operation: "prompt.retry",
                packageId: "pkg_prompt_queue",
                lane: "agent",
                state: "pending",
                createdAt: "2026-07-01T00:00:00.000Z",
                inputHashes: { motion: "a".repeat(64) },
                request: "render preview with local agent",
                agentId: "codex",
                sourceReceiptId: "prompt-run-failed-panel",
                sourceReceiptPath: join(receiptsRoot, "failed.receipt.json"),
                eventReplay: {
                  schema: "shellx-motion/job-event-replay@1",
                  eventLogPath: join(receiptsRoot, "events", "prompt-retry-panel.events.jsonl"),
                  eventCount: 3,
                  lastSeq: 3,
                  lastEventAt: "2026-07-01T00:00:03.000Z",
                  reconnectCursor: { receiptId: "prompt-retry-panel", sinceSeq: 3 }
                },
                retryAttempt: 1
              },
              eventReplay: {
                schema: "shellx-motion/job-event-replay@1",
                eventLogPath: join(receiptsRoot, "events", "prompt-retry-panel.events.jsonl"),
                eventCount: 3,
                lastSeq: 3,
                lastEventAt: "2026-07-01T00:00:03.000Z",
                reconnectCursor: { receiptId: "prompt-retry-panel", sinceSeq: 3 }
              },
              availableActions: [{ id: "cancel", command: "motion.prompt.cancel", receiptId: "prompt-retry-panel" }]
            })
          ])
        });
        const queueResult = result.result as { jobs: Array<{ receiptId: string; handoff?: unknown }> };
        const retryJob = queueResult.jobs.find((job) => job.receiptId === "prompt-retry-panel");
        expect(await validateDocument(await loadSchema("promptJobHandoff"), retryJob?.handoff)).toEqual({ ok: true });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  itLinux("cancels and retries prompt jobs through receipt-backed debug commands", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-prompt-lifecycle-"));
    const receiptsRoot = join(tempRoot, "receipts");
    const queued = debugReceipt({
      id: "prompt-run-queued-control",
      operation: "prompt.run",
      status: "not_run",
      packageId: "pkg_prompt_control",
      lane: "agent",
      output: { callerId: "test-prompt", request: "edit product title", agentId: "codex" }
    });
    const failed = debugReceipt({
      id: "prompt-run-failed-control",
      operation: "prompt.run",
      status: "failed",
      packageId: "pkg_prompt_control",
      lane: "agent",
      output: { callerId: "test-prompt", request: "preview current package", agentId: "codex" }
    });

    try {
      await mkdir(receiptsRoot, { recursive: true });
      await writeFile(join(receiptsRoot, "queued.receipt.json"), `${JSON.stringify(queued, null, 2)}\n`);
      await writeFile(join(receiptsRoot, "failed.receipt.json"), `${JSON.stringify(failed, null, 2)}\n`);

      const cancel = await dispatchDebugCommand(
        "motion.prompt.cancel",
        { receiptsRoot, receiptId: "prompt-run-queued-control", reason: "user cancelled prompt" },
        { tier: "draft_motion", callerId: "test-prompt" }
      );
      expect(cancel.ok).toBe(true);
      if (cancel.ok) {
        expect(cancel.receiptId).toMatch(/^prompt-cancel-prompt-run-queued-control-/);
        expect(cancel.visibleState).toMatchObject({
          panel: "agent",
          operation: "prompt.cancel",
          targetReceiptId: "prompt-run-queued-control",
          state: "cancelled"
        });
        expect(cancel.result).toMatchObject({
          ok: true,
          targetReceiptId: "prompt-run-queued-control",
          targetState: "pending",
          state: "cancelled",
          receipt: expect.objectContaining({
            operation: "prompt.cancel",
            status: "passed",
            output: expect.objectContaining({ reason: "user cancelled prompt" })
          })
        });
      }

      const retry = await dispatchDebugCommand(
        "motion.prompt.retry",
        { receiptsRoot, receiptId: "prompt-run-failed-control", reason: "retry with refreshed auth" },
        { tier: "draft_motion", callerId: "test-prompt" }
      );
      expect(retry.ok).toBe(true);
      if (retry.ok) {
        expect(retry.receiptId).toMatch(/^prompt-retry-prompt-run-failed-control-/);
        expect(retry.visibleState).toMatchObject({
          panel: "agent",
          operation: "prompt.retry",
          sourceReceiptId: "prompt-run-failed-control",
          state: "pending"
        });
        expect(retry.result).toMatchObject({
          ok: true,
          sourceReceiptId: "prompt-run-failed-control",
          sourceState: "failed",
          state: "pending",
          retryAttempt: 1,
          receipt: expect.objectContaining({
            operation: "prompt.retry",
            status: "not_run",
            output: expect.objectContaining({
              reason: "retry with refreshed auth",
              retryAttempt: 1,
              request: "preview current package",
              agentId: "codex"
            })
          })
        });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  itLinux("reports package timeline receipt and render state through the debug API", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-state-"));
    const receiptsRoot = join(outDir, "receipts");
    try {
      await mkdir(receiptsRoot, { recursive: true });
      await writeFile(
        join(receiptsRoot, "render.receipt.json"),
        `${JSON.stringify(debugReceipt({
          id: "render-final-state",
          operation: "render.final",
          status: "warning",
          packageId: "pkg_debug_timeline",
          lane: "ffmpeg",
          output: { path: "/work/final.mp4" },
          warnings: ["review audio peak"]
        }), null, 2)}\n`,
        "utf8"
      );

      const result = await dispatchDebugCommand(
        "motion.state",
        { packageRoot, receiptsRoot },
        {
          tier: "read_motion",
          scratchRoot: receiptsRoot,
          callerId: "test-operator",
          crossCallerJobScope: true
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toEqual({
          panel: "timeline",
          packageOpen: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          layerCount: 1,
          receiptCount: 1,
          renderJobCount: 1
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageOpen: true,
          packageRoot,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          package: {
            id: "pkg_debug_timeline",
            name: "Debug Timeline",
            sourceApp: "shellx-motion",
            compatibility: { lanes: ["native", "ffmpeg"], hosts: ["motion"] },
            inputHashes: {
              "manifest.json": expect.stringMatching(/^[a-f0-9]{64}$/),
              "motion.json": expect.stringMatching(/^[a-f0-9]{64}$/)
            }
          },
          motion: { durationMs: 500, fps: 10, width: 64, height: 36, layerCount: 1, assetCount: 0 },
          timeline: { trackCount: 1, sceneCount: 1, markerCount: 2 },
          receipts: {
            receiptsRoot,
            receiptCount: 1,
            receipts: [expect.objectContaining({ id: "render-final-state", status: "warning" })]
          },
          render: {
            jobCount: 1,
            failedCount: 0,
            jobs: [expect.objectContaining({ receiptId: "render-final-state", status: "warning", outputPath: "/work/final.mp4" })]
          }
        });
        expect(result.warnings).toEqual(["review audio peak"]);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("refuses direct receipt reads outside the host receipts root", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-receipt-read-"));
    const receiptsRoot = join(outDir, "receipts");
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-receipt-outside-"));
    const outsideReceiptPath = join(outsideRoot, "external.receipt.json");
    const linkedOutsideDir = join(receiptsRoot, "linked-outside");
    const linkedReceiptPath = join(linkedOutsideDir, "external.receipt.json");
    try {
      await mkdir(receiptsRoot, { recursive: true });
      await writeFile(
        outsideReceiptPath,
        `${JSON.stringify(debugReceipt({
          id: "external-receipt",
          operation: "render.final",
          status: "passed",
          packageId: "pkg_external",
          lane: "ffmpeg",
          output: { path: "/outside/final.mp4" }
        }), null, 2)}\n`,
        "utf8"
      );
      await symlink(outsideRoot, linkedOutsideDir, process.platform === "win32" ? "junction" : "dir");

      const direct = await dispatchDebugCommand(
        "motion.receipts.read",
        { receiptsRoot, receiptPath: outsideReceiptPath },
        { tier: "read_motion" }
      );
      const linked = await dispatchDebugCommand(
        "motion.receipts.read",
        { receiptsRoot, receiptPath: linkedReceiptPath },
        { tier: "read_motion" }
      );

      expect(direct.ok).toBe(false);
      expect(linked.ok).toBe(false);
      if (!direct.ok) {
        expect(direct.error).toEqual({
          code: "invalid_args",
          message: "motion.receipts.read receiptPath must be inside receiptsRoot."
        });
      }
      if (!linked.ok) {
        expect(linked.error).toEqual({
          code: "receipt_not_found",
          message: `Receipt not found at path: ${linkedReceiptPath}.`
        });
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  itLinux("reads direct receipts through a bounded no-follow descriptor", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-safe-receipt-"));
    const receiptsRoot = join(tempRoot, "receipts");
    const receiptPath = join(receiptsRoot, "regular.receipt.json");
    const symlinkPath = join(receiptsRoot, "linked.receipt.json");
    const oversizedPath = join(receiptsRoot, "oversized.receipt.json");
    let tooDeepRoot = receiptsRoot;
    const receipt = debugReceipt({
      id: "safe-direct-receipt",
      operation: "preview.frame",
      status: "passed",
      packageId: "pkg_safe_receipt",
      lane: "browser",
      output: { path: join(tempRoot, "preview.png") }
    });
    try {
      await mkdir(receiptsRoot, { recursive: true });
      await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
      await writeFile(
        oversizedPath,
        `${JSON.stringify({ ...receipt, id: "oversized-receipt", output: { padding: "x".repeat(4 * 1024 * 1024) } })}\n`,
        "utf8"
      );
      for (let depth = 0; depth < 18; depth += 1) tooDeepRoot = join(tooDeepRoot, `depth-${depth}`);
      await mkdir(tooDeepRoot, { recursive: true });
      await writeFile(join(tooDeepRoot, "deep.receipt.json"), `${JSON.stringify({ ...receipt, id: "too-deep-receipt" })}\n`, "utf8");
      if (process.platform !== "win32") await symlink(receiptPath, symlinkPath, "file");

      const regular = await dispatchDebugCommand(
        "motion.receipts.read",
        { receiptsRoot, receiptPath },
        { tier: "read_motion", callerId: "test-operator", crossCallerJobScope: true }
      );
      const oversized = await dispatchDebugCommand(
        "motion.receipts.read",
        { receiptsRoot, receiptPath: oversizedPath },
        { tier: "read_motion", callerId: "test-operator", crossCallerJobScope: true }
      );
      const listed = await dispatchDebugCommand(
        "motion.receipts.list",
        { receiptsRoot },
        { tier: "read_motion", callerId: "test-operator", crossCallerJobScope: true }
      );
      expect(regular).toMatchObject({ ok: true, receiptId: "safe-direct-receipt" });
      expect(oversized).toMatchObject({ ok: false, error: { code: "receipt_not_found" } });
      expect(listed).toMatchObject({ ok: true, visibleState: { receiptCount: 1 } });
      if (process.platform !== "win32") {
        const linked = await dispatchDebugCommand(
          "motion.receipts.read",
          { receiptsRoot, receiptPath: symlinkPath },
          { tier: "read_motion", callerId: "test-operator", crossCallerJobScope: true }
        );
        expect(linked).toMatchObject({ ok: false, error: { code: "receipt_not_found" } });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("inspects timeline scenes tracks and markers through the debug API", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.inspect",
        { packageRoot },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^timeline-inspect-pkg_debug_timeline-/);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          trackCount: 1,
          sceneCount: 1,
          markerCount: 2
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          timeline: {
            trackCount: 1,
            sceneCount: 1,
            markerCount: 2,
            tracks: [{ id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] }],
            scenes: [{ id: "intro", name: "Intro", startMs: 0, durationMs: 500, trackIds: ["overlay"], markerIds: ["start", "beat"] }],
            markers: [
              { id: "start", atMs: 0, label: "Start", type: "cue" },
              { id: "beat", atMs: 250, durationMs: 100, label: "Beat", type: "beat" }
            ],
            layerTrackRefs: [{ layerId: "title", trackId: "overlay" }]
          }
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  itLinux("returns a panel-ready timeline with controls, layers, scenes, tracks, and actions", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.safeAreas = {
      title: { top: 36, right: 48, bottom: 36, left: 48 },
      action: { top: 18, right: 24, bottom: 18, left: 24 }
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    try {
      await dispatchDebugCommand(
        "motion.timeline.playhead.set",
        { packageRoot, atMs: 250 },
        { tier: "draft_motion" }
      );
      await dispatchDebugCommand(
        "motion.timeline.range.select",
        { packageRoot, startMs: 100, endMs: 400 },
        { tier: "draft_motion" }
      );
      await dispatchDebugCommand(
        "motion.timeline.viewport.set",
        { packageRoot, startMs: 0, endMs: 500, zoom: 2, pixelsPerSecond: 120 },
        { tier: "draft_motion" }
      );

      const result = await dispatchDebugCommand(
        "motion.timeline.panel",
        { packageRoot },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^timeline-panel-pkg_debug_timeline-/);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.panel",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          durationMs: 500,
          playheadMs: 250,
          layerCount: 1,
          trackCount: 1,
          sceneCount: 1,
          markerCount: 2,
          safeAreaCount: 2,
          protectedRegionCount: 0
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageRoot,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          durationMs: 500,
          fps: 10,
          size: { width: 64, height: 36 },
          controls: {
            packageId: "pkg_debug_timeline",
            motionId: "motion_debug_timeline",
            durationMs: 500,
            playheadMs: 250,
            selectedRange: { startMs: 100, endMs: 400 },
            viewport: { startMs: 0, endMs: 500, zoom: 2, pixelsPerSecond: 120 }
          },
          counts: {
            layers: 1,
            tracks: 1,
            scenes: 1,
            markers: 2,
            keyframedLayers: 0,
            safeAreas: 2
          },
          safeAreas: [
            { id: "action", top: 18, right: 24, bottom: 18, left: 24 },
            { id: "title", top: 36, right: 48, bottom: 36, left: 48 }
          ],
          layers: [
            {
              id: "title",
              type: "text",
              trackId: "overlay",
              startMs: 0,
              durationMs: 500,
              endMs: 500,
              activeAtPlayhead: true,
              textPreview: "A",
              keyframeTargets: [],
              transitionKinds: []
            }
          ],
          tracks: [{ id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] }],
          scenes: [{ id: "intro", name: "Intro", startMs: 0, durationMs: 500, trackIds: ["overlay"], markerIds: ["start", "beat"] }],
          markers: [
            { id: "start", atMs: 0, label: "Start", type: "cue" },
            { id: "beat", atMs: 250, durationMs: 100, label: "Beat", type: "beat" }
          ],
          suggestedActions: expect.arrayContaining([
            { id: "inspect", command: "motion.timeline.inspect", args: { packageRoot } },
            { id: "setPlayhead", command: "motion.timeline.playhead.set", args: { packageRoot } },
            { id: "preview", command: "motion.preview.playhead", args: { packageRoot } }
          ])
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("returns duration policy overlays in the timeline panel", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion["x-shellx-duration-policy"] = {
      schema: "shellx-motion/duration-policy@1",
      minDurationMs: 500,
      maxDurationMs: 1200,
      resizeMode: "stretch-middle",
      protectedRegions: [
        { id: "outro-lock", label: "Outro", role: "outro", startMs: 400, durationMs: 100 },
        { id: "intro-lock", label: "Intro", role: "intro", startMs: 0, durationMs: 80 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");

    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.panel",
        { packageRoot },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.visibleState).toMatchObject({
        panel: "timeline",
        operation: "timeline.panel",
        protectedRegionCount: 2
      });
      expect(result.result).toMatchObject({
        ok: true,
        counts: {
          protectedRegions: 2
        },
        durationPolicy: {
          schema: "shellx-motion/duration-policy@1",
          minDurationMs: 500,
          maxDurationMs: 1200,
          resizeMode: "stretch-middle",
          protectedRegions: [
            { id: "intro-lock", label: "Intro", role: "intro", startMs: 0, durationMs: 80, endMs: 80 },
            { id: "outro-lock", label: "Outro", role: "outro", startMs: 400, durationMs: 100, endMs: 500 }
          ]
        }
      });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  itLinux("returns a panel-ready preview player without rendering frames", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    let rendered = false;
    try {
      await dispatchDebugCommand(
        "motion.timeline.playhead.set",
        { packageRoot, atMs: 250 },
        { tier: "draft_motion" }
      );
      await dispatchDebugCommand(
        "motion.timeline.range.select",
        { packageRoot, startMs: 100, endMs: 400 },
        { tier: "draft_motion" }
      );

      const result = await dispatchDebugCommand(
        "motion.preview.panel" as any,
        { packageRoot },
        {
          tier: "read_motion",
          browserFrameRenderer: async () => {
            rendered = true;
            throw new Error("preview panel should not render");
          }
        }
      );

      expect(rendered).toBe(false);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^preview-panel-pkg_debug_timeline-/);
        expect(result.visibleState).toEqual({
          panel: "preview",
          operation: "preview.panel",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          durationMs: 500,
          fps: 10,
          width: 64,
          height: 36,
          playheadMs: 250,
          layerCount: 1,
          sceneCount: 1,
          markerCount: 2,
          hasSelectedRange: true
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageRoot,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          durationMs: 500,
          fps: 10,
          size: { width: 64, height: 36 },
          controls: {
            packageId: "pkg_debug_timeline",
            motionId: "motion_debug_timeline",
            playheadMs: 250,
            selectedRange: { startMs: 100, endMs: 400 }
          },
          player: {
            playheadMs: 250,
            normalizedProgress: 0.5,
            activeLayerIds: ["title"],
            activeSceneIds: ["intro"],
            activeMarkerIds: ["beat"]
          },
          counts: {
            layers: 1,
            tracks: 1,
            scenes: 1,
            markers: 2,
            keyframedLayers: 0
          },
          previewModes: [
            { id: "frame", label: "Frame", command: "motion.preview.frame", args: { packageRoot, atMs: 250 } },
            { id: "playhead", label: "Playhead", command: "motion.preview.playhead", args: { packageRoot } },
            { id: "strip", label: "Strip", command: "motion.preview.strip", args: { packageRoot } }
          ],
          suggestedActions: expect.arrayContaining([
            { id: "timeline", command: "motion.timeline.panel", args: { packageRoot } },
            { id: "previewPlayhead", command: "motion.preview.playhead", args: { packageRoot } },
            { id: "previewStrip", command: "motion.preview.strip", args: { packageRoot } },
            { id: "render", command: "motion.render.final", args: { packageRoot } },
            { id: "exportPanel", command: "motion.export.panel", args: {} }
          ])
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("keeps timeline panel row associations track-aware, interval-aware, and non-mutating", async () => {
    const packageRoot = await writeDebugPackageWithMultiTrackTimeline();
    const statePath = join(packageRoot, ".shellx-motion", "timeline-state.json");
    try {
      await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const result = await dispatchDebugCommand(
        "motion.timeline.panel",
        { packageRoot },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toMatchObject({
          panel: "timeline",
          operation: "timeline.panel",
          layerCount: 2,
          trackCount: 2,
          sceneCount: 2,
          markerCount: 5
        });
        expect(result.result).toMatchObject({
          ok: true,
          controls: expect.objectContaining({ playheadMs: 0 }),
          layers: [
            expect.objectContaining({
              id: "title",
              trackId: "overlay",
              sceneIds: ["intro"],
              markerIds: ["overlap-in", "inside", "overlap-out"]
            }),
            expect.objectContaining({
              id: "music",
              trackId: "audio",
              sceneIds: ["music-scene"],
              markerIds: ["overlap-in", "inside", "overlap-out"]
            })
          ]
        });
      }
      await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("returns a read-only keyframe panel with animated layers, targets, easing usage, and next actions", async () => {
    const packageRoot = await writeDebugPackageWithKeyframes();
    const statePath = join(packageRoot, ".shellx-motion", "timeline-state.json");
    try {
      await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const result = await dispatchDebugCommand(
        "motion.timeline.keyframes.panel",
        { packageRoot },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^timeline-keyframes-panel-pkg_debug_keyframes-/);
        expect(result.visibleState).toEqual({
          panel: "keyframes",
          operation: "timeline.keyframes.panel",
          packageId: "pkg_debug_keyframes",
          motionId: "motion_debug_keyframes",
          layerCount: 2,
          animatedLayerCount: 2,
          targetCount: 3,
          keyframeCount: 7,
          malformedKeyframeCount: 0,
          easingPresetCount: expect.any(Number),
          animationPresetCount: expect.any(Number)
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageRoot,
          packageId: "pkg_debug_keyframes",
          motionId: "motion_debug_keyframes",
          counts: {
            layers: 2,
            animatedLayers: 2,
            targets: 3,
            keyframes: 7,
            easingPresets: expect.any(Number),
            animationPresets: expect.any(Number)
          },
          layers: [
            expect.objectContaining({
              id: "title",
              type: "text",
              trackId: "overlay",
              keyframeTargetCount: 2,
              keyframeCount: 5,
              targets: expect.arrayContaining([
                expect.objectContaining({
                  target: "opacity",
                  keyframeCount: 3,
                  firstMs: 0,
                  lastMs: 500,
                  easings: ["ease-in-out", "ease-out", "linear"],
                  valueTypes: ["number"]
                }),
                expect.objectContaining({
                  target: "transform.x",
                  keyframeCount: 2,
                  firstMs: 0,
                  lastMs: 500,
                  easings: ["ease-out"],
                  valueTypes: ["number"]
                })
              ])
            }),
            expect.objectContaining({
              id: "panel",
              type: "shape",
              keyframeTargetCount: 1,
              keyframeCount: 2,
              targets: [
                expect.objectContaining({
                  target: "style.fill",
                  keyframeCount: 2,
                  firstMs: 0,
                  lastMs: 500,
                  easings: ["hold"],
                  valueTypes: ["string"]
                })
              ]
            })
          ],
          targets: [
            expect.objectContaining({ layerId: "title", target: "opacity", keyframeCount: 3 }),
            expect.objectContaining({ layerId: "title", target: "transform.x", keyframeCount: 2 }),
            expect.objectContaining({ layerId: "panel", target: "style.fill", keyframeCount: 2 })
          ],
          easingPresets: expect.arrayContaining([
            expect.objectContaining({ id: "linear", easing: "linear" }),
            expect.objectContaining({ id: "ease-out", easing: "ease-out" })
          ]),
          animationPresets: expect.arrayContaining([
            expect.objectContaining({ id: "fade-in" })
          ]),
          suggestedActions: expect.arrayContaining([
            { id: "timeline", command: "motion.timeline.panel", args: { packageRoot } },
            { id: "upsert", command: "motion.timeline.keyframe.upsert", args: { packageRoot } },
            { id: "applyEasing", command: "motion.timeline.keyframe.easing.apply", args: { packageRoot } },
            { id: "shift", command: "motion.timeline.keyframe.shift", args: { packageRoot } },
            { id: "scale", command: "motion.timeline.keyframe.scale", args: { packageRoot } },
            { id: "duplicate", command: "motion.timeline.keyframe.duplicate", args: { packageRoot } },
            { id: "distribute", command: "motion.timeline.keyframe.distribute", args: { packageRoot } },
            { id: "reverse", command: "motion.timeline.keyframe.reverse", args: { packageRoot } },
            { id: "snap", command: "motion.timeline.keyframe.snap", args: { packageRoot } },
            { id: "easingPresets", command: "motion.timeline.easing.presets", args: {} },
            { id: "animationPresets", command: "motion.timeline.animation.presets", args: {} },
            { id: "applyAnimationPreset", command: "motion.timeline.animation.preset.apply", args: { packageRoot } }
          ])
        });
      }
      await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("filters keyframe panel rows by layer id and target without mutating packages", async () => {
    const packageRoot = await writeDebugPackageWithKeyframes();
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.keyframes.panel",
        { packageRoot, layerId: "title", target: "opacity" },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toMatchObject({
          panel: "keyframes",
          layerCount: 1,
          animatedLayerCount: 1,
          targetCount: 1,
          keyframeCount: 3
        });
        expect(result.result).toMatchObject({
          ok: true,
          filter: { layerId: "title", target: "opacity" },
          counts: { layers: 1, animatedLayers: 1, targets: 1, keyframes: 3 },
          layers: [
            expect.objectContaining({
              id: "title",
              targets: [expect.objectContaining({ target: "opacity", keyframeCount: 3 })]
            })
          ],
          targets: [expect.objectContaining({ layerId: "title", target: "opacity", keyframeCount: 3 })]
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("returns a read-only transition panel with enter/exit windows, easing usage, and next actions", async () => {
    const packageRoot = await writeDebugPackageWithTransitions();
    const statePath = join(packageRoot, ".shellx-motion", "timeline-state.json");
    try {
      await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const result = await dispatchDebugCommand(
        "motion.timeline.transitions.panel",
        { packageRoot },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^timeline-transitions-panel-pkg_debug_transitions-/);
        expect(result.visibleState).toEqual({
          panel: "transitions",
          operation: "timeline.transitions.panel",
          packageId: "pkg_debug_transitions",
          motionId: "motion_debug_transitions",
          layerCount: 2,
          transitionLayerCount: 2,
          transitionCount: 3,
          enterTransitionCount: 2,
          exitTransitionCount: 1,
          transitionTypeCount: 3,
          easingPresetCount: expect.any(Number)
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageRoot,
          packageId: "pkg_debug_transitions",
          motionId: "motion_debug_transitions",
          counts: {
            layers: 2,
            transitionLayers: 2,
            transitions: 3,
            enterTransitions: 2,
            exitTransitions: 1,
            transitionTypes: 3,
            easingPresets: expect.any(Number)
          },
          transitionTypes: ["fade", "slide", "wipe"],
          layers: [
            expect.objectContaining({
              id: "title",
              type: "text",
              trackId: "overlay",
              transitionCount: 2,
              transitions: expect.arrayContaining([
                expect.objectContaining({
                  layerId: "title",
                  edge: "in",
                  type: "slide",
                  durationMs: 120,
                  easing: "ease-out",
                  direction: "left",
                  distance: 32,
                  fromMs: 0,
                  toMs: 120
                }),
                expect.objectContaining({
                  layerId: "title",
                  edge: "out",
                  type: "fade",
                  durationMs: 100,
                  easing: "linear",
                  fromMs: 400,
                  toMs: 500
                })
              ])
            }),
            expect.objectContaining({
              id: "panel",
              type: "shape",
              transitionCount: 1,
              transitions: [
                expect.objectContaining({
                  layerId: "panel",
                  edge: "in",
                  type: "wipe",
                  durationMs: 180,
                  easing: "ease-in",
                  direction: "right",
                  fromMs: 50,
                  toMs: 230
                })
              ]
            })
          ],
          transitions: [
            expect.objectContaining({ layerId: "title", edge: "in", type: "slide", key: "title:in" }),
            expect.objectContaining({ layerId: "title", edge: "out", type: "fade", key: "title:out" }),
            expect.objectContaining({ layerId: "panel", edge: "in", type: "wipe", key: "panel:in" })
          ],
          easingPresets: expect.arrayContaining([
            expect.objectContaining({ id: "linear", easing: "linear" }),
            expect.objectContaining({ id: "ease-out", easing: "ease-out" })
          ]),
          suggestedActions: expect.arrayContaining([
            { id: "timeline", command: "motion.timeline.panel", args: { packageRoot } },
            { id: "upsert", command: "motion.timeline.transition.upsert", args: { packageRoot } },
            { id: "delete", command: "motion.timeline.transition.delete", args: { packageRoot } },
            { id: "easingPresets", command: "motion.timeline.easing.presets", args: {} },
            { id: "preview", command: "motion.preview.playhead", args: { packageRoot } }
          ])
        });
      }
      await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("filters transition panel rows by layer id and edge without mutating packages", async () => {
    const packageRoot = await writeDebugPackageWithTransitions();
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.transitions.panel",
        { packageRoot, layerId: "title", edge: "out" },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toMatchObject({
          panel: "transitions",
          layerCount: 1,
          transitionLayerCount: 1,
          transitionCount: 1,
          enterTransitionCount: 0,
          exitTransitionCount: 1
        });
        expect(result.result).toMatchObject({
          ok: true,
          filter: { layerId: "title", edge: "out" },
          counts: {
            layers: 1,
            transitionLayers: 1,
            transitions: 1,
            enterTransitions: 0,
            exitTransitions: 1
          },
          layers: [
            expect.objectContaining({
              id: "title",
              transitions: [expect.objectContaining({ edge: "out", type: "fade", fromMs: 400, toMs: 500 })]
            })
          ],
          transitions: [expect.objectContaining({ layerId: "title", edge: "out", type: "fade", key: "title:out" })]
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("summarizes audio mix inputs, automation, track controls, and export compatibility", async () => {
    const packageRoot = await writeDebugPackageWithAudioMix();
    const statePath = join(packageRoot, ".shellx-motion", "timeline-state.json");
    try {
      await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const result = await dispatchDebugCommand(
        "motion.audio.panel",
        { packageRoot, preset: "gif" },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^audio-panel-pkg_debug_audio_mix-/);
        expect(result.warnings).toEqual(["Export preset gif does not support audio; 2 requested audio tracks will be ignored."]);
        expect(result.visibleState).toEqual({
          panel: "audio",
          operation: "audio.panel",
          packageId: "pkg_debug_audio_mix",
          motionId: "motion_debug_audio_mix",
          audioLayerCount: 2,
          resolvedInputCount: 2,
          duckingCount: 1,
          volumeAutomationKeyframeCount: 4,
          panAutomationKeyframeCount: 2,
          playbackRateControlCount: 1,
          audioTrackCount: 2,
          mutedTrackCount: 0,
          soloTrackCount: 0,
          documentMasterCount: 0,
          documentMasterLoudnessTargetCount: 0,
          warningCount: 1,
          preset: "gif"
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageRoot,
          packageId: "pkg_debug_audio_mix",
          motionId: "motion_debug_audio_mix",
          preset: {
            preset: "gif",
            label: "Animated GIF",
            supportsAudio: false,
            willDropAudio: true,
            warnings: ["Export preset gif does not support audio; 2 requested audio tracks will be ignored."]
          },
          counts: {
            layers: 2,
            resolvedInputs: 2,
            ducking: 1,
            volumeAutomationKeyframes: 4,
            panAutomationKeyframes: 2,
            playbackRateControls: 1,
            audioTracks: 2,
            mutedTracks: 0,
            soloTracks: 0,
            trackVolumeControls: 2,
            trackPanControls: 1,
            trackFadeControls: 1,
            documentMaster: 0,
            documentMasterLoudnessTarget: 0
          },
          tracks: [
            { id: "music-track", type: "audio", muted: false, solo: false, volume: 0.7, pan: -0.2, fadeInMs: 120, fadeOutMs: 180 },
            { id: "voice-track", type: "audio", muted: false, solo: false, volume: 1 }
          ],
          inputs: [
            expect.objectContaining({
              index: 0,
              layerId: "music",
              trackId: "music-track",
              source: "assets/music.wav",
              startMs: 0,
              durationMs: 2400,
              path: join(packageRoot, "assets", "music.wav"),
              volume: 0.42,
              panAutomationKeyframeCount: 2,
              volumeAutomationKeyframeCount: 4,
              ducking: { triggerLayerIds: ["voice"], duckToVolume: 0.2, attackMs: 100, releaseMs: 200 }
            }),
            expect.objectContaining({
              index: 1,
              layerId: "voice",
              trackId: "voice-track",
              source: "assets/voice.wav",
              startMs: 600,
              durationMs: 800,
              path: join(packageRoot, "assets", "voice.wav"),
              volume: 1,
              playbackRate: 1.25
            })
          ],
          suggestedActions: expect.arrayContaining([
            { id: "exportPlan", command: "motion.export.plan", args: { packageRoot, preset: "gif", needsAudio: true } },
            { id: "render", command: "motion.render.final", args: { packageRoot, preset: "gif" } },
            { id: "trackVolume", command: "motion.timeline.track.volume", args: { packageRoot, trackId: "music-track" } },
            { id: "ducking", command: "motion.timeline.layer.ducking.set", args: { packageRoot, layerId: "music" } }
          ])
        });
      }
      await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const motionPath = join(packageRoot, "motion.json");
      const motion = JSON.parse(await readFile(motionPath, "utf8"));
      motion.audio = { master: { volume: 0.9, loudness: { integratedLufs: -16, toleranceLufs: 1, maxTruePeakDbtp: -1 } } };
      await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
      await expect(dispatchDebugCommand("motion.audio.panel", { packageRoot }, { tier: "read_motion" })).resolves.toMatchObject({
        ok: true,
        visibleState: { panel: "audio", documentMasterCount: 1, documentMasterLoudnessTargetCount: 1 },
        result: { counts: { documentMaster: 1, documentMasterLoudnessTarget: 1 } }
      });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("returns structured debug API errors when timeline package loading fails", async () => {
    const packageRoot = join(tmpdir(), "shellx-motion-debug-missing-package");

    await expect(dispatchDebugCommand(
      "motion.timeline.inspect",
      { packageRoot },
      { tier: "read_motion" }
    )).resolves.toMatchObject({
      ok: false,
      error: {
        code: "debug_command_failed",
        message: expect.stringContaining("motion.timeline.inspect failed:")
      },
      warnings: []
    });
  });

  itLinux("persists timeline playhead range and viewport controls through the debug API", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-timeline-controls-receipts-"));
    const statePath = join(packageRoot, ".shellx-motion", "timeline-state.json");
    try {
      const playhead = await dispatchDebugCommand(
        "motion.timeline.playhead.set",
        { packageRoot, atMs: 250, receiptsRoot },
        // The host nominates its receipts root; the fence refuses a caller-named path outside it.
        { tier: "draft_motion", scratchRoot: receiptsRoot }
      );
      const range = await dispatchDebugCommand(
        "motion.timeline.range.select",
        { packageRoot, startMs: 100, endMs: 350, receiptsRoot },
        { tier: "draft_motion", scratchRoot: receiptsRoot }
      );
      const viewport = await dispatchDebugCommand(
        "motion.timeline.viewport.set",
        { packageRoot, startMs: 0, endMs: 500, zoom: 1.5, pixelsPerSecond: 80, receiptsRoot },
        { tier: "draft_motion", scratchRoot: receiptsRoot }
      );
      const state = await dispatchDebugCommand(
        "motion.state",
        { packageRoot, receiptsRoot },
        { tier: "read_motion", scratchRoot: receiptsRoot }
      );

      expect(playhead.ok).toBe(true);
      expect(range.ok).toBe(true);
      expect(viewport.ok).toBe(true);
      if (playhead.ok) {
        expect(playhead.receiptId).toMatch(/^timeline-playhead-pkg_debug_timeline-/);
        expect(playhead.visibleState).toMatchObject({
          panel: "timeline",
          operation: "timeline.playhead.set",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          playheadMs: 250,
          statePath,
          hostReceiptPath: join(receiptsRoot, `${playhead.receiptId}.receipt.json`)
        });
      }
      if (range.ok) {
        expect(range.receiptId).toMatch(/^timeline-range-pkg_debug_timeline-/);
        expect(range.visibleState).toMatchObject({
          panel: "timeline",
          operation: "timeline.range.select",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          selectedRange: { startMs: 100, endMs: 350 },
          statePath,
          hostReceiptPath: join(receiptsRoot, `${range.receiptId}.receipt.json`)
        });
      }
      if (viewport.ok) {
        expect(viewport.receiptId).toMatch(/^timeline-viewport-pkg_debug_timeline-/);
        expect(viewport.visibleState).toMatchObject({
          panel: "timeline",
          operation: "timeline.viewport.set",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          viewport: { startMs: 0, endMs: 500, zoom: 1.5, pixelsPerSecond: 80 },
          statePath,
          hostReceiptPath: join(receiptsRoot, `${viewport.receiptId}.receipt.json`)
        });
      }

      const persistedState = JSON.parse(await readFile(statePath, "utf8"));
      expect(persistedState).toMatchObject({
        schema: "shellx-motion/timeline-state@1",
        packageId: "pkg_debug_timeline",
        motionId: "motion_debug_timeline",
        durationMs: 500,
        playheadMs: 250,
        selectedRange: { startMs: 100, endMs: 350 },
        viewport: { startMs: 0, endMs: 500, zoom: 1.5, pixelsPerSecond: 80 }
      });
      expect(typeof persistedState.updatedAt).toBe("string");

      expect(state.ok).toBe(true);
      if (state.ok) {
        expect(state.result).toMatchObject({
          ok: true,
          timeline: {
            controls: {
              schema: "shellx-motion/timeline-state@1",
              statePath,
              playheadMs: 250,
              selectedRange: { startMs: 100, endMs: 350 },
              viewport: { startMs: 0, endMs: 500, zoom: 1.5, pixelsPerSecond: 80 }
            }
          }
        });
      }

      const viewportReceipt = JSON.parse(await readFile(join(receiptsRoot, `${viewport.ok ? viewport.receiptId : "missing"}.receipt.json`), "utf8"));
      expect(viewportReceipt).toMatchObject({
        operation: "timeline.viewport.set",
        status: "passed",
        packageId: "pkg_debug_timeline",
        lane: "debug-api",
        output: {
          statePath,
          controls: {
            playheadMs: 250,
            selectedRange: { startMs: 100, endMs: 350 },
            viewport: { startMs: 0, endMs: 500, zoom: 1.5, pixelsPerSecond: 80 }
          }
        }
      });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(receiptsRoot, { recursive: true, force: true });
    }
  });

  it("reads missing duration policy through the debug API", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.duration.policy",
        { packageRoot },
        { tier: "read_motion" }
      );

      expect(result).toMatchObject({
        ok: true,
        receiptId: expect.stringMatching(/^timeline-duration-policy-pkg_debug_timeline-/),
        visibleState: {
          panel: "timeline",
          operation: "timeline.duration.policy",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          hasPolicy: false,
          protectedRegionCount: 0,
          durationMs: 500
        },
        result: {
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          durationMs: 500,
          policy: null,
          protectedRegions: []
        },
        warnings: []
      });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("sets timeline duration policy with protected-region receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-duration-policy-"));
    const receiptsRoot = join(outDir, "host-receipts");
    const policy = {
      minDurationMs: 500,
      maxDurationMs: 2000,
      resizeMode: "stretch-middle",
      protectedRegions: [
        { id: "intro", label: "Intro lock", role: "intro", startMs: 0, durationMs: 120 },
        { id: "outro", label: "Outro lock", role: "outro", startMs: 420, durationMs: 80 }
      ]
    };
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.duration.policy.set",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          policy,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-duration-policy.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion["x-shellx-duration-policy"]).toEqual({
          schema: "shellx-motion/duration-policy@1",
          minDurationMs: 500,
          maxDurationMs: 2000,
          resizeMode: "stretch-middle",
          protectedRegions: [
            { id: "intro", label: "Intro lock", role: "intro", startMs: 0, durationMs: 120 },
            { id: "outro", label: "Outro lock", role: "outro", startMs: 420, durationMs: 80 }
          ]
        });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.duration.policy.set",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          hasPolicy: true,
          protectedRegionCount: 2,
          durationMs: 500,
          minDurationMs: 500,
          maxDurationMs: 2000,
          resizeMode: "stretch-middle",
          changedPath: "/x-shellx-duration-policy",
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPath: "/x-shellx-duration-policy",
          changedPaths: ["/x-shellx-duration-policy"],
          previousPolicy: null,
          policy: patchedMotion["x-shellx-duration-policy"],
          protectedRegions: patchedMotion["x-shellx-duration-policy"].protectedRegions,
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.duration.policy.set",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            changedPath: "/x-shellx-duration-policy",
            changedPaths: ["/x-shellx-duration-policy"],
            previousPolicy: null,
            policy: patchedMotion["x-shellx-duration-policy"],
            protectedRegions: patchedMotion["x-shellx-duration-policy"].protectedRegions,
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid protected regions before copying packages", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-duration-policy-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.duration.policy.set",
        {
          packageRoot,
          outDir,
          policy: {
            protectedRegions: [
              { id: "too-long", startMs: 450, durationMs: 80 }
            ]
          }
        },
        { tier: "edit_motion" }
      );

      expect(result).toEqual({
        ok: false,
        error: {
          code: "invalid_args",
          message: "protectedRegions[too-long] must end within motion duration."
        },
        warnings: []
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid duration policy metadata before copying packages", async () => {
    const cases: Array<{ name: string; policy: unknown; message: string }> = [
      {
        name: "min greater than max",
        policy: { minDurationMs: 800, maxDurationMs: 500 },
        message: "minDurationMs must be less than or equal to maxDurationMs."
      },
      {
        name: "unsupported resize mode",
        policy: { resizeMode: "elastic" },
        message: "resizeMode must be stretch-middle, ripple, or fixed."
      },
      {
        name: "duplicate protected region ids",
        policy: {
          protectedRegions: [
            { id: "intro", startMs: 0, durationMs: 100 },
            { id: "intro", startMs: 200, durationMs: 100 }
          ]
        },
        message: "protectedRegions[intro] id must be unique."
      }
    ];

    for (const invalidCase of cases) {
      const packageRoot = await writeDebugPackageWithTimeline();
      const root = await mkdtemp(join(tmpdir(), `shellx-motion-debug-duration-policy-${invalidCase.name.replace(/[^a-z0-9]+/gi, "-")}-`));
      const outDir = join(root, "package");
      try {
        const result = await dispatchDebugCommand(
          "motion.timeline.duration.policy.set",
          {
            packageRoot,
            outDir,
            policy: invalidCase.policy
          },
          { tier: "edit_motion" }
        );

        expect(result).toEqual({
          ok: false,
          error: {
            code: "invalid_args",
            message: invalidCase.message
          },
          warnings: []
        });
        await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow(/ENOENT/);
      } finally {
        await rm(packageRoot, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("cleans timeline refs through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.durationMs = 500;
    motion.layers[0].durationMs = 700;
    motion.tracks[0].layerIds = ["title", "missing-layer", "title"];
    motion.scenes[0].trackIds = ["overlay", "missing-track", "overlay"];
    motion.scenes[0].markerIds = ["start", "missing-marker", "beat", "beat"];
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-timeline-cleanup-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.cleanup",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-cleanup.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.durationMs).toBe(700);
        expect(patchedMotion.tracks[0].layerIds).toEqual(["title"]);
        expect(patchedMotion.scenes[0].trackIds).toEqual(["overlay"]);
        expect(patchedMotion.scenes[0].markerIds).toEqual(["start", "beat"]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.cleanup",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          changedPaths: ["/tracks/overlay/layerIds", "/scenes/intro/trackIds", "/scenes/intro/markerIds", "/durationMs"],
          removedRefCount: 6,
          oldDurationMs: 500,
          newDurationMs: 700,
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          changedPaths: ["/tracks/overlay/layerIds", "/scenes/intro/trackIds", "/scenes/intro/markerIds", "/durationMs"],
          removedTrackLayerRefs: [
            { trackId: "overlay", layerId: "missing-layer", reason: "missing" },
            { trackId: "overlay", layerId: "title", reason: "duplicate" }
          ],
          removedSceneTrackRefs: [
            { sceneId: "intro", trackId: "missing-track", reason: "missing" },
            { sceneId: "intro", trackId: "overlay", reason: "duplicate" }
          ],
          removedSceneMarkerRefs: [
            { sceneId: "intro", markerId: "missing-marker", reason: "missing" },
            { sceneId: "intro", markerId: "beat", reason: "duplicate" }
          ],
          oldDurationMs: 500,
          newDurationMs: 700,
          durationChanged: true
        });
        expect(receipt.operation).toBe("timeline.cleanup");
        expect(receipt.output.validation).toEqual({ ok: true });
        expect(hostReceipt.operation).toBe("timeline.cleanup");
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("refuses no-op timeline cleanup before copying packages", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-timeline-cleanup-noop-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.cleanup",
        { packageRoot, outDir },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "timeline_cleanup_failed",
          message: "Timeline cleanup did not change anything."
        });
      }
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("resizes timeline scenes through the debug API with ripple receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.durationMs = 1000;
    motion.scenes = [
      { id: "intro", name: "Intro", startMs: 0, durationMs: 500, trackIds: ["overlay"], markerIds: ["start"] },
      { id: "outro", name: "Outro", startMs: 500, durationMs: 500, trackIds: ["overlay"], markerIds: ["beat"] }
    ];
    motion.markers = [
      { id: "start", atMs: 0, label: "Start", type: "cue" },
      { id: "beat", atMs: 500, durationMs: 100, label: "Beat", type: "beat" }
    ];
    motion.layers[0].durationMs = 300;
    motion.layers.push({
      id: "outro_title",
      type: "text",
      text: "B",
      trackId: "overlay",
      startMs: 500,
      durationMs: 300
    });
    motion.tracks[0].layerIds = ["title", "outro_title"];
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-scene-resize-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.scene.resize",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          sceneId: "intro",
          durationMs: 800,
          ripple: true,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-scene-resize.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.durationMs).toBe(1300);
        expect(patchedMotion.scenes).toEqual([
          { id: "intro", name: "Intro", startMs: 0, durationMs: 800, trackIds: ["overlay"], markerIds: ["start"] },
          { id: "outro", name: "Outro", startMs: 800, durationMs: 500, trackIds: ["overlay"], markerIds: ["beat"] }
        ]);
        expect(patchedMotion.layers[1]).toMatchObject({ id: "outro_title", startMs: 800 });
        expect(patchedMotion.markers[1]).toMatchObject({ id: "beat", atMs: 800 });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.scene.resize",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          sceneId: "intro",
          oldDurationMs: 500,
          newDurationMs: 800,
          deltaMs: 300,
          ripple: true,
          changedPaths: [
            "/scenes/intro/durationMs",
            "/scenes/outro/startMs",
            "/layers/outro_title/startMs",
            "/markers/beat/atMs",
            "/durationMs"
          ],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: [
            "/scenes/intro/durationMs",
            "/scenes/outro/startMs",
            "/layers/outro_title/startMs",
            "/markers/beat/atMs",
            "/durationMs"
          ],
          action: "resized",
          sceneId: "intro",
          oldDurationMs: 500,
          newDurationMs: 800,
          deltaMs: 300,
          ripple: true,
          shiftedSceneIds: ["outro"],
          shiftedLayerIds: ["outro_title"],
          shiftedMarkerIds: ["beat"],
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.scene.resize",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            sceneId: "intro",
            oldDurationMs: 500,
            newDurationMs: 800,
            deltaMs: 300,
            ripple: true,
            shiftedSceneIds: ["outro"],
            shiftedLayerIds: ["outro_title"],
            shiftedMarkerIds: ["beat"],
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("resizes scenes through the debug API while keeping duration policy protected regions synced", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.durationMs = 1000;
    motion.scenes = [
      { id: "intro", name: "Intro", startMs: 0, durationMs: 200, trackIds: ["overlay"], markerIds: ["start"] },
      { id: "middle", name: "Middle", startMs: 200, durationMs: 600, trackIds: ["overlay"] },
      { id: "outro", name: "Outro", startMs: 800, durationMs: 200, trackIds: ["overlay"], markerIds: ["beat"] }
    ];
    motion.markers = [
      { id: "start", atMs: 0, label: "Start", type: "cue" },
      { id: "beat", atMs: 800, durationMs: 100, label: "Beat", type: "beat" }
    ];
    motion.layers[0].durationMs = 200;
    motion.layers.push({
      id: "outro_title",
      type: "text",
      text: "B",
      trackId: "overlay",
      startMs: 800,
      durationMs: 200
    });
    motion.tracks[0].layerIds = ["title", "outro_title"];
    motion["x-shellx-duration-policy"] = {
      schema: "shellx-motion/duration-policy@1",
      minDurationMs: 800,
      maxDurationMs: 1400,
      resizeMode: "stretch-middle",
      protectedRegions: [
        { id: "intro-lock", role: "intro", startMs: 0, durationMs: 120 },
        { id: "outro-lock", role: "outro", startMs: 800, durationMs: 200 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-scene-resize-policy-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.scene.resize",
        {
          packageRoot,
          outDir,
          sceneId: "middle",
          durationMs: 800,
          ripple: true
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
        expect(patchedMotion.durationMs).toBe(1200);
        expect(patchedMotion["x-shellx-duration-policy"].protectedRegions).toEqual([
          { id: "intro-lock", role: "intro", startMs: 0, durationMs: 120 },
          { id: "outro-lock", role: "outro", startMs: 1000, durationMs: 200 }
        ]);
        expect(result.visibleState).toMatchObject({
          panel: "timeline",
          operation: "timeline.scene.resize",
          sceneId: "middle",
          oldDurationMs: 600,
          newDurationMs: 800,
          deltaMs: 200,
          ripple: true,
          changedPaths: [
            "/scenes/middle/durationMs",
            "/scenes/outro/startMs",
            "/layers/outro_title/startMs",
            "/markers/beat/atMs",
            "/x-shellx-duration-policy/protectedRegions/outro-lock/startMs",
            "/durationMs"
          ]
        });
        expect(result.result).toMatchObject({
          ok: true,
          changedPaths: [
            "/scenes/middle/durationMs",
            "/scenes/outro/startMs",
            "/layers/outro_title/startMs",
            "/markers/beat/atMs",
            "/x-shellx-duration-policy/protectedRegions/outro-lock/startMs",
            "/durationMs"
          ],
          validation: { ok: true }
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("creates timeline scenes through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-scene-create-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.scene.create",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          sceneId: "outro",
          name: "Outro",
          startMs: 500,
          durationMs: 250,
          trackIds: ["overlay"],
          markerIds: ["beat"],
          index: 1,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-scene-create.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.durationMs).toBe(750);
        expect(patchedMotion.scenes).toEqual([
          { id: "intro", name: "Intro", startMs: 0, durationMs: 500, trackIds: ["overlay"], markerIds: ["start", "beat"] },
          { id: "outro", name: "Outro", startMs: 500, durationMs: 250, trackIds: ["overlay"], markerIds: ["beat"] }
        ]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.scene.create",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          sceneId: "outro",
          index: 1,
          action: "created",
          oldSceneCount: 1,
          newSceneCount: 2,
          oldDurationMs: 500,
          newDurationMs: 750,
          durationChanged: true,
          changedPaths: ["/scenes/outro", "/durationMs"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/scenes/outro", "/durationMs"],
          action: "created",
          sceneId: "outro",
          index: 1,
          scene: { id: "outro", name: "Outro", startMs: 500, durationMs: 250, trackIds: ["overlay"], markerIds: ["beat"] },
          referencedTrackIds: ["overlay"],
          referencedMarkerIds: ["beat"],
          oldSceneCount: 1,
          newSceneCount: 2,
          oldDurationMs: 500,
          newDurationMs: 750,
          durationChanged: true,
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.scene.create",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            sceneId: "outro",
            index: 1,
            scene: { id: "outro", name: "Outro", startMs: 500, durationMs: 250, trackIds: ["overlay"], markerIds: ["beat"] },
            referencedTrackIds: ["overlay"],
            referencedMarkerIds: ["beat"],
            oldSceneCount: 1,
            newSceneCount: 2,
            oldDurationMs: 500,
            newDurationMs: 750,
            durationChanged: true,
            changedPaths: ["/scenes/outro", "/durationMs"],
            action: "created",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline scene create args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-scene-create-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.scene.create",
        {
          packageRoot,
          outDir,
          sceneId: "outro",
          startMs: 500
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "durationMs must be a positive number."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("deletes timeline scenes through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.scenes.push({ id: "outro", name: "Outro", startMs: 500, durationMs: 250, trackIds: ["overlay"], markerIds: ["beat"] });
    sourceMotion.durationMs = 750;
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-scene-delete-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.scene.delete",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          sceneId: "outro",
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-scene-delete.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.durationMs).toBe(750);
        expect(patchedMotion.tracks).toEqual(sourceMotion.tracks);
        expect(patchedMotion.markers).toEqual(sourceMotion.markers);
        expect(patchedMotion.layers).toEqual(sourceMotion.layers);
        expect(patchedMotion.scenes).toEqual([
          { id: "intro", name: "Intro", startMs: 0, durationMs: 500, trackIds: ["overlay"], markerIds: ["start", "beat"] }
        ]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.scene.delete",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          sceneId: "outro",
          index: 1,
          action: "deleted",
          oldSceneCount: 2,
          newSceneCount: 1,
          oldDurationMs: 750,
          newDurationMs: 750,
          durationChanged: false,
          changedPaths: ["/scenes/outro"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/scenes/outro"],
          action: "deleted",
          sceneId: "outro",
          index: 1,
          removed: { id: "outro", name: "Outro", startMs: 500, durationMs: 250, trackIds: ["overlay"], markerIds: ["beat"] },
          oldSceneCount: 2,
          newSceneCount: 1,
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.scene.delete",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            sceneId: "outro",
            index: 1,
            removed: { id: "outro", name: "Outro", startMs: 500, durationMs: 250, trackIds: ["overlay"], markerIds: ["beat"] },
            oldSceneCount: 2,
            newSceneCount: 1,
            changedPaths: ["/scenes/outro"],
            action: "deleted",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline scene delete args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-scene-delete-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.scene.delete",
        {
          packageRoot,
          outDir
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "motion.timeline.scene.delete requires sceneId."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("reorders timeline scenes through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.scenes.push({ id: "outro", name: "Outro", startMs: 500, durationMs: 250, trackIds: ["overlay"], markerIds: ["beat"] });
    sourceMotion.durationMs = 750;
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-scene-reorder-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.scene.reorder",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          sceneId: "outro",
          index: 0,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-scene-reorder.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.durationMs).toBe(750);
        expect(patchedMotion.tracks).toEqual(sourceMotion.tracks);
        expect(patchedMotion.markers).toEqual(sourceMotion.markers);
        expect(patchedMotion.layers).toEqual(sourceMotion.layers);
        expect(patchedMotion.scenes).toEqual([
          { id: "outro", name: "Outro", startMs: 500, durationMs: 250, trackIds: ["overlay"], markerIds: ["beat"] },
          { id: "intro", name: "Intro", startMs: 0, durationMs: 500, trackIds: ["overlay"], markerIds: ["start", "beat"] }
        ]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.scene.reorder",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          sceneId: "outro",
          action: "reordered",
          oldIndex: 1,
          newIndex: 0,
          oldSceneOrder: ["intro", "outro"],
          newSceneOrder: ["outro", "intro"],
          oldDurationMs: 750,
          newDurationMs: 750,
          durationChanged: false,
          changedPaths: ["/scenes"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/scenes"],
          action: "reordered",
          sceneId: "outro",
          oldIndex: 1,
          newIndex: 0,
          oldSceneOrder: ["intro", "outro"],
          newSceneOrder: ["outro", "intro"],
          scene: { id: "outro", name: "Outro", startMs: 500, durationMs: 250, trackIds: ["overlay"], markerIds: ["beat"] },
          oldDurationMs: 750,
          newDurationMs: 750,
          durationChanged: false,
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.scene.reorder",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            sceneId: "outro",
            oldIndex: 1,
            newIndex: 0,
            oldSceneOrder: ["intro", "outro"],
            newSceneOrder: ["outro", "intro"],
            scene: { id: "outro", name: "Outro", startMs: 500, durationMs: 250, trackIds: ["overlay"], markerIds: ["beat"] },
            oldDurationMs: 750,
            newDurationMs: 750,
            durationChanged: false,
            changedPaths: ["/scenes"],
            action: "reordered",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline scene reorder args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-scene-reorder-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.scene.reorder",
        {
          packageRoot,
          outDir,
          sceneId: "intro",
          index: -1
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "index must be a non-negative integer."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("sets timeline scene display names through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-scene-name-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.scene.name.set",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          sceneId: "intro",
          name: "Cold Open",
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-scene-name-set.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.scenes.find((scene: { id: string }) => scene.id === "intro")).toMatchObject({
          id: "intro",
          name: "Cold Open"
        });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.scene.name.set",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          sceneId: "intro",
          action: "renamed",
          oldName: "Intro",
          newName: "Cold Open",
          changedPaths: ["/scenes/intro/name"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/scenes/intro/name"],
          action: "renamed",
          sceneId: "intro",
          oldName: "Intro",
          newName: "Cold Open",
          scene: expect.objectContaining({ id: "intro", name: "Cold Open" }),
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.scene.name.set",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            sceneId: "intro",
            oldName: "Intro",
            newName: "Cold Open",
            changedPaths: ["/scenes/intro/name"],
            action: "renamed",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("accepts value as a direct debug API alias for timeline scene display names", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-scene-name-value-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.scene.name.set",
        {
          packageRoot,
          outDir,
          sceneId: "intro",
          value: "Value Alias Scene"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          sceneId: "intro",
          oldName: "Intro",
          newName: "Value Alias Scene",
          changedPaths: ["/scenes/intro/name"]
        });
        const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
        expect(patchedMotion.scenes.find((scene: { id: string }) => scene.id === "intro")).toMatchObject({
          id: "intro",
          name: "Value Alias Scene"
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline scene name args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-scene-name-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.scene.name.set",
        {
          packageRoot,
          outDir,
          sceneId: "intro"
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "motion.timeline.scene.name.set requires name."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("upserts timeline markers through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-marker-upsert-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.marker.upsert",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          id: "outro",
          atMs: 420,
          durationMs: 80,
          label: "Outro",
          type: "cue",
          color: "#ffaa00",
          sceneId: "intro",
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-marker-upsert.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.markers).toEqual([
          { id: "start", atMs: 0, label: "Start", type: "cue" },
          { id: "beat", atMs: 250, durationMs: 100, label: "Beat", type: "beat" },
          { id: "outro", atMs: 420, durationMs: 80, label: "Outro", type: "cue", color: "#ffaa00" }
        ]);
        expect(patchedMotion.scenes[0].markerIds).toEqual(["start", "beat", "outro"]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.marker.upsert",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          markerId: "outro",
          action: "inserted",
          changedPath: "/markers/2",
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPath: "/markers/2",
          changedPaths: ["/markers/2", "/scenes/0/markerIds"],
          action: "inserted",
          marker: { id: "outro", atMs: 420, durationMs: 80, label: "Outro", type: "cue", color: "#ffaa00" },
          previousMarker: undefined,
          attachedSceneId: "intro",
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.marker.upsert",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            markerId: "outro",
            atMs: 420,
            durationMs: 80,
            label: "Outro",
            type: "cue",
            color: "#ffaa00",
            sceneId: "intro",
            changedPath: "/markers/2",
            changedPaths: ["/markers/2", "/scenes/0/markerIds"],
            action: "inserted",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects symlinked marker upsert output paths that resolve inside the source package", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const symlinkRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-marker-symlink-"));
    const linkPath = join(symlinkRoot, "source-parent");
    const outDir = join(linkPath, basename(packageRoot));
    const motionPath = join(packageRoot, "motion.json");
    await symlink(dirname(packageRoot), linkPath, process.platform === "win32" ? "junction" : "dir");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.marker.upsert",
        {
          packageRoot,
          outDir,
          id: "unsafe",
          atMs: 100
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "invalid_args",
          message: "motion.timeline.marker.upsert outDir must be outside packageRoot."
        });
      }
      await expect(readFile(motionPath, "utf8")).resolves.toContain("motion_debug_timeline");
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(symlinkRoot, { recursive: true, force: true });
    }
  });

  it("rejects marker upsert output dirs that already contain files", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-marker-upsert-non-empty-"));
    const sentinelPath = join(outDir, "sentinel.txt");
    await writeFile(sentinelPath, "keep", "utf8");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.marker.upsert",
        {
          packageRoot,
          outDir,
          id: "unsafe",
          atMs: 100
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "invalid_args",
          message: "motion.timeline.marker.upsert outDir must be empty or absent before package copy."
        });
      }
      await expect(readFile(sentinelPath, "utf8")).resolves.toBe("keep");
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("deletes timeline markers through the debug API and prunes scene refs", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-marker-delete-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.marker.delete",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          id: "beat",
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-marker-delete.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.markers).toEqual([{ id: "start", atMs: 0, label: "Start", type: "cue" }]);
        expect(patchedMotion.scenes[0].markerIds).toEqual(["start"]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.marker.delete",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          markerId: "beat",
          action: "deleted",
          changedPath: "/markers/1",
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPath: "/markers/1",
          changedPaths: ["/markers/1", "/scenes/0/markerIds"],
          action: "deleted",
          removed: { id: "beat", atMs: 250, durationMs: 100, label: "Beat", type: "beat" },
          remainingCount: 1,
          removedSceneRefs: ["intro"],
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.marker.delete",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            markerId: "beat",
            changedPath: "/markers/1",
            changedPaths: ["/markers/1", "/scenes/0/markerIds"],
            action: "deleted",
            removed: { id: "beat", atMs: 250, durationMs: 100, label: "Beat", type: "beat" },
            remainingCount: 1,
            removedSceneRefs: ["intro"],
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects symlinked marker delete output paths that resolve inside the source package", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const symlinkRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-marker-delete-symlink-"));
    const linkPath = join(symlinkRoot, "source-parent");
    const outDir = join(linkPath, basename(packageRoot));
    const motionPath = join(packageRoot, "motion.json");
    await symlink(dirname(packageRoot), linkPath, process.platform === "win32" ? "junction" : "dir");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.marker.delete",
        {
          packageRoot,
          outDir,
          id: "beat"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "invalid_args",
          message: "motion.timeline.marker.delete outDir must be outside packageRoot."
        });
      }
      await expect(readFile(motionPath, "utf8")).resolves.toContain("motion_debug_timeline");
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(symlinkRoot, { recursive: true, force: true });
    }
  });

  it("rejects marker delete output dirs that already contain files", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-marker-delete-non-empty-"));
    const sentinelPath = join(outDir, "sentinel.txt");
    await writeFile(sentinelPath, "keep", "utf8");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.marker.delete",
        {
          packageRoot,
          outDir,
          id: "beat"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "invalid_args",
          message: "motion.timeline.marker.delete outDir must be empty or absent before package copy."
        });
      }
      await expect(readFile(sentinelPath, "utf8")).resolves.toBe("keep");
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("creates timeline layers through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-create-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.create",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layer: {
            id: "subtitle",
            type: "text",
            text: "Subtitle",
            trackId: "overlay",
            startMs: 400,
            durationMs: 200,
            style: { color: "#ffffff", fontSize: 16 }
          },
          index: 1,
          trackIndex: 1,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-create.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.durationMs).toBe(600);
        expect(patchedMotion.layers).toEqual([
          expect.objectContaining({ id: "title", startMs: 0, durationMs: 500, trackId: "overlay" }),
          expect.objectContaining({
            id: "subtitle",
            type: "text",
            text: "Subtitle",
            trackId: "overlay",
            startMs: 400,
            durationMs: 200,
            style: { color: "#ffffff", fontSize: 16 }
          })
        ]);
        expect(patchedMotion.tracks[0].layerIds).toEqual(["title", "subtitle"]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.create",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "subtitle",
          action: "created",
          index: 1,
          trackId: "overlay",
          trackIndex: 1,
          changedPaths: ["/layers/subtitle", "/tracks/0/layerIds", "/durationMs"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/subtitle", "/tracks/0/layerIds", "/durationMs"],
          action: "created",
          layerId: "subtitle",
          index: 1,
          trackId: "overlay",
          trackIndex: 1,
          oldLayerCount: 1,
          newLayerCount: 2,
          layer: { id: "subtitle", type: "text", text: "Subtitle", startMs: 400, durationMs: 200 },
          insertedTrackRefs: ["overlay"],
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.create",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "subtitle",
            index: 1,
            trackId: "overlay",
            trackIndex: 1,
            changedPaths: ["/layers/subtitle", "/tracks/0/layerIds", "/durationMs"],
            action: "created",
            oldLayerCount: 1,
            newLayerCount: 2,
            insertedTrackRefs: ["overlay"],
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("preserves advanced timeline layer fields through debug API layer creation", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-create-advanced-"));
    const advancedLayer = {
      id: "product",
      type: "image",
      source: "https://example.com/product.png",
      trackId: "overlay",
      startMs: 50,
      durationMs: 300,
      width: 32,
      height: 18,
      opacity: 0.9,
      visible: true,
      locked: false,
      fit: "cover",
      crop: { x: 0, y: 0, width: 32, height: 18 },
      allowedOrigins: ["https://example.com"],
      transform: { x: 4, y: 5, width: 32, height: 18, opacity: 0.8, scale: 1.1, rotation: 2, originX: 0, originY: 0 },
      keyframes: {
        "transform.x": [
          { atMs: 0, value: 4, easing: "ease-out" },
          { atMs: 250, value: 12 }
        ],
        "crop.x": [{ atMs: 0, value: 0 }]
      },
      transitions: {
        in: { type: "fade", durationMs: 100, easing: "ease-out" },
        out: { type: "slide", durationMs: 80, direction: "left", distance: 10 }
      },
      mask: { type: "rounded-rect", inset: { top: 1, right: 2, bottom: 3, left: 4 }, radius: 2 },
      effects: { blur: 0, brightness: 1, contrast: 1, saturate: 1, grayscale: 0 },
      blendMode: "multiply",
      ducking: { triggerLayerIds: ["title"], duckToVolume: 0.5, attackMs: 25, releaseMs: 75 },
      style: { color: "#ffffff", fontSize: 16 },
      label: { text: "Product" }
    };
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.create",
        {
          packageRoot,
          outDir,
          layer: advancedLayer,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
        const createdLayer = patchedMotion.layers.find((layer: { id?: string }) => layer.id === "product");

        expect(createdLayer).toMatchObject(advancedLayer);
        expect(patchedMotion.tracks[0].layerIds).toEqual(["title", "product"]);
        expect(result.result).toMatchObject({
          ok: true,
          action: "created",
          layerId: "product",
          trackId: "overlay",
          validation: { ok: true },
          layer: expect.objectContaining(advancedLayer)
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("creates bounded snow environments through the agent-facing layer API", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-create-snow-"));
    const environment = {
      schema: "shellx-motion/environment@1",
      kind: "snow",
      seed: 20260715,
      quality: "cinematic",
      mode: "scene",
      backgroundColor: "#07111F",
      snowColor: "#F8FCFF",
      shadowColor: "#8BA7C1",
      lightColor: "#C7E7FF",
      fall: { intensity: 0.72, speed: 0.68, wind: 0.22, turbulence: 0.48, flakeSize: 1.15, depthLayers: 4, focusFalloff: 0.62 },
      ground: { horizon: 0.63, accumulation: 0.7, drift: 0.52, contactAmount: 0.46 },
      atmosphere: { haze: 0.3, depthFade: 0.58 }
    };
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.create",
        {
          packageRoot,
          outDir,
          layer: {
            id: "snow-stage",
            type: "environment",
            startMs: 0,
            durationMs: 6000,
            transform: { x: 0, y: 0, width: 1920, height: 1080 },
            environment,
            keyframes: {
              "environment.fall.intensity": [{ atMs: 0, value: 0.2 }, { atMs: 3000, value: 0.9, easing: "ease-in-out" }],
              "environment.ground.accumulation": [{ atMs: 0, value: 0.3 }, { atMs: 6000, value: 0.8 }]
            }
          }
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
        const createdLayer = patchedMotion.layers.find((layer: { id?: string }) => layer.id === "snow-stage");
        expect(createdLayer).toMatchObject({ type: "environment", environment });
        expect(createdLayer.keyframes["environment.fall.intensity"]).toHaveLength(2);
        expect(result.result).toMatchObject({ action: "created", layerId: "snow-stage", validation: { ok: true } });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects executable fields in agent-created environments before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-create-hostile-environment-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.create",
        {
          packageRoot,
          outDir,
          layer: {
            id: "hostile-rain",
            type: "environment",
            startMs: 0,
            durationMs: 1000,
            environment: {
              schema: "shellx-motion/environment@1", kind: "rain", seed: 1, quality: "preview", mode: "scene",
              intensity: 0.5, wind: 0, dropSpeed: 1, dropLength: 1, depthLayers: 2,
              color: "#FFFFFF", backgroundColor: "#000000", lightColor: "#FFFFFF", accentColor: "#FFFFFF",
              ground: { horizon: 0.5, wetness: 0.5, roughness: 0.5, rippleAmount: 0.5, splashAmount: 0.5, reflectionStrength: 0.5 },
              atmosphere: { mist: 0.5, lensDroplets: 0.5 },
              code: "fetch('https://example.test')"
            }
          }
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline layer create args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-create-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.create",
        {
          packageRoot,
          outDir,
          layerId: "subtitle",
          type: "text",
          startMs: Number.NaN,
          durationMs: 200
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "startMs must be a non-negative number."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline layer create numeric style args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-create-invalid-style-"));
    try {
      const fontSize = await dispatchDebugCommand(
        "motion.timeline.layer.create",
        {
          packageRoot,
          outDir,
          layerId: "subtitle",
          type: "text",
          startMs: 0,
          durationMs: 200,
          fontSize: Number.NaN
        },
        { tier: "edit_motion" }
      );
      const width = await dispatchDebugCommand(
        "motion.timeline.layer.create",
        {
          packageRoot,
          outDir,
          layerId: "subtitle",
          type: "shape",
          startMs: 0,
          durationMs: 200,
          width: 0
        },
        { tier: "edit_motion" }
      );
      const height = await dispatchDebugCommand(
        "motion.timeline.layer.create",
        {
          packageRoot,
          outDir,
          layerId: "subtitle",
          type: "shape",
          startMs: 0,
          durationMs: 200,
          height: Number.POSITIVE_INFINITY
        },
        { tier: "edit_motion" }
      );

      expect(fontSize).toMatchObject({
        ok: false,
        error: { code: "invalid_args", message: "fontSize must be a positive number." }
      });
      expect(width).toMatchObject({
        ok: false,
        error: { code: "invalid_args", message: "width must be a positive number." }
      });
      expect(height).toMatchObject({
        ok: false,
        error: { code: "invalid_args", message: "height must be a positive number." }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("splits timeline layers through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-split-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.split",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          atMs: 200,
          newLayerId: "title_tail",
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-split.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers).toEqual([
          expect.objectContaining({ id: "title", startMs: 0, durationMs: 200, trackId: "overlay" }),
          expect.objectContaining({ id: "title_tail", startMs: 200, durationMs: 300, trackId: "overlay" })
        ]);
        expect(patchedMotion.tracks[0].layerIds).toEqual(["title", "title_tail"]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.split",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          newLayerId: "title_tail",
          atMs: 200,
          action: "split",
          changedPaths: ["/layers/title/durationMs", "/layers/title_tail", "/tracks/0/layerIds"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/title/durationMs", "/layers/title_tail", "/tracks/0/layerIds"],
          action: "split",
          layerId: "title",
          newLayerId: "title_tail",
          atMs: 200,
          originalLayer: { id: "title", durationMs: 200 },
          newLayer: { id: "title_tail", startMs: 200, durationMs: 300 },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.split",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            newLayerId: "title_tail",
            atMs: 200,
            splitOffsetMs: 200,
            changedPaths: ["/layers/title/durationMs", "/layers/title_tail", "/tracks/0/layerIds"],
            action: "split",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("sets timeline layer text through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-text-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.text.set",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          text: "Updated title",
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-text-set.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0]).toMatchObject({ id: "title", text: "Updated title" });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.text.set",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          action: "updated",
          oldText: "A",
          newText: "Updated title",
          changedPaths: ["/layers/title/text"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/title/text"],
          action: "updated",
          layerId: "title",
          oldText: "A",
          newText: "Updated title",
          layer: { id: "title", type: "text", text: "Updated title" },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.text.set",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            oldText: "A",
            newText: "Updated title",
            changedPaths: ["/layers/title/text"],
            action: "updated",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline layer text args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-text-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.text.set",
        {
          packageRoot,
          outDir,
          layerId: "title"
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "motion.timeline.layer.text.set requires text."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects non-string timeline layer text args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-text-non-string-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.text.set",
        {
          packageRoot,
          outDir,
          layerId: "title",
          text: 123
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "motion.timeline.layer.text.set requires text."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("sets timeline layer style through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-style-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.style.set",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          property: "color",
          value: "#13d3ff",
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-style-set.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0]).toMatchObject({ id: "title", style: { color: "#13d3ff" } });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.style.set",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          property: "color",
          action: "updated",
          oldValue: null,
          newValue: "#13d3ff",
          changedPaths: ["/layers/title/style/color"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/title/style/color"],
          action: "updated",
          layerId: "title",
          property: "color",
          oldValue: null,
          newValue: "#13d3ff",
          layer: { id: "title", type: "text", text: "A", trackId: "overlay", startMs: 0, durationMs: 500, style: { color: "#13d3ff" } },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.style.set",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            property: "color",
            oldValue: null,
            newValue: "#13d3ff",
            changedPaths: ["/layers/title/style/color"],
            action: "updated",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline layer style args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-style-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.style.set",
        {
          packageRoot,
          outDir,
          layerId: "title",
          property: "color"
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "motion.timeline.layer.style.set requires value."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("sets timeline layer transform through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-transform-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.transform.set",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          property: "x",
          value: 12,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-transform-set.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0]).toMatchObject({ id: "title", transform: { x: 12 } });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.transform.set",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          property: "x",
          action: "updated",
          oldValue: null,
          newValue: 12,
          changedPaths: ["/layers/title/transform/x"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/title/transform/x"],
          action: "updated",
          layerId: "title",
          property: "x",
          oldValue: null,
          newValue: 12,
          layer: { id: "title", type: "text", text: "A", trackId: "overlay", startMs: 0, durationMs: 500, transform: { x: 12 } },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.transform.set",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            property: "x",
            oldValue: null,
            newValue: 12,
            changedPaths: ["/layers/title/transform/x"],
            action: "updated",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("canonicalizes legacy transform opacity through the debug API", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const sourceMotionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(sourceMotionPath, "utf8"));
    sourceMotion.layers[0].transform = { opacity: 0.5 };
    await writeFile(sourceMotionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-transform-opacity-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.transform.set",
        {
          packageRoot,
          outDir,
          layerId: "title",
          property: "opacity",
          value: 0.5,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
        expect(patchedMotion.layers[0]).toMatchObject({ id: "title", opacity: 0.5 });
        expect(patchedMotion.layers[0].transform).toBeUndefined();
        expect(result.result).toMatchObject({
          ok: true,
          changedPaths: ["/layers/title/opacity", "/layers/title/transform/opacity"],
          property: "opacity",
          oldValue: 0.5,
          newValue: 0.5
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline layer transform args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-transform-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.transform.set",
        {
          packageRoot,
          outDir,
          layerId: "title",
          property: "x"
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "motion.timeline.layer.transform.set requires value."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("sets timeline layer effects through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-effect-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.effect.set",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          property: "blur",
          value: 4,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-effect-set.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0]).toMatchObject({ id: "title", effects: { blur: 4 } });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.effect.set",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          property: "blur",
          action: "updated",
          oldValue: null,
          newValue: 4,
          changedPaths: ["/layers/title/effects/blur"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/title/effects/blur"],
          action: "updated",
          layerId: "title",
          property: "blur",
          oldValue: null,
          newValue: 4,
          layer: { id: "title", type: "text", text: "A", trackId: "overlay", startMs: 0, durationMs: 500, effects: { blur: 4 } },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.effect.set",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            property: "blur",
            oldValue: null,
            newValue: 4,
            changedPaths: ["/layers/title/effects/blur"],
            action: "updated",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline layer effect args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-effect-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.effect.set",
        {
          packageRoot,
          outDir,
          layerId: "title",
          property: "blur"
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "motion.timeline.layer.effect.set requires value."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("sets timeline layer blend mode through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-blend-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.blend.set",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          blendMode: "multiply",
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-blend-set.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0]).toMatchObject({ id: "title", blendMode: "multiply" });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.blend.set",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          action: "updated",
          oldBlendMode: null,
          newBlendMode: "multiply",
          changedPaths: ["/layers/title/blendMode"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/title/blendMode"],
          action: "updated",
          layerId: "title",
          oldBlendMode: null,
          newBlendMode: "multiply",
          layer: { id: "title", type: "text", text: "A", trackId: "overlay", startMs: 0, durationMs: 500, blendMode: "multiply" },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.blend.set",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            oldBlendMode: null,
            newBlendMode: "multiply",
            changedPaths: ["/layers/title/blendMode"],
            action: "updated",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline layer blend args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-blend-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.blend.set",
        {
          packageRoot,
          outDir,
          layerId: "title"
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "motion.timeline.layer.blend.set requires blendMode."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("sets timeline layer crop through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const sourceMotionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(sourceMotionPath, "utf8"));
    sourceMotion.layers.push({
      id: "product",
      type: "image",
      source: "assets/product.png",
      startMs: 0,
      durationMs: 500,
      crop: { x: 0, y: 0, width: 32, height: 18 }
    });
    await writeFile(sourceMotionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-crop-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.crop.set",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "product",
          crop: { x: 4, y: 2, width: 24, height: 12 },
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-crop-set.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers.find((layer: { id: string }) => layer.id === "product")).toMatchObject({ id: "product", crop: { x: 4, y: 2, width: 24, height: 12 } });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.crop.set",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "product",
          action: "updated",
          oldCrop: { x: 0, y: 0, width: 32, height: 18 },
          newCrop: { x: 4, y: 2, width: 24, height: 12 },
          changedPaths: ["/layers/product/crop/x", "/layers/product/crop/y", "/layers/product/crop/width", "/layers/product/crop/height"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/product/crop/x", "/layers/product/crop/y", "/layers/product/crop/width", "/layers/product/crop/height"],
          action: "updated",
          layerId: "product",
          oldCrop: { x: 0, y: 0, width: 32, height: 18 },
          newCrop: { x: 4, y: 2, width: 24, height: 12 },
          layer: { id: "product", type: "image", source: "assets/product.png", startMs: 0, durationMs: 500, crop: { x: 4, y: 2, width: 24, height: 12 } },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.crop.set",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "product",
            oldCrop: { x: 0, y: 0, width: 32, height: 18 },
            newCrop: { x: 4, y: 2, width: 24, height: 12 },
            changedPaths: ["/layers/product/crop/x", "/layers/product/crop/y", "/layers/product/crop/width", "/layers/product/crop/height"],
            action: "updated",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline layer crop args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-crop-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.crop.set",
        {
          packageRoot,
          outDir,
          layerId: "title",
          x: 0,
          y: 0,
          width: 32
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "motion.timeline.layer.crop.set requires crop.height."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("sets timeline layer masks through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-mask-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.mask.set",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          mask: { type: "rounded-rect", inset: { top: 4, right: 8, bottom: 4, left: 8 }, radius: 12 },
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-mask-set.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers.find((layer: { id: string }) => layer.id === "title")).toMatchObject({ id: "title", mask: { type: "rounded-rect", inset: { top: 4, right: 8, bottom: 4, left: 8 }, radius: 12 } });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.mask.set",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          action: "updated",
          oldMask: null,
          newMask: { type: "rounded-rect", inset: { top: 4, right: 8, bottom: 4, left: 8 }, radius: 12 },
          changedPaths: ["/layers/title/mask/type", "/layers/title/mask/inset/top", "/layers/title/mask/inset/right", "/layers/title/mask/inset/bottom", "/layers/title/mask/inset/left", "/layers/title/mask/radius"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/title/mask/type", "/layers/title/mask/inset/top", "/layers/title/mask/inset/right", "/layers/title/mask/inset/bottom", "/layers/title/mask/inset/left", "/layers/title/mask/radius"],
          action: "updated",
          layerId: "title",
          oldMask: null,
          newMask: { type: "rounded-rect", inset: { top: 4, right: 8, bottom: 4, left: 8 }, radius: 12 },
          layer: { id: "title", type: "text", text: "A", trackId: "overlay", startMs: 0, durationMs: 500, mask: { type: "rounded-rect", inset: { top: 4, right: 8, bottom: 4, left: 8 }, radius: 12 } },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.mask.set",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            oldMask: null,
            newMask: { type: "rounded-rect", inset: { top: 4, right: 8, bottom: 4, left: 8 }, radius: 12 },
            changedPaths: ["/layers/title/mask/type", "/layers/title/mask/inset/top", "/layers/title/mask/inset/right", "/layers/title/mask/inset/bottom", "/layers/title/mask/inset/left", "/layers/title/mask/radius"],
            action: "updated",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline layer mask args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-mask-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.mask.set",
        {
          packageRoot,
          outDir,
          layerId: "title",
          top: 4,
          right: 8
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "motion.timeline.layer.mask.set requires mask.type."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("sets timeline layer media fit through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const sourceMotionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(sourceMotionPath, "utf8"));
    sourceMotion.layers.push({
      id: "product",
      type: "image",
      source: "assets/product.png",
      startMs: 0,
      durationMs: 500,
      fit: "cover",
      style: { objectFit: "scale-down", fit: "none", borderRadius: 8 }
    });
    await writeFile(sourceMotionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-fit-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.fit.set",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "product",
          fit: "contain",
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-fit-set.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers.find((layer: { id: string }) => layer.id === "product")).toEqual({
          id: "product",
          type: "image",
          source: "assets/product.png",
          startMs: 0,
          durationMs: 500,
          fit: "contain",
          style: { borderRadius: 8 }
        });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.fit.set",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "product",
          action: "updated",
          oldFit: "cover",
          newFit: "contain",
          changedPaths: ["/layers/product/fit", "/layers/product/style/objectFit", "/layers/product/style/fit"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/product/fit", "/layers/product/style/objectFit", "/layers/product/style/fit"],
          action: "updated",
          layerId: "product",
          oldFit: "cover",
          newFit: "contain",
          layer: { id: "product", type: "image", source: "assets/product.png", startMs: 0, durationMs: 500, fit: "contain", style: { borderRadius: 8 } },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.fit.set",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "product",
            oldFit: "cover",
            newFit: "contain",
            changedPaths: ["/layers/product/fit", "/layers/product/style/objectFit", "/layers/product/style/fit"],
            action: "updated",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline layer fit args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-fit-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.fit.set",
        {
          packageRoot,
          outDir,
          layerId: "title"
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "motion.timeline.layer.fit.set requires fit."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("sets timeline layer media source through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const sourceMotionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(sourceMotionPath, "utf8"));
    sourceMotion.layers.push({
      id: "product",
      type: "image",
      assetRef: "assets/product-asset-ref.png",
      source: "assets/product-old.png",
      src: "assets/product-src.png",
      assetId: "asset_product_old",
      startMs: 0,
      durationMs: 500,
      fit: "cover"
    });
    await writeFile(sourceMotionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-media-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.media.set",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "product",
          source: "assets/product-new.png",
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-media-set.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers.find((layer: { id: string }) => layer.id === "product")).toEqual({
          id: "product",
          type: "image",
          source: "assets/product-new.png",
          startMs: 0,
          durationMs: 500,
          fit: "cover"
        });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.media.set",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "product",
          action: "updated",
          oldSource: "assets/product-asset-ref.png",
          newSource: "assets/product-new.png",
          changedPaths: ["/layers/product/source", "/layers/product/assetRef", "/layers/product/src", "/layers/product/assetId"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/product/source", "/layers/product/assetRef", "/layers/product/src", "/layers/product/assetId"],
          action: "updated",
          layerId: "product",
          oldSource: "assets/product-asset-ref.png",
          newSource: "assets/product-new.png",
          layer: { id: "product", type: "image", source: "assets/product-new.png", startMs: 0, durationMs: 500, fit: "cover" },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.media.set",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "product",
            oldSource: "assets/product-asset-ref.png",
            newSource: "assets/product-new.png",
            changedPaths: ["/layers/product/source", "/layers/product/assetRef", "/layers/product/src", "/layers/product/assetId"],
            action: "updated",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline layer media source args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-media-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.media.set",
        {
          packageRoot,
          outDir,
          layerId: "title"
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "motion.timeline.layer.media.set requires source."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("sets timeline layer display names through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-name-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.name.set",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          name: "Hero Title",
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-name-set.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers.find((layer: { id: string }) => layer.id === "title")).toMatchObject({
          id: "title",
          name: "Hero Title"
        });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.name.set",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          action: "renamed",
          oldName: null,
          newName: "Hero Title",
          changedPaths: ["/layers/title/name"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/title/name"],
          action: "renamed",
          layerId: "title",
          oldName: null,
          newName: "Hero Title",
          layer: expect.objectContaining({ id: "title", name: "Hero Title" }),
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.name.set",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            oldName: null,
            newName: "Hero Title",
            changedPaths: ["/layers/title/name"],
            action: "renamed",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("accepts value as a direct debug API alias for timeline layer display names", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-name-value-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.name.set",
        {
          packageRoot,
          outDir,
          layerId: "title",
          value: "Value Alias Title"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          layerId: "title",
          oldName: null,
          newName: "Value Alias Title",
          changedPaths: ["/layers/title/name"]
        });
        const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
        expect(patchedMotion.layers.find((layer: { id: string }) => layer.id === "title")).toMatchObject({
          id: "title",
          name: "Value Alias Title"
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline layer name args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-name-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.name.set",
        {
          packageRoot,
          outDir,
          layerId: "title"
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "motion.timeline.layer.name.set requires name."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("sets timeline layer visibility through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-visibility-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.visibility.set",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          visible: false,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-visibility-set.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers.find((layer: { id: string }) => layer.id === "title")).toMatchObject({
          id: "title",
          visible: false
        });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.visibility.set",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          action: "hidden",
          oldVisible: true,
          newVisible: false,
          changedPaths: ["/layers/title/visible"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/title/visible"],
          action: "hidden",
          layerId: "title",
          oldVisible: true,
          newVisible: false,
          layer: expect.objectContaining({ id: "title", visible: false }),
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.visibility.set",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            oldVisible: true,
            newVisible: false,
            changedPaths: ["/layers/title/visible"],
            action: "hidden",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline layer visibility args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-visibility-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.visibility.set",
        {
          packageRoot,
          outDir,
          layerId: "title",
          visible: "no"
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "visible must be a boolean."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("sets timeline layer locks through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-lock-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.lock",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          locked: true,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-lock.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers.find((layer: { id: string }) => layer.id === "title")).toMatchObject({
          id: "title",
          locked: true
        });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.lock",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          action: "locked",
          oldLocked: false,
          newLocked: true,
          changedPaths: ["/layers/title/locked"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/title/locked"],
          action: "locked",
          layerId: "title",
          oldLocked: false,
          newLocked: true,
          layer: expect.objectContaining({ id: "title", locked: true }),
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.lock",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            oldLocked: false,
            newLocked: true,
            changedPaths: ["/layers/title/locked"],
            action: "locked",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline layer lock args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-lock-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.lock",
        {
          packageRoot,
          outDir,
          layerId: "title",
          locked: "yes"
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "locked must be a boolean."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("deletes timeline layers through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-delete-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.delete",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-delete.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers).toEqual([]);
        expect(patchedMotion.tracks[0].layerIds).toEqual([]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.delete",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          action: "deleted",
          changedPaths: ["/layers/title", "/tracks/0/layerIds"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/title", "/tracks/0/layerIds"],
          action: "deleted",
          layerId: "title",
          removed: { id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 500 },
          remainingCount: 0,
          removedTrackRefs: ["overlay"],
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.delete",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            changedPaths: ["/layers/title", "/tracks/0/layerIds"],
            action: "deleted",
            remainingCount: 0,
            removedTrackRefs: ["overlay"],
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("duplicates timeline layers through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-duplicate-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.duplicate",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          newLayerId: "title_copy",
          offsetMs: 50,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-duplicate.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.durationMs).toBe(550);
        expect(patchedMotion.layers).toEqual([
          expect.objectContaining({ id: "title", startMs: 0, durationMs: 500, trackId: "overlay" }),
          expect.objectContaining({ id: "title_copy", startMs: 50, durationMs: 500, trackId: "overlay" })
        ]);
        expect(patchedMotion.tracks[0].layerIds).toEqual(["title", "title_copy"]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.duplicate",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          newLayerId: "title_copy",
          offsetMs: 50,
          action: "duplicated",
          changedPaths: ["/layers/title_copy", "/tracks/0/layerIds", "/durationMs"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/title_copy", "/tracks/0/layerIds", "/durationMs"],
          action: "duplicated",
          layerId: "title",
          newLayerId: "title_copy",
          offsetMs: 50,
          layer: { id: "title_copy", startMs: 50, durationMs: 500 },
          insertedTrackRefs: ["overlay"],
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.duplicate",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            newLayerId: "title_copy",
            offsetMs: 50,
            changedPaths: ["/layers/title_copy", "/tracks/0/layerIds", "/durationMs"],
            action: "duplicated",
            insertedTrackRefs: ["overlay"],
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("reorders timeline layers through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const sourceMotionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(sourceMotionPath, "utf8"));
    sourceMotion.layers.push({ id: "badge", type: "shape", trackId: "overlay", startMs: 0, durationMs: 500 });
    sourceMotion.tracks[0].layerIds.push("badge");
    await writeFile(sourceMotionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-reorder-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.reorder",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "badge",
          index: 0,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-reorder.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers.map((layer: { id: string }) => layer.id)).toEqual(["badge", "title"]);
        expect(patchedMotion.tracks[0].layerIds).toEqual(["badge", "title"]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.reorder",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "badge",
          action: "reordered",
          oldIndex: 1,
          newIndex: 0,
          changedPaths: ["/layers", "/tracks/0/layerIds"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers", "/tracks/0/layerIds"],
          action: "reordered",
          layerId: "badge",
          oldIndex: 1,
          newIndex: 0,
          layer: { id: "badge", type: "shape", trackId: "overlay", startMs: 0, durationMs: 500 },
          reorderedTrackRefs: ["overlay"],
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.reorder",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "badge",
            oldIndex: 1,
            newIndex: 0,
            changedPaths: ["/layers", "/tracks/0/layerIds"],
            action: "reordered",
            reorderedTrackRefs: ["overlay"],
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline layer reorder debug API index args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-reorder-invalid-"));
    await rm(outDir, { recursive: true, force: true });
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.reorder",
        {
          packageRoot,
          outDir,
          layerId: "title",
          index: -1
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({
          code: "invalid_args",
          message: "index must be a non-negative integer."
        });
      }
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("upserts timeline keyframes through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-keyframe-upsert-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.keyframe.upsert",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          target: "opacity",
          atMs: 250,
          value: 0.65,
          easing: "ease-out",
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const motionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-keyframe-upsert.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const motion = JSON.parse(await readFile(motionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(motion.layers[0].keyframes.opacity).toEqual([
          { atMs: 250, value: 0.65, easing: "ease-out" }
        ]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.keyframe.upsert",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          target: "opacity",
          atMs: 250,
          action: "inserted",
          changedPath: "/layers/title/keyframes/opacity/250",
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath,
          receiptPath,
          hostReceiptPath,
          changedPath: "/layers/title/keyframes/opacity/250",
          action: "inserted",
          layer: {
            id: "title",
            keyframes: {
              opacity: [{ atMs: 250, value: 0.65, easing: "ease-out" }]
            }
          },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.keyframe.upsert",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath,
            layerId: "title",
            target: "opacity",
            atMs: 250,
            value: 0.65,
            easing: "ease-out",
            changedPath: "/layers/title/keyframes/opacity/250",
            action: "inserted",
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("upserts effect keyframes through the debug API", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-effect-keyframe-upsert-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.keyframe.upsert",
        {
          packageRoot,
          outDir,
          layerId: "title",
          target: "effects.blur",
          atMs: 500,
          value: 12,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const motion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
        const receipt = JSON.parse(await readFile(join(outDir, "receipts", "timeline-keyframe-upsert.receipt.json"), "utf8"));

        expect(motion.layers[0].keyframes["effects.blur"]).toEqual([
          { atMs: 500, value: 12, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
        ]);
        expect(result.visibleState).toMatchObject({
          panel: "timeline",
          operation: "timeline.keyframe.upsert",
          layerId: "title",
          target: "effects.blur",
          atMs: 500,
          action: "inserted",
          changedPath: "/layers/title/keyframes/effects.blur/500"
        });
        expect(receipt.output).toMatchObject({
          layerId: "title",
          target: "effects.blur",
          atMs: 500,
          value: 12,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          changedPath: "/layers/title/keyframes/effects.blur/500",
          action: "inserted"
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("upserts color keyframes through the debug API", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-color-keyframe-upsert-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.keyframe.upsert",
        {
          packageRoot,
          outDir,
          layerId: "title",
          target: "style.color",
          atMs: 400,
          value: "#00ff00",
          easing: "ease-in-out"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const motion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
        const receipt = JSON.parse(await readFile(join(outDir, "receipts", "timeline-keyframe-upsert.receipt.json"), "utf8"));

        expect(motion.layers[0].keyframes["style.color"]).toEqual([
          { atMs: 400, value: "#00ff00", easing: "ease-in-out" }
        ]);
        expect(result.visibleState).toMatchObject({
          panel: "timeline",
          operation: "timeline.keyframe.upsert",
          layerId: "title",
          target: "style.color",
          atMs: 400,
          action: "inserted",
          changedPath: "/layers/title/keyframes/style.color/400"
        });
        expect(receipt.output).toMatchObject({
          layerId: "title",
          target: "style.color",
          atMs: 400,
          value: "#00ff00",
          easing: "ease-in-out",
          changedPath: "/layers/title/keyframes/style.color/400",
          action: "inserted"
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("upserts mask inset keyframes through the debug API", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-mask-keyframe-upsert-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.keyframe.upsert",
        {
          packageRoot,
          outDir,
          layerId: "title",
          target: "mask.inset.left",
          atMs: 500,
          value: 36,
          easing: "ease-in-out"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const motion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
        const receipt = JSON.parse(await readFile(join(outDir, "receipts", "timeline-keyframe-upsert.receipt.json"), "utf8"));

        expect(motion.layers[0].keyframes["mask.inset.left"]).toEqual([
          { atMs: 500, value: 36, easing: "ease-in-out" }
        ]);
        expect(result.visibleState).toMatchObject({
          panel: "timeline",
          operation: "timeline.keyframe.upsert",
          layerId: "title",
          target: "mask.inset.left",
          atMs: 500,
          action: "inserted",
          changedPath: "/layers/title/keyframes/mask.inset.left/500"
        });
        expect(receipt.output).toMatchObject({
          layerId: "title",
          target: "mask.inset.left",
          atMs: 500,
          value: 36,
          easing: "ease-in-out",
          changedPath: "/layers/title/keyframes/mask.inset.left/500",
          action: "inserted"
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("upserts image crop keyframes through the debug API", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0] = {
      id: "title",
      type: "image",
      assetRef: "assets/product.png",
      source: "assets/product.png",
      trackId: "overlay",
      startMs: 0,
      durationMs: 500,
      transform: { x: 0, y: 0, width: 64, height: 36 },
      crop: { x: 0, y: 0, width: 64, height: 36 }
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-crop-keyframe-upsert-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.keyframe.upsert",
        {
          packageRoot,
          outDir,
          layerId: "title",
          target: "crop.x",
          atMs: 500,
          value: 24,
          easing: "ease-in-out"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
        const receipt = JSON.parse(await readFile(join(outDir, "receipts", "timeline-keyframe-upsert.receipt.json"), "utf8"));

        expect(patchedMotion.layers[0].keyframes["crop.x"]).toEqual([
          { atMs: 500, value: 24, easing: "ease-in-out" }
        ]);
        expect(result.visibleState).toMatchObject({
          panel: "timeline",
          operation: "timeline.keyframe.upsert",
          layerId: "title",
          target: "crop.x",
          atMs: 500,
          action: "inserted",
          changedPath: "/layers/title/keyframes/crop.x/500"
        });
        expect(receipt.output).toMatchObject({
          layerId: "title",
          target: "crop.x",
          atMs: 500,
          value: 24,
          easing: "ease-in-out",
          changedPath: "/layers/title/keyframes/crop.x/500",
          action: "inserted"
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("upserts video crop keyframes through the debug API", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0] = {
      id: "title",
      type: "video",
      source: "assets/clip.mp4",
      trackId: "overlay",
      startMs: 0,
      durationMs: 500,
      transform: { x: 0, y: 0, width: 64, height: 36 },
      crop: { x: 0, y: 0, width: 64, height: 36 }
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-video-crop-keyframe-upsert-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.keyframe.upsert",
        {
          packageRoot,
          outDir,
          layerId: "title",
          target: "crop.x",
          atMs: 500,
          value: 24,
          easing: "ease-in-out"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
        const receipt = JSON.parse(await readFile(join(outDir, "receipts", "timeline-keyframe-upsert.receipt.json"), "utf8"));

        expect(patchedMotion.layers[0].keyframes["crop.x"]).toEqual([
          { atMs: 500, value: 24, easing: "ease-in-out" }
        ]);
        expect(result.visibleState).toMatchObject({
          panel: "timeline",
          operation: "timeline.keyframe.upsert",
          layerId: "title",
          target: "crop.x",
          atMs: 500,
          action: "inserted",
          changedPath: "/layers/title/keyframes/crop.x/500"
        });
        expect(receipt.output).toMatchObject({
          layerId: "title",
          target: "crop.x",
          atMs: 500,
          value: 24,
          easing: "ease-in-out",
          changedPath: "/layers/title/keyframes/crop.x/500",
          action: "inserted"
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("deletes timeline keyframes through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 250, value: 0.65, easing: "ease-out" }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-keyframe-delete-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.keyframe.delete",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          target: "opacity",
          atMs: 0,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-keyframe-delete.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0].keyframes.opacity).toEqual([
          { atMs: 250, value: 0.65, easing: "ease-out" }
        ]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.keyframe.delete",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          target: "opacity",
          atMs: 0,
          action: "deleted",
          changedPath: "/layers/title/keyframes/opacity/0",
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPath: "/layers/title/keyframes/opacity/0",
          action: "deleted",
          removed: { atMs: 0, value: 0, easing: "linear" },
          layer: {
            id: "title",
            keyframes: {
              opacity: [{ atMs: 250, value: 0.65, easing: "ease-out" }]
            }
          },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.keyframe.delete",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            target: "opacity",
            atMs: 0,
            changedPath: "/layers/title/keyframes/opacity/0",
            action: "deleted",
            removed: { atMs: 0, value: 0, easing: "linear" },
            remainingCount: 1,
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("deletes timeline keyframe ranges through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 200, value: 0.5, easing: "ease-out" },
        { atMs: 500, value: 1 }
      ],
      "transform.x": [{ atMs: 200, value: 120, easing: "linear" }]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-keyframe-range-delete-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.keyframe.range.delete",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          target: "opacity",
          startMs: 0,
          endMs: 200,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-keyframe-range-delete.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0].keyframes).toEqual({
          opacity: [{ atMs: 500, value: 1 }],
          "transform.x": [{ atMs: 200, value: 120, easing: "linear" }]
        });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.keyframe.range.delete",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          target: "opacity",
          startMs: 0,
          endMs: 200,
          action: "deleted",
          deletedCount: 2,
          remainingCount: 1,
          changedPaths: [
            "/layers/title/keyframes/opacity/0",
            "/layers/title/keyframes/opacity/200"
          ],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: [
            "/layers/title/keyframes/opacity/0",
            "/layers/title/keyframes/opacity/200"
          ],
          action: "deleted",
          target: "opacity",
          startMs: 0,
          endMs: 200,
          removedKeyframes: [
            { target: "opacity", atMs: 0, value: 0, easing: "linear" },
            { target: "opacity", atMs: 200, value: 0.5, easing: "ease-out" }
          ],
          remainingCount: 1,
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.keyframe.range.delete",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            target: "opacity",
            startMs: 0,
            endMs: 200,
            action: "deleted",
            deletedCount: 2,
            remainingCount: 1,
            removedKeyframes: [
              { target: "opacity", atMs: 0, value: 0, easing: "linear" },
              { target: "opacity", atMs: 200, value: 0.5, easing: "ease-out" }
            ],
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("deletes the final timeline keyframe without leaving invalid empty containers", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [{ atMs: 0, value: 0, easing: "linear" }]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-keyframe-delete-final-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.keyframe.delete",
        {
          packageRoot,
          outDir,
          layerId: "title",
          target: "opacity",
          atMs: 0,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const commandResult = result.result as { layer: Record<string, unknown> };
        const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
        expect(patchedMotion.layers[0].keyframes).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(patchedMotion.layers[0], "keyframes")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(commandResult.layer, "keyframes")).toBe(false);
        expect(result.result).toMatchObject({
          ok: true,
          changedPath: "/layers/title/keyframes/opacity/0",
          remainingCount: 0,
          validation: { ok: true }
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("moves timeline keyframes through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 250, value: 0.65, easing: "ease-out" }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-keyframe-move-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.keyframe.move",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          target: "opacity",
          fromMs: 250,
          toMs: 400,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-keyframe-move.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0].keyframes.opacity).toEqual([
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 400, value: 0.65, easing: "ease-out" }
        ]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.keyframe.move",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          target: "opacity",
          fromMs: 250,
          toMs: 400,
          action: "moved",
          changedPaths: [
            "/layers/title/keyframes/opacity/250",
            "/layers/title/keyframes/opacity/400"
          ],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: [
            "/layers/title/keyframes/opacity/250",
            "/layers/title/keyframes/opacity/400"
          ],
          action: "moved",
          target: "opacity",
          fromMs: 250,
          toMs: 400,
          previousKeyframe: { atMs: 250, value: 0.65, easing: "ease-out" },
          keyframe: { atMs: 400, value: 0.65, easing: "ease-out" },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.keyframe.move",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            target: "opacity",
            fromMs: 250,
            toMs: 400,
            changedPaths: [
              "/layers/title/keyframes/opacity/250",
              "/layers/title/keyframes/opacity/400"
            ],
            action: "moved",
            previousKeyframe: { atMs: 250, value: 0.65, easing: "ease-out" },
            keyframe: { atMs: 400, value: 0.65, easing: "ease-out" },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("applies timeline keyframe easing through the debug API with range receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 250, value: 0.65, easing: "ease-out" },
        { atMs: 500, value: 1 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-keyframe-easing-apply-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.keyframe.easing.apply",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          target: "opacity",
          easing: "ease-in-out",
          startMs: 0,
          endMs: 250,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-keyframe-easing-apply.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0].keyframes.opacity).toEqual([
          { atMs: 0, value: 0, easing: "ease-in-out" },
          { atMs: 250, value: 0.65, easing: "ease-in-out" },
          { atMs: 500, value: 1 }
        ]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.keyframe.easing.apply",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          target: "opacity",
          easing: "ease-in-out",
          startMs: 0,
          endMs: 250,
          action: "updated",
          updatedCount: 2,
          changedPaths: [
            "/layers/title/keyframes/opacity/0/easing",
            "/layers/title/keyframes/opacity/250/easing"
          ],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          target: "opacity",
          easing: "ease-in-out",
          startMs: 0,
          endMs: 250,
          action: "updated",
          updatedKeyframes: [
            { atMs: 0, value: 0, oldEasing: "linear", newEasing: "ease-in-out" },
            { atMs: 250, value: 0.65, oldEasing: "ease-out", newEasing: "ease-in-out" }
          ],
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.keyframe.easing.apply",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            target: "opacity",
            easing: "ease-in-out",
            startMs: 0,
            endMs: 250,
            changedPaths: [
              "/layers/title/keyframes/opacity/0/easing",
              "/layers/title/keyframes/opacity/250/easing"
            ],
            action: "updated",
            updatedCount: 2,
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("shifts timeline keyframe ranges through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 250, value: 0.65, easing: "ease-out" },
        { atMs: 500, value: 1 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-keyframe-shift-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.keyframe.shift",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          target: "opacity",
          deltaMs: 100,
          startMs: 0,
          endMs: 250,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-keyframe-shift.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0].keyframes.opacity).toEqual([
          { atMs: 100, value: 0, easing: "linear" },
          { atMs: 350, value: 0.65, easing: "ease-out" },
          { atMs: 500, value: 1 }
        ]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.keyframe.shift",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          target: "opacity",
          deltaMs: 100,
          startMs: 0,
          endMs: 250,
          action: "shifted",
          shiftedCount: 2,
          changedPaths: [
            "/layers/title/keyframes/opacity/0",
            "/layers/title/keyframes/opacity/100",
            "/layers/title/keyframes/opacity/250",
            "/layers/title/keyframes/opacity/350"
          ],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: [
            "/layers/title/keyframes/opacity/0",
            "/layers/title/keyframes/opacity/100",
            "/layers/title/keyframes/opacity/250",
            "/layers/title/keyframes/opacity/350"
          ],
          action: "shifted",
          target: "opacity",
          deltaMs: 100,
          startMs: 0,
          endMs: 250,
          shiftedKeyframes: [
            { target: "opacity", fromMs: 0, toMs: 100, value: 0, easing: "linear" },
            { target: "opacity", fromMs: 250, toMs: 350, value: 0.65, easing: "ease-out" }
          ],
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.keyframe.shift",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            target: "opacity",
            deltaMs: 100,
            startMs: 0,
            endMs: 250,
            action: "shifted",
            shiftedCount: 2,
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("scales timeline keyframe ranges through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 100, value: 0 },
        { atMs: 200, value: 0.25, easing: "linear" },
        { atMs: 400, value: 0.75, easing: "ease-out" },
        { atMs: 900, value: 1 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-keyframe-scale-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.keyframe.scale",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          target: "opacity",
          scale: 2,
          originMs: 100,
          startMs: 200,
          endMs: 400,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-keyframe-scale.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0].keyframes.opacity).toEqual([
          { atMs: 100, value: 0 },
          { atMs: 300, value: 0.25, easing: "linear" },
          { atMs: 700, value: 0.75, easing: "ease-out" },
          { atMs: 900, value: 1 }
        ]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.keyframe.scale",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          target: "opacity",
          scale: 2,
          originMs: 100,
          startMs: 200,
          endMs: 400,
          action: "scaled",
          scaledCount: 2,
          changedPaths: [
            "/layers/title/keyframes/opacity/200",
            "/layers/title/keyframes/opacity/300",
            "/layers/title/keyframes/opacity/400",
            "/layers/title/keyframes/opacity/700"
          ],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: [
            "/layers/title/keyframes/opacity/200",
            "/layers/title/keyframes/opacity/300",
            "/layers/title/keyframes/opacity/400",
            "/layers/title/keyframes/opacity/700"
          ],
          action: "scaled",
          target: "opacity",
          scale: 2,
          originMs: 100,
          startMs: 200,
          endMs: 400,
          scaledKeyframes: [
            { target: "opacity", fromMs: 200, toMs: 300, value: 0.25, easing: "linear" },
            { target: "opacity", fromMs: 400, toMs: 700, value: 0.75, easing: "ease-out" }
          ],
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.keyframe.scale",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            target: "opacity",
            scale: 2,
            originMs: 100,
            startMs: 200,
            endMs: 400,
            action: "scaled",
            scaledCount: 2,
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("duplicates timeline keyframe ranges through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 200, value: 0.5, easing: "ease-out" },
        { atMs: 500, value: 1 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-keyframe-duplicate-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.keyframe.duplicate",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          target: "opacity",
          deltaMs: 400,
          startMs: 0,
          endMs: 200,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-keyframe-duplicate.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0].keyframes.opacity).toEqual([
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 200, value: 0.5, easing: "ease-out" },
          { atMs: 400, value: 0, easing: "linear" },
          { atMs: 500, value: 1 },
          { atMs: 600, value: 0.5, easing: "ease-out" }
        ]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.keyframe.duplicate",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          target: "opacity",
          deltaMs: 400,
          startMs: 0,
          endMs: 200,
          action: "duplicated",
          duplicatedCount: 2,
          changedPaths: [
            "/layers/title/keyframes/opacity/400",
            "/layers/title/keyframes/opacity/600"
          ],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: [
            "/layers/title/keyframes/opacity/400",
            "/layers/title/keyframes/opacity/600"
          ],
          action: "duplicated",
          target: "opacity",
          deltaMs: 400,
          startMs: 0,
          endMs: 200,
          duplicatedKeyframes: [
            { target: "opacity", fromMs: 0, toMs: 400, value: 0, easing: "linear" },
            { target: "opacity", fromMs: 200, toMs: 600, value: 0.5, easing: "ease-out" }
          ],
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.keyframe.duplicate",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            target: "opacity",
            deltaMs: 400,
            startMs: 0,
            endMs: 200,
            action: "duplicated",
            duplicatedCount: 2,
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("distributes timeline keyframe ranges through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 120, value: 0.5, easing: "ease-out" },
        { atMs: 500, value: 1 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-keyframe-distribute-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.keyframe.distribute",
        { packageRoot, outDir, receiptsRoot, layerId: "title", target: "opacity", startMs: 0, endMs: 500, createdBy: "codex-test" },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const receiptPath = join(outDir, "receipts", "timeline-keyframe-distribute.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0].keyframes.opacity).toEqual([
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 250, value: 0.5, easing: "ease-out" },
          { atMs: 500, value: 1 }
        ]);
        expect(result.visibleState).toMatchObject({
          panel: "timeline",
          operation: "timeline.keyframe.distribute",
          layerId: "title",
          target: "opacity",
          startMs: 0,
          endMs: 500,
          spacingMs: 250,
          action: "distributed",
          distributedCount: 1
        });
        expect(result.result).toMatchObject({
          ok: true,
          action: "distributed",
          spacingMs: 250,
          distributedKeyframes: [
            { target: "opacity", fromMs: 120, toMs: 250, value: 0.5, easing: "ease-out" }
          ],
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          operation: "timeline.keyframe.distribute",
          status: "passed",
          output: { spacingMs: 250, action: "distributed", distributedCount: 1, createdBy: "codex-test" }
        });
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("reverses timeline keyframe ranges through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 200, value: 0.5, easing: "ease-out" },
        { atMs: 500, value: 1 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-keyframe-reverse-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.keyframe.reverse",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          target: "opacity",
          startMs: 0,
          endMs: 500,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-keyframe-reverse.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0].keyframes.opacity).toEqual([
          { atMs: 0, value: 1 },
          { atMs: 300, value: 0.5, easing: "ease-out" },
          { atMs: 500, value: 0, easing: "linear" }
        ]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.keyframe.reverse",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          target: "opacity",
          startMs: 0,
          endMs: 500,
          action: "reversed",
          reversedCount: 3,
          changedPaths: [
            "/layers/title/keyframes/opacity/0",
            "/layers/title/keyframes/opacity/500",
            "/layers/title/keyframes/opacity/200",
            "/layers/title/keyframes/opacity/300"
          ],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          action: "reversed",
          target: "opacity",
          startMs: 0,
          endMs: 500,
          reversedKeyframes: [
            { target: "opacity", fromMs: 0, toMs: 500, value: 0, easing: "linear" },
            { target: "opacity", fromMs: 200, toMs: 300, value: 0.5, easing: "ease-out" },
            { target: "opacity", fromMs: 500, toMs: 0, value: 1 }
          ],
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.keyframe.reverse",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            target: "opacity",
            startMs: 0,
            endMs: 500,
            action: "reversed",
            reversedCount: 3,
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("snaps timeline keyframe ranges through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].keyframes = {
      opacity: [
        { atMs: 47, value: 0, easing: "linear" },
        { atMs: 151, value: 0.5, easing: "ease-out" },
        { atMs: 253, value: 1 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-keyframe-snap-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.keyframe.snap",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          target: "opacity",
          fps: 10,
          mode: "nearest",
          startMs: 0,
          endMs: 300,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-keyframe-snap.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0].keyframes.opacity).toEqual([
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 200, value: 0.5, easing: "ease-out" },
          { atMs: 300, value: 1 }
        ]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.keyframe.snap",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          target: "opacity",
          fps: 10,
          mode: "nearest",
          startMs: 0,
          endMs: 300,
          action: "snapped",
          snappedCount: 3,
          changedPaths: [
            "/layers/title/keyframes/opacity/47",
            "/layers/title/keyframes/opacity/0",
            "/layers/title/keyframes/opacity/151",
            "/layers/title/keyframes/opacity/200",
            "/layers/title/keyframes/opacity/253",
            "/layers/title/keyframes/opacity/300"
          ],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          action: "snapped",
          target: "opacity",
          fps: 10,
          mode: "nearest",
          startMs: 0,
          endMs: 300,
          snappedKeyframes: [
            { target: "opacity", fromMs: 47, toMs: 0, value: 0, easing: "linear" },
            { target: "opacity", fromMs: 151, toMs: 200, value: 0.5, easing: "ease-out" },
            { target: "opacity", fromMs: 253, toMs: 300, value: 1 }
          ],
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.keyframe.snap",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            target: "opacity",
            fps: 10,
            mode: "nearest",
            startMs: 0,
            endMs: 300,
            action: "snapped",
            snappedCount: 3,
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("returns a read-only easing panel with sampled curves, package usage, and next actions", async () => {
    const packageRoot = await writeDebugPackageWithKeyframes();
    const statePath = join(packageRoot, ".shellx-motion", "timeline-state.json");
    try {
      await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const result = await dispatchDebugCommand(
        "motion.timeline.easing.panel",
        { packageRoot, sampleCount: 5 },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^timeline-easing-panel-pkg_debug_keyframes-/);
        expect(result.visibleState).toEqual({
          panel: "easing",
          operation: "timeline.easing.panel",
          packageId: "pkg_debug_keyframes",
          motionId: "motion_debug_keyframes",
          presetCount: expect.any(Number),
          usedPresetCount: 4,
          customEasingCount: 0,
          usageCount: 7,
          // Zero here is the healthy-path half of the keyframe-readability fix: this fixture's
          // keyframes are all readable, so the count the panel now reports is 0 and every other
          // number is exactly what it was before. See keyframe-readability-surfaces.test.ts.
          unreadableKeyframeCount: 0,
          sampleCount: 5
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageRoot,
          packageId: "pkg_debug_keyframes",
          motionId: "motion_debug_keyframes",
          counts: {
            presets: expect.any(Number),
            usedPresets: 4,
            customEasings: 0,
            usage: 7,
            keyframeUsage: 7,
            transitionUsage: 0
          },
          usage: {
            total: 7,
            byEasing: {
              linear: 3,
              "ease-out": 2,
              "ease-in-out": 1,
              hold: 1
            },
            custom: []
          },
          presets: expect.arrayContaining([
            expect.objectContaining({
              id: "linear",
              easing: "linear",
              usageCount: 3,
              sampleCount: 5,
              samples: [
                { t: 0, value: 0 },
                { t: 0.25, value: 0.25 },
                { t: 0.5, value: 0.5 },
                { t: 0.75, value: 0.75 },
                { t: 1, value: 1 }
              ]
            }),
            expect.objectContaining({
              id: "ease-out",
              easing: "ease-out",
              usageCount: 2,
              sampleCount: 5,
              usedBy: expect.arrayContaining([
                { layerId: "title", target: "opacity", kind: "keyframe", atMs: 250 },
                { layerId: "title", target: "transform.x", kind: "keyframe", atMs: 0 }
              ])
            }),
            expect.objectContaining({
              id: "back-out",
              easing: "back-out",
              samples: expect.arrayContaining([
                expect.objectContaining({ t: 0.5, value: expect.any(Number) })
              ])
            }),
            expect.objectContaining({
              id: "smooth",
              easing: "cubic-bezier(0.16, 1, 0.3, 1)",
              curve: [0.16, 1, 0.3, 1]
            }),
            expect.objectContaining({
              id: "steps-4-end",
              easing: "steps(4, end)",
              kind: "steps",
              samples: [
                { t: 0, value: 0 },
                { t: 0.25, value: 0.25 },
                { t: 0.5, value: 0.5 },
                { t: 0.75, value: 0.75 },
                { t: 1, value: 1 }
              ]
            })
          ]),
          suggestedActions: expect.arrayContaining([
            { id: "keyframes", command: "motion.timeline.keyframes.panel", args: { packageRoot } },
            { id: "transitions", command: "motion.timeline.transitions.panel", args: { packageRoot } },
            { id: "applyEasing", command: "motion.timeline.keyframe.easing.apply", args: { packageRoot } },
            { id: "presets", command: "motion.timeline.easing.presets", args: {} }
          ])
        });
      }
      await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("lists timeline easing presets through the debug API", async () => {
    const result = await dispatchDebugCommand("motion.timeline.easing.presets", {}, { tier: "read_motion" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.receiptId).toMatch(/^timeline-easing-presets-/);
      expect(result.visibleState).toEqual({
        panel: "timeline",
        operation: "timeline.easing.presets",
        presetCount: expect.any(Number)
      });
      expect(result.result).toMatchObject({
        ok: true,
        defaultPreset: "linear",
        presets: expect.arrayContaining([
          expect.objectContaining({ id: "linear", easing: "linear", kind: "named" }),
          expect.objectContaining({ id: "ease-in-out", easing: "ease-in-out", kind: "named" }),
          expect.objectContaining({ id: "back-out", easing: "back-out", kind: "named" }),
          expect.objectContaining({ id: "bounce-out", easing: "bounce-out", kind: "named" }),
          expect.objectContaining({ id: "smooth", easing: "cubic-bezier(0.16, 1, 0.3, 1)", kind: "cubic-bezier" }),
          expect.objectContaining({ id: "steps-4-end", easing: "steps(4, end)", kind: "steps" })
        ])
      });
    }
  });

  it("lists timeline animation presets through the debug API", async () => {
    const result = await dispatchDebugCommand("motion.timeline.animation.presets", {}, { tier: "read_motion" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.receiptId).toMatch(/^timeline-animation-presets-/);
      expect(result.visibleState).toEqual({
        panel: "timeline",
        operation: "timeline.animation.presets",
        presetCount: expect.any(Number)
      });
      expect(result.result).toMatchObject({
        ok: true,
        defaultPreset: "fade-in",
        presets: expect.arrayContaining([
          expect.objectContaining({ id: "fade-in", kind: "entrance", targets: ["opacity"] }),
          expect.objectContaining({ id: "lower-third-in", kind: "entrance", targets: ["opacity", "transform.y"] }),
          expect.objectContaining({ id: "lower-third-out", kind: "exit", targets: ["opacity", "transform.y"] })
        ])
      });
    }
  });

  it("applies timeline animation presets through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].opacity = 0.9;
    motion.layers[0].transform = { y: 12 };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-animation-preset-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.animation.preset.apply",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          preset: "lower-third-in",
          durationMs: 200,
          distancePx: 24,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-animation-preset-apply.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0].keyframes).toEqual({
          opacity: [
            { atMs: 0, value: 0, easing: "ease-out" },
            { atMs: 200, value: 0.9 }
          ],
          "transform.y": [
            { atMs: 0, value: 36, easing: "ease-out" },
            { atMs: 200, value: 12 }
          ]
        });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.animation.preset.apply",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          preset: "lower-third-in",
          action: "applied",
          timing: { startMs: 0, endMs: 200, durationMs: 200 },
          changedPaths: [
            "/layers/title/keyframes/opacity/0",
            "/layers/title/keyframes/opacity/200",
            "/layers/title/keyframes/transform.y/0",
            "/layers/title/keyframes/transform.y/200"
          ],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: [
            "/layers/title/keyframes/opacity/0",
            "/layers/title/keyframes/opacity/200",
            "/layers/title/keyframes/transform.y/0",
            "/layers/title/keyframes/transform.y/200"
          ],
          action: "applied",
          preset: "lower-third-in",
          timing: { startMs: 0, endMs: 200, durationMs: 200 },
          appliedKeyframes: [
            { target: "opacity", atMs: 0, value: 0, easing: "ease-out" },
            { target: "opacity", atMs: 200, value: 0.9 },
            { target: "transform.y", atMs: 0, value: 36, easing: "ease-out" },
            { target: "transform.y", atMs: 200, value: 12 }
          ],
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.animation.preset.apply",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            preset: "lower-third-in",
            durationMs: 200,
            distancePx: 24,
            action: "applied",
            timing: { startMs: 0, endMs: 200, durationMs: 200 },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("applies staggered timeline animation presets to multiple layers through the debug API", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].opacity = 1;
    motion.layers[0].transform = { y: 20 };
    motion.layers.push({
      id: "subtitle",
      type: "text",
      text: "B",
      trackId: "overlay",
      startMs: 0,
      durationMs: 500,
      opacity: 0.8,
      transform: { y: 30 }
    });
    motion.tracks[0].layerIds.push("subtitle");
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-animation-preset-group-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.animation.preset.apply",
        {
          packageRoot,
          outDir,
          layerIds: ["subtitle", "title"],
          preset: "lower-third-in",
          startMs: 50,
          durationMs: 100,
          staggerMs: 75,
          distancePx: 10
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-animation-preset-apply.receipt.json");
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const subtitle = patchedMotion.layers.find((layer: { id: string }) => layer.id === "subtitle");
        const title = patchedMotion.layers.find((layer: { id: string }) => layer.id === "title");

        expect(subtitle.keyframes).toEqual({
          opacity: [
            { atMs: 50, value: 0, easing: "ease-out" },
            { atMs: 150, value: 0.8 }
          ],
          "transform.y": [
            { atMs: 50, value: 40, easing: "ease-out" },
            { atMs: 150, value: 30 }
          ]
        });
        expect(title.keyframes).toEqual({
          opacity: [
            { atMs: 125, value: 0, easing: "ease-out" },
            { atMs: 225, value: 1 }
          ],
          "transform.y": [
            { atMs: 125, value: 30, easing: "ease-out" },
            { atMs: 225, value: 20 }
          ]
        });
        expect(result.visibleState).toMatchObject({
          panel: "timeline",
          operation: "timeline.animation.preset.apply",
          layerIds: ["subtitle", "title"],
          preset: "lower-third-in",
          staggerMs: 75,
          applications: [
            { layerId: "subtitle", timing: { startMs: 50, endMs: 150, durationMs: 100 } },
            { layerId: "title", timing: { startMs: 125, endMs: 225, durationMs: 100 } }
          ],
          receiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          layerIds: ["subtitle", "title"],
          staggerMs: 75,
          applications: [
            { layerId: "subtitle", timing: { startMs: 50, endMs: 150, durationMs: 100 } },
            { layerId: "title", timing: { startMs: 125, endMs: 225, durationMs: 100 } }
          ],
          validation: { ok: true }
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("trims timeline layer timing through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-trim-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.trim",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          startMs: 75,
          durationMs: 300,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-trim.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0]).toMatchObject({ startMs: 75, durationMs: 300 });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.trim",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          action: "updated",
          changedPaths: ["/layers/title/startMs", "/layers/title/durationMs"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/title/startMs", "/layers/title/durationMs"],
          action: "updated",
          oldTiming: { startMs: 0, durationMs: 500 },
          newTiming: { startMs: 75, durationMs: 300 },
          layer: { id: "title", startMs: 75, durationMs: 300 },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.trim",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            changedPaths: ["/layers/title/startMs", "/layers/title/durationMs"],
            action: "updated",
            oldTiming: { startMs: 0, durationMs: 500 },
            newTiming: { startMs: 75, durationMs: 300 },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("assigns timeline layers to tracks through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push({ id: "captions", type: "caption", name: "Captions", order: 2, layerIds: [] });
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-track-assign-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.track.assign",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          trackId: "captions",
          index: 0,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-track-assign.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0].trackId).toBe("captions");
        expect(patchedMotion.tracks).toEqual([
          { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: [] },
          { id: "captions", type: "caption", name: "Captions", order: 2, layerIds: ["title"] }
        ]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.track.assign",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          oldTrackId: "overlay",
          newTrackId: "captions",
          oldIndex: 0,
          newIndex: 0,
          removedFromTrackIds: ["overlay"],
          action: "assigned",
          changedPaths: ["/layers/title/trackId", "/tracks/0/layerIds", "/tracks/1/layerIds"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/title/trackId", "/tracks/0/layerIds", "/tracks/1/layerIds"],
          action: "assigned",
          oldTrackId: "overlay",
          newTrackId: "captions",
          oldIndex: 0,
          newIndex: 0,
          removedFromTrackIds: ["overlay"],
          layer: { id: "title", trackId: "captions" },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.track.assign",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            oldTrackId: "overlay",
            newTrackId: "captions",
            oldIndex: 0,
            newIndex: 0,
            changedPaths: ["/layers/title/trackId", "/tracks/0/layerIds", "/tracks/1/layerIds"],
            action: "assigned",
            removedFromTrackIds: ["overlay"],
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("imports caption files through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const sourceRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-caption-source-"));
    const captionsPath = join(sourceRoot, "captions.srt");
    await writeFile(
      captionsPath,
      ["1", "00:00:00,000 --> 00:00:01,000", "First caption", "", "2", "00:00:01,250 --> 00:00:02,500", "Second caption"].join("\n"),
      "utf8"
    );
    const captionsSha256 = hashBuffer(await readFile(captionsPath));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-caption-import-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.caption.import",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          captionsPath,
          format: "srt",
          trackId: "captions",
          trackName: "Captions",
          layerPrefix: "cap",
          createdBy: "codex-test"
        },
        { tier: "edit_motion", authoringInputRoots: [packageRoot, sourceRoot], authoringOutputRoots: [outDir] }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-caption-import.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.tracks).toEqual(expect.arrayContaining([
          { id: "captions", type: "caption", name: "Captions", order: 2, layerIds: ["cap_0001", "cap_0002"] }
        ]));
        expect(patchedMotion.layers).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: "cap_0001", type: "caption", text: "First caption", trackId: "captions", startMs: 0, durationMs: 1000 }),
          expect.objectContaining({ id: "cap_0002", type: "caption", text: "Second caption", trackId: "captions", startMs: 1250, durationMs: 1250 })
        ]));
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.caption.import",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          trackId: "captions",
          cueCount: 2,
          insertedLayerIds: ["cap_0001", "cap_0002"],
          replacedLayerIds: [],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          format: "srt",
          trackId: "captions",
          cueCount: 2,
          insertedLayerIds: ["cap_0001", "cap_0002"],
          replacedLayerIds: [],
          trackCreated: true,
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.caption.import",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            captionsPath,
            format: "srt",
            trackId: "captions",
            cueCount: 2,
            insertedLayerIds: ["cap_0001", "cap_0002"],
            replacedLayerIds: [],
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes[captionsPath]).toBe(captionsSha256);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("upserts caption layers through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-caption-upsert-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.caption.upsert",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          id: "caption_001",
          text: "Edited caption",
          startMs: 120,
          durationMs: 900,
          trackId: "captions",
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-caption-upsert.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: "caption_001", type: "caption", text: "Edited caption", trackId: "captions", startMs: 120, durationMs: 900 })
        ]));
        expect(patchedMotion.tracks).toEqual(expect.arrayContaining([
          { id: "captions", type: "caption", name: "Captions", order: 2, layerIds: ["caption_001"] }
        ]));
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.caption.upsert",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "caption_001",
          trackId: "captions",
          action: "inserted",
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          action: "inserted",
          layer: { id: "caption_001", text: "Edited caption", trackId: "captions" },
          trackCreated: true,
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.caption.upsert",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "caption_001",
            text: "Edited caption",
            startMs: 120,
            durationMs: 900,
            trackId: "captions",
            action: "inserted",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects replacing locked caption layers through caption debug commands before copying packages", async () => {
    const cases = [
      {
        command: "motion.timeline.caption.upsert",
        expectedCode: "timeline_caption_upsert_failed",
        args: {
          id: "caption_0001",
          text: "Edited caption",
          startMs: 0,
          durationMs: 1000,
          trackId: "captions"
        }
      },
      {
        command: "motion.timeline.caption.import",
        expectedCode: "timeline_caption_import_failed",
        args: {
          format: "srt",
          trackId: "captions",
          layerPrefix: "caption"
        }
      }
    ] as const;
    const packageRoot = await writeDebugPackageWithTimeline();
    const sourceRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-locked-caption-source-"));
    const captionsPath = join(sourceRoot, "captions.srt");
    await writeFile(captionsPath, "00:00:00,000 --> 00:00:01,000\nImported caption", "utf8");
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks = [{ id: "captions", type: "caption", name: "Captions", order: 1, layerIds: ["caption_0001"] }];
    delete sourceMotion.scenes;
    delete sourceMotion.markers;
    sourceMotion.layers = [
      {
        id: "caption_0001",
        type: "caption",
        text: "Locked caption",
        locked: true,
        trackId: "captions",
        startMs: 0,
        durationMs: 1000
      }
    ];
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDirs: string[] = [];
    try {
      for (const testCase of cases) {
        const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-locked-caption-"));
        outDirs.push(outDir);
        const result = await dispatchDebugCommand(
          testCase.command,
          {
            packageRoot,
            outDir,
            ...(testCase.command === "motion.timeline.caption.import" ? { captionsPath } : {}),
            ...testCase.args
          },
          { tier: "edit_motion", authoringInputRoots: [packageRoot, sourceRoot], authoringOutputRoots: [outDir] }
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toEqual({
            code: testCase.expectedCode,
            message: "Cannot edit locked layer: caption_0001."
          });
        }
        await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow(/ENOENT/);
      }
      const sourceAfter = JSON.parse(await readFile(motionPath, "utf8"));
      expect(sourceAfter.layers[0]).toMatchObject({ id: "caption_0001", text: "Locked caption", locked: true });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
      await Promise.all(outDirs.map((outDir) => rm(outDir, { recursive: true, force: true })));
    }
  });

  it("creates timeline tracks through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const sourceMotionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(sourceMotionPath, "utf8"));
    delete sourceMotion.tracks;
    delete sourceMotion.layers[0].trackId;
    await writeFile(sourceMotionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-create-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.create",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          trackId: "overlay",
          type: "overlay",
          name: "Overlay",
          order: 1,
          layerIds: ["title"],
          index: 0,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-track-create.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.tracks).toEqual([{ id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] }]);
        expect(patchedMotion.layers[0]).toMatchObject({ id: "title", trackId: "overlay" });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.track.create",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          trackId: "overlay",
          action: "created",
          index: 0,
          attachedLayerIds: ["title"],
          changedPaths: ["/tracks/overlay", "/layers/title/trackId"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/tracks/overlay", "/layers/title/trackId"],
          action: "created",
          trackId: "overlay",
          index: 0,
          oldTrackCount: 0,
          newTrackCount: 1,
          attachedLayerIds: ["title"],
          track: { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.track.create",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            trackId: "overlay",
            index: 0,
            changedPaths: ["/tracks/overlay", "/layers/title/trackId"],
            action: "created",
            oldTrackCount: 0,
            newTrackCount: 1,
            attachedLayerIds: ["title"],
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline track create args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-create-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.create",
        {
          packageRoot,
          outDir,
          trackId: "captions",
          type: "caption",
          index: -1
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "index must be a non-negative integer."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("reorders timeline tracks through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push({ id: "music", type: "audio", name: "Music", order: 2, layerIds: [] });
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-reorder-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.reorder",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          trackId: "music",
          index: 0,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-track-reorder.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.tracks.map((track: { id: string }) => track.id)).toEqual(["music", "overlay"]);
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.track.reorder",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          trackId: "music",
          action: "reordered",
          oldIndex: 1,
          newIndex: 0,
          oldTrackOrder: ["overlay", "music"],
          newTrackOrder: ["music", "overlay"],
          changedPaths: ["/tracks"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/tracks"],
          action: "reordered",
          trackId: "music",
          oldIndex: 1,
          newIndex: 0,
          oldTrackOrder: ["overlay", "music"],
          newTrackOrder: ["music", "overlay"],
          track: { id: "music", type: "audio", name: "Music", order: 2, layerIds: [] },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.track.reorder",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            trackId: "music",
            oldIndex: 1,
            newIndex: 0,
            oldTrackOrder: ["overlay", "music"],
            newTrackOrder: ["music", "overlay"],
            changedPaths: ["/tracks"],
            action: "reordered",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline track reorder args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-reorder-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.reorder",
        {
          packageRoot,
          outDir,
          trackId: "overlay",
          index: -1
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "index must be a non-negative integer."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("deletes timeline tracks through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-delete-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.delete",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          trackId: "overlay",
          detachLayers: true,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-track-delete.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.tracks).toBeUndefined();
        expect(patchedMotion.layers[0].trackId).toBeUndefined();
        expect(patchedMotion.scenes[0].trackIds).toBeUndefined();
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.track.delete",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          trackId: "overlay",
          action: "deleted",
          detachedLayerIds: ["title"],
          removedSceneRefs: ["intro"],
          oldTrackCount: 1,
          newTrackCount: 0,
          changedPaths: ["/tracks/overlay", "/layers/title/trackId", "/scenes/intro/trackIds"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/tracks/overlay", "/layers/title/trackId", "/scenes/intro/trackIds"],
          action: "deleted",
          trackId: "overlay",
          detachedLayerIds: ["title"],
          removedSceneRefs: ["intro"],
          oldTrackCount: 1,
          newTrackCount: 0,
          removed: { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.track.delete",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            trackId: "overlay",
            detachedLayerIds: ["title"],
            removedSceneRefs: ["intro"],
            oldTrackCount: 1,
            newTrackCount: 0,
            changedPaths: ["/tracks/overlay", "/layers/title/trackId", "/scenes/intro/trackIds"],
            action: "deleted",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline track delete args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-delete-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.delete",
        {
          packageRoot,
          outDir,
          detachLayers: true
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "motion.timeline.track.delete requires trackId."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("renames timeline tracks through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-rename-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.rename",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          trackId: "overlay",
          name: "Main Titles",
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-track-rename.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.tracks[0]).toMatchObject({ id: "overlay", name: "Main Titles" });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.track.rename",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          trackId: "overlay",
          action: "renamed",
          oldName: "Overlay",
          newName: "Main Titles",
          changedPaths: ["/tracks/overlay/name"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/tracks/overlay/name"],
          action: "renamed",
          trackId: "overlay",
          oldName: "Overlay",
          newName: "Main Titles",
          track: { id: "overlay", type: "overlay", name: "Main Titles", order: 1, layerIds: ["title"] },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.track.rename",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            trackId: "overlay",
            oldName: "Overlay",
            newName: "Main Titles",
            changedPaths: ["/tracks/overlay/name"],
            action: "renamed",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline track rename args before package copy", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-rename-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.rename",
        {
          packageRoot,
          outDir,
          trackId: "overlay"
        },
        { tier: "edit_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "motion.timeline.track.rename requires name."
        }
      });
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("locks timeline tracks through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-lock-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.lock",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          trackId: "overlay",
          locked: true,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-track-lock.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.tracks[0]).toMatchObject({ id: "overlay", locked: true });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.track.lock",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          trackId: "overlay",
          action: "locked",
          oldLocked: false,
          newLocked: true,
          changedPaths: ["/tracks/overlay/locked"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/tracks/overlay/locked"],
          action: "locked",
          trackId: "overlay",
          oldLocked: false,
          newLocked: true,
          track: { id: "overlay", locked: true },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.track.lock",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            trackId: "overlay",
            oldLocked: false,
            newLocked: true,
            changedPaths: ["/tracks/overlay/locked"],
            action: "locked",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline track lock debug args without copying packages", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-lock-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.lock",
        {
          packageRoot,
          outDir,
          trackId: "overlay"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "invalid_args",
          message: "locked must be a boolean."
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("mutes timeline tracks through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push({ id: "music", type: "audio", name: "Music", order: 2, layerIds: [] });
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-mute-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.mute",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          trackId: "music",
          muted: true,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-track-mute.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.tracks[1]).toMatchObject({ id: "music", muted: true });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.track.mute",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          trackId: "music",
          action: "muted",
          oldMuted: false,
          newMuted: true,
          changedPaths: ["/tracks/music/muted"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/tracks/music/muted"],
          action: "muted",
          trackId: "music",
          oldMuted: false,
          newMuted: true,
          track: { id: "music", muted: true },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.track.mute",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            trackId: "music",
            oldMuted: false,
            newMuted: true,
            changedPaths: ["/tracks/music/muted"],
            action: "muted",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline track mute debug args without copying packages", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-mute-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.mute",
        {
          packageRoot,
          outDir,
          trackId: "overlay"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "invalid_args",
          message: "muted must be a boolean."
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("solos timeline tracks through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push({ id: "music", type: "audio", name: "Music", order: 2, layerIds: [] });
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-solo-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.solo",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          trackId: "music",
          solo: true,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-track-solo.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.tracks[1]).toMatchObject({ id: "music", solo: true });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.track.solo",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          trackId: "music",
          action: "soloed",
          oldSolo: false,
          newSolo: true,
          changedPaths: ["/tracks/music/solo"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/tracks/music/solo"],
          action: "soloed",
          trackId: "music",
          oldSolo: false,
          newSolo: true,
          track: { id: "music", solo: true },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.track.solo",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            trackId: "music",
            oldSolo: false,
            newSolo: true,
            changedPaths: ["/tracks/music/solo"],
            action: "soloed",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline track solo debug args without copying packages", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-solo-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.solo",
        {
          packageRoot,
          outDir,
          trackId: "overlay"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "invalid_args",
          message: "solo must be a boolean."
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("sets timeline track volume through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push({ id: "music", type: "audio", name: "Music", order: 2, layerIds: [] });
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-volume-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.volume",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          trackId: "music",
          volume: 0.65,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-track-volume.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.tracks[1]).toMatchObject({ id: "music", volume: 0.65 });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.track.volume",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          trackId: "music",
          action: "updated",
          oldVolume: 1,
          newVolume: 0.65,
          changedPaths: ["/tracks/music/volume"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/tracks/music/volume"],
          action: "updated",
          trackId: "music",
          oldVolume: 1,
          newVolume: 0.65,
          track: { id: "music", volume: 0.65 },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.track.volume",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            trackId: "music",
            oldVolume: 1,
            newVolume: 0.65,
            changedPaths: ["/tracks/music/volume"],
            action: "updated",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline track volume debug args without copying packages", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-volume-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.volume",
        {
          packageRoot,
          outDir,
          trackId: "overlay",
          volume: -0.1
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "invalid_args",
          message: "volume must be a non-negative finite number."
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("sets timeline track fades through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push({ id: "music", type: "audio", name: "Music", order: 2, layerIds: [] });
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-fade-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.fade",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          trackId: "music",
          fadeInMs: 120,
          fadeOutMs: 240,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-track-fade.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.tracks[1]).toMatchObject({ id: "music", fadeInMs: 120, fadeOutMs: 240 });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.track.fade",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          trackId: "music",
          action: "updated",
          oldFade: { fadeInMs: 0, fadeOutMs: 0 },
          newFade: { fadeInMs: 120, fadeOutMs: 240 },
          changedPaths: ["/tracks/music/fadeInMs", "/tracks/music/fadeOutMs"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/tracks/music/fadeInMs", "/tracks/music/fadeOutMs"],
          action: "updated",
          trackId: "music",
          oldFade: { fadeInMs: 0, fadeOutMs: 0 },
          newFade: { fadeInMs: 120, fadeOutMs: 240 },
          track: { id: "music", fadeInMs: 120, fadeOutMs: 240 },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.track.fade",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            trackId: "music",
            oldFade: { fadeInMs: 0, fadeOutMs: 0 },
            newFade: { fadeInMs: 120, fadeOutMs: 240 },
            changedPaths: ["/tracks/music/fadeInMs", "/tracks/music/fadeOutMs"],
            action: "updated",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline track fade debug args without copying packages", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-fade-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.fade",
        {
          packageRoot,
          outDir,
          trackId: "overlay",
          fadeInMs: -1
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "invalid_args",
          message: "fadeInMs and fadeOutMs must be non-negative finite numbers."
        });
      }
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("sets timeline track pan through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push({ id: "music", type: "audio", name: "Music", order: 2, layerIds: [] });
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-pan-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.pan",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          trackId: "music",
          pan: 0.5,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-track-pan.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.tracks[1]).toMatchObject({ id: "music", pan: 0.5 });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.track.pan",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          trackId: "music",
          action: "updated",
          oldPan: 0,
          newPan: 0.5,
          changedPaths: ["/tracks/music/pan"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/tracks/music/pan"],
          action: "updated",
          trackId: "music",
          oldPan: 0,
          newPan: 0.5,
          track: { id: "music", pan: 0.5 },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.track.pan",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            trackId: "music",
            oldPan: 0,
            newPan: 0.5,
            changedPaths: ["/tracks/music/pan"],
            action: "updated",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline track pan debug args without copying packages", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-pan-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.track.pan",
        {
          packageRoot,
          outDir,
          trackId: "overlay",
          pan: 1.25
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "invalid_args",
          message: "pan must be a finite number between -1 and 1."
        });
      }
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("sets timeline layer ducking through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.layers.push(
      { id: "music", type: "audio", source: "assets/music.wav", startMs: 0, durationMs: 2000 },
      { id: "voice", type: "audio", source: "assets/voice.wav", startMs: 600, durationMs: 800 }
    );
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-ducking-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.ducking.set",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "music",
          triggerLayerIds: ["voice"],
          duckToVolume: 0.25,
          attackMs: 100,
          releaseMs: 200,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-layer-ducking.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers.find((layer: { id: string }) => layer.id === "music")).toMatchObject({
          id: "music",
          ducking: { triggerLayerIds: ["voice"], duckToVolume: 0.25, attackMs: 100, releaseMs: 200 }
        });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.layer.ducking.set",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "music",
          action: "updated",
          oldDucking: null,
          newDucking: { triggerLayerIds: ["voice"], duckToVolume: 0.25, attackMs: 100, releaseMs: 200 },
          changedPaths: ["/layers/music/ducking"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPaths: ["/layers/music/ducking"],
          action: "updated",
          layerId: "music",
          oldDucking: null,
          newDucking: { triggerLayerIds: ["voice"], duckToVolume: 0.25, attackMs: 100, releaseMs: 200 },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.layer.ducking.set",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "music",
            oldDucking: null,
            newDucking: { triggerLayerIds: ["voice"], duckToVolume: 0.25, attackMs: 100, releaseMs: 200 },
            changedPaths: ["/layers/music/ducking"],
            action: "updated",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeline layer ducking debug args without copying packages", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.layers.push(
      { id: "music", type: "audio", source: "assets/music.wav", startMs: 0, durationMs: 2000 },
      { id: "voice", type: "audio", source: "assets/voice.wav", startMs: 600, durationMs: 800 }
    );
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-ducking-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.ducking.set",
        {
          packageRoot,
          outDir,
          layerId: "music",
          triggerLayerIds: ["voice"],
          duckToVolume: -0.1
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "invalid_args",
          message: "duckToVolume, attackMs, and releaseMs must be non-negative finite numbers."
        });
      }
      await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects typed layer edit commands on locked tracks before mutating packages", async () => {
    const cases = [
      {
        command: "motion.timeline.keyframe.upsert",
        expectedCode: "timeline_keyframe_upsert_failed",
        args: { layerId: "title", target: "opacity", atMs: 250, value: 0.75 }
      },
      {
        command: "motion.timeline.keyframe.delete",
        expectedCode: "timeline_keyframe_delete_failed",
        args: { layerId: "title", target: "opacity", atMs: 0 }
      },
      {
        command: "motion.timeline.layer.trim",
        expectedCode: "timeline_layer_trim_failed",
        args: { layerId: "title", durationMs: 250 }
      },
      {
        command: "motion.timeline.transition.upsert",
        expectedCode: "timeline_transition_upsert_failed",
        args: { layerId: "title", edge: "in", type: "fade", durationMs: 120 }
      },
      {
        command: "motion.timeline.transition.delete",
        expectedCode: "timeline_transition_delete_failed",
        args: { layerId: "title", edge: "in" }
      }
    ] as const;
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks[0].locked = true;
    sourceMotion.layers[0].keyframes = { opacity: [{ atMs: 0, value: 1 }] };
    sourceMotion.layers[0].transitions = { in: { type: "fade", durationMs: 80 } };
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDirs: string[] = [];
    try {
      for (const testCase of cases) {
        const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-locked-layer-edit-"));
        outDirs.push(outDir);
        const result = await dispatchDebugCommand(
          testCase.command,
          {
            packageRoot,
            outDir,
            ...testCase.args
          },
          { tier: "edit_motion" }
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toEqual({
            code: testCase.expectedCode,
            message: "Cannot edit layer on locked track: overlay."
          });
        }
        await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow(/ENOENT/);
      }
      const sourceAfter = JSON.parse(await readFile(motionPath, "utf8"));
      expect(sourceAfter.tracks[0].locked).toBe(true);
      expect(sourceAfter.layers[0]).toMatchObject({
        keyframes: { opacity: [{ atMs: 0, value: 1 }] },
        transitions: { in: { type: "fade", durationMs: 80 } }
      });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await Promise.all(outDirs.map((outDir) => rm(outDir, { recursive: true, force: true })));
    }
  });

  it("rejects typed layer edit commands on locked layers before mutating packages", async () => {
    const cases = [
      {
        command: "motion.timeline.layer.text.set",
        expectedCode: "timeline_layer_text_set_failed",
        args: { layerId: "title", text: "Changed" }
      },
      {
        command: "motion.timeline.layer.visibility.set",
        expectedCode: "timeline_layer_visibility_set_failed",
        args: { layerId: "title", visible: false }
      },
      {
        command: "motion.timeline.keyframe.upsert",
        expectedCode: "timeline_keyframe_upsert_failed",
        args: { layerId: "title", target: "opacity", atMs: 250, value: 0.75 }
      }
    ] as const;
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    const originalTitleText = sourceMotion.layers[0].text;
    sourceMotion.layers[0].locked = true;
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDirs: string[] = [];
    try {
      for (const testCase of cases) {
        const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-locked-layer-edit-"));
        outDirs.push(outDir);
        const result = await dispatchDebugCommand(
          testCase.command,
          {
            packageRoot,
            outDir,
            ...testCase.args
          },
          { tier: "edit_motion" }
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toEqual({
            code: testCase.expectedCode,
            message: "Cannot edit locked layer: title."
          });
        }
        await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow(/ENOENT/);
      }
      const sourceAfter = JSON.parse(await readFile(motionPath, "utf8"));
      expect(sourceAfter.layers[0]).toMatchObject({ id: "title", locked: true, text: originalTitleText });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await Promise.all(outDirs.map((outDir) => rm(outDir, { recursive: true, force: true })));
    }
  });

  it("refuses non-empty typed layer edit output dirs before deleting files", async () => {
    const cases = [
      {
        command: "motion.timeline.keyframe.upsert",
        message: "motion.timeline.keyframe.upsert outDir must be empty or absent before package copy.",
        args: { layerId: "title", target: "opacity", atMs: 250, value: 0.75 }
      },
      {
        command: "motion.timeline.keyframe.delete",
        message: "motion.timeline.keyframe.delete outDir must be empty or absent before package copy.",
        args: { layerId: "title", target: "opacity", atMs: 0 }
      },
      {
        command: "motion.timeline.layer.trim",
        message: "motion.timeline.layer.trim outDir must be empty or absent before package copy.",
        args: { layerId: "title", durationMs: 250 }
      },
      {
        command: "motion.timeline.transition.upsert",
        message: "motion.timeline.transition.upsert outDir must be empty or absent before package copy.",
        args: { layerId: "title", edge: "in", type: "fade", durationMs: 120 }
      },
      {
        command: "motion.timeline.transition.delete",
        message: "motion.timeline.transition.delete outDir must be empty or absent before package copy.",
        args: { layerId: "title", edge: "in" }
      }
    ] as const;
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.layers[0].keyframes = { opacity: [{ atMs: 0, value: 1 }] };
    sourceMotion.layers[0].transitions = { in: { type: "fade", durationMs: 80 } };
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDirs: string[] = [];
    try {
      for (const testCase of cases) {
        const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-edit-nonempty-"));
        outDirs.push(outDir);
        const sentinelPath = join(outDir, "do-not-delete.txt");
        await writeFile(sentinelPath, "keep", "utf8");

        const result = await dispatchDebugCommand(
          testCase.command,
          {
            packageRoot,
            outDir,
            ...testCase.args
          },
          { tier: "edit_motion" }
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toEqual({
            code: "invalid_args",
            message: testCase.message
          });
        }
        await expect(readFile(sentinelPath, "utf8")).resolves.toBe("keep");
        await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toThrow(/ENOENT/);
      }
      const sourceAfter = JSON.parse(await readFile(motionPath, "utf8"));
      expect(sourceAfter.layers[0]).toMatchObject({
        keyframes: { opacity: [{ atMs: 0, value: 1 }] },
        transitions: { in: { type: "fade", durationMs: 80 } }
      });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await Promise.all(outDirs.map((outDir) => rm(outDir, { recursive: true, force: true })));
    }
  });

  it("refuses non-empty track assignment output dirs before deleting files", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push({ id: "captions", type: "caption", name: "Captions", order: 2, layerIds: [] });
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-track-nonempty-"));
    const sentinelPath = join(outDir, "do-not-delete.txt");
    await writeFile(sentinelPath, "keep", "utf8");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.track.assign",
        {
          packageRoot,
          outDir,
          layerId: "title",
          trackId: "captions",
          index: 0
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "invalid_args",
          message: "motion.timeline.layer.track.assign outDir must be empty or absent before package copy."
        });
      }
      await expect(readFile(sentinelPath, "utf8")).resolves.toBe("keep");
      const sourceAfter = JSON.parse(await readFile(motionPath, "utf8"));
      expect(sourceAfter.layers[0].trackId).toBe("overlay");
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("refuses file paths as track assignment output dirs before copying packages", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push({ id: "captions", type: "caption", name: "Captions", order: 2, layerIds: [] });
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-track-file-"));
    const outPath = join(outRoot, "out.txt");
    await writeFile(outPath, "keep", "utf8");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.layer.track.assign",
        {
          packageRoot,
          outDir: outPath,
          layerId: "title",
          trackId: "captions",
          index: 0
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "timeline_layer_track_assign_failed",
          message: "motion.timeline.layer.track.assign outDir must be inside an approved authoring output root and may not traverse symbolic links."
        });
      }
      await expect(readFile(outPath, "utf8")).resolves.toBe("keep");
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outRoot, { recursive: true, force: true });
    }
  });

  it("upserts timeline transitions through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-transition-upsert-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.transition.upsert",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          edge: "in",
          type: "slide",
          durationMs: 220,
          easing: "ease-out",
          direction: "left",
          distance: 36,
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-transition-upsert.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0].transitions.in).toEqual({
          type: "slide",
          durationMs: 220,
          easing: "ease-out",
          direction: "left",
          distance: 36
        });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.transition.upsert",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          edge: "in",
          type: "slide",
          action: "inserted",
          changedPath: "/layers/title/transitions/in",
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPath: "/layers/title/transitions/in",
          action: "inserted",
          transition: {
            type: "slide",
            durationMs: 220,
            easing: "ease-out",
            direction: "left",
            distance: 36
          },
          layer: {
            id: "title",
            transitions: {
              in: {
                type: "slide",
                durationMs: 220,
                easing: "ease-out",
                direction: "left",
                distance: 36
              }
            }
          },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.transition.upsert",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            edge: "in",
            type: "slide",
            durationMs: 220,
            easing: "ease-out",
            direction: "left",
            distance: 36,
            changedPath: "/layers/title/transitions/in",
            action: "inserted",
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects transition output paths that are ancestors of the source package", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-transition-ancestor-"));
    const packageRoot = join(tempRoot, "source-package");
    await writeDebugPackageWithTimeline(packageRoot);
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.transition.upsert",
        {
          packageRoot,
          outDir: tempRoot,
          layerId: "title",
          edge: "in",
          type: "fade",
          durationMs: 100
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "invalid_args",
          message: "motion.timeline.transition.upsert outDir must be outside packageRoot."
        });
      }
      const sourceMotion = JSON.parse(await readFile(join(packageRoot, "motion.json"), "utf8"));
      expect(sourceMotion.layers[0].transitions).toBeUndefined();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects unsupported transition types as invalid debug arguments", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-transition-invalid-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.transition.upsert",
        {
          packageRoot,
          outDir,
          layerId: "title",
          edge: "in",
          type: "zoom",
          durationMs: 100
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "invalid_args", suggestedAction: "transition type must be one of: fade, slide, wipe.",
          message: "Unsupported transition type: zoom.", detail: { argument: "transition type", value: "zoom", allowedValues: ["fade", "slide", "wipe"] }
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("deletes timeline transitions through the debug API with package and receipt evidence", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].transitions = {
      in: { type: "fade", durationMs: 120, easing: "linear" },
      out: { type: "slide", durationMs: 240, easing: "ease-in", direction: "left", distance: 32 }
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-transition-delete-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.transition.delete",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          layerId: "title",
          edge: "in",
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "timeline-transition-delete.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const patchedMotion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(patchedMotion.layers[0].transitions).toEqual({
          out: { type: "slide", durationMs: 240, easing: "ease-in", direction: "left", distance: 32 }
        });
        expect(result.visibleState).toEqual({
          panel: "timeline",
          operation: "timeline.transition.delete",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          layerId: "title",
          edge: "in",
          action: "deleted",
          changedPath: "/layers/title/transitions/in",
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          packageDir: outDir,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedPath: "/layers/title/transitions/in",
          action: "deleted",
          removed: { type: "fade", durationMs: 120, easing: "linear" },
          remainingEdges: ["out"],
          layer: {
            id: "title",
            transitions: {
              out: { type: "slide", durationMs: 240, easing: "ease-in", direction: "left", distance: 32 }
            }
          },
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "timeline.transition.delete",
          status: "passed",
          packageId: "pkg_debug_timeline",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            layerId: "title",
            edge: "in",
            changedPath: "/layers/title/transitions/in",
            action: "deleted",
            removed: { type: "fade", durationMs: 120, easing: "linear" },
            remainingEdges: ["out"],
            validation: { ok: true },
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("deletes the final timeline transition without leaving invalid empty containers", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].transitions = {
      out: { type: "slide", durationMs: 240, easing: "ease-in", direction: "left", distance: 32 }
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-transition-delete-final-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.timeline.transition.delete",
        {
          packageRoot,
          outDir,
          layerId: "title",
          edge: "out",
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const commandResult = result.result as { layer: Record<string, unknown> };
        const patchedMotion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
        expect(patchedMotion.layers[0].transitions).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(patchedMotion.layers[0], "transitions")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(commandResult.layer, "transitions")).toBe(false);
        expect(result.result).toMatchObject({
          ok: true,
          changedPath: "/layers/title/transitions/out",
          remainingEdges: [],
          validation: { ok: true }
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("lists export preset metadata through the debug API", async () => {
    const result = await dispatchDebugCommand("motion.export.presets", {}, { tier: "read_motion" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^export-presets-/);
      expect(result.visibleState).toEqual({ panel: "export", presetCount: 10 });
      expect(result.result).toMatchObject({
        ok: true,
        presets: [
          expect.objectContaining({ preset: "mp4-h264", extension: "mp4", mimeType: "video/mp4", supportsAudio: true, supportsAlpha: false }),
          expect.objectContaining({ preset: "mp4-hevc", extension: "mp4", mimeType: "video/mp4", codec: "hevc", supportsAudio: true, supportsAlpha: false, encoderPolicy: { family: "hevc", mode: "software-preferred", candidates: ["libx265"] } }),
          expect.objectContaining({ preset: "webm-av1", extension: "webm", mimeType: "video/webm", codec: "av1", supportsAudio: true, supportsAlpha: false, encoderPolicy: { family: "av1", mode: "software-preferred", candidates: ["libsvtav1", "libaom-av1"] } }),
          expect.objectContaining({ preset: "webm-vp9", extension: "webm", mimeType: "video/webm", supportsAudio: true, supportsAlpha: false }),
          expect.objectContaining({ preset: "webm-vp9-alpha", extension: "webm", mimeType: "video/webm", supportsAudio: true, supportsAlpha: true }),
          expect.objectContaining({ preset: "gif", extension: "gif", mimeType: "image/gif", supportsAudio: false, supportsAlpha: false }),
          expect.objectContaining({ preset: "mov-prores", extension: "mov", mimeType: "video/quicktime", supportsAudio: true, supportsAlpha: true }),
          expect.objectContaining({ preset: "png-sequence", extension: "png", mimeType: "image/png", supportsAudio: false, supportsAlpha: true, outputKind: "image_sequence" }),
          expect.objectContaining({ preset: "png-frame", extension: "png", mimeType: "image/png", supportsAudio: false, supportsAlpha: true, outputKind: "still_frame" }),
          expect.objectContaining({ preset: "jpeg-frame", extension: "jpg", mimeType: "image/jpeg", supportsAudio: false, supportsAlpha: false, outputKind: "still_frame" })
        ]
      });
    }
  });

  it("summarizes export presets into panel-ready groups through the debug API", async () => {
    const result = await dispatchDebugCommand("motion.export.panel", {}, { tier: "read_motion", receiptsRoot: tmpdir() });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visibleState).toMatchObject({
        panel: "export",
        operation: "export.panel",
        presetCount: 10,
        groupCount: 4,
        defaultPreset: "mp4-h264",
        recommendedPresets: {
          delivery: "mp4-h264",
          transparent: "webm-vp9-alpha",
          imageSequence: "png-sequence",
          stillFrame: "png-frame"
        }
      });
      expect(result.result).toMatchObject({
        ok: true,
        defaultPreset: "mp4-h264",
        recommendedPresets: {
          delivery: "mp4-h264",
          transparent: "webm-vp9-alpha",
          imageSequence: "png-sequence",
          stillFrame: "png-frame"
        },
        groups: [
          { id: "delivery", label: "Delivery Video", presetIds: ["mp4-h264", "mp4-hevc", "webm-av1", "webm-vp9"] },
          { id: "transparent", label: "Transparent Overlays", presetIds: ["webm-vp9-alpha", "mov-prores"] },
          { id: "animation", label: "Lightweight Animation", presetIds: ["gif"] },
          { id: "image", label: "Frames And Sequences", presetIds: ["png-sequence", "png-frame", "jpeg-frame"] }
        ],
        cards: expect.arrayContaining([
          expect.objectContaining({
            preset: "mp4-h264",
            groupId: "delivery",
            outputKind: "video",
            badges: ["audio"],
            recommendedFor: expect.arrayContaining(["default", "Canvas MP4", "Cut timeline media"]),
            suggestedArgs: { render: ["--preset", "mp4-h264"], debugRender: ["--preset", "mp4-h264"] }
          }),
          expect.objectContaining({
            preset: "webm-vp9-alpha",
            groupId: "transparent",
            outputKind: "video",
            badges: ["audio", "alpha"],
            recommendedFor: expect.arrayContaining(["transparent overlay"])
          }),
          expect.objectContaining({
            preset: "png-sequence",
            groupId: "image",
            outputKind: "image_sequence",
            badges: ["no-audio", "alpha"],
            suggestedArgs: { render: ["--preset", "png-sequence"], debugRender: ["--preset", "png-sequence"] }
          }),
          expect.objectContaining({
            preset: "jpeg-frame",
            groupId: "image",
            outputKind: "still_frame",
            badges: ["no-audio"]
          })
        ])
      });
    }
  });

  it("plans export presets with package-aware preflight guidance through the debug API", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outputPath = join(packageRoot, "..", "render", "transparent.webm"), receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-export-plan-receipts-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.export.plan",
        {
          packageRoot,
          target: "transparent overlay for Cut",
          needsAlpha: true,
          needsAudio: true,
          outputPath,
          requiredHosts: ["linux", "windows", "macos"],
          qualityManifestPath: join(packageRoot, "quality-manifest.json")
        },
        { tier: "read_motion", receiptsRoot }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^export-plan-/);
        expect(result.visibleState).toMatchObject({
          panel: "export",
          operation: "export.plan",
          packageId: "pkg_debug_timeline",
          preset: "webm-vp9-alpha",
          target: "transparent overlay for Cut",
          recommendedLane: "ffmpeg",
          recommendedPipeline: ["browser", "ffmpeg"],
          preflightCount: expect.any(Number)
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          target: "transparent overlay for Cut",
          preset: "webm-vp9-alpha",
          presetSpec: expect.objectContaining({ supportsAudio: true, supportsAlpha: true, extension: "webm" }),
          outputPath,
          recommendedLane: "ffmpeg",
          recommendedPipeline: {
            lanes: ["browser", "ffmpeg"],
            frameLane: "browser",
            finalLane: "ffmpeg"
          },
          featureImpact: {
            audio: expect.objectContaining({ requested: true, supported: true, packageTrackCount: 0 }),
            alpha: expect.objectContaining({ requested: true, supported: true })
          },
          capturePlan: expect.objectContaining({
            mode: "deterministic-browser-capture",
            requirements: expect.arrayContaining([
              "fixed-viewport-and-device-scale",
              "stylesheets-and-fonts-ready-before-animation-start",
              "network-blocked-unless-declared",
              "timeline-driven-animation-start",
              "trim-dead-lead-in-before-ffmpeg-encode"
            ])
          }),
          preflight: expect.arrayContaining([
            expect.objectContaining({ id: "package.load", status: "passed" }),
            expect.objectContaining({ id: "capture.deterministic_readiness", status: "required" }),
            expect.objectContaining({ id: "platform.verification", status: "missing" }),
            expect.objectContaining({ id: "quality.manifest", status: "planned" })
          ]),
          suggestedActions: expect.arrayContaining([
            expect.objectContaining({ command: "motion.render.final", args: expect.objectContaining({ packageRoot, preset: "webm-vp9-alpha", outputPath }) }),
            expect.objectContaining({ command: "motion.browser.workflow.capture" })
          ]),
          suggestedArgs: expect.objectContaining({
            debugRender: expect.arrayContaining(["--preset", "webm-vp9-alpha", "--quality-manifest", join(packageRoot, "quality-manifest.json")])
          })
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await Promise.all([rm(join(packageRoot, "..", "render"), { recursive: true, force: true }), rm(receiptsRoot, { recursive: true, force: true })]);
    }
  });

  it("surfaces renderer pipelines in final media export plans", async () => {
    const packageRoot = resolve("../../fixtures/packages/lower-third");
    const outputPath = join(tmpdir(), "shellx-motion-export-plan-pipeline.mp4");
    const result = await dispatchDebugCommand(
      "motion.export.plan",
      {
        packageRoot,
        target: "Cut delivery",
        preset: "mp4-h264",
        needsAudio: true,
        outputPath
      },
      { tier: "read_motion", receiptsRoot: tmpdir() }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visibleState).toMatchObject({
        panel: "export",
        operation: "export.plan",
        packageId: "pkg_lower_third",
        preset: "mp4-h264",
        recommendedLane: "ffmpeg",
        recommendedPipeline: ["browser", "ffmpeg"]
      });
      expect(result.result).toMatchObject({
        ok: true,
        preset: "mp4-h264",
        recommendedLane: "ffmpeg",
        recommendedPipeline: {
          lanes: ["browser", "ffmpeg"],
          frameLane: "browser",
          finalLane: "ffmpeg"
        },
        suggestedActions: expect.arrayContaining([
          expect.objectContaining({
            command: "motion.render.final",
            args: expect.objectContaining({ packageRoot, preset: "mp4-h264", outputPath, frameLane: "browser" })
          })
        ]),
        suggestedArgs: {
          render: expect.arrayContaining(["--frame-lane", "browser"]),
          debugRender: expect.arrayContaining(["--frame-lane", "browser"])
        }
      });
    }
  });

  it("warns when export planning chooses a preset that drops requested audio", async () => {
    const result = await dispatchDebugCommand(
      "motion.export.plan",
      { preset: "png-frame", target: "thumbnail", needsAudio: true },
      { tier: "read_motion", receiptsRoot: tmpdir() }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({
        ok: true,
        preset: "png-frame",
        warningCount: 1,
        warnings: ["Export preset png-frame does not support audio; requested audio will be ignored."],
        featureImpact: {
          audio: expect.objectContaining({ requested: true, supported: false, willDrop: true })
        }
      });
    }
  });

  it("marks preset compatibility preflight as warning when requested features will be dropped", async () => {
    const result = await dispatchDebugCommand(
      "motion.export.plan",
      { preset: "gif", target: "animated transparent review with sound", needsAudio: true, needsAlpha: true },
      { tier: "read_motion", receiptsRoot: tmpdir() }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({
        ok: true,
        preset: "gif",
        warningCount: 2,
        warnings: [
          "Export preset gif does not support audio; requested audio will be ignored.",
          "Export preset gif does not preserve alpha; requested transparency will be flattened."
        ],
        featureImpact: {
          audio: expect.objectContaining({ requested: true, supported: false, willDrop: true }),
          alpha: expect.objectContaining({ requested: true, supported: false, willFlatten: true })
        },
        preflight: expect.arrayContaining([
          expect.objectContaining({
            id: "preset.compatibility",
            status: "warning",
            details: expect.arrayContaining([
              "audio=requested_not_supported",
              "alpha=requested_not_supported"
            ])
          })
        ])
      });
    }
  });

  itLinux("adds platform verification evidence to export panels when receipt roots are provided", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-export-platform-"));
    const receiptsRoot = join(tempRoot, "receipts");
    try {
      await mkdir(receiptsRoot, { recursive: true });
      await writeFile(
        join(receiptsRoot, "linux.platform.json"),
        `${JSON.stringify(completedPlatformReceipt({ requiredHosts: ["linux", "windows"], complete: false }), null, 2)}\n`,
        "utf8"
      );

      const result = await dispatchDebugCommand(
        "motion.export.panel",
        { receiptsRoot, requiredHosts: ["linux", "windows"] },
        { tier: "read_motion", receiptsRoot }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toMatchObject({
          panel: "export",
          operation: "export.panel",
          platformVerificationStatus: "partial",
          verifiedAlphaPresetCount: 0
        });
        const body = result.result as {
          platformVerification?: Record<string, unknown>;
          cards?: Array<{ preset: string; verification?: Record<string, unknown> }>;
        };
        expect(body.platformVerification).toMatchObject({
          receiptsRoot,
          status: "partial",
          requiredHosts: ["linux", "windows"],
          satisfiedHosts: ["linux"],
          missingHosts: ["windows"]
        });
        const webm = body.cards?.find((card) => card.preset === "webm-vp9");
        const webmAlpha = body.cards?.find((card) => card.preset === "webm-vp9-alpha");
        const movProres = body.cards?.find((card) => card.preset === "mov-prores");
        expect(webm?.verification).toMatchObject({
          status: "partial",
          requiredCommands: ["render-webm:smoke"],
          satisfiedHosts: ["linux"],
          missingHosts: ["windows"],
          failedHosts: []
        });
        expect(webmAlpha?.verification).toMatchObject({
          status: "partial",
          requiredCommands: ["render-alpha:smoke"],
          satisfiedHosts: ["linux"],
          missingHosts: ["windows"],
          failedHosts: []
        });
        expect(movProres?.verification).toMatchObject({
          status: "partial",
          requiredCommands: ["render-alpha:smoke"]
        });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("checks final media dimensions and audio levels through the debug API", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-quality-"));
    const inputPath = join(tempRoot, "final.mp4");
    const calls: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      if (command.executable.includes("ffprobe")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [
              { codec_type: "video", codec_name: "h264", width: 640, height: 360, avg_frame_rate: "30/1" },
              { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000", duration: "2.000000" }
            ],
            format: { duration: "2.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
          }),
          stderr: ""
        };
      }
      if (command.args.some((arg) => arg.startsWith("volumedetect,"))) {
        return {
          exitCode: 0,
          stdout: "",
          stderr: [
            "[Parsed_volumedetect_0 @ 0x1] n_samples: 96000",
            "[Parsed_volumedetect_0 @ 0x1] mean_volume: -18.5 dB",
            "[Parsed_volumedetect_0 @ 0x1] max_volume: -8.1 dB",
            "{\"input_i\":\"-23.0\",\"input_tp\":\"-0.5\",\"input_lra\":\"8.0\",\"input_thresh\":\"-33.0\",\"target_offset\":\"0.0\"}"
          ].join("\n")
        };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected ffmpeg call" };
    };
    try {
      await writeFile(inputPath, "fake media");
      const result = await dispatchDebugCommand(
        "motion.quality.check",
        {
          inputPath,
          expectWidth: 640,
          expectHeight: 360,
          expectAudio: true,
          maxAudioPeakDb: -6,
          minAudioLoudnessLufs: -24,
          maxAudioLoudnessLufs: -22,
          maxAudioTruePeakDbtp: -0.1,
          maxAudioLoudnessRangeLu: 10
        },
        { tier: "render_motion", ffmpegRunner: runner, scratchRoot: tempRoot }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^quality-check-/);
        expect(result.visibleState).toEqual({
          panel: "receipts",
          operation: "quality.check",
          inputPath,
          ok: true,
          status: "passed"
        });
        expect(result.result).toMatchObject({
          ok: true,
          inputPath,
          checks: {
            expectWidth: 640,
            expectHeight: 360,
            expectAudio: true,
            maxAudioPeakDb: -6,
            minAudioLoudnessLufs: -24,
            maxAudioLoudnessLufs: -22,
            maxAudioTruePeakDbtp: -0.1,
            maxAudioLoudnessRangeLu: 10
          },
          media: {
            ok: true,
            width: 640,
            height: 360,
            audio: {
              present: true,
              streamCount: 1
            }
          },
          audioLevels: {
            ok: true,
            sampleCount: 96000,
            meanVolumeDb: -18.5,
            maxVolumeDb: -8.1,
            integratedLoudnessLufs: -23,
            truePeakDbtp: -0.5,
            loudnessRangeLu: 8
          }
        });
      }
      expect(await dispatchDebugCommand(
        "motion.quality.check",
        { inputPath, maxAudioTruePeakDbtp: -1 },
        { tier: "render_motion", ffmpegRunner: runner, scratchRoot: tempRoot }
      )).toMatchObject({
        ok: false,
        error: {
          code: "audio_quality_failed",
          message: "Audio true peak is -0.5 dBTP; expected at most -1 dBTP."
        }
      });
      expect(calls.some((call) => call.executable.includes("ffprobe"))).toBe(true);
      expect(calls.some((call) => call.args.some((arg) => arg.startsWith("volumedetect,")))).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("binds authenticated motion.quality.check subprocesses and its receipt to one private input snapshot after RED substitution", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-quality-snapshot-red-"));
    const inputPath = join(tempRoot, "final.mp4");
    const admittedBytes = Buffer.from("admitted quality media", "utf8");
    const calls: FfmpegCommand[] = [];
    let substituted = false;
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      if (!substituted) {
        substituted = true;
        await writeFile(inputPath, "RED replacement media", "utf8");
      }
      if (command.executable.includes("ffprobe")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [
              { codec_type: "video", codec_name: "h264", width: 640, height: 360, avg_frame_rate: "30/1" },
              { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000", duration: "2.000000" }
            ],
            format: { duration: "2.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
          }),
          stderr: ""
        };
      }
      return {
        exitCode: 0,
        stdout: "",
        stderr: [
          "[Parsed_volumedetect_0 @ 0x1] n_samples: 96000",
          "[Parsed_volumedetect_0 @ 0x1] mean_volume: -18.5 dB",
          "[Parsed_volumedetect_0 @ 0x1] max_volume: -8.1 dB",
          "{\"input_i\":\"-23.0\",\"input_tp\":\"-0.5\",\"input_lra\":\"8.0\",\"input_thresh\":\"-33.0\",\"target_offset\":\"0.0\"}"
        ].join("\n")
      };
    };
    try {
      await writeFile(inputPath, admittedBytes);
      const result = await dispatchDebugCommand(
        "motion.quality.check",
        { inputPath, expectWidth: 640, expectHeight: 360, expectAudio: true, maxAudioPeakDb: -6 },
        {
          tier: "render_motion",
          ffmpegRunner: runner,
          scratchRoot: tempRoot,
          actor: { kind: "agent", label: "quality-red-control", transport: "mcp", grantedTier: "render_motion" }
        }
      );

      expect(result).toMatchObject({
        ok: true,
        result: {
          receipt: { inputHashes: { [inputPath]: hashBuffer(admittedBytes) } }
        }
      });
      const subprocessInputs = calls.map((call) => call.args[call.args.indexOf("-i") + 1]);
      expect(subprocessInputs).toHaveLength(2);
      expect(new Set(subprocessInputs).size).toBe(1);
      expect(subprocessInputs[0]).toMatch(/shellx-motion-ffmpeg-media-[^/]+\/[a-f0-9]{64}\.mp4$/);
      expect(calls.flatMap((call) => call.args)).not.toContain(inputPath);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("refuses media quality checks outside the trusted debug scratch root", async () => {
    const trustedRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-quality-trusted-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-quality-untrusted-"));
    const inputPath = join(outsideRoot, "final.mp4");
    let called = false;
    const runner: FfmpegRunner = async () => {
      called = true;
      throw new Error("ffprobe must not run for untrusted input paths");
    };
    try {
      await writeFile(inputPath, "fake media");
      const result = await dispatchDebugCommand(
        "motion.quality.check",
        { inputPath, expectWidth: 640 },
        { tier: "render_motion", ffmpegRunner: runner, scratchRoot: trustedRoot }
      );

      expect(result).toEqual({
        ok: false,
        error: {
          code: "ffmpeg_failed",
          message: "FFmpeg quality input must remain a canonical regular file inside a configured input root."
        },
        warnings: []
      });
      expect(called).toBe(false);
    } finally {
      await rm(trustedRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("confines quality auxiliary reads and writes to trusted roots before invoking tools", async () => {
    const trustedRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-quality-aux-trusted-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-quality-aux-untrusted-"));
    const inputPath = join(trustedRoot, "final.mp4");
    let called = false;
    const runner: FfmpegRunner = async () => {
      called = true;
      throw new Error("FFmpeg must not run for untrusted auxiliary paths");
    };

    try {
      await writeFile(inputPath, "fake media");
      const cases = [
        {
          args: { inputPath, manifestPath: join(outsideRoot, "quality.json") },
          message: "motion.quality.check manifestPath must be inside a trusted quality input root."
        },
        {
          args: { inputPath, framePath: join(outsideRoot, "frame.png") },
          message: "motion.quality.check framePath must be inside a trusted quality input root."
        },
        {
          args: { inputPath, baselinePath: join(outsideRoot, "baseline.png") },
          message: "motion.quality.check baselinePath must be inside a trusted quality input root."
        },
        {
          args: { inputPath, minBrightPixels: 1, outDir: join(outsideRoot, "frames") },
          message: "motion.quality.check outDir must be inside a trusted quality output root."
        },
        {
          args: { inputPath, receiptsRoot: join(outsideRoot, "receipts") },
          message: "motion.quality.check receiptsRoot must be inside a trusted quality output root."
        }
      ];
      for (const testCase of cases) {
        expect(await dispatchDebugCommand(
          "motion.quality.check",
          testCase.args,
          { tier: "render_motion", ffmpegRunner: runner, scratchRoot: trustedRoot }
        )).toEqual({
          ok: false,
          error: { code: "invalid_args", message: testCase.message },
          warnings: []
        });
      }
      expect(called).toBe(false);
    } finally {
      await rm(trustedRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("reports media quality failures through the debug API", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-quality-failure-receipt-"));
    const inputPath = join(tempRoot, "final.mp4");
    const receiptsRoot = join(tempRoot, "host-receipts");
    const runner: FfmpegRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        streams: [
          { codec_type: "video", codec_name: "h264", width: 320, height: 180, avg_frame_rate: "30/1" }
        ],
        format: { duration: "1.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
      }),
      stderr: ""
    });

    try {
      await writeFile(inputPath, "fake media");
      const result = await dispatchDebugCommand(
        "motion.quality.check",
        { inputPath, expectWidth: 640, expectAudio: true, receiptsRoot },
        { tier: "render_motion", ffmpegRunner: runner, scratchRoot: tempRoot }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({
          code: "media_quality_failed",
          message: "Media width is 320; expected 640.",
          detail: {
            receiptId: expect.stringMatching(/^quality-check-/),
            hostReceiptPath: expect.stringMatching(/quality-check-.*\.receipt\.json$/),
            receipt: {
              schema: "shellx-motion/receipt@1",
              operation: "quality.check",
              status: "failed",
              packageId: "quality-check",
              lane: "quality",
              inputHashes: {
                [inputPath]: expect.stringMatching(/^[a-f0-9]{64}$/)
              },
              output: {
                inputPath,
                media: expect.objectContaining({ width: 320, height: 180 }),
                checks: {
                  expectWidth: 640,
                  expectAudio: true
                },
                error: {
                  code: "media_quality_failed",
                  message: "Media width is 320; expected 640."
                }
              },
              warnings: ["Media width is 320; expected 640."]
            }
          }
        });
        const detail = result.error.detail as { hostReceiptPath: string; receipt: unknown };
        const hostReceipt = JSON.parse(await readFile(detail.hostReceiptPath, "utf8"));
        expect(hostReceipt).toEqual(detail.receipt);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("times out default FFmpeg frame extraction in quality checks", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-quality-timeout-"));
    const inputPath = join(tempRoot, "final.mp4");
    const ffprobeShim = join(tempRoot, "ffprobe-shim.js");
    const ffmpegShim = join(tempRoot, "ffmpeg-hang.js");
    const previousFfmpeg = process.env.SHELLX_MOTION_FFMPEG;
    const previousFfprobe = process.env.SHELLX_MOTION_FFPROBE;
    const previousTimeout = process.env.SHELLX_MOTION_FFMPEG_TIMEOUT_MS;
    try {
      await writeFile(inputPath, "fake media");
      await writeFile(
        ffprobeShim,
        `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify({
          streams: [{ codec_type: "video", codec_name: "h264", width: 640, height: 360, avg_frame_rate: "30/1" }],
          format: { duration: "1.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
        }))});\n`,
        "utf8"
      );
      await writeFile(
        ffmpegShim,
        "#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 200);\n",
        "utf8"
      );
      await chmod(ffprobeShim, 0o755);
      await chmod(ffmpegShim, 0o755);
      process.env.SHELLX_MOTION_FFPROBE = ffprobeShim;
      process.env.SHELLX_MOTION_FFMPEG = ffmpegShim;
      process.env.SHELLX_MOTION_FFMPEG_TIMEOUT_MS = "50";

      const result = await dispatchDebugCommand(
        "motion.quality.check",
        { inputPath, outDir: join(tempRoot, "quality"), minBrightPixels: 1 },
        { tier: "render_motion", scratchRoot: tempRoot }
      );

      expect(result).toEqual({
        ok: false,
        error: {
          code: "ffmpeg_failed",
          message: "FFmpeg command timed out after 50ms."
        },
        warnings: []
      });
    } finally {
      restoreEnv("SHELLX_MOTION_FFMPEG", previousFfmpeg);
      restoreEnv("SHELLX_MOTION_FFPROBE", previousFfprobe);
      restoreEnv("SHELLX_MOTION_FFMPEG_TIMEOUT_MS", previousTimeout);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("captures browser preview frames through the debug API", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-preview-frame-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.preview.frame",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outDir,
          atMs: 500,
          workflow: {
            schema: "shellx-motion/browser-workflow@1",
            viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
            steps: [{ action: "wait", ms: 10 }]
          }
        },
        {
          tier: "render_motion",
          browserFrameRenderer: async (pkg, options) => ({
            ok: true,
            output: {
              path: join(options.outDir, "debug-frame.png"),
              sha256: "a".repeat(64),
              width: pkg.motion.width,
              height: pkg.motion.height,
              atMs: options.atMs,
              browser: { name: "chromium", version: "test" },
              viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
              workflow: options.workflow ? {
                schema: "shellx-motion/browser-workflow@1",
                networkPolicy: "blocked-unless-declared",
                stepCount: options.workflow.steps.length,
                steps: [{ action: "wait", ms: 10 }]
              } : undefined,
              workflowTrace: options.workflow ? {
                schema: "shellx-motion/browser-workflow-trace@1",
                workflowHash: "b".repeat(64),
                stepCount: options.workflow.steps.length,
                steps: [{ index: 0, action: { action: "wait", ms: 10 }, status: "passed" }]
              } : undefined
            },
            receipt: {
              schema: "shellx-motion/receipt@1",
              id: "browser-preview-debug",
              operation: "preview.frame",
              status: "passed",
              packageId: pkg.manifest.id,
              inputHashes: { motion: "c".repeat(64) },
              createdAt: "2026-07-01T00:00:00.000Z",
              lane: "browser",
              output: { path: join(options.outDir, "debug-frame.png") },
              warnings: []
            }
          })
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toBe("browser-preview-debug");
        expect(result.visibleState).toEqual({
          panel: "preview",
          operation: "preview.frame",
          packageId: "pkg_keyframed_lower_third",
          atMs: 500,
          outputPath: join(outDir, "debug-frame.png")
        });
        expect(result.result).toMatchObject({
          ok: true,
          lane: "browser",
          packageId: "pkg_keyframed_lower_third",
          output: {
            path: join(outDir, "debug-frame.png"),
            atMs: 500,
            workflow: {
              stepCount: 1
            },
            workflowTrace: {
              stepCount: 1
            }
          },
          receipt: {
            id: "browser-preview-debug",
            operation: "preview.frame"
          }
        });
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("passes deterministic createdAt into browser preview frame renders", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-preview-frame-created-at-"));
    try {
      let rendererCreatedAt: string | undefined;
      const result = await dispatchDebugCommand(
        "motion.preview.frame",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outDir,
          atMs: 500,
          createdAt: "2026-07-03T10:30:00.000Z"
        },
        {
          tier: "render_motion",
          browserFrameRenderer: async (pkg, options) => {
            rendererCreatedAt = options.now?.();
            const outputPath = join(options.outDir, "debug-frame-created-at.png");
            return {
              ok: true,
              output: {
                path: outputPath,
                sha256: "d".repeat(64),
                width: pkg.motion.width,
                height: pkg.motion.height,
                atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: "browser-preview-created-at",
                operation: "preview.frame",
                status: "passed",
                packageId: pkg.manifest.id,
                inputHashes: { motion: "e".repeat(64) },
                createdAt: rendererCreatedAt ?? "",
                lane: "browser",
                output: { path: outputPath },
                warnings: []
              }
            };
          }
        }
      );

      expect(rendererCreatedAt).toBe("2026-07-03T10:30:00.000Z");
      expect(result).toMatchObject({
        ok: true,
        result: {
          receipt: {
            id: "browser-preview-created-at",
            createdAt: "2026-07-03T10:30:00.000Z"
          }
        }
      });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("captures browser playhead previews through the debug API", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-preview-playhead-"));
    const receiptsRoot = join(outDir, "receipts");
    const statePath = join(packageRoot, ".shellx-motion", "timeline-state.json");
    const renderedAtMs: number[] = [];
    const rendererCreatedAt: Array<string | undefined> = [];
    try {
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, `${JSON.stringify({
        schema: "shellx-motion/timeline-state@1",
        packageId: "pkg_debug_timeline",
        motionId: "motion_debug_timeline",
        durationMs: 500,
        playheadMs: 250,
        updatedAt: "2026-07-01T00:00:00.000Z"
      }, null, 2)}\n`, "utf8");

      const result = await dispatchDebugCommand(
        "motion.preview.playhead",
        { packageRoot, outDir, receiptsRoot, createdAt: "2026-07-03T11:00:00.000Z" },
        {
          tier: "render_motion",
          browserFrameRenderer: async (pkg, options) => {
            renderedAtMs.push(options.atMs);
            rendererCreatedAt.push(options.now?.());
            const outputPath = options.outputPath ?? join(options.outDir, `debug-playhead-${options.atMs}.png`);
            await writeFile(outputPath, `png ${options.atMs}`, "utf8");
            return {
              ok: true,
              output: {
                path: outputPath,
                sha256: `${String(options.atMs).padStart(4, "0")}${"b".repeat(60)}`.slice(0, 64),
                width: pkg.motion.width,
                height: pkg.motion.height,
                atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: `browser-playhead-${options.atMs}`,
                operation: "preview.frame",
                status: "passed",
                packageId: pkg.manifest.id,
                inputHashes: { motion: "d".repeat(64) },
                createdAt: options.now?.() ?? "2026-07-01T00:00:00.000Z",
                lane: "browser",
                output: { path: outputPath, atMs: options.atMs },
                warnings: []
              }
            };
          }
        }
      );

      expect(renderedAtMs).toEqual([250]);
      expect(rendererCreatedAt).toEqual(["2026-07-03T11:00:00.000Z"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const receiptPath = (result.result as { receiptPath?: string }).receiptPath;
        expect(result.visibleState).toMatchObject({
          panel: "preview",
          operation: "preview.playhead",
          packageId: "pkg_debug_timeline",
          playheadMs: 250,
          atMs: 250,
          outputPath: join(outDir, "pkg_debug_timeline-playhead-250ms.png"),
          receiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          lane: "browser",
          packageId: "pkg_debug_timeline",
          playheadMs: 250,
          output: {
            path: join(outDir, "pkg_debug_timeline-playhead-250ms.png"),
            atMs: 250
          },
          timelineState: {
            statePath,
            playheadMs: 250
          },
          receipt: {
            operation: "preview.playhead",
            status: "passed",
            packageId: "pkg_debug_timeline",
            createdAt: "2026-07-03T11:00:00.000Z"
          }
        });
        const receipt = JSON.parse(await readFile(receiptPath as string, "utf8")) as Record<string, unknown>;
        expect(receipt).toMatchObject({
          operation: "preview.playhead",
          createdAt: "2026-07-03T11:00:00.000Z",
          output: {
            path: join(outDir, "pkg_debug_timeline-playhead-250ms.png"),
            playheadMs: 250,
            timelineState: { statePath }
          }
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("reuses one default browser session for an ordered preview strip", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-preview-strip-session-"));
    const renderedAtMs: number[] = [];
    let closeCount = 0;
    const factory = vi.spyOn(browserRenderer, "createHostBoundBrowserRenderSessionFactory").mockImplementation(() => async (pkg) => ({
      browserVersion: "test",
      scriptExecution: { schema: "shellx-motion/script-execution@1", detectedClass: "data-only", requestedMode: "none", activeMode: "data-only", resolverVersion: 1, sources: [] },
      metrics: {
        browserLaunches: 1,
        framesRendered: 0,
        contextsCreated: 0,
        pagesCreated: 0,
        activeFrames: 0,
        peakConcurrentFrames: 0,
        frameCacheHits: 0,
        frameRetries: 0
      },
      renderFrame: async (options: Parameters<MotionBrowserRenderSession["renderFrame"]>[0]) => {
        renderedAtMs.push(options.atMs);
        const outputPath = options.outputPath ?? join(options.outDir, `debug-strip-${options.atMs}.png`);
        await writeFile(outputPath, `png ${options.atMs}`, "utf8");
        return {
          ok: true,
          output: {
            path: outputPath,
            sha256: `${String(options.atMs).padStart(4, "0")}${"a".repeat(60)}`.slice(0, 64),
            width: pkg.motion.width,
            height: pkg.motion.height,
            atMs: options.atMs,
            browser: { name: "chromium", version: "test" },
            viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
          },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: `browser-preview-strip-${options.atMs}`,
            operation: "preview.frame",
            status: "passed",
            packageId: pkg.manifest.id,
            inputHashes: { motion: "c".repeat(64) },
            createdAt: options.now?.() ?? "2026-07-01T00:00:00.000Z",
            lane: "browser",
            output: { path: outputPath, atMs: options.atMs },
            warnings: []
          }
        } as BrowserFrameResult;
      },
      renderFrames: async () => [],
      close: async () => { closeCount += 1; }
    } as MotionBrowserRenderSession));
    try {
      const result = await dispatchDebugCommand(
        "motion.preview.strip",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outDir,
          frameCount: 3,
          startMs: 0,
          endMs: 1000,
          createdAt: "2026-07-03T11:30:00.000Z"
        },
        { tier: "render_motion" }
      );

      expect(factory).toHaveBeenCalledTimes(1);
      expect(renderedAtMs).toEqual([0, 500, 1000]);
      expect(closeCount).toBe(1);
      expect(result).toMatchObject({
        ok: true,
        result: {
          frameCount: 3,
          frames: [
            { index: 0, atMs: 0, path: join(outDir, "pkg_keyframed_lower_third-strip-01-0ms.png") },
            { index: 1, atMs: 500, path: join(outDir, "pkg_keyframed_lower_third-strip-02-500ms.png") },
            { index: 2, atMs: 1000, path: join(outDir, "pkg_keyframed_lower_third-strip-03-1000ms.png") }
          ],
          receipt: { operation: "preview.strip", createdAt: "2026-07-03T11:30:00.000Z" }
        }
      });
    } finally {
      factory.mockRestore();
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("closes one default preview-strip session and stops at the first frame failure", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-preview-strip-session-failure-"));
    const renderedAtMs: number[] = [];
    let closeCount = 0;
    const factory = vi.spyOn(browserRenderer, "createHostBoundBrowserRenderSessionFactory").mockImplementation(() => async (pkg) => ({
      browserVersion: "test",
      scriptExecution: { schema: "shellx-motion/script-execution@1", detectedClass: "data-only", requestedMode: "none", activeMode: "data-only", resolverVersion: 1, sources: [] },
      metrics: {
        browserLaunches: 1,
        framesRendered: 0,
        contextsCreated: 0,
        pagesCreated: 0,
        activeFrames: 0,
        peakConcurrentFrames: 0,
        frameCacheHits: 0,
        frameRetries: 0
      },
      renderFrame: async (options: Parameters<MotionBrowserRenderSession["renderFrame"]>[0]) => {
        renderedAtMs.push(options.atMs);
        if (renderedAtMs.length === 2) throw new Error("frame renderer stopped");
        const outputPath = options.outputPath ?? join(options.outDir, `debug-strip-${options.atMs}.png`);
        await writeFile(outputPath, `png ${options.atMs}`, "utf8");
        return {
          ok: true,
          output: {
            path: outputPath,
            sha256: `${String(options.atMs).padStart(4, "0")}${"a".repeat(60)}`.slice(0, 64),
            width: pkg.motion.width,
            height: pkg.motion.height,
            atMs: options.atMs,
            browser: { name: "chromium", version: "test" },
            viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
          },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: `browser-preview-strip-${options.atMs}`,
            operation: "preview.frame",
            status: "passed",
            packageId: pkg.manifest.id,
            inputHashes: { motion: "c".repeat(64) },
            createdAt: options.now?.() ?? "2026-07-01T00:00:00.000Z",
            lane: "browser",
            output: { path: outputPath, atMs: options.atMs },
            warnings: []
          }
        } as BrowserFrameResult;
      },
      renderFrames: async () => [],
      close: async () => { closeCount += 1; }
    } as MotionBrowserRenderSession));
    try {
      const result = await dispatchDebugCommand(
        "motion.preview.strip",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outDir,
          frameCount: 3,
          startMs: 0,
          endMs: 1000
        },
        { tier: "render_motion" }
      );

      expect(factory).toHaveBeenCalledTimes(1);
      expect(renderedAtMs).toEqual([0, 500]);
      expect(closeCount).toBe(1);
      expect(result).toEqual({
        ok: false,
        error: { code: "preview_strip_failed", message: "frame renderer stopped" },
        warnings: []
      });
    } finally {
      factory.mockRestore();
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("captures deterministic browser preview strips through the debug API", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-preview-strip-"));
    const receiptsRoot = join(outDir, "receipts");
    const renderedAtMs: number[] = [];
    const rendererCreatedAt: Array<string | undefined> = [];
    const factory = vi.spyOn(browserRenderer, "createMotionBrowserRenderSession");
    try {
      const result = await dispatchDebugCommand(
        "motion.preview.strip",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outDir,
          receiptsRoot,
          frameCount: 3,
          startMs: 0,
          endMs: 1000,
          createdAt: "2026-07-03T11:30:00.000Z"
        },
        {
          tier: "render_motion",
          browserFrameRenderer: async (pkg, options) => {
            renderedAtMs.push(options.atMs);
            rendererCreatedAt.push(options.now?.());
            const outputPath = options.outputPath ?? join(options.outDir, `debug-strip-${options.atMs}.png`);
            await writeFile(outputPath, `png ${options.atMs}`, "utf8");
            return {
              ok: true,
              output: {
                path: outputPath,
                sha256: `${String(options.atMs).padStart(4, "0")}${"a".repeat(60)}`.slice(0, 64),
                width: pkg.motion.width,
                height: pkg.motion.height,
                atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: `browser-preview-strip-${options.atMs}`,
                operation: "preview.frame",
                status: "passed",
                packageId: pkg.manifest.id,
                inputHashes: { motion: "c".repeat(64) },
                createdAt: options.now?.() ?? "2026-07-01T00:00:00.000Z",
                lane: "browser",
                output: { path: outputPath, atMs: options.atMs },
                warnings: []
              }
            };
          }
        }
      );

      expect(renderedAtMs).toEqual([0, 500, 1000]);
      expect(factory).not.toHaveBeenCalled();
      expect(rendererCreatedAt).toEqual([
        "2026-07-03T11:30:00.000Z",
        "2026-07-03T11:30:00.000Z",
        "2026-07-03T11:30:00.000Z"
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const receiptPath = (result.result as { receiptPath?: string }).receiptPath;
        expect(receiptPath).toBe(join(receiptsRoot, `${result.receiptId}.receipt.json`));
        expect(result.visibleState).toEqual({
          panel: "preview",
          operation: "preview.strip",
          packageId: "pkg_keyframed_lower_third",
          frameCount: 3,
          startMs: 0,
          endMs: 1000,
          receiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          lane: "browser",
          packageId: "pkg_keyframed_lower_third",
          frameCount: 3,
          startMs: 0,
          endMs: 1000,
          frames: [
            { index: 0, atMs: 0, path: join(outDir, "pkg_keyframed_lower_third-strip-01-0ms.png") },
            { index: 1, atMs: 500, path: join(outDir, "pkg_keyframed_lower_third-strip-02-500ms.png") },
            { index: 2, atMs: 1000, path: join(outDir, "pkg_keyframed_lower_third-strip-03-1000ms.png") }
          ],
          // This stub renderer writes placeholder bytes rather than real PNGs, so the strip's motion
          // probe cannot measure anything. It says so — an unmeasurable probe reports "unavailable"
          // and warns, rather than emitting a zero that would read as "this piece is fine". The
          // preview itself still succeeded, so the receipt still reports `passed`: a motion-density
          // observation describes the content, never whether the operation worked.
          motion: { status: "unavailable", reason: expect.stringContaining("not a PNG") },
          receipt: {
            operation: "preview.strip",
            status: "passed",
            packageId: "pkg_keyframed_lower_third",
            lane: "browser",
            createdAt: "2026-07-03T11:30:00.000Z",
            warnings: [expect.stringContaining("Motion density was not measured")]
          },
          artifacts: expect.arrayContaining([
            expect.objectContaining({ role: "preview_frame", mediaType: "image/png", primary: true }),
            expect.objectContaining({ role: "preview_receipt", path: receiptPath, mediaType: "application/json" })
          ])
        });
        const receipt = JSON.parse(await readFile(receiptPath as string, "utf8")) as Record<string, unknown>;
        expect(receipt).toMatchObject({
          operation: "preview.strip",
          createdAt: "2026-07-03T11:30:00.000Z",
          output: {
            frameCount: 3,
            frames: expect.arrayContaining([
              expect.objectContaining({ atMs: 500, path: join(outDir, "pkg_keyframed_lower_third-strip-02-500ms.png") })
            ])
          }
        });
      }
    } finally {
      factory.mockRestore();
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("validates preview strip frame count and time range before rendering", async () => {
    await expect(dispatchDebugCommand(
      "motion.preview.strip",
      { packageRoot: "../../fixtures/packages/keyframed-lower-third", frameCount: 0 },
      { tier: "render_motion" }
    )).resolves.toEqual({
      ok: false,
      error: {
        code: "invalid_args",
        message: "frameCount must be a positive integer."
      },
      warnings: []
    });

    await expect(dispatchDebugCommand(
      "motion.preview.strip",
      { packageRoot: "../../fixtures/packages/keyframed-lower-third", startMs: 1000, endMs: 500 },
      { tier: "render_motion" }
    )).resolves.toEqual({
      ok: false,
      error: {
        code: "invalid_args",
        message: "endMs must be greater than or equal to startMs."
      },
      warnings: []
    });

    await expect(dispatchDebugCommand(
      "motion.preview.strip",
      { packageRoot: "../../fixtures/packages/keyframed-lower-third", startMs: 3500 },
      { tier: "render_motion" }
    )).resolves.toEqual({
      ok: false,
      error: {
        code: "invalid_args",
        message: "startMs must be within motion duration."
      },
      warnings: []
    });
  });

  it("reports browser preview frame failures through the debug API", async () => {
    const result = await dispatchDebugCommand(
      "motion.preview.frame",
      { packageRoot: "../../fixtures/packages/keyframed-lower-third" },
      {
        tier: "render_motion",
        browserFrameRenderer: async () => {
          throw new Error("browser executable missing");
        }
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "preview_failed",
        message: "browser executable missing"
      });
    }
  });

  it("captures deterministic browser workflow traces through the debug API", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-browser-workflow-"));
    const outputPath = join(outDir, "browser-frame.png");
    const workflowTracePath = join(outDir, "pkg_keyframed_lower_third-browser-workflow.trace.json");
    const receiptPath = join(outDir, "pkg_keyframed_lower_third-browser-capture.receipt.json");
    try {
      const result = await dispatchDebugCommand(
        "motion.browser.workflow.capture",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outDir,
          atMs: 750,
          workflow: {
            schema: "shellx-motion/browser-workflow@1",
            viewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
            networkPolicy: "blocked-unless-declared",
            steps: [{ action: "type", selector: "#prompt", text: "secret" }]
          }
        },
        {
          tier: "render_motion",
          scratchRoot: outDir,
          browserFrameRenderer: async (pkg, options) => ({
            ok: true,
            output: {
              path: outputPath,
              sha256: "d".repeat(64),
              width: pkg.motion.width,
              height: pkg.motion.height,
              atMs: options.atMs,
              browser: { name: "chromium", version: "test" },
              viewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
              workflow: {
                schema: "shellx-motion/browser-workflow@1",
                networkPolicy: "blocked-unless-declared",
                stepCount: 1,
                steps: [{ action: "type", selector: "#prompt", textLength: 6 }]
              },
              workflowTrace: {
                schema: "shellx-motion/browser-workflow-trace@1",
                workflowHash: "e".repeat(64),
                stepCount: 1,
                steps: [{ index: 0, action: { action: "type", selector: "#prompt", textLength: 6 }, status: "passed" }]
              }
            },
            receipt: {
              schema: "shellx-motion/receipt@1",
              id: "browser-workflow-capture-debug",
              operation: "preview.frame",
              status: "passed",
              packageId: pkg.manifest.id,
              inputHashes: { motion: "f".repeat(64), workflow: "e".repeat(64) },
              createdAt: "2026-07-01T00:00:00.000Z",
              lane: "browser",
              output: { path: outputPath },
              warnings: []
            }
          })
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toBe("browser-workflow-capture-debug");
        expect(result.visibleState).toEqual({
          panel: "preview",
          operation: "browser.workflow.capture",
          packageId: "pkg_keyframed_lower_third",
          outputPath,
          workflowTracePath
        });
        expect(result.result).toMatchObject({
          ok: true,
          command: "browser.workflow.capture",
          lane: "browser",
          deterministic: {
            network: "blocked-unless-declared",
            animations: "disabled",
            caret: "hide",
            deviceScaleFactor: 2
          },
          outputPath,
          workflowTracePath,
          receiptPath,
          artifacts: expect.arrayContaining([
            expect.objectContaining({ role: "preview_frame", path: outputPath, status: "available", primary: true }),
            expect.objectContaining({ role: "browser_workflow_trace", path: workflowTracePath, status: "available" }),
            expect.objectContaining({ role: "preview_receipt", path: receiptPath, status: "available" })
          ]),
          output: {
            workflowTracePath,
            workflow: {
              steps: [{ action: "type", selector: "#prompt", textLength: 6 }]
            }
          }
        });
        const trace = JSON.parse(await readFile(workflowTracePath, "utf8")) as Record<string, unknown>;
        const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, any>;
        expect(trace).toMatchObject({
          schema: "shellx-motion/browser-workflow-trace@1",
          workflowHash: "e".repeat(64),
          steps: [{ action: { action: "type", selector: "#prompt", textLength: 6 } }]
        });
        expect(receipt.artifacts).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: "browser_workflow_trace", path: workflowTracePath }),
          expect.objectContaining({ role: "preview_frame", path: outputPath })
        ]));
        expect(receipt.operation).toBe("browser.workflow.capture");
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects browser workflow waits that can stall deterministic debug capture", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-browser-workflow-long-wait-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.browser.workflow.capture",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outDir,
          workflow: {
            schema: "shellx-motion/browser-workflow@1",
            steps: [{ action: "wait", ms: 30_001 }]
          }
        },
        {
          tier: "render_motion",
          browserFrameRenderer: async () => {
            throw new Error("renderer should not run for an invalid workflow");
          }
        }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "invalid_args",
          message: "workflow must be a shellx-motion/browser-workflow@1 object."
        });
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("writes failed browser workflow traces through the debug API", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-browser-workflow-failure-"));
    const workflowTracePath = join(outDir, "pkg_keyframed_lower_third-browser-workflow.trace.json");
    const receiptPath = join(outDir, "pkg_keyframed_lower_third-browser-capture.receipt.json");
    try {
      const failedStep = {
        index: 1,
        action: { action: "verify", selector: "body", hasText: true },
        status: "failed" as const,
        error: {
          code: "text_mismatch" as const,
          message: "Expected selector body text to contain requested workflow text.",
          selector: "body",
          expectedTextLength: 18,
          actualTextLength: 5,
          actualTextSha256: "a".repeat(64)
        }
      };
      const trace = {
        schema: "shellx-motion/browser-workflow-trace@1" as const,
        workflowHash: "9".repeat(64),
        stepCount: 2,
        steps: [
          { index: 0, action: { action: "wait", ms: 5 }, status: "passed" as const },
          failedStep
        ]
      };
      const result = await dispatchDebugCommand(
        "motion.browser.workflow.capture",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outDir,
          workflow: {
            schema: "shellx-motion/browser-workflow@1",
            steps: [
              { action: "wait", ms: 5 },
              { action: "verify", selector: "body", text: "Sensitive expected" }
            ]
          }
        },
        {
          tier: "render_motion",
          scratchRoot: outDir,
          browserFrameRenderer: async () => {
            throw new BrowserWorkflowReplayError(trace, failedStep);
          }
        }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "browser_workflow_replay_failed",
          message: expect.stringContaining("Browser workflow replay failed at step 1"),
          detail: {
            workflowTracePath,
            receiptPath,
            workflowTrace: trace,
            artifacts: expect.arrayContaining([
              expect.objectContaining({ role: "browser_workflow_trace", path: workflowTracePath, status: "failed" }),
              expect.objectContaining({ role: "preview_receipt", path: receiptPath, status: "available" })
            ])
          }
        },
        warnings: [expect.stringContaining("Browser workflow replay failed at step 1")]
      });
      const writtenTrace = JSON.parse(await readFile(workflowTracePath, "utf8")) as Record<string, unknown>;
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
      expect(writtenTrace).toMatchObject(trace);
      expect(receipt).toMatchObject({
        operation: "browser.workflow.capture",
        status: "failed",
        output: {
          workflowTracePath,
          workflowTrace: trace
        },
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: "browser_workflow_trace", status: "failed" })
        ])
      });
      expect(JSON.stringify({ result, writtenTrace, receipt })).not.toContain("Sensitive expected");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("emits sampled browser recording manifests through the debug API", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-browser-recording-manifest-"));
    const recordingManifestPath = join(outDir, "browser-recording.manifest.json");
    const receiptPath = join(outDir, "pkg_keyframed_lower_third-browser-capture.receipt.json");
    const renderedAtMs: number[] = [];
    const captureReadiness = {
      schema: "shellx-motion/browser-capture-readiness@1" as const,
      page: "loaded" as const,
      stylesheets: "settled" as const,
      fonts: "ready" as const,
      animationPolicy: "screenshot-disabled" as const,
      media: "settled-after-time-seek" as const,
      waitMs: 7,
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
    };
    try {
      const result = await dispatchDebugCommand(
        "motion.browser.workflow.capture",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outDir,
          atMs: 750,
          recordingManifestPath,
          recordingSampleCount: 2,
          workflow: {
            schema: "shellx-motion/browser-workflow@1",
            networkPolicy: "blocked-unless-declared",
            steps: [{ action: "wait", ms: 5 }]
          }
        },
        {
          tier: "render_motion",
          scratchRoot: outDir,
          browserFrameRenderer: async (pkg, options) => {
            renderedAtMs.push(options.atMs);
            const outputPath = options.outputPath ?? join(options.outDir, `debug-frame-${options.atMs}.png`);
            await writeFile(outputPath, `png ${options.atMs}`, "utf8");
            return {
              ok: true,
              output: {
                path: outputPath,
                sha256: `${String(options.atMs).padStart(4, "0")}${"a".repeat(60)}`.slice(0, 64),
                width: pkg.motion.width,
                height: pkg.motion.height,
                atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 },
                workflow: {
                  schema: "shellx-motion/browser-workflow@1",
                  networkPolicy: "blocked-unless-declared",
                  stepCount: 1,
                  steps: [{ action: "wait", ms: 5 }]
                },
                workflowTrace: {
                  schema: "shellx-motion/browser-workflow-trace@1",
                  workflowHash: "2".repeat(64),
                  stepCount: 1,
                  steps: [{ index: 0, action: { action: "wait", ms: 5 }, status: "passed" }],
                  captureReadiness
                },
                captureReadiness
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: `browser-recording-debug-${options.atMs}`,
                operation: "preview.frame",
                status: "passed",
                packageId: pkg.manifest.id,
                inputHashes: { motion: "3".repeat(64), workflow: "2".repeat(64) },
                createdAt: "2026-07-01T00:00:00.000Z",
                lane: "browser",
                output: { path: outputPath },
                warnings: []
              }
            };
          }
        }
      );
      const manifest = JSON.parse(await readFile(recordingManifestPath, "utf8")) as Record<string, any>;
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, any>;

      expect(renderedAtMs).toEqual([750, 0, 3000]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toMatchObject({
          recordingManifestPath
        });
        expect(result.result).toMatchObject({
          recordingManifestPath,
          recordingManifest: {
            schema: "shellx-motion/browser-recording-manifest@1",
            sampleCount: 2
          },
          artifacts: expect.arrayContaining([
            expect.objectContaining({ role: "browser_recording_manifest", path: recordingManifestPath, status: "available", mediaType: "application/json" })
          ])
        });
      }
      expect(manifest).toMatchObject({
        schema: "shellx-motion/browser-recording-manifest@1",
        mode: "deterministic-browser-frame-samples",
        packageId: "pkg_keyframed_lower_third",
        motionId: "motion_keyframed_lower_third",
        durationMs: 3000,
        fps: 30,
        sampleCount: 2,
        frames: [
          { index: 0, atMs: 0, path: join(outDir, "browser-recording-frames", "000000.png") },
          { index: 1, atMs: 3000, path: join(outDir, "browser-recording-frames", "000001.png") }
        ],
        workflow: {
          hash: "2".repeat(64),
          tracePath: join(outDir, "pkg_keyframed_lower_third-browser-workflow.trace.json")
        },
        captureReadiness: {
          schema: "shellx-motion/browser-capture-readiness@1",
          fonts: "ready",
          waitMs: 7,
          diagnostics: {
            stylesheetLinkCount: 1,
            finiteAnimationMaxMs: 1200
          }
        }
      });
      expect(receipt.output).toMatchObject({
        recordingManifestPath,
        recordingManifest: {
          schema: "shellx-motion/browser-recording-manifest@1",
          sampleCount: 2
        }
      });
      expect(receipt.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "browser_recording_manifest", path: recordingManifestPath })
      ]));
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("catalogs browser workflow drift through the debug API", async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-browser-workflow-catalog-"));
    const firstOutDir = join(scratchRoot, "capture-1");
    const changedOutDir = join(scratchRoot, "capture-2");
    const failedOutDir = join(scratchRoot, "capture-3");
    const catalogPath = join(scratchRoot, "browser-workflows.catalog.json");
    const receiptPath = join(failedOutDir, "pkg_keyframed_lower_third-browser-capture.receipt.json");
    let outputHash = "1".repeat(64);
    const captureReadiness = {
      schema: "shellx-motion/browser-capture-readiness@1" as const,
      page: "loaded" as const,
      stylesheets: "settled" as const,
      fonts: "ready" as const,
      animationPolicy: "screenshot-disabled" as const,
      media: "settled-after-time-seek" as const,
      waitMs: 9,
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
    };
    try {
      const runCapture = (outDir: string, failOnDrift = false) => dispatchDebugCommand(
        "motion.browser.workflow.capture",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outDir,
          atMs: 750,
          catalogPath,
          failOnDrift,
          workflow: {
            schema: "shellx-motion/browser-workflow@1",
            networkPolicy: "blocked-unless-declared",
            steps: [{ action: "wait", ms: 5 }]
          }
        },
        {
          tier: "render_motion",
          scratchRoot,
          browserFrameRenderer: async (pkg, options) => ({
            ok: true,
            output: {
              path: join(options.outDir, "debug-frame.png"),
              sha256: outputHash,
              width: pkg.motion.width,
              height: pkg.motion.height,
              atMs: options.atMs,
              browser: { name: "chromium", version: "test" },
              viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
              workflow: {
                schema: "shellx-motion/browser-workflow@1",
                networkPolicy: "blocked-unless-declared",
                stepCount: 1,
                steps: [{ action: "wait", ms: 5 }]
              },
              workflowTrace: {
                schema: "shellx-motion/browser-workflow-trace@1",
                workflowHash: "2".repeat(64),
                stepCount: 1,
                steps: [{ index: 0, action: { action: "wait", ms: 5 }, status: "passed" }],
                captureReadiness
              },
              captureReadiness
            },
            receipt: {
              schema: "shellx-motion/receipt@1",
              id: "browser-workflow-catalog-debug",
              operation: "preview.frame",
              status: "passed",
              packageId: pkg.manifest.id,
              inputHashes: { motion: "3".repeat(64), workflow: "2".repeat(64) },
              createdAt: "2026-07-01T00:00:00.000Z",
              lane: "browser",
              output: { path: join(options.outDir, "debug-frame.png") },
              warnings: []
            }
          })
        }
      );

      const first = await runCapture(firstOutDir);
      outputHash = "4".repeat(64);
      const changed = await runCapture(changedOutDir);
      outputHash = "5".repeat(64);
      const failed = await runCapture(failedOutDir, true);
      const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as Record<string, any>;
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, any>;

      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.result).toMatchObject({
          workflowCatalogPath: catalogPath,
          workflowDrift: { status: "new" },
          artifacts: expect.arrayContaining([
            expect.objectContaining({ role: "browser_workflow_catalog", path: catalogPath, status: "available" })
          ])
        });
      }
      expect(changed.ok).toBe(true);
      if (changed.ok) {
        expect(changed.visibleState).toMatchObject({
          workflowCatalogPath: catalogPath,
          workflowDriftStatus: "changed"
        });
        expect(changed.result).toMatchObject({
          workflowCatalogPath: catalogPath,
          workflowDrift: {
            status: "changed",
            baselineOutputSha256: "1".repeat(64),
            currentOutputSha256: "4".repeat(64)
          },
          warnings: expect.arrayContaining([expect.stringContaining("Browser workflow drift detected")])
        });
        expect(changed.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Browser workflow drift detected")]));
      }
      expect(failed.ok).toBe(false);
      if (!failed.ok) {
        expect(failed.error).toMatchObject({
          code: "browser_workflow_drift_detected",
          message: expect.stringContaining("Browser workflow drift detected"),
          detail: {
            workflowCatalogPath: catalogPath,
            workflowDrift: {
              status: "changed",
              baselineOutputSha256: "1".repeat(64),
              currentOutputSha256: "5".repeat(64)
            },
            outputPath: join(failedOutDir, "debug-frame.png"),
            receiptId: "browser-workflow-catalog-debug",
            receiptPath,
            artifacts: expect.arrayContaining([
              expect.objectContaining({ role: "browser_workflow_trace", status: "available" }),
              expect.objectContaining({ role: "browser_workflow_catalog", path: catalogPath, status: "available" }),
              expect.objectContaining({ role: "preview_receipt", path: receiptPath, status: "available" })
            ])
          }
        });
      }
      expect(catalog.entries[0]).toMatchObject({
        packageId: "pkg_keyframed_lower_third",
        drift: { status: "changed" },
        baseline: {
          outputSha256: "1".repeat(64),
          captureReadiness: {
            schema: "shellx-motion/browser-capture-readiness@1",
            fonts: "ready",
            waitMs: 9,
            diagnostics: {
              stylesheetLinkCount: 1,
              finiteAnimationMaxMs: 1200
            }
          }
        },
        latest: {
          outputSha256: "5".repeat(64),
          captureReadiness: {
            schema: "shellx-motion/browser-capture-readiness@1",
            fonts: "ready",
            waitMs: 9
          }
        }
      });
      expect(receipt.output).toMatchObject({
        workflowCatalogPath: catalogPath,
        workflowDrift: { status: "changed" }
      });
      expect(receipt.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "browser_workflow_catalog", path: catalogPath })
      ]));
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it("renders final media through the native frame lane without a browser fallback", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.background = "#000000";
    motion.layers[0].transform = { x: 4, y: 4 };
    motion.layers[0].style = { color: "#ffffff", fontSize: 16 };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-native-render-final-"));
    const outputPath = join(outDir, "final.mp4");
    const framesDir = join(outDir, "frames");
    const calls: FfmpegCommand[] = [];
    let browserCalls = 0;
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      if (command.args[0] === "-version" || command.args.includes("-encoders")) return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      await writeFile(command.args.at(-1) as string, "fake mp4");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      const result = await dispatchDebugCommand(
        "motion.render.final",
        { packageRoot, outputPath, framesDir, keepFrames: true, preset: "mp4-h264", frameLane: "native" },
        {
          tier: "render_motion",
          ffmpegRunner: runner,
          browserFrameRenderer: async () => {
            browserCalls += 1;
            throw new Error("native frame lane must not invoke browser rendering");
          }
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          lane: "ffmpeg",
          frameLane: "native",
          outputPath,
          frames: { dir: framesDir, count: 5 },
          frameReceipt: { lane: "native", status: "passed" },
          receipt: { operation: "render.final", lane: "ffmpeg" }
        });
      }
      expect(browserCalls).toBe(0);
      expect(await readdir(framesDir)).toHaveLength(5);
      expect(calls[0].args).toEqual(["-version"]);
      expect(calls.at(-1)?.args).not.toContain(outputPath); expect(await readFile(outputPath, "utf8")).toBe("fake mp4");
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("carries native still-frame warnings into the final-render receipt", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].text = "Sveiks";
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-native-still-"));
    const outputPath = join(outDir, "frame.png");
    let browserCalls = 0;

    try {
      const result = await dispatchDebugCommand(
        "motion.render.final",
        { packageRoot, outputPath, preset: "png-frame", frameLane: "native" },
        {
          tier: "render_motion",
          browserFrameRenderer: async () => {
            browserCalls += 1;
            throw new Error("native frame lane must not invoke browser rendering");
          }
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          lane: "image",
          frameLane: "native",
          frameReceipt: {
            lane: "native",
            status: "warning",
            warnings: ["Native renderer case-folded lowercase text to uppercase block glyphs on layer title: veiks."]
          },
          receipt: {
            operation: "render.final",
            status: "warning",
            warnings: ["Native renderer case-folded lowercase text to uppercase block glyphs on layer title: veiks."]
          }
        });
      }
      expect(browserCalls).toBe(0);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("refuses non-deliverable native text during final-render planning without a browser fallback", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].text = "Sveiks";
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    let browserCalls = 0;

    try {
      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot,
          outputPath: join(packageRoot, "final.mp4"),
          preset: "mp4-h264",
          frameLane: "native",
          dryRun: true
        },
        {
          tier: "render_motion",
          browserFrameRenderer: async () => {
            browserCalls += 1;
            throw new Error("native frame lane must not invoke browser rendering");
          }
        }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "native_text_not_deliverable",
          suggestedAction: expect.stringContaining("frameLane browser"),
          detail: {
            frameLane: "native",
            unsupported: expect.arrayContaining([
              expect.objectContaining({ layerId: "title", feature: "text.case.preserved" })
            ])
          }
        }
      });
      expect(browserCalls).toBe(0);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("refuses an unsupported native frame lane instead of falling back to browser", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-native-refusal-"));
    let browserCalls = 0;
    try {
      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot: "../../fixtures/packages/web-card",
          outputPath: join(outDir, "frame.png"),
          preset: "png-frame",
          frameLane: "native"
        },
        {
          tier: "render_motion",
          browserFrameRenderer: async () => {
            browserCalls += 1;
            throw new Error("native frame lane must not invoke browser rendering");
          }
        }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "unsupported_layer",
          suggestedAction: expect.stringContaining("frameLane browser"),
          detail: {
            frameLane: "native",
            unsupported: expect.arrayContaining([
              expect.objectContaining({ layerId: "web-card", feature: "layer.type:web" })
            ])
          }
        }
      });
      expect(browserCalls).toBe(0);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("renders final media through the debug API", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-render-final-"));
    const outputPath = join(outDir, "final.mp4");
    const framesDir = join(outDir, "frames");
    const calls: FfmpegCommand[] = [];
    const framePaths: string[] = [];
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      if (command.args[0] === "-version" || command.args.includes("-encoders")) {
        return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      }
      await writeFile(command.args.at(-1) as string, "fake mp4");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outputPath,
          framesDir,
          keepFrames: true,
          preset: "mp4-h264",
          minUniqueFrameHashes: 1
        },
        {
          tier: "render_motion",
          ffmpegRunner: runner,
          browserFrameRenderer: async (pkg, options) => {
            const framePath = options.outputPath ?? join(options.outDir, "frame.png");
            framePaths.push(framePath);
            await mkdir(dirname(framePath), { recursive: true });
            await writeFile(framePath, CONTRAST_PNG);
            return {
              ok: true,
              output: {
                path: framePath,
                sha256: `${String(framePaths.length).padStart(64, "0")}`,
                width: pkg.motion.width,
                height: pkg.motion.height,
                atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: `browser-preview-${framePaths.length}`,
                operation: "preview.frame",
                status: "passed",
                packageId: pkg.manifest.id,
                inputHashes: { motion: "d".repeat(64) },
                createdAt: "2026-07-01T00:00:00.000Z",
                lane: "browser",
                output: { path: framePath },
                warnings: []
              }
            };
          }
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^ffmpeg-render-/);
        // `warning`, not `passed`: this render is a static frame sequence and the receipt says so in
        // two warnings. under the current contract a render receipt escalates on an actionable warning under the
        // shared rule in `@shellx-motion/core` (`receiptStatusForWarnings`), instead of asserting
        // success while telling the reader the output never moves.
        expect(result.visibleState).toEqual({
          panel: "receipts",
          operation: "render.final",
          packageId: "pkg_keyframed_lower_third",
          outputPath,
          status: "warning"
        });
        expect(result.result).toMatchObject({
          ok: true,
          lane: "ffmpeg",
          frameLane: "browser",
          preset: "mp4-h264",
          packageId: "pkg_keyframed_lower_third",
          outputPath,
          frames: { dir: framesDir, count: 90 },
          output: {
            path: outputPath,
            width: 1280,
            height: 720,
            durationMs: 3000,
            codec: "h264",
            container: "mp4",
            preset: "mp4-h264"
          },
          receipt: {
            operation: "render.final",
            status: "warning",
            warnings: expect.arrayContaining([
              "Rendered frame sequence is static; verify this is intentional before using it as product output."
            ]),
            lane: "ffmpeg"
          }
        });
      }
      expect(framePaths).toHaveLength(90);
      expect(calls[0].args).toEqual(["-version"]);
      expect(calls.at(-1)?.args).not.toContain(outputPath); expect(await readFile(outputPath, "utf8")).toBe("fake mp4");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("replays browser workflow evidence during debug final renders", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-render-final-workflow-"));
    const outputPath = join(outDir, "final.mp4");
    const framesDir = join(outDir, "frames");
    const workflowPath = join(outDir, "workflow.json");
    const workflowHash = "a".repeat(64);
    const calls: FfmpegCommand[] = [];
    const workflowRequests: unknown[] = [];
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      if (command.args[0] === "-version" || command.args.includes("-encoders")) {
        return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      }
      await writeFile(command.args.at(-1) as string, "fake mp4");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await writeFile(workflowPath, JSON.stringify({
      schema: "shellx-motion/browser-workflow@1",
      networkPolicy: "blocked-unless-declared",
      steps: [
        { action: "wait", ms: 5 },
        { action: "scroll", y: 12 }
      ],
      cursor: { visible: true, path: [{ x: 6, y: 9, atMs: 0 }] }
    }, null, 2));

    try {
      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outputPath,
          framesDir,
          preset: "mp4-h264",
          workflowPath,
          minUniqueFrameHashes: 1
        },
        {
          tier: "render_motion",
          scratchRoot: outDir,
          ffmpegRunner: runner,
          browserFrameRenderer: async (pkg, options) => {
            const framePath = options.outputPath ?? join(options.outDir, "frame.png");
            const workflow = options.workflow
              ? {
                  schema: options.workflow.schema,
                  networkPolicy: options.workflow.networkPolicy ?? "blocked-unless-declared",
                  stepCount: options.workflow.steps.length,
                  steps: options.workflow.steps.map((step) => ({ ...step })),
                  cursor: { visible: true, pointCount: 1 }
                }
              : undefined;
            const workflowTrace = options.workflow
              ? {
                  schema: "shellx-motion/browser-workflow-trace@1" as const,
                  workflowHash,
                  stepCount: options.workflow.steps.length,
                  steps: [
                    { index: 0, action: { action: "wait" as const, ms: 5 }, status: "passed" as const },
                    { index: 1, action: { action: "scroll" as const, x: 0, y: 12 }, status: "passed" as const }
                  ]
                }
              : undefined;
            workflowRequests.push(options.workflow ?? null);
            await mkdir(dirname(framePath), { recursive: true });
            await writeFile(framePath, CONTRAST_PNG);
            return {
              ok: true,
              output: {
                path: framePath,
                sha256: `${String(workflowRequests.length).padStart(64, "0")}`,
                width: pkg.motion.width,
                height: pkg.motion.height,
                atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 },
                ...(workflow ? { workflow } : {}),
                ...(workflowTrace ? { workflowTrace } : {})
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: `browser-preview-workflow-${workflowRequests.length}`,
                operation: "preview.frame",
                status: "passed",
                packageId: pkg.manifest.id,
                inputHashes: {
                  motion: "d".repeat(64),
                  ...(workflow ? { workflow: workflowHash } : {})
                },
                createdAt: "2026-07-01T00:00:00.000Z",
                lane: "browser",
                output: {
                  path: framePath,
                  ...(workflow ? { workflow } : {}),
                  ...(workflowTrace ? { workflowTrace } : {})
                },
                warnings: []
              }
            };
          }
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          lane: "ffmpeg",
          frameLane: "browser",
          outputPath,
          workflowPath,
          workflow: {
            schema: "shellx-motion/browser-workflow@1",
            networkPolicy: "blocked-unless-declared",
            stepCount: 2,
            cursor: { visible: true, pointCount: 1 }
          },
          workflowTrace: {
            schema: "shellx-motion/browser-workflow-trace@1",
            workflowHash,
            stepCount: 2
          },
          receipt: {
            inputHashes: { workflow: workflowHash },
            output: {
              workflow: { stepCount: 2 },
              workflowTrace: { workflowHash, stepCount: 2 }
            }
          }
        });
      }
      expect(workflowRequests).toHaveLength(90);
      expect(workflowRequests[0]).toMatchObject({
        schema: "shellx-motion/browser-workflow@1",
        networkPolicy: "blocked-unless-declared",
        steps: [{ action: "wait", ms: 5 }, { action: "scroll", y: 12 }]
      });
      expect(calls[0].args).toEqual(["-version"]);
      expect(calls.at(-1)?.args).not.toContain(outputPath); expect(await readFile(outputPath, "utf8")).toBe("fake mp4");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("ignores package audio layers on muted tracks when planning final renders", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const assetsDir = join(packageRoot, "assets");
    const audioPath = join(assetsDir, "tone.wav");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push({ id: "music-track", type: "audio", name: "Music", muted: true, layerIds: ["music"] });
    sourceMotion.layers.push({
      id: "music",
      type: "audio",
      trackId: "music-track",
      source: "assets/tone.wav",
      startMs: 0,
      durationMs: 500
    });
    await mkdir(assetsDir, { recursive: true });
    await writeFile(audioPath, "fake wav bytes", "utf8");
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-muted-audio-render-"));
    const outputPath = join(outDir, "final.mp4");
    try {
      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot,
          outputPath,
          framesDir: join(outDir, "frames"),
          preset: "mp4-h264",
          dryRun: true
        },
        { tier: "render_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          lane: "ffmpeg",
          dryRun: true
        });
        expect((result.result as Record<string, unknown>).warnings).toBeUndefined();
        expect(((result.result as { ffmpeg?: FfmpegCommand }).ffmpeg?.args ?? [])).not.toContain(audioPath);
        expect(result.warnings).toEqual([]);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("keeps only package audio layers on soloed tracks when planning final renders", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const assetsDir = join(packageRoot, "assets");
    const musicPath = join(assetsDir, "music.wav");
    const voicePath = join(assetsDir, "voice.wav");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push(
      { id: "music-track", type: "audio", name: "Music", solo: true, layerIds: ["music"] },
      { id: "voice-track", type: "audio", name: "Voice", layerIds: ["voice"] }
    );
    sourceMotion.layers.push(
      {
        id: "music",
        type: "audio",
        trackId: "music-track",
        source: "assets/music.wav",
        startMs: 0,
        durationMs: 500
      },
      {
        id: "voice",
        type: "audio",
        trackId: "voice-track",
        source: "assets/voice.wav",
        startMs: 0,
        durationMs: 500
      }
    );
    await mkdir(assetsDir, { recursive: true });
    await writeFile(musicPath, "fake music wav bytes", "utf8");
    await writeFile(voicePath, "fake voice wav bytes", "utf8");
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-solo-audio-render-"));
    const outputPath = join(outDir, "final.mp4");
    try {
      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot,
          outputPath,
          framesDir: join(outDir, "frames"),
          preset: "mp4-h264",
          dryRun: true
        },
        { tier: "render_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const ffmpegArgs = (result.result as { ffmpeg?: FfmpegCommand }).ffmpeg?.args ?? [];
        expect(ffmpegArgs).toContain(musicPath);
        expect(ffmpegArgs).not.toContain(voicePath);
        expect(result.result).toMatchObject({
          ok: true,
          lane: "ffmpeg",
          dryRun: true
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("applies track volume gain to package audio layers when planning final renders", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const assetsDir = join(packageRoot, "assets");
    const audioPath = join(assetsDir, "tone.wav");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push({ id: "music-track", type: "audio", name: "Music", volume: 0.5, layerIds: ["music"] });
    sourceMotion.layers.push({
      id: "music",
      type: "audio",
      trackId: "music-track",
      source: "assets/tone.wav",
      startMs: 0,
      durationMs: 500,
      volume: 0.4
    });
    await mkdir(assetsDir, { recursive: true });
    await writeFile(audioPath, "fake wav bytes", "utf8");
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-volume-render-"));
    const outputPath = join(outDir, "final.mp4");
    try {
      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot,
          outputPath,
          framesDir: join(outDir, "frames"),
          preset: "mp4-h264",
          dryRun: true
        },
        { tier: "render_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          lane: "ffmpeg",
          dryRun: true,
          ffmpeg: {
            args: expect.arrayContaining(["-filter:a", "atrim=duration=0.5,volume=0.2,apad=whole_dur=0.5"])
          }
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("applies track fades to package audio layers when planning final renders", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const assetsDir = join(packageRoot, "assets");
    const audioPath = join(assetsDir, "tone.wav");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push({ id: "music-track", type: "audio", name: "Music", fadeInMs: 120, fadeOutMs: 180, layerIds: ["music"] });
    sourceMotion.layers.push({
      id: "music",
      type: "audio",
      trackId: "music-track",
      source: "assets/tone.wav",
      startMs: 0,
      durationMs: 300
    });
    await mkdir(assetsDir, { recursive: true });
    await writeFile(audioPath, "fake wav bytes", "utf8");
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-fade-render-"));
    const outputPath = join(outDir, "final.mp4");
    try {
      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot,
          outputPath,
          framesDir: join(outDir, "frames"),
          preset: "mp4-h264",
          dryRun: true
        },
        { tier: "render_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          lane: "ffmpeg",
          dryRun: true,
          ffmpeg: {
            args: expect.arrayContaining([
              audioPath,
              "-filter:a",
              "atrim=duration=0.3,afade=t=in:st=0:d=0.12,afade=t=out:st=0.12:d=0.18,apad=whole_dur=0.5"
            ])
          }
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("applies track pan to package audio layers when planning final renders", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const assetsDir = join(packageRoot, "assets");
    const audioPath = join(assetsDir, "tone.wav");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.tracks.push({ id: "music-track", type: "audio", name: "Music", pan: -0.25, layerIds: ["music"] });
    sourceMotion.layers.push({
      id: "music",
      type: "audio",
      trackId: "music-track",
      source: "assets/tone.wav",
      startMs: 0,
      durationMs: 300
    });
    await mkdir(assetsDir, { recursive: true });
    await writeFile(audioPath, "fake wav bytes", "utf8");
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-track-pan-render-"));
    const outputPath = join(outDir, "final.mp4");
    try {
      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot,
          outputPath,
          framesDir: join(outDir, "frames"),
          preset: "mp4-h264",
          dryRun: true
        },
        { tier: "render_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          lane: "ffmpeg",
          dryRun: true,
          ffmpeg: {
            args: expect.arrayContaining([
              audioPath,
              "-filter:a",
              "atrim=duration=0.3,pan=stereo|c0=1*c0|c1=0.75*c1,apad=whole_dur=0.5"
            ])
          }
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("applies layer pan to package audio layers when planning final renders", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const motionPath = join(packageRoot, "motion.json");
    const assetsDir = join(packageRoot, "assets");
    const audioPath = join(assetsDir, "tone.wav");
    const sourceMotion = JSON.parse(await readFile(motionPath, "utf8"));
    sourceMotion.layers.push({
      id: "music",
      type: "audio",
      source: "assets/tone.wav",
      startMs: 0,
      durationMs: 300,
      pan: 0.35
    });
    await mkdir(assetsDir, { recursive: true });
    await writeFile(audioPath, "fake wav bytes", "utf8");
    await writeFile(motionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`, "utf8");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-layer-pan-render-"));
    const outputPath = join(outDir, "final.mp4");
    try {
      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot,
          outputPath,
          framesDir: join(outDir, "frames"),
          preset: "mp4-h264",
          dryRun: true
        },
        { tier: "render_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          lane: "ffmpeg",
          dryRun: true,
          ffmpeg: {
            args: expect.arrayContaining([
              audioPath,
              "-filter:a",
              "atrim=duration=0.3,pan=stereo|c0=0.65*c0|c1=1*c1,apad=whole_dur=0.5"
            ])
          }
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("renders PNG sequence outputs through browser frames without invoking FFmpeg", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-render-png-sequence-"));
    const outputPath = join(outDir, "frames");
    const receiptsRoot = join(outDir, "host-receipts");
    const calls: FfmpegCommand[] = [];
    const framePaths: string[] = [];
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      return { exitCode: 0, stdout: "unexpected", stderr: "" };
    };

    try {
      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outputPath,
          receiptsRoot,
          preset: "png-sequence"
        },
        {
          tier: "render_motion",
          ffmpegRunner: runner,
          browserFrameRenderer: async (pkg, options) => {
            const framePath = options.outputPath ?? join(options.outDir, "frame.png");
            framePaths.push(framePath);
            await mkdir(dirname(framePath), { recursive: true });
            await writeFile(framePath, CONTRAST_PNG);
            return {
              ok: true,
              output: {
                path: framePath,
                sha256: `${String(framePaths.length).padStart(64, "0")}`,
                width: pkg.motion.width,
                height: pkg.motion.height,
                atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: `browser-preview-sequence-${framePaths.length}`,
                operation: "preview.frame",
                status: "passed",
                packageId: pkg.manifest.id,
                inputHashes: { motion: "d".repeat(64) },
                createdAt: "2026-07-01T00:00:00.000Z",
                lane: "browser",
                output: { path: framePath },
                warnings: []
              }
            };
          }
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^png-sequence-render-/);
        // Same rule, same reason as the MP4 case above: a static sequence warns, so the receipt that
        // reports it warns too rather than claiming an unqualified success.
        expect(result.visibleState).toEqual({
          panel: "receipts",
          operation: "render.final",
          packageId: "pkg_keyframed_lower_third",
          outputPath,
          status: "warning"
        });
        expect(result.result).toMatchObject({
          ok: true,
          lane: "image-sequence",
          frameLane: "browser",
          preset: "png-sequence",
          packageId: "pkg_keyframed_lower_third",
          outputPath,
          frames: { dir: outputPath, count: 90 },
          output: {
            path: outputPath,
            framePattern: "%06d.png",
            frameCount: 90,
            width: 1280,
            height: 720,
            durationMs: 3000,
            fps: 30,
            codec: "png",
            container: "image-sequence",
            preset: "png-sequence"
          },
          receipt: {
            operation: "render.final",
            status: "warning",
            lane: "image-sequence",
            artifacts: [
              { role: "frame_sequence", path: outputPath, status: "available", mediaType: "image/png", primary: true }
            ]
          },
          receiptPath: join(receiptsRoot, `${result.receiptId}.receipt.json`)
        });
      }
      expect(framePaths).toHaveLength(90);
      expect(framePaths.every((framePath) => framePath.startsWith(`${outputPath}/`))).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("fails PNG sequence renders when the requested unique-frame quality gate is not met", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-render-png-sequence-quality-fail-"));
    const outputPath = join(outDir, "frames");
    const calls: FfmpegCommand[] = [];
    const framePaths: string[] = [];
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      return { exitCode: 0, stdout: "ffmpeg should not be needed for PNG sequence renders", stderr: "" };
    };

    try {
      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outputPath,
          preset: "png-sequence",
          minUniqueFrameHashes: 2
        },
        {
          tier: "render_motion",
          ffmpegRunner: runner,
          browserFrameRenderer: async (pkg, options) => {
            const framePath = options.outputPath ?? join(options.outDir, "frame.png");
            framePaths.push(framePath);
            await mkdir(dirname(framePath), { recursive: true });
            await writeFile(framePath, CONTRAST_PNG);
            return {
              ok: true,
              output: {
                path: framePath,
                sha256: `${String(framePaths.length).padStart(64, "0")}`,
                width: pkg.motion.width,
                height: pkg.motion.height,
                atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: `browser-preview-static-sequence-${framePaths.length}`,
                operation: "preview.frame",
                status: "passed",
                packageId: pkg.manifest.id,
                inputHashes: { motion: "d".repeat(64) },
                createdAt: "2026-07-01T00:00:00.000Z",
                lane: "browser",
                output: { path: framePath },
                warnings: []
              }
            };
          }
        }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          code: "frame_quality_failed",
          message: "Rendered frame sequence has 1 unique frame; expected at least 2."
        });
        expect(result.warnings).toContain("Rendered frame sequence is static; verify this is intentional before using it as product output.");
      }
      expect(framePaths).toHaveLength(90);
      await expect(readdir(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(calls).toHaveLength(0);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("refuses PNG sequence renders into non-empty output directories", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-render-png-sequence-non-empty-"));
    const outputPath = join(outDir, "frames");
    const sentinelPath = join(outputPath, "keep.txt");
    try {
      await mkdir(outputPath, { recursive: true });
      await writeFile(sentinelPath, "do not delete", "utf8");

      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outputPath,
          preset: "png-sequence"
        },
        { tier: "render_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("derived_output_exists");
      }
      expect(await readFile(sentinelPath, "utf8")).toBe("do not delete");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });


  it("renders still-frame image outputs through one browser frame without invoking FFmpeg", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-render-still-frame-"));
    const outputPath = join(outDir, "frame.png");
    const receiptsRoot = join(outDir, "host-receipts");
    const calls: FfmpegCommand[] = [];
    const framePaths: string[] = [];
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      return { exitCode: 0, stdout: "unexpected", stderr: "" };
    };

    try {
      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outputPath,
          receiptsRoot,
          preset: "png-frame",
          atMs: 1250
        },
        {
          tier: "render_motion",
          ffmpegRunner: runner,
          browserFrameRenderer: async (pkg, options) => {
            const framePath = options.outputPath ?? join(options.outDir, "frame.png");
            framePaths.push(framePath);
            await mkdir(dirname(framePath), { recursive: true });
            await writeFile(framePath, CONTRAST_PNG);
            return {
              ok: true,
              output: {
                path: framePath,
                sha256: `${String(framePaths.length).padStart(64, "0")}`,
                width: pkg.motion.width,
                height: pkg.motion.height,
                atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: `browser-preview-still-${framePaths.length}`,
                operation: "preview.frame",
                status: "passed",
                packageId: pkg.manifest.id,
                inputHashes: { motion: "d".repeat(64) },
                createdAt: "2026-07-01T00:00:00.000Z",
                lane: "browser",
                output: { path: framePath },
                warnings: []
              }
            };
          }
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^still-frame-render-/);
        expect(result.visibleState).toEqual({
          panel: "receipts",
          operation: "render.final",
          packageId: "pkg_keyframed_lower_third",
          outputPath,
          status: "passed"
        });
        expect(result.result).toMatchObject({
          ok: true,
          lane: "image",
          frameLane: "browser",
          preset: "png-frame",
          packageId: "pkg_keyframed_lower_third",
          outputPath,
          output: {
            path: outputPath,
            width: 1280,
            height: 720,
            atMs: 1250,
            codec: "png",
            container: "image",
            preset: "png-frame"
          },
          receipt: {
            operation: "render.final",
            status: "passed",
            lane: "image",
            artifacts: [
              { role: "still_frame", path: outputPath, status: "available", mediaType: "image/png", primary: true }
            ]
          },
          receiptPath: join(receiptsRoot, `${result.receiptId}.receipt.json`)
        });
      }
      expect(framePaths).toHaveLength(1); expect(framePaths[0]).not.toBe(outputPath);
      expect(calls).toEqual([]);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("runs quality manifests as part of final still-frame debug renders", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-render-quality-manifest-"));
    const outputPath = join(outDir, "frame.png");
    const receiptsRoot = join(outDir, "host-receipts");
    const manifestPath = join(outDir, "quality-manifest.json");
    const framePaths: string[] = [];

    try {
      await writeFile(manifestPath, JSON.stringify({
        schema: "shellx-motion/quality-manifest@1",
        samples: [{ id: "still", atMs: 0, minBrightPixels: 1 }]
      }, null, 2));

      const result = await dispatchDebugCommand(
        "motion.render.final",
        {
          packageRoot: "../../fixtures/packages/keyframed-lower-third",
          outputPath,
          receiptsRoot,
          preset: "png-frame",
          qualityManifestPath: manifestPath
        },
        {
          tier: "render_motion",
          scratchRoot: outDir,
          browserFrameRenderer: async (pkg, options) => {
            const framePath = options.outputPath ?? join(options.outDir, "frame.png");
            framePaths.push(framePath);
            await mkdir(dirname(framePath), { recursive: true });
            await writeFile(framePath, CONTRAST_PNG);
            return {
              ok: true,
              output: {
                path: framePath,
                sha256: `${String(framePaths.length).padStart(64, "0")}`,
                width: pkg.motion.width,
                height: pkg.motion.height,
                atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: `browser-preview-quality-${framePaths.length}`,
                operation: "preview.frame",
                status: "passed",
                packageId: pkg.manifest.id,
                inputHashes: { motion: "d".repeat(64) },
                createdAt: "2026-07-01T00:00:00.000Z",
                lane: "browser",
                output: { path: framePath },
                warnings: []
              }
            };
          }
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          lane: "image",
          preset: "png-frame",
          qualityManifestPath: manifestPath,
          qualityCheck: {
            ok: true,
            result: {
              inputPath: outputPath, manifestPath,
              samples: [{ id: "still", ok: true, framePath: outputPath }]
            }
          },
          receipt: {
            operation: "render.final",
            status: "passed",
            inputHashes: {
              qualityManifest: expect.stringMatching(/^[a-f0-9]{64}$/),
              qualityManifestMaterialized: expect.stringMatching(/^[a-f0-9]{64}$/),
              qualityBaselines: expect.stringMatching(/^[a-f0-9]{64}$/),
              qualityInputs: expect.stringMatching(/^[a-f0-9]{64}$/)
            },
            output: {
              qualityManifestPath: manifestPath,
              qualityCheck: { status: "passed" }
            }
          }
        });
        const qualityCheck = (result.result as Record<string, any>).qualityCheck; expect(JSON.parse(await readFile(join(receiptsRoot, `${qualityCheck.receiptId}.receipt.json`), "utf8"))).toEqual(qualityCheck.result.receipt);
      }
      expect(framePaths).toHaveLength(1);
      expect(framePaths[0]).not.toBe(outputPath);
      const receiptFiles = await readdir(receiptsRoot);
      expect(receiptFiles.some((entry) => entry.startsWith("quality-check-"))).toBe(true);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects still-frame debug renders when the output extension disagrees with the preset", async () => {
    const result = await dispatchDebugCommand(
      "motion.render.final",
      {
        packageRoot: "../../fixtures/packages/keyframed-lower-third",
        outputPath: "/tmp/lower-third-frame.png",
        preset: "jpeg-frame",
        atMs: 1250
      },
      { tier: "render_motion" }
    );

    // toMatchObject, not toEqual: a render dispatch now also reports the jobId it ran under, so a
    // caller that did not name its own job still learns the handle it can query afterwards.
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_args",
        message: "jpeg-frame outputs must use a .jpg or .jpeg path."
      },
      warnings: []
    });
  });

  it("rejects FFmpeg debug renders when the output extension disagrees with the preset", async () => {
    const result = await dispatchDebugCommand(
      "motion.render.final",
      {
        packageRoot: "../../fixtures/packages/keyframed-lower-third",
        outputPath: "/tmp/lower-third-alpha.mp4",
        preset: "webm-vp9-alpha",
        dryRun: true
      },
      { tier: "render_motion" }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_args",
        message: "webm-vp9-alpha outputs must use a .webm path."
      },
      warnings: []
    });
  });

  itLinux("lists and reads host-owned receipt evidence through the debug API", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-receipts-"));
    const receiptsRoot = join(tempRoot, "receipts");
    const renderReceipt = debugReceipt({
      id: "render-final-1",
      operation: "render.final",
      status: "passed",
      packageId: "pkg_demo",
      lane: "ffmpeg",
      output: { path: join(tempRoot, "final.mp4"), width: 1920, height: 1080, durationMs: 4000, codec: "h264", container: "mp4" }
    });
    const previewReceipt = debugReceipt({
      id: "preview-frame-1",
      operation: "preview.frame",
      status: "warning",
      packageId: "pkg_demo",
      lane: "browser",
      output: { path: join(tempRoot, "preview.png"), width: 1920, height: 1080, atMs: 500 },
      warnings: ["console.warning: font fallback"]
    });

    try {
      await mkdir(join(receiptsRoot, "nested"), { recursive: true });
      await writeFile(join(receiptsRoot, "render.receipt.json"), `${JSON.stringify(renderReceipt, null, 2)}\n`);
      await writeFile(join(receiptsRoot, "nested", "preview.receipt.json"), `${JSON.stringify(previewReceipt, null, 2)}\n`);

      const listed = await dispatchDebugCommand(
        "motion.receipts.list",
        { receiptsRoot },
        { tier: "read_motion", callerId: "test-operator", crossCallerJobScope: true }
      );

      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.visibleState).toEqual({ panel: "receipts", receiptCount: 2 });
        expect(listed.result).toMatchObject({
          ok: true,
          receiptsRoot,
          receiptCount: 2,
          receipts: expect.arrayContaining([
            expect.objectContaining({
              id: "render-final-1",
              operation: "render.final",
              status: "passed",
              packageId: "pkg_demo",
              lane: "ffmpeg",
              outputPath: join(tempRoot, "final.mp4"),
              path: join(receiptsRoot, "render.receipt.json")
            }),
            expect.objectContaining({
              id: "preview-frame-1",
              operation: "preview.frame",
              status: "warning",
              packageId: "pkg_demo",
              lane: "browser",
              outputPath: join(tempRoot, "preview.png"),
              path: join(receiptsRoot, "nested", "preview.receipt.json")
            })
          ])
        });
      }

      const read = await dispatchDebugCommand(
        "motion.receipts.read",
        { receiptsRoot, receiptId: "render-final-1" },
        { tier: "read_motion", callerId: "test-operator", crossCallerJobScope: true }
      );

      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.receiptId).toBe("render-final-1");
        expect(read.visibleState).toEqual({
          panel: "receipts",
          receiptId: "render-final-1",
          operation: "render.final",
          status: "passed"
        });
        expect(read.result).toEqual({
          ok: true,
          path: join(receiptsRoot, "render.receipt.json"),
          receipt: renderReceipt
        });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  itLinux("summarizes host-owned receipt evidence into panel state", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-receipts-panel-"));
    const receiptsRoot = join(tempRoot, "receipts");
    const renderReceipt = debugReceipt({
      id: "render-final-panel",
      operation: "render.final",
      status: "passed",
      packageId: "pkg_panel",
      lane: "ffmpeg",
      output: {
        path: join(tempRoot, "final.mp4"),
        qualityManifestPath: join(tempRoot, "render-quality.json"),
        qualityCheck: { status: "passed", receiptId: "quality-render-panel" }
      },
      artifacts: [
        { role: "video", path: join(tempRoot, "final.mp4"), status: "available", mediaType: "video/mp4", primary: true }
      ]
    });
    const failedReceipt = debugReceipt({
      id: "quality-failed-panel",
      operation: "quality.check",
      status: "failed",
      packageId: "pkg_panel",
      lane: "debug-api",
      output: {
        path: join(tempRoot, "quality.json"),
        qualityManifestPath: join(tempRoot, "failed-quality.json"),
        qualityCheck: { status: "failed", code: "visual_regression_failed" }
      },
      warnings: ["brightness below threshold"]
    });
    const warningReceipt = debugReceipt({
      id: "preview-warning-panel",
      operation: "preview.frame",
      status: "warning",
      packageId: "pkg_panel",
      lane: "browser",
      output: { path: join(tempRoot, "preview.png") },
      warnings: ["font fallback"]
    });
    const connectorReceipt = debugReceipt({
      id: "connector-canvas-panel",
      operation: "connector.canvas_to_cut",
      status: "passed",
      packageId: "pkg_panel",
      lane: "connector",
      output: {
        packageDir: join(tempRoot, "connector", "package"),
        artifacts: [
          { role: "canvas_selection", path: join(tempRoot, "connector", "canvas-selection.json"), status: "available", mediaType: "application/json" },
          { role: "rendered_media", path: join(tempRoot, "connector", "render.mp4"), status: "available", mediaType: "video/mp4", primary: true }
        ]
      }
    });

    try {
      await mkdir(receiptsRoot, { recursive: true });
      await writeFile(join(receiptsRoot, "render.receipt.json"), `${JSON.stringify(renderReceipt, null, 2)}\n`);
      await writeFile(join(receiptsRoot, "quality.receipt.json"), `${JSON.stringify(failedReceipt, null, 2)}\n`);
      await writeFile(join(receiptsRoot, "preview.receipt.json"), `${JSON.stringify(warningReceipt, null, 2)}\n`);
      await writeFile(join(receiptsRoot, "zz-connector.receipt.json"), `${JSON.stringify(connectorReceipt, null, 2)}\n`);

      const result = await dispatchDebugCommand(
        "motion.receipts.panel",
        { receiptsRoot, limit: 2 },
        { tier: "read_motion", callerId: "test-operator", crossCallerJobScope: true }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toEqual({
          panel: "receipts",
          operation: "receipts.panel",
          receiptCount: 4,
          failedCount: 1,
          warningCount: 1,
          artifactCount: 3
        });
        expect(result.result).toMatchObject({
          ok: true,
          receiptsRoot,
          receiptCount: 4,
          failedCount: 1,
          warningCount: 1,
          artifactCount: 3,
          statusCounts: { passed: 2, warning: 1, failed: 1, not_run: 0 },
          operationCounts: {
            "connector.canvas_to_cut": 1,
            "preview.frame": 1,
            "quality.check": 1,
            "render.final": 1
          },
          failedReceipts: [
            expect.objectContaining({
              id: "quality-failed-panel",
              status: "failed",
              qualityManifest: {
                path: join(tempRoot, "failed-quality.json"),
                status: "failed",
                code: "visual_regression_failed"
              }
            })
          ],
          warningReceipts: [expect.objectContaining({ id: "preview-warning-panel", status: "warning" })],
          warnings: [
            { receiptId: "preview-warning-panel", operation: "preview.frame", warning: "font fallback" },
            { receiptId: "quality-failed-panel", operation: "quality.check", warning: "brightness below threshold" }
          ],
          artifacts: expect.arrayContaining([
            expect.objectContaining({
              receiptId: "render-final-panel",
              operation: "render.final",
              role: "video",
              path: join(tempRoot, "final.mp4"),
              status: "available",
              mediaType: "video/mp4",
              primary: true
            }),
            expect.objectContaining({
              receiptId: "connector-canvas-panel",
              operation: "connector.canvas_to_cut",
              role: "canvas_selection",
              path: join(tempRoot, "connector", "canvas-selection.json"),
              status: "available",
              mediaType: "application/json"
            }),
            expect.objectContaining({
              receiptId: "connector-canvas-panel",
              operation: "connector.canvas_to_cut",
              role: "rendered_media",
              path: join(tempRoot, "connector", "render.mp4"),
              status: "available",
              mediaType: "video/mp4",
              primary: true
            })
          ]),
          recentReceipts: [
            expect.objectContaining({ id: "preview-warning-panel" }),
            expect.objectContaining({
              id: "quality-failed-panel",
              qualityManifest: {
                path: join(tempRoot, "failed-quality.json"),
                status: "failed",
                code: "visual_regression_failed"
              }
            })
          ]
        });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  itLinux("summarizes platform verification receipts for host-matrix panels", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-platform-panel-"));
    const receiptsRoot = join(tempRoot, "receipts");
    try {
      await mkdir(receiptsRoot, { recursive: true });
      await writeFile(
        join(receiptsRoot, "linux.platform.json"),
        `${JSON.stringify(completedPlatformReceipt({ requiredHosts: ["linux", "windows", "macos"], complete: false }), null, 2)}\n`,
        "utf8"
      );
      await writeFile(
        join(receiptsRoot, "aggregate.platform.json"),
        `${JSON.stringify({
          schema: "shellx-motion/platform-verification-aggregate@1",
          status: "failed",
          dryRun: false,
          repoRoot: "/workspace/ShellX Motion",
          startedAt: "2026-07-03T10:30:00.000Z",
          finishedAt: "2026-07-03T10:30:00.000Z",
          requiredHosts: ["linux", "windows", "macos"],
          requiredCommands: ["typecheck"],
          summary: {
            requiredHostCount: 3,
            satisfiedHostCount: 1,
            missingHosts: ["windows", "macos"],
            failedHosts: ["windows", "macos"],
            invalidReceiptCount: 0
          },
          receipts: [
            {
              path: "/tmp/linux.platform.json",
              hostId: "linux",
              schemaOk: true,
              status: "passed",
              dryRun: false,
              ok: true,
              failures: [],
              requiredCommands: { total: 1, passed: 1, missing: [], failed: [] }
            }
          ]
        }, null, 2)}\n`,
        "utf8"
      );

      const result = await dispatchDebugCommand(
        "motion.platform.verification.panel",
        { receiptsRoot },
        { tier: "read_motion", receiptsRoot }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toEqual({
          panel: "receipts",
          operation: "platform.verification.panel",
          status: "failed",
          platformReceiptCount: 2,
          hostReceiptCount: 1,
          aggregateReceiptCount: 1,
          missingHostCount: 2,
          failedHostCount: 2
        });
        expect(result.result).toMatchObject({
          ok: true,
          receiptsRoot,
          status: "failed",
          platformReceiptCount: 2,
          requiredHosts: ["linux", "windows", "macos"],
          satisfiedHosts: ["linux"],
          missingHosts: ["windows", "macos"],
          failedHosts: ["windows", "macos"],
          hostReceipts: [
            expect.objectContaining({
              schema: "shellx-motion/platform-verification@1",
              hostId: "linux",
              status: "passed",
              dryRun: false,
              commandCount: expect.any(Number),
              failedCommandCount: 0
            })
          ],
          aggregateReceipts: [
            expect.objectContaining({
              schema: "shellx-motion/platform-verification-aggregate@1",
              status: "failed",
              receiptCount: 1,
              requiredHosts: ["linux", "windows", "macos"],
              missingHosts: ["windows", "macos"],
              failedHosts: ["windows", "macos"]
            })
          ]
        });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  itLinux("summarizes render status from receipt evidence through the debug API", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-render-status-"));
    const receiptsRoot = join(tempRoot, "receipts");
    const passed = debugReceipt({
      id: "render-final-passed",
      operation: "render.final",
      status: "passed",
      packageId: "pkg_a",
      lane: "ffmpeg",
      output: {
        path: join(tempRoot, "a.mp4"),
        width: 1280,
        height: 720,
        durationMs: 3000,
        codec: "h264",
        container: "mp4",
        qualityManifestPath: join(tempRoot, "quality-manifest.json"),
        qualityCheck: { status: "passed", receiptId: "quality-final-passed" }
      }
    });
    const failed = debugReceipt({
      id: "batch-failed",
      operation: "render.batch",
      status: "failed",
      packageId: "pkg_batch",
      lane: "batch",
      output: {
        qualityManifestPath: join(tempRoot, "batch-quality.json"),
        jobs: [
          {
            rowId: "row-b",
            packageId: "pkg_b",
            status: "failed",
            receiptPath: join(receiptsRoot, "b.receipt.json"),
            qualityManifestAppliedPath: join(receiptsRoot, "quality-manifests", "pkg_b.quality-manifest.json"),
            qualityCheck: { status: "failed", code: "visual_regression_failed" }
          }
        ]
      },
      warnings: ["row b failed"]
    });
    const queued = debugReceipt({
      id: "batch-planned",
      operation: "render.batch",
      status: "not_run",
      packageId: "pkg_planned",
      lane: "batch",
      output: {
        jobs: [
          { packageId: "pkg_q1", status: "not_run", receiptPath: join(receiptsRoot, "q1.receipt.json") },
          { packageId: "pkg_q2", status: "not_run", receiptPath: join(receiptsRoot, "q2.receipt.json") }
        ]
      }
    });

    try {
      await mkdir(receiptsRoot, { recursive: true });
      await writeFile(join(receiptsRoot, "a.receipt.json"), `${JSON.stringify(passed, null, 2)}\n`);
      await writeFile(join(receiptsRoot, "batch.receipt.json"), `${JSON.stringify(failed, null, 2)}\n`);
      await writeFile(join(receiptsRoot, "planned.receipt.json"), `${JSON.stringify(queued, null, 2)}\n`);

      const result = await dispatchDebugCommand(
        "motion.render.status",
        { receiptsRoot },
        { tier: "read_motion", callerId: "test-operator", crossCallerJobScope: true }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toEqual({
          panel: "render",
          jobCount: 3,
          failedCount: 1,
          stateCounts: { pending: 1, running: 0, succeeded: 1, failed: 1, cancelled: 0, skipped: 0 }
        });
        expect(result.result).toMatchObject({
          ok: true,
          receiptsRoot,
          jobCount: 3,
          failedCount: 1,
          stateCounts: { pending: 1, running: 0, succeeded: 1, failed: 1, cancelled: 0, skipped: 0 },
          jobs: [
            expect.objectContaining({
              receiptId: "render-final-passed",
              operation: "render.final",
              status: "passed",
              state: "succeeded",
              progress: { completed: 1, total: 1, percent: 100 },
              outputPath: join(tempRoot, "a.mp4"),
              qualityManifest: {
                path: join(tempRoot, "quality-manifest.json"),
                status: "passed",
                receiptId: "quality-final-passed"
              }
            }),
            expect.objectContaining({
              receiptId: "batch-failed",
              operation: "render.batch",
              status: "failed",
              state: "failed",
              progress: { completed: 1, total: 1, percent: 100 },
              qualityManifest: {
                path: join(tempRoot, "batch-quality.json"),
                rows: [
                  {
                    rowId: "row-b",
                    packageId: "pkg_b",
                    path: join(receiptsRoot, "quality-manifests", "pkg_b.quality-manifest.json"),
                    status: "failed",
                    code: "visual_regression_failed"
                  }
                ]
              },
              warnings: ["row b failed"]
            }),
            expect.objectContaining({
              receiptId: "batch-planned",
              operation: "render.batch",
              status: "not_run",
              state: "pending",
              progress: { completed: 0, total: 2, percent: 0 }
            })
          ]
        });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  itLinux("summarizes render queue jobs with available actions", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-render-queue-"));
    const receiptsRoot = join(tempRoot, "receipts");
    const queued = debugReceipt({
      id: "render-queued-panel",
      operation: "render.final",
      status: "not_run",
      packageId: "pkg_queue",
      lane: "ffmpeg",
      output: { path: join(tempRoot, "queued.mp4") }
    });
    const failed = debugReceipt({
      id: "render-failed-panel",
      operation: "render.final",
      status: "failed",
      packageId: "pkg_queue",
      lane: "ffmpeg",
      output: {
        path: join(tempRoot, "failed.mp4"),
        qualityManifestPath: join(tempRoot, "queue-quality.json"),
        qualityCheck: { status: "failed", code: "visual_regression_failed" }
      },
      warnings: ["encode failed"]
    });
    const cancel = debugReceipt({
      id: "render-cancel-panel",
      operation: "render.cancel",
      status: "passed",
      packageId: "pkg_queue",
      lane: "debug-api",
      output: { targetReceiptId: "render-queued-panel", reason: "stop queued" }
    });
    const retry = debugReceipt({
      id: "render-retry-panel",
      operation: "render.retry",
      status: "not_run",
      packageId: "pkg_queue",
      lane: "ffmpeg",
      output: {
        sourceReceiptId: "render-failed-panel",
        eventLogPath: join(receiptsRoot, "events", "render-retry-panel.events.jsonl"),
        eventCount: 4,
        lastEventSeq: 4,
        lastEventAt: "2026-07-01T00:00:04.000Z",
        retryAttempt: 1,
        reason: "try again"
      }
    });

    try {
      await mkdir(receiptsRoot, { recursive: true });
      await writeFile(join(receiptsRoot, "queued.receipt.json"), `${JSON.stringify(queued, null, 2)}\n`);
      await writeFile(join(receiptsRoot, "failed.receipt.json"), `${JSON.stringify(failed, null, 2)}\n`);
      await writeFile(join(receiptsRoot, "cancel.receipt.json"), `${JSON.stringify(cancel, null, 2)}\n`);
      await writeFile(join(receiptsRoot, "retry.receipt.json"), `${JSON.stringify(retry, null, 2)}\n`);

      const result = await dispatchDebugCommand(
        "motion.render.queue",
        { receiptsRoot },
        { tier: "read_motion", callerId: "test-operator", crossCallerJobScope: true }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toEqual({
          panel: "render",
          operation: "render.queue",
          jobCount: 3,
          actionableCount: 3,
          failedCount: 1,
          stateCounts: { pending: 1, running: 0, succeeded: 0, failed: 1, cancelled: 1, skipped: 0 }
        });
        expect(result.result).toMatchObject({
          ok: true,
          receiptsRoot,
          jobCount: 3,
          actionableCount: 3,
          failedCount: 1,
          stateCounts: { pending: 1, running: 0, succeeded: 0, failed: 1, cancelled: 1, skipped: 0 },
          jobs: expect.arrayContaining([
            expect.objectContaining({
              receiptId: "render-queued-panel",
              state: "cancelled",
              availableActions: [
                { id: "retry", command: "motion.render.retry", receiptId: "render-queued-panel" }
              ],
              control: expect.objectContaining({ cancelReceiptId: "render-cancel-panel", reason: "stop queued" })
            }),
            expect.objectContaining({
              receiptId: "render-failed-panel",
              state: "failed",
              qualityManifest: {
                path: join(tempRoot, "queue-quality.json"),
                status: "failed",
                code: "visual_regression_failed"
              },
              availableActions: [
                { id: "retry", command: "motion.render.retry", receiptId: "render-failed-panel" }
              ]
            }),
            expect.objectContaining({
              receiptId: "render-retry-panel",
              operation: "render.retry",
              state: "pending",
              handoff: {
                schema: "shellx-motion/render-job-handoff@1",
                jobId: "render-retry-panel",
                receiptId: "render-retry-panel",
                receiptPath: join(receiptsRoot, "retry.receipt.json"),
                operation: "render.retry",
                packageId: "pkg_queue",
                lane: "ffmpeg",
                state: "pending",
                createdAt: "2026-07-01T00:00:00.000Z",
                inputHashes: { motion: "a".repeat(64) },
                sourceReceiptId: "render-failed-panel",
                eventReplay: {
                  schema: "shellx-motion/job-event-replay@1",
                  eventLogPath: join(receiptsRoot, "events", "render-retry-panel.events.jsonl"),
                  eventCount: 4,
                  lastSeq: 4,
                  lastEventAt: "2026-07-01T00:00:04.000Z",
                  reconnectCursor: { receiptId: "render-retry-panel", sinceSeq: 4 }
                },
                retryAttempt: 1
              },
              eventReplay: {
                schema: "shellx-motion/job-event-replay@1",
                eventLogPath: join(receiptsRoot, "events", "render-retry-panel.events.jsonl"),
                eventCount: 4,
                lastSeq: 4,
                lastEventAt: "2026-07-01T00:00:04.000Z",
                reconnectCursor: { receiptId: "render-retry-panel", sinceSeq: 4 }
              },
              availableActions: [
                { id: "cancel", command: "motion.render.cancel", receiptId: "render-retry-panel" }
              ],
              control: expect.objectContaining({ retryOfReceiptId: "render-failed-panel", retryAttempt: 1 })
            })
          ])
        });
        const queueResult = result.result as { jobs: Array<{ receiptId: string; handoff?: unknown }> };
        const retryJob = queueResult.jobs.find((job) => job.receiptId === "render-retry-panel");
        expect(await validateDocument(await loadSchema("renderJobHandoff"), retryJob?.handoff)).toEqual({ ok: true });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  itLinux("cancels queued render jobs with host-owned receipt evidence", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-render-cancel-"));
    const receiptsRoot = join(tempRoot, "receipts");
    const queued = debugReceipt({
      id: "render-final-queued",
      operation: "render.final",
      status: "not_run",
      packageId: "pkg_cancel",
      lane: "ffmpeg",
      output: { path: join(tempRoot, "queued.mp4"), preset: "mp4-h264" }
    });
    try {
      await mkdir(receiptsRoot, { recursive: true });
      await writeFile(join(receiptsRoot, "queued.receipt.json"), `${JSON.stringify(queued, null, 2)}\n`);

      const cancel = await dispatchDebugCommand(
        "motion.render.cancel",
        { receiptsRoot, receiptId: "render-final-queued", reason: "user stopped export" },
        { tier: "render_motion", callerId: "test-operator", crossCallerJobScope: true }
      );

      expect(cancel.ok).toBe(true);
      if (cancel.ok) {
        expect(cancel.receiptId).toMatch(/^render-cancel-render-final-queued-/);
        expect(cancel.visibleState).toEqual({
          panel: "render",
          operation: "render.cancel",
          receiptId: "render-final-queued",
          targetReceiptId: "render-final-queued",
          state: "cancelled",
          controlReceiptPath: join(receiptsRoot, `${cancel.receiptId}.receipt.json`)
        });
        expect(cancel.result).toMatchObject({
          ok: true,
          targetReceiptId: "render-final-queued",
          targetState: "pending",
          state: "cancelled",
          receipt: {
            operation: "render.cancel",
            status: "passed",
            output: {
              targetReceiptId: "render-final-queued",
              targetState: "pending",
              reason: "user stopped export"
            }
          }
        });
      }

      const status = await dispatchDebugCommand("motion.render.status", { receiptsRoot }, { tier: "read_motion", callerId: "test-operator", crossCallerJobScope: true });

      expect(status.ok).toBe(true);
      if (status.ok) {
        expect(status.visibleState).toEqual({
          panel: "render",
          jobCount: 1,
          failedCount: 0,
          stateCounts: { pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 1, skipped: 0 }
        });
        expect(status.result).toMatchObject({
          ok: true,
          stateCounts: { pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 1, skipped: 0 },
          jobs: [
            expect.objectContaining({
              receiptId: "render-final-queued",
              operation: "render.final",
              state: "cancelled",
              control: expect.objectContaining({
                cancelReceiptId: cancel.ok ? cancel.receiptId : expect.any(String),
                reason: "user stopped export"
              })
            })
          ]
        });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  itLinux("queues retry receipts for failed render jobs", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-render-retry-"));
    const receiptsRoot = join(tempRoot, "receipts");
    const failed = debugReceipt({
      id: "render-final-failed",
      operation: "render.final",
      status: "failed",
      packageId: "pkg_retry",
      lane: "ffmpeg",
      output: { path: join(tempRoot, "failed.mp4"), preset: "mp4-h264" },
      warnings: ["ffmpeg failed"]
    });
    try {
      await mkdir(receiptsRoot, { recursive: true });
      await writeFile(join(receiptsRoot, "failed.receipt.json"), `${JSON.stringify(failed, null, 2)}\n`);

      const retry = await dispatchDebugCommand(
        "motion.render.retry",
        { receiptsRoot, receiptId: "render-final-failed", reason: "try again" },
        { tier: "render_motion", callerId: "test-operator", crossCallerJobScope: true }
      );

      expect(retry.ok).toBe(true);
      if (retry.ok) {
        expect(retry.receiptId).toMatch(/^render-retry-render-final-failed-/);
        expect(retry.visibleState).toEqual({
          panel: "render",
          operation: "render.retry",
          receiptId: retry.receiptId,
          sourceReceiptId: "render-final-failed",
          state: "pending",
          controlReceiptPath: join(receiptsRoot, `${retry.receiptId}.receipt.json`)
        });
        expect(retry.result).toMatchObject({
          ok: true,
          sourceReceiptId: "render-final-failed",
          state: "pending",
          receipt: {
            operation: "render.retry",
            status: "not_run",
            packageId: "pkg_retry",
            output: {
              sourceReceiptId: "render-final-failed",
              sourceState: "failed",
              retryAttempt: 1,
              reason: "try again"
            }
          }
        });
      }

      const status = await dispatchDebugCommand("motion.render.status", { receiptsRoot }, { tier: "read_motion", callerId: "test-operator", crossCallerJobScope: true });

      expect(status.ok).toBe(true);
      if (status.ok) {
        expect(status.visibleState).toEqual({
          panel: "render",
          jobCount: 2,
          failedCount: 1,
          stateCounts: { pending: 1, running: 0, succeeded: 0, failed: 1, cancelled: 0, skipped: 0 }
        });
        expect(status.result).toMatchObject({
          ok: true,
          jobs: expect.arrayContaining([
            expect.objectContaining({ receiptId: "render-final-failed", state: "failed" }),
            expect.objectContaining({
              receiptId: retry.ok ? retry.receiptId : expect.any(String),
              operation: "render.retry",
              status: "not_run",
              state: "pending",
              control: expect.objectContaining({ retryOfReceiptId: "render-final-failed", retryAttempt: 1 })
            })
          ])
        });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  itLinux("compiles scripted-video JSON into a Motion package through the debug API", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-script-compile-"));
    const scriptPath = join(tempRoot, "storyboard.json");
    const packageDir = join(tempRoot, "package");
    const receiptsRoot = join(tempRoot, "receipts");

    try {
      await writeFile(scriptPath, `${JSON.stringify(scriptedVideo(), null, 2)}\n`, "utf8");

      const result = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(tempRoot), async () => await dispatchDebugCommand(
        "motion.script.compile",
        {
          scriptPath,
          packageDir,
          receiptsRoot,
          createdAt: "2026-07-01T00:00:00.000Z"
        },
        { tier: "write_local", authoringInputRoots: [tempRoot], authoringOutputRoots: [tempRoot] }
      ));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toBe("receipt_script_compile_pkg_script_launch_demo");
        expect(result.visibleState).toEqual({
          panel: "receipts",
          operation: "script.compile",
          packageId: "pkg_script_launch_demo",
          packageDir,
          hostReceiptPath: join(receiptsRoot, "receipt_script_compile_pkg_script_launch_demo.receipt.json")
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_script_launch_demo",
          motionId: "motion_script_launch_demo",
          packageDir,
          manifestPath: join(packageDir, "manifest.json"),
          motionPath: join(packageDir, "motion.json"),
          receiptPath: join(packageDir, "receipts", "script-compile.receipt.json"),
          hostReceiptPath: join(receiptsRoot, "receipt_script_compile_pkg_script_launch_demo.receipt.json"),
          receipt: {
            operation: "script.compile",
            status: "passed",
            lane: "script",
            packageId: "pkg_script_launch_demo"
          }
        });
      }

      const manifest = JSON.parse(await readFile(join(packageDir, "manifest.json"), "utf8")) as Record<string, any>;
      const motion = JSON.parse(await readFile(join(packageDir, "motion.json"), "utf8")) as Record<string, any>;
      const packageReceipt = JSON.parse(await readFile(join(packageDir, "receipts", "script-compile.receipt.json"), "utf8")) as Record<string, any>;
      const hostReceipt = JSON.parse(await readFile(join(receiptsRoot, "receipt_script_compile_pkg_script_launch_demo.receipt.json"), "utf8")) as Record<string, any>;
      expect(manifest.compatibility.hosts).toEqual(["shellx-motion", "shellx-cut"]);
      expect(manifest.compatibility.lanes).toEqual(["native", "browser", "ffmpeg", "cut"]);
      expect(motion.durationMs).toBe(2500);
      expect(motion.layers.map((layer: { id: string }) => layer.id)).toEqual([
        "frame_hook_background",
        "frame_hook_accent_rail",
        "frame_hook_signal_bar",
        "frame_hook_panel",
        "frame_hook_kicker",
        "frame_hook_title",
        "frame_hook_body",
        "frame_cta_background",
        "frame_cta_accent_rail",
        "frame_cta_signal_bar",
        "frame_cta_panel",
        "frame_cta_kicker",
        "frame_cta_title",
        "frame_cta_caption_plate",
        "frame_cta_caption"
      ]);
      expect(hostReceipt.inputHashes["input/scripted-video.json"]).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(hostReceipt)).not.toContain(scriptPath);
      expect(hostReceipt).toEqual(packageReceipt);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("extracts and evaluates representative frame quality through the debug API", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-visual-quality-"));
    const inputPath = join(tempRoot, "final.mp4");
    const outDir = join(tempRoot, "quality");
    const calls: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      if (command.executable.includes("ffprobe")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1" }],
            format: { duration: "4.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
          }),
          stderr: ""
        };
      }
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
      await writeFile(outputPath, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      await writeFile(inputPath, "fake media");
      const result = await dispatchDebugCommand(
        "motion.quality.check",
        { inputPath, expectWidth: 1920, expectHeight: 1080, minBrightPixels: 1, minEdgePixels: 0, atMs: 500, outDir },
        { tier: "render_motion", ffmpegRunner: runner, scratchRoot: tempRoot }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          inputPath,
          framePath: join(outDir, "final-frame.png"),
          atMs: 500,
          quality: {
            frameCount: 1,
            blankFrames: 0,
            minBrightPixels: 1
          }
        });
      }
      expect(calls[1].args).toEqual([
        "-y",
        "-ss",
        "0.5",
        ...qualityFfmpegInputArgs("mov"),
        "-i",
        expect.stringMatching(/\/shellx-motion-ffmpeg-media-[^/]+\/[a-f0-9]{64}\.mp4$/),
        "-frames:v",
        "1",
        join(outDir, "final-frame.png")
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails quality checks when alpha coverage is below the requested threshold", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-quality-alpha-"));
    const inputPath = join(tempRoot, "overlay.webm");
    const outDir = join(tempRoot, "quality");
    const calls: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      if (command.executable.includes("ffprobe")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_type: "video", codec_name: "vp9", pix_fmt: "yuv420p", tags: { alpha_mode: "1" }, width: 2, height: 2, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "matroska,webm" }
          }),
          stderr: ""
        };
      }
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, ALPHA_2X2_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      await writeFile(inputPath, "fake media");
      const result = await dispatchDebugCommand(
        "motion.quality.check",
        { inputPath, minTransparentPixels: 3, minNonTransparentPixels: 2, outDir },
        { tier: "render_motion", ffmpegRunner: runner, scratchRoot: tempRoot }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({
          code: "visual_quality_failed",
          message: "Extracted frame has 2 transparent pixels; expected at least 3.",
          detail: {
            receipt: {
              output: {
                quality: {
                  minTransparentPixels: 2,
                  maxTransparentPixels: 2,
                  minNonTransparentPixels: 2,
                  maxNonTransparentPixels: 2
                },
                checks: {
                  minTransparentPixels: 3,
                  minNonTransparentPixels: 2
                }
              }
            }
          }
        });
      }
      expect(calls[1].args).toEqual([
        "-y",
        "-c:v",
        "libvpx-vp9",
        ...qualityFfmpegInputArgs("matroska"),
        "-i",
        expect.stringMatching(/\/shellx-motion-ffmpeg-media-[^/]+\/[a-f0-9]{64}\.webm$/),
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgba",
        join(outDir, "overlay-frame.png")
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs quality manifest samples through the debug API", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-quality-manifest-"));
    const inputPath = join(tempRoot, "final.mp4");
    const manifestPath = join(tempRoot, "quality-manifest.json");
    const outDir = join(tempRoot, "quality");
    const calls: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      if (command.executable.includes("ffprobe")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1" }],
            format: { duration: "4.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
          }),
          stderr: ""
        };
      }
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      await writeFile(inputPath, "fake media");
      await writeFile(
        manifestPath,
        `${JSON.stringify({
          schema: "shellx-motion/quality-manifest@1",
          samples: [
            { id: "intro sample", atMs: 500, minBrightPixels: 1, minEdgePixels: 0, minLumaRange: 200, maxChangedPixels: 0, maxMeanDiff: 0 }
          ]
        }, null, 2)}\n`,
        "utf8"
      );

      const result = await dispatchDebugCommand(
        "motion.quality.check",
        { inputPath, manifestPath, outDir },
        { tier: "render_motion", ffmpegRunner: runner, scratchRoot: tempRoot }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          inputPath,
          manifestPath,
          samples: [
            {
              ok: true,
              id: "intro sample",
              atMs: 500,
              framePath: join(outDir, "final-intro-sample-frame.png"),
              quality: {
                frameCount: 1,
                blankFrames: 0,
                minBrightPixels: 1,
                minLumaRange: 255
              }
            }
          ]
        });
        expect(result.visibleState).toEqual({
          panel: "receipts",
          operation: "quality.check",
          inputPath,
          manifestPath,
          ok: true,
          status: "passed",
          sampleCount: 1
        });
      }
      expect(calls[1].args).toEqual([
        "-y",
        "-ss",
        "0.5",
        ...qualityFfmpegInputArgs("mov"),
        "-i",
        expect.stringMatching(/\/shellx-motion-ffmpeg-media-[^/]+\/[a-f0-9]{64}\.mp4$/),
        "-frames:v",
        "1",
        join(outDir, "final-intro-sample-frame.png")
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns chroma and cross-sample motion evidence through the debug API", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-quality-motion-"));
    const inputPath = join(tempRoot, "final.mp4");
    const manifestPath = join(tempRoot, "quality-manifest.json");
    const outDir = join(tempRoot, "quality");
    const firstFrame = CONTRAST_PNG;
    const secondFrame = BLACK_2X1_PNG;
    const runner: FfmpegRunner = async (command) => {
      if (command.executable.includes("ffprobe")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_type: "video", codec_name: "h264", width: 2, height: 1, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "mov,mp4" }
          }),
          stderr: ""
        };
      }
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, outputPath.includes("-move-frame") ? secondFrame : firstFrame);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      await writeFile(inputPath, "fake media");
      await writeFile(manifestPath, `${JSON.stringify({
        schema: "shellx-motion/quality-manifest@1",
        samples: [
          { id: "establish", atMs: 0 },
          { id: "move", atMs: 500, minChangedPixelsFromPrevious: 1, minMeanDiffFromPrevious: 1 }
        ]
      }, null, 2)}\n`, "utf8");

      const result = await dispatchDebugCommand(
        "motion.quality.check",
        { inputPath, manifestPath, outDir },
        { tier: "render_motion", ffmpegRunner: runner, scratchRoot: tempRoot }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          samples: [
            { id: "establish", ok: true, quality: { minChromaPixels: 0 } },
            {
              id: "move",
              ok: true,
              quality: { minChromaPixels: 0 },
              previousSampleId: "establish",
              motionDiff: { ok: true, changedPixels: 1, meanAbsoluteError: expect.any(Number) }
            }
          ]
        });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects quality-manifest baselines that escape trusted input roots", async () => {
    const trustedRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-quality-manifest-trusted-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-quality-manifest-untrusted-"));
    const inputPath = join(trustedRoot, "final.mp4");
    const manifestPath = join(trustedRoot, "quality-manifest.json");
    const outsideBaseline = join(outsideRoot, "baseline.png");
    let nonProbeCalls = 0;
    const runner: FfmpegRunner = async (command) => {
      if (command.executable.includes("ffprobe")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_type: "video", codec_name: "h264", width: 2, height: 1, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
          }),
          stderr: ""
        };
      }
      nonProbeCalls += 1;
      throw new Error("Frame extraction must not run for an untrusted baseline");
    };

    try {
      await writeFile(inputPath, "fake media");
      await writeFile(outsideBaseline, BLACK_2X1_PNG);
      await writeFile(manifestPath, `${JSON.stringify({
        schema: "shellx-motion/quality-manifest@1",
        samples: [{ id: "escaped", atMs: 0, baseline: outsideBaseline }]
      }, null, 2)}\n`, "utf8");

      expect(await dispatchDebugCommand(
        "motion.quality.check",
        { inputPath, manifestPath, outDir: join(trustedRoot, "quality") },
        { tier: "render_motion", ffmpegRunner: runner, scratchRoot: trustedRoot }
      )).toEqual({
        ok: false,
        error: {
          code: "invalid_args",
          message: "batch quality baseline 1 escapes its approved root"
        },
        warnings: []
      });
      expect(nonProbeCalls).toBe(0);
    } finally {
      await rm(trustedRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("summarizes quality manifests into a read-only quality panel", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-quality-panel-"));
    const packageRoot = await writeDebugPackageWithTimeline();
    const manifestPath = join(tempRoot, "quality-manifest.json");
    const baselinePath = join(tempRoot, "baseline.png");
    const inputPath = join(tempRoot, "final.mp4");

    try {
      await writeFile(inputPath, "fake media", "utf8");
      await writeFile(baselinePath, "fake baseline", "utf8");
      await writeFile(
        manifestPath,
        `${JSON.stringify({
          schema: "shellx-motion/quality-manifest@1",
          audio: { expect: true, minPeakDb: -35, minMeanDb: -40, maxPeakDb: -1 },
          samples: [
            {
              id: "title",
              atMs: 250,
              baseline: "baseline.png",
              minBrightPixels: 20,
              minEdgePixels: 12,
              minLumaRange: 48,
              maxChangedPixels: 50,
              maxMeanDiff: 1.25,
              minPsnrDb: 38,
              minSsim: 0.985,
              compareAlpha: false,
              regions: [
                { id: "safe-title", x: 10, y: 20, width: 120, height: 40, minDarkPixels: 4, minBrightPixels: 6, minEdgePixels: 3 }
              ]
            },
            { id: "settle", atMs: 750, minNonTransparentPixels: 100 }
          ]
        }, null, 2)}\n`,
        "utf8"
      );

      const result = await dispatchDebugCommand(
        "motion.quality.panel",
        { qualityManifestPath: manifestPath, inputPath, packageRoot, preset: "mp4-h264" },
        { tier: "read_motion", scratchRoot: tempRoot }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^quality-panel-/);
        expect(result.visibleState).toMatchObject({
          panel: "quality",
          operation: "quality.panel",
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          manifestPath,
          sampleCount: 2,
          regionCount: 1,
          baselineCount: 1,
          hasAudioPolicy: true,
          preset: "mp4-h264"
        });
        expect(result.result).toMatchObject({
          ok: true,
          manifestPath,
          inputPath,
          packageRoot,
          packageId: "pkg_debug_timeline",
          motionId: "motion_debug_timeline",
          preset: "mp4-h264",
          counts: {
            samples: 2,
            regions: 1,
            baselines: 1,
            audioPolicies: 1,
            thresholdedSamples: 2
          },
          audio: { expectAudio: true, minPeakDb: -35, minMeanDb: -40, maxPeakDb: -1 },
          samples: [
            {
              id: "title",
              atMs: 250,
              baselinePath,
              baselineExists: true,
              compareAlpha: false,
              thresholded: true,
              thresholds: {
                minBrightPixels: 20,
                minEdgePixels: 12,
                minLumaRange: 48,
                maxChangedPixels: 50,
                maxMeanDiff: 1.25,
                minPsnrDb: 38,
                minSsim: 0.985
              },
              regionCount: 1,
              regions: [
                { id: "safe-title", x: 10, y: 20, width: 120, height: 40, minDarkPixels: 4, minBrightPixels: 6, minEdgePixels: 3 }
              ]
            },
            {
              id: "settle",
              atMs: 750,
              thresholded: true,
              thresholds: { minNonTransparentPixels: 100 },
              regionCount: 0,
              regions: []
            }
          ],
          suggestedActions: expect.arrayContaining([
            { id: "qualityCheck", command: "motion.quality.check", args: { inputPath, manifestPath } },
            { id: "renderFinal", command: "motion.render.final", args: { packageRoot, qualityManifestPath: manifestPath, preset: "mp4-h264" } },
            { id: "exportPlan", command: "motion.export.plan", args: { packageRoot, qualityManifestPath: manifestPath, preset: "mp4-h264" } },
            { id: "reviewBundle", command: "motion.review.html.bundle", args: {} }
          ])
        });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("runs quality manifest alpha coverage checks through the debug API", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-quality-manifest-alpha-"));
    const inputPath = join(tempRoot, "overlay.webm");
    const manifestPath = join(tempRoot, "quality-manifest.json");
    const outDir = join(tempRoot, "quality");
    const runner: FfmpegRunner = async (command) => {
      if (command.executable.includes("ffprobe")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_type: "video", codec_name: "vp9", width: 2, height: 2, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "matroska,webm" }
          }),
          stderr: ""
        };
      }
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, ALPHA_2X2_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      await writeFile(inputPath, "fake media");
      await writeFile(
        manifestPath,
        `${JSON.stringify({
          schema: "shellx-motion/quality-manifest@1",
          samples: [
            {
              id: "overlay",
              atMs: 0,
              minTransparentPixels: 2,
              minNonTransparentPixels: 2,
              regions: [
                { id: "full alpha", x: 0, y: 0, width: 2, height: 2, minTransparentPixels: 2, minNonTransparentPixels: 2 }
              ]
            }
          ]
        }, null, 2)}\n`,
        "utf8"
      );

      const result = await dispatchDebugCommand(
        "motion.quality.check",
        { inputPath, manifestPath, outDir },
        { tier: "render_motion", ffmpegRunner: runner, scratchRoot: tempRoot }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          inputPath,
          manifestPath,
          samples: [
            {
              ok: true,
              id: "overlay",
              quality: { minTransparentPixels: 2, minNonTransparentPixels: 2 },
              regions: [
                { ok: true, id: "full alpha", quality: { minTransparentPixels: 2, minNonTransparentPixels: 2 } }
              ]
            }
          ]
        });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("applies quality manifest audio policy and region checks through the debug API", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-quality-manifest-audio-region-"));
    const inputPath = join(tempRoot, "final.mp4");
    const manifestPath = join(tempRoot, "quality-manifest.json");
    const outDir = join(tempRoot, "quality");
    const calls: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      if (command.executable.includes("ffprobe")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [
              { codec_type: "video", codec_name: "h264", width: 2, height: 1, avg_frame_rate: "30/1" },
              { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000", duration: "1.000000" }
            ],
            format: { duration: "1.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
          }),
          stderr: ""
        };
      }
      if (command.args.some((arg) => arg.startsWith("volumedetect,"))) {
        return {
          exitCode: 0,
          stdout: "",
          stderr: [
            "[Parsed_volumedetect_0 @ 0x1] n_samples: 48000",
            "[Parsed_volumedetect_0 @ 0x1] mean_volume: -18.5 dB",
            "[Parsed_volumedetect_0 @ 0x1] max_volume: -8.1 dB",
            "{\"input_i\":\"-20.0\",\"input_tp\":\"-2.0\",\"input_lra\":\"8.0\",\"input_thresh\":\"-30.0\",\"target_offset\":\"0.0\"}"
          ].join("\n")
        };
      }
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      await writeFile(inputPath, "fake media");
      await writeFile(
        manifestPath,
        `${JSON.stringify({
          schema: "shellx-motion/quality-manifest@1",
          audio: {
            expect: true,
            minPeakDb: -50,
            minMeanDb: -35,
            maxPeakDb: -1,
            minIntegratedLoudnessLufs: -24,
            maxIntegratedLoudnessLufs: -18,
            maxTruePeakDbtp: -1,
            maxLoudnessRangeLu: 12
          },
          samples: [
            {
              id: "title safe",
              atMs: 250,
              minBrightPixels: 1,
              minEdgePixels: 0,
              maxChangedPixels: 0,
              maxMeanDiff: 0,
              regions: [
                { id: "full frame", x: 0, y: 0, width: 2, height: 1, minDarkPixels: 1, minBrightPixels: 1, minEdgePixels: 0 }
              ]
            }
          ]
        }, null, 2)}\n`,
        "utf8"
      );

      const result = await dispatchDebugCommand(
        "motion.quality.check",
        { inputPath, manifestPath, outDir },
        { tier: "render_motion", ffmpegRunner: runner, scratchRoot: tempRoot }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          inputPath,
          manifestPath,
          audioLevels: {
            ok: true,
            sampleCount: 48000,
            meanVolumeDb: -18.5,
            maxVolumeDb: -8.1,
            integratedLoudnessLufs: -20,
            truePeakDbtp: -2,
            loudnessRangeLu: 8
          },
          samples: [
            {
              ok: true,
              id: "title safe",
              atMs: 250,
              framePath: join(outDir, "final-title-safe-frame.png"),
              regions: [
                {
                  ok: true,
                  id: "full frame",
                  region: { x: 0, y: 0, width: 2, height: 1 },
                  quality: {
                    frameCount: 1,
                    minDarkPixels: 1,
                    minBrightPixels: 1,
                    minEdgePixels: 1
                  }
                }
              ]
            }
          ]
        });
        expect(result.visibleState).toMatchObject({
          panel: "receipts",
          operation: "quality.check",
          manifestPath,
          sampleCount: 1,
          audio: {
            expectAudio: true,
            minPeakDb: -50,
            minMeanDb: -35,
            maxPeakDb: -1,
            minIntegratedLoudnessLufs: -24,
            maxIntegratedLoudnessLufs: -18,
            maxTruePeakDbtp: -1,
            maxLoudnessRangeLu: 12
          }
        });
      }
      expect(calls.some((call) => call.args.some((arg) => arg.startsWith("volumedetect,")))).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes receipt evidence for quality manifest checks through the debug API", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-quality-receipt-"));
    const inputPath = join(tempRoot, "final.mp4");
    const manifestPath = join(tempRoot, "quality-manifest.json");
    const outDir = join(tempRoot, "quality");
    const receiptsRoot = join(tempRoot, "host-receipts");
    const runner: FfmpegRunner = async (command) => {
      if (command.executable.includes("ffprobe")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [
              { codec_type: "video", codec_name: "h264", width: 2, height: 1, avg_frame_rate: "30/1" },
              { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000", duration: "1.000000" }
            ],
            format: { duration: "1.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
          }),
          stderr: ""
        };
      }
      if (command.args.some((arg) => arg.startsWith("volumedetect,"))) {
        return {
          exitCode: 0,
          stdout: "",
          stderr: [
            "[Parsed_volumedetect_0 @ 0x1] n_samples: 48000",
            "[Parsed_volumedetect_0 @ 0x1] mean_volume: -18.5 dB",
            "[Parsed_volumedetect_0 @ 0x1] max_volume: -8.1 dB"
          ].join("\n")
        };
      }
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      await writeFile(inputPath, "fake media");
      await writeFile(
        manifestPath,
        `${JSON.stringify({
          schema: "shellx-motion/quality-manifest@1",
          audio: { expect: true, minPeakDb: -50, minMeanDb: -35, maxPeakDb: -1 },
          samples: [
            {
              id: "title safe",
              atMs: 250,
              minBrightPixels: 1,
              minEdgePixels: 0,
              maxChangedPixels: 0,
              maxMeanDiff: 0,
              regions: [
                { id: "full frame", x: 0, y: 0, width: 2, height: 1, minDarkPixels: 1, minBrightPixels: 1, minEdgePixels: 0 }
              ]
            }
          ]
        }, null, 2)}\n`,
        "utf8"
      );

      const result = await dispatchDebugCommand(
        "motion.quality.check",
        { inputPath, manifestPath, outDir, receiptsRoot },
        { tier: "render_motion", ffmpegRunner: runner, scratchRoot: tempRoot }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const debugResult = result.result as Record<string, any>;
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        expect(debugResult.hostReceiptPath).toBe(hostReceiptPath);
        expect(result.visibleState).toMatchObject({
          panel: "receipts",
          operation: "quality.check",
          inputPath,
          manifestPath,
          hostReceiptPath,
          status: "passed",
          sampleCount: 1
        });
        expect(debugResult.receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "quality.check",
          status: "passed",
          packageId: "quality-check",
          lane: "quality",
          output: {
            inputPath,
            manifestPath,
            sampleCount: 1,
            audio: { expectAudio: true, minPeakDb: -50, minMeanDb: -35, maxPeakDb: -1 },
            audioLevels: {
              ok: true,
              sampleCount: 48000,
              meanVolumeDb: -18.5,
              maxVolumeDb: -8.1
            }
          }
        });
        expect(debugResult.receipt.inputHashes[inputPath]).toMatch(/^[a-f0-9]{64}$/);
        expect(debugResult.receipt.inputHashes[manifestPath]).toBe(hashBuffer(await readFile(manifestPath)));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));
        expect(hostReceipt).toEqual(debugResult.receipt);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes failed receipt evidence for quality manifest visual regressions through the debug API", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-quality-manifest-failure-receipt-"));
    const inputPath = join(tempRoot, "final.mp4");
    const manifestPath = join(tempRoot, "quality-manifest.json");
    const baselinePath = join(tempRoot, "baseline.png");
    const outDir = join(tempRoot, "quality");
    const receiptsRoot = join(tempRoot, "host-receipts");
    const runner: FfmpegRunner = async (command) => {
      if (command.executable.includes("ffprobe")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_type: "video", codec_name: "h264", width: 2, height: 1, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
          }),
          stderr: ""
        };
      }
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      await writeFile(inputPath, "fake media");
      await writeFile(baselinePath, BLACK_2X1_PNG);
      await writeFile(
        manifestPath,
        `${JSON.stringify({
          schema: "shellx-motion/quality-manifest@1",
          samples: [
            {
              id: "title safe",
              atMs: 250,
              baseline: baselinePath,
              minBrightPixels: 1,
              minEdgePixels: 0,
              maxChangedPixels: 0,
              maxMeanDiff: 0
            }
          ]
        }, null, 2)}\n`,
        "utf8"
      );

      const result = await dispatchDebugCommand(
        "motion.quality.check",
        { inputPath, manifestPath, outDir, receiptsRoot },
        { tier: "render_motion", ffmpegRunner: runner, scratchRoot: tempRoot }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({
          code: "visual_regression_failed",
          message: expect.stringContaining("Quality manifest sample title safe failed: Visual regression failed:"),
          detail: {
            receiptId: expect.stringMatching(/^quality-check-/),
            hostReceiptPath: expect.stringMatching(/quality-check-.*\.receipt\.json$/),
            receipt: {
              schema: "shellx-motion/receipt@1",
              operation: "quality.check",
              status: "failed",
              packageId: "quality-check",
              lane: "quality",
              inputHashes: {
                [inputPath]: expect.stringMatching(/^[a-f0-9]{64}$/)
              },
              output: {
                inputPath,
                manifestPath,
                sampleCount: 1,
                samples: [
                  expect.objectContaining({
                    ok: false,
                    id: "title safe",
                    baselinePath,
                    error: {
                      code: "visual_regression_failed",
                      message: expect.stringContaining("Visual regression failed:")
                    }
                  })
                ],
                error: {
                  code: "visual_regression_failed",
                  message: expect.stringContaining("Quality manifest sample title safe failed: Visual regression failed:")
                }
              },
              warnings: [expect.stringContaining("Quality manifest sample title safe failed: Visual regression failed:")]
            }
          }
        });
        const detail = result.error.detail as { hostReceiptPath: string; receipt: unknown };
        expect((detail.receipt as { inputHashes: Record<string, string> }).inputHashes[manifestPath]).toBe(hashBuffer(await readFile(manifestPath)));
        const hostReceipt = JSON.parse(await readFile(detail.hostReceiptPath, "utf8"));
        expect(hostReceipt).toEqual(detail.receipt);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails visual regression thresholds through the debug API", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-visual-regression-"));
    const inputPath = join(tempRoot, "final.mp4");
    const baselinePath = join(tempRoot, "baseline.png");
    const outDir = join(tempRoot, "quality");
    const runner: FfmpegRunner = async (command) => {
      if (command.executable.includes("ffprobe")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_type: "video", codec_name: "h264", width: 2, height: 1, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
          }),
          stderr: ""
        };
      }
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      await writeFile(inputPath, "fake media");
      await writeFile(baselinePath, BLACK_2X1_PNG);
      const result = await dispatchDebugCommand(
        "motion.quality.check",
        { inputPath, baselinePath, maxChangedPixels: 0, maxMeanDiff: 0, outDir },
        { tier: "render_motion", ffmpegRunner: runner, scratchRoot: tempRoot }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("visual_regression_failed");
        expect(result.error.message).toContain("Visual regression failed:");
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails SSIM regressions through the debug API", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-ssim-regression-"));
    const inputPath = join(tempRoot, "final.mp4");
    const baselinePath = join(tempRoot, "baseline.png");
    const outDir = join(tempRoot, "quality");
    const runner: FfmpegRunner = async (command) => {
      if (command.executable.includes("ffprobe")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_type: "video", codec_name: "h264", width: 2, height: 1, avg_frame_rate: "30/1" }],
            format: { duration: "1.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
          }),
          stderr: ""
        };
      }
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, CONTRAST_PNG);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      await writeFile(inputPath, "fake media");
      await writeFile(baselinePath, BLACK_2X1_PNG);
      const result = await dispatchDebugCommand(
        "motion.quality.check",
        { inputPath, baselinePath, maxChangedPixels: 2, maxMeanDiff: 255, minSsim: 0.9, outDir },
        { tier: "render_motion", ffmpegRunner: runner, scratchRoot: tempRoot }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "visual_regression_failed",
          message: expect.stringContaining("SSIM")
        }
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("plans batch/data renders through the debug API", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-plan-receipt-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir,
          preset: "webm-vp9",
          minUniqueFrameHashes: 2,
          dryRun: true
        },
        { tier: "render_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const receiptPath = join(outDir, "receipts", "batch-render.receipt.json");
        const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_batch_card",
          dryRun: true,
          preset: "webm-vp9",
          quality: { minUniqueFrameHashes: 2 },
          rows: 2,
          jobs: [
            { rowId: "ada", packageId: "pkg_batch_card_ada", status: "not_run", quality: { minUniqueFrameHashes: 2 }, frameTransport: { delivery: "streamed", reason: "stream_default" } },
            { rowId: "grace", packageId: "pkg_batch_card_grace", status: "not_run", quality: { minUniqueFrameHashes: 2 }, frameTransport: { delivery: "streamed", reason: "stream_default" } }
          ],
          receiptPath,
          receipt: {
            operation: "render.batch",
            status: "not_run",
            output: {
              dryRun: true,
              preset: "webm-vp9",
              quality: { minUniqueFrameHashes: 2 },
              rows: 2,
              jobs: [
                { rowId: "ada", packageId: "pkg_batch_card_ada", status: "not_run", quality: { minUniqueFrameHashes: 2 } },
                { rowId: "grace", packageId: "pkg_batch_card_grace", status: "not_run", quality: { minUniqueFrameHashes: 2 } }
              ]
            }
          }
        });
        expect(result.receiptId).toBe(receipt.id);
        expect(result.receiptId).toMatch(/^batch-render-pkg_batch_card-/);
        expect(result.visibleState).toMatchObject({
          panel: "receipts",
          operation: "render.batch",
          status: "not_run",
          receiptPath,
          quality: { minUniqueFrameHashes: 2 }
        });
        expect(receipt).toMatchObject({
          operation: "render.batch",
          status: "not_run",
          output: {
            dryRun: true,
            preset: "webm-vp9",
            quality: { minUniqueFrameHashes: 2 },
            rows: 2,
            jobs: [
              { rowId: "ada", packageId: "pkg_batch_card_ada", status: "not_run", quality: { minUniqueFrameHashes: 2 } },
              { rowId: "grace", packageId: "pkg_batch_card_grace", status: "not_run", quality: { minUniqueFrameHashes: 2 } }
            ]
          }
        });
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  // Every receipt a batch produces (aggregate plus per-row plan) must carry the
  // same first-class actor the transport observed — not just the per-row final
  // renders. Parameterized across the direct/no-actor, HTTP, and MCP paths.
  describe("batch receipts carry first-class actor attribution across transports", () => {
    const HTTP_ACTOR = { kind: "human", label: "operator@localhost", transport: "http", clientInfo: "engine-room/1.0", sessionId: "srv-2:http-7", grantedTier: "render_motion" } as const;
    const MCP_ACTOR = { kind: "agent", label: "mcp client", transport: "mcp", clientInfo: "claude-code/1.0", sessionId: "srv-1:ws-2", grantedTier: "render_motion" } as const;

    const cases: Array<{ name: string; actor?: typeof HTTP_ACTOR | typeof MCP_ACTOR; expected: Record<string, unknown> | null }> = [
      { name: "direct/no-actor", actor: undefined, expected: null },
      { name: "HTTP", actor: HTTP_ACTOR, expected: { ...HTTP_ACTOR } },
      { name: "MCP", actor: MCP_ACTOR, expected: { ...MCP_ACTOR } }
    ];

    it.each(cases)("$name: aggregate + every row-plan receipt carries the same normalized actor", async ({ actor, expected }) => {
      const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-batch-actor-"));
      try {
        const context = actor
          ? { tier: "render_motion" as const, actor }
          : { tier: "render_motion" as const };
        const result = await dispatchDebugCommand(
          "motion.render.batch",
          { packageRoot: "../../fixtures/packages/batch-card", outDir, preset: "webm-vp9", dryRun: true },
          context
        );
        expect(result.ok).toBe(true);

        const receiptsRoot = join(outDir, "receipts");
        const receiptNames = (await readdir(receiptsRoot)).filter((name) => name.endsWith(".receipt.json"));
        // The batch produces one aggregate receipt plus one plan receipt per data row.
        expect(receiptNames).toEqual(expect.arrayContaining([
          "batch-render.receipt.json",
          "pkg_batch_card_ada.batch-row.receipt.json",
          "pkg_batch_card_grace.batch-row.receipt.json"
        ]));

        const observedActors: string[] = [];
        for (const name of receiptNames) {
          const receipt = JSON.parse(await readFile(join(receiptsRoot, name), "utf8")) as { actor?: unknown };
          if (expected === null) {
            expect(receipt.actor, `${name} must stay unattributed for a direct/no-actor call`).toBeUndefined();
          } else {
            expect(receipt.actor, `${name} must carry the observed actor`).toEqual(expected);
          }
          observedActors.push(JSON.stringify(receipt.actor ?? null));
        }
        // Every batch-generated receipt carries the SAME normalized actor.
        expect(new Set(observedActors).size).toBe(1);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    });
  });

  it("emits stable per-row idempotency keys for debug batch/data plans", async () => {
    const firstOutDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-idempotency-a-"));
    const secondOutDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-idempotency-b-"));
    const webmOutDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-idempotency-webm-"));
    try {
      const first = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir: firstOutDir,
          dryRun: true
        },
        { tier: "render_motion" }
      );
      const second = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir: secondOutDir,
          dryRun: true
        },
        { tier: "render_motion" }
      );
      const webm = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir: webmOutDir,
          preset: "webm-vp9",
          dryRun: true
        },
        { tier: "render_motion" }
      );

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(webm.ok).toBe(true);
      if (first.ok && second.ok && webm.ok) {
        const firstReceipt = JSON.parse(await readFile(join(firstOutDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;
        const firstJobs = (first.result as { jobs: Array<Record<string, string>> }).jobs;
        const secondJobs = (second.result as { jobs: Array<Record<string, string>> }).jobs;
        const webmJobs = (webm.result as { jobs: Array<Record<string, string>> }).jobs;

        expect(firstJobs.map((job) => job.idempotencyKey)).toEqual(secondJobs.map((job) => job.idempotencyKey));
        expect(firstJobs[0].idempotencyKey).toMatch(/^pkg_batch_card_ada:ada:mp4-h264:[a-f0-9]{24}$/);
        expect(firstJobs[1].idempotencyKey).toMatch(/^pkg_batch_card_grace:grace:mp4-h264:[a-f0-9]{24}$/);
        expect(webmJobs[0].idempotencyKey).not.toBe(firstJobs[0].idempotencyKey);
        expect(firstReceipt.output.jobs[0].idempotencyKey).toBe(firstJobs[0].idempotencyKey);
        expect(firstReceipt.output.jobs[1].idempotencyKey).toBe(firstJobs[1].idempotencyKey);
      }
    } finally {
      await rm(firstOutDir, { recursive: true, force: true });
      await rm(secondOutDir, { recursive: true, force: true });
      await rm(webmOutDir, { recursive: true, force: true });
    }
  });

  it("writes per-row batch/data plan receipts through the debug API", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-row-receipts-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir,
          dryRun: true
        },
        { tier: "render_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const jobs = (result.result as { jobs: Array<Record<string, string>> }).jobs;
        const batchReceipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;
        const adaPlanReceiptPath = join(outDir, "receipts", "pkg_batch_card_ada.batch-row.receipt.json");
        const adaPlanReceipt = JSON.parse(await readFile(adaPlanReceiptPath, "utf8")) as Record<string, any>;

        expect(jobs[0]).toMatchObject({
          rowId: "ada",
          idempotencyKey: expect.stringMatching(/^pkg_batch_card_ada:ada:mp4-h264:[a-f0-9]{24}$/),
          planReceiptPath: adaPlanReceiptPath,
          receiptPath: adaPlanReceiptPath
        });
        expect(adaPlanReceipt).toMatchObject({
          operation: "render.batch.row",
          status: "not_run",
          packageId: "pkg_batch_card_ada",
          lane: "batch",
          inputHashes: {
            row: jobs[0].rowHash
          },
          output: {
            dryRun: true,
            rowId: "ada",
            rowKey: jobs[0].rowKey,
            idempotencyKey: jobs[0].idempotencyKey,
            packageId: "pkg_batch_card_ada",
            packageDir: join(outDir, "packages", "pkg_batch_card_ada"),
            outputPath: join(outDir, "render", "pkg_batch_card_ada.mp4"),
            preset: "mp4-h264",
            status: "not_run"
          }
        });
        expect(adaPlanReceipt.artifacts).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: "row_package", path: join(outDir, "packages", "pkg_batch_card_ada"), status: "available" }),
          expect.objectContaining({ role: "planned_output", path: join(outDir, "render", "pkg_batch_card_ada.mp4"), status: "planned" })
        ]));
        expect(batchReceipt.output.jobs[0]).toMatchObject({
          idempotencyKey: jobs[0].idempotencyKey,
          planReceiptPath: adaPlanReceiptPath,
          receiptPath: adaPlanReceiptPath
        });
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("uses per-row render presets for batch/data variants through the debug API", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-row-presets-"));
    const rowsDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-row-presets-rows-"));
    const rowsPath = join(rowsDir, "rows.json");
    try {
      await writeFile(rowsPath, `${JSON.stringify({
        schema: "shellx-motion/data-rows@1",
        rows: [
          { id: "webm", name: "WebM", background: "#0f172a", accent: "#38bdf8", render: { preset: "webm-vp9" } },
          { id: "still", name: "Still", background: "#111827", accent: "#22c55e", render: { preset: "png-frame" } }
        ]
      }, null, 2)}\n`, "utf8");

      const result = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir,
          rowsPath,
          dryRun: true
        },
        { tier: "render_motion", scratchRoot: dirname(rowsPath) }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const receiptPath = join(outDir, "receipts", "batch-render.receipt.json");
        const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_batch_card",
          dryRun: true,
          preset: "mp4-h264",
          presets: ["webm-vp9", "png-frame"],
          rows: 2,
          jobs: [
            { rowId: "webm", packageId: "pkg_batch_card_webm", preset: "webm-vp9", outputPath: join(outDir, "render", "pkg_batch_card_webm.webm"), status: "not_run" },
            { rowId: "still", packageId: "pkg_batch_card_still", preset: "png-frame", outputPath: join(outDir, "render", "pkg_batch_card_still.png"), status: "not_run" }
          ],
          receiptPath
        });
        expect(receipt).toMatchObject({
          operation: "render.batch",
          status: "not_run",
          output: {
            dryRun: true,
            preset: "mp4-h264",
            presets: ["webm-vp9", "png-frame"],
            rows: 2,
            jobs: [
              { rowId: "webm", packageId: "pkg_batch_card_webm", preset: "webm-vp9", outputPath: join(outDir, "render", "pkg_batch_card_webm.webm"), status: "not_run" },
              { rowId: "still", packageId: "pkg_batch_card_still", preset: "png-frame", outputPath: join(outDir, "render", "pkg_batch_card_still.png"), status: "not_run" }
            ]
          }
        });
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
      await rm(rowsDir, { recursive: true, force: true });
    }
  });

  it("plans selected batch/data rows through the debug API", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-row-filter-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir,
          rowIds: ["grace"],
          dryRun: true
        },
        { tier: "render_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const batchReceipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;
        const graceMotion = JSON.parse(await readFile(join(outDir, "packages", "pkg_batch_card_grace", "motion.json"), "utf8")) as Record<string, any>;

        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_batch_card",
          dryRun: true,
          rows: 1,
          jobs: [
            { rowId: "grace", packageId: "pkg_batch_card_grace", status: "not_run" }
          ]
        });
        expect(batchReceipt.output).toMatchObject({
          rows: 1,
          jobs: [
            { rowId: "grace", packageId: "pkg_batch_card_grace", status: "not_run" }
          ]
        });
        expect(graceMotion.layers[1].text).toBe("Hello Grace");
        await expect(readFile(join(outDir, "packages", "pkg_batch_card_ada", "motion.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("publishes bounded Debug batch row selection arguments", () => {
    const argsSchema = debugContract("motion.render.batch").argsSchema as { properties: Record<string, unknown> };
    const rowIds = argsSchema.properties.rowIds;
    const rowId = argsSchema.properties.rowId;

    expect(rowIds).toMatchObject({
      type: "array",
      maxItems: 256,
      items: { type: "string", maxLength: 256 }
    });
    expect(rowId).toMatchObject({ type: "string", maxLength: 256 });
  });

  it("rejects missing debug batch/data row selections", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-row-missing-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir,
          rowIds: ["missing"],
          dryRun: true
        },
        { tier: "render_motion" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: "Motion data row IDs not found: missing."
        }
      });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("plans batch/data PNG sequence exports through the debug API", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-png-sequence-dry-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir,
          preset: "png-sequence",
          dryRun: true
        },
        { tier: "render_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const receiptPath = join(outDir, "receipts", "batch-render.receipt.json");
        const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, any>;
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_batch_card",
          dryRun: true,
          preset: "png-sequence",
          rows: 2,
          jobs: [
            { rowId: "ada", packageId: "pkg_batch_card_ada", outputPath: join(outDir, "render", "pkg_batch_card_ada"), status: "not_run" },
            { rowId: "grace", packageId: "pkg_batch_card_grace", outputPath: join(outDir, "render", "pkg_batch_card_grace"), status: "not_run" }
          ],
          receiptPath
        });
        expect(receipt).toMatchObject({
          operation: "render.batch",
          status: "not_run",
          output: {
            dryRun: true,
            preset: "png-sequence",
            rows: 2,
            jobs: [
              { rowId: "ada", packageId: "pkg_batch_card_ada", outputPath: join(outDir, "render", "pkg_batch_card_ada"), status: "not_run" },
              { rowId: "grace", packageId: "pkg_batch_card_grace", outputPath: join(outDir, "render", "pkg_batch_card_grace"), status: "not_run" }
            ]
          }
        });
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("materializes debug batch dry-run packages from external CSV rows", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-csv-dry-"));
    const rowsDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-csv-rows-"));
    const rowsPath = join(rowsDir, "rows.csv");
    try {
      await writeFile(rowsPath, [
        "id,name,background,accent",
        "ada,Ada,#0f172a,#38bdf8",
        "grace,Grace,#111827,#22c55e"
      ].join("\n"), "utf8");

      const result = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir,
          rowsPath,
          dryRun: true
        },
        { tier: "render_motion", scratchRoot: dirname(rowsPath) }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const adaPackageDir = join(outDir, "packages", "pkg_batch_card_ada");
        const gracePackageDir = join(outDir, "packages", "pkg_batch_card_grace");
        const adaMotion = JSON.parse(await readFile(join(adaPackageDir, "motion.json"), "utf8")) as Record<string, any>;
        const graceMotion = JSON.parse(await readFile(join(gracePackageDir, "motion.json"), "utf8")) as Record<string, any>;
        const batchReceipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;

        expect(result.result).toMatchObject({
          ok: true,
          dryRun: true,
          rows: 2,
          jobs: [
            { rowId: "ada", packageId: "pkg_batch_card_ada", packageDir: adaPackageDir, status: "not_run" },
            { rowId: "grace", packageId: "pkg_batch_card_grace", packageDir: gracePackageDir, status: "not_run" }
          ]
        });
        const jobs = (result.result as { jobs: Array<Record<string, string>> }).jobs;
        expect(jobs[0].rowKey).toBe(`${jobs[0].rowId}-${String(jobs[0].rowHash).slice(0, 16)}`);
        expect(batchReceipt.output.jobs[0].rowKey).toBe(jobs[0].rowKey);
        expect(adaMotion).toMatchObject({
          id: "motion_batch_card_ada",
          name: "Batch Card Ada",
          background: "#0f172a",
          provenance: {
            dataRowId: "ada",
            dataRowKey: jobs[0].rowKey,
            dataRowHash: jobs[0].rowHash
          }
        });
        expect(adaMotion.layers[1].text).toBe("Hello Ada");
        expect(graceMotion).toMatchObject({
          id: "motion_batch_card_grace",
          name: "Batch Card Grace",
          background: "#111827"
        });
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
      await rm(rowsDir, { recursive: true, force: true });
    }
  });

  it("warns when debug batch dry-run silent export presets drop package audio", async () => {
    const packageRoot = await writeDebugBatchPackageWithAudioLayer();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-audio-warning-"));
    const warning = "Export preset gif does not support audio; 1 requested audio track will be ignored.";
    try {
      const result = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot,
          outDir,
          preset: "gif",
          dryRun: true
        },
        { tier: "render_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.warnings).toEqual([warning]);
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_audio_batch",
          dryRun: true,
          preset: "gif",
          rows: 2,
          warnings: [warning],
          jobs: [
            { rowId: "ada", packageId: "pkg_debug_audio_batch_ada", status: "not_run", warnings: [warning] },
            { rowId: "grace", packageId: "pkg_debug_audio_batch_grace", status: "not_run", warnings: [warning] }
          ]
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("renders debug batch/data rows as PNG sequences without invoking FFmpeg", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-png-sequence-real-"));
    const calls: FfmpegCommand[] = [];
    const framePaths: string[] = [];
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      return { exitCode: 0, stdout: "ffmpeg should not be needed for PNG sequence batch renders", stderr: "" };
    };

    try {
      const result = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir,
          preset: "png-sequence",
          dryRun: false
        },
        {
          tier: "render_motion",
          ffmpegRunner: runner,
          browserFrameRenderer: async (pkg, options) => {
            const framePath = options.outputPath ?? join(options.outDir, "frame.png");
            framePaths.push(framePath);
            await mkdir(dirname(framePath), { recursive: true, mode: 0o700 });
            await writeFile(framePath, CONTRAST_PNG);
            return {
              ok: true,
              output: {
                path: framePath,
                sha256: `${String(framePaths.length).padStart(64, "0")}`,
                width: pkg.motion.width,
                height: pkg.motion.height,
                atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: `browser-preview-png-sequence-${framePaths.length}`,
                operation: "preview.frame",
                status: "passed",
                packageId: pkg.manifest.id,
                inputHashes: { motion: "d".repeat(64) },
                createdAt: "2026-07-01T00:00:00.000Z",
                lane: "browser",
                output: { path: framePath },
                warnings: []
              }
            };
          }
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const batchReceiptPath = join(outDir, "receipts", "batch-render.receipt.json");
        const batchReceipt = JSON.parse(await readFile(batchReceiptPath, "utf8")) as Record<string, any>;
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_batch_card",
          dryRun: false,
          preset: "png-sequence",
          rows: 2,
          receiptPath: batchReceiptPath,
          jobs: [
            {
              rowId: "ada",
              packageId: "pkg_batch_card_ada",
              outputPath: join(outDir, "render", "pkg_batch_card_ada"),
              status: BATCH_STATIC_FIXTURE_STATUS,
              render: { lane: "image-sequence", preset: "png-sequence", frames: { count: 24 } }
            },
            {
              rowId: "grace",
              packageId: "pkg_batch_card_grace",
              outputPath: join(outDir, "render", "pkg_batch_card_grace"),
              status: BATCH_STATIC_FIXTURE_STATUS,
              render: { lane: "image-sequence", preset: "png-sequence", frames: { count: 24 } }
            }
          ]
        });
        expect(batchReceipt).toMatchObject({
          operation: "render.batch",
          status: BATCH_STATIC_FIXTURE_STATUS,
          output: {
            preset: "png-sequence",
            jobs: [
              { rowId: "ada", outputPath: join(outDir, "render", "pkg_batch_card_ada"), status: BATCH_STATIC_FIXTURE_STATUS },
              { rowId: "grace", outputPath: join(outDir, "render", "pkg_batch_card_grace"), status: BATCH_STATIC_FIXTURE_STATUS }
            ]
          }
        });
        expect(calls).toHaveLength(0);
        await expect(readFile(join(outDir, "render", "pkg_batch_card_ada", "000001.png"))).resolves.toBeInstanceOf(Buffer);
        await expect(readFile(join(outDir, "render", "pkg_batch_card_grace", "000024.png"))).resolves.toBeInstanceOf(Buffer);
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 45_000);

  it.skipIf(process.platform === "win32")("creates an absent debug batch output tree privately under umask 0002", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-private-output-"));
    const outDir = join(root, "batch");
    const previousUmask = process.umask(0o002);
    try {
      const result = await dispatchDebugCommand(
        "motion.render.batch",
        { packageRoot: "../../fixtures/packages/batch-card", outDir, dryRun: true },
        { tier: "render_motion" }
      );
      expect(result.ok).toBe(true);
      for (const path of [outDir, join(outDir, "packages"), join(outDir, "render"), join(outDir, "receipts")]) {
        expect(Number((await stat(path)).mode) & 0o777, path).toBe(0o700);
      }
    } finally {
      process.umask(previousUmask);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders debug batch/data rows as still-frame images without invoking FFmpeg", async () => {
    const cases = [
      { preset: "png-frame", extension: "png", codec: "png", mimeType: "image/png", format: "png", bytes: CONTRAST_PNG, signature: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      { preset: "jpeg-frame", extension: "jpg", codec: "jpeg", mimeType: "image/jpeg", format: "jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), signature: Buffer.from([0xff, 0xd8, 0xff]) }
    ] as const;

    for (const imageCase of cases) {
      const outDir = await mkdtemp(join(tmpdir(), `shellx-motion-debug-batch-${imageCase.preset}-real-`));
      const calls: FfmpegCommand[] = [];
      const frameRequests: Array<{ path: string; format?: string }> = [];
      const runner: FfmpegRunner = async (command) => {
        calls.push(command);
        return { exitCode: 0, stdout: "ffmpeg should not be needed for still-frame batch renders", stderr: "" };
      };
      const adaOutputPath = join(outDir, "render", `pkg_batch_card_ada.${imageCase.extension}`);
      const graceOutputPath = join(outDir, "render", `pkg_batch_card_grace.${imageCase.extension}`);

      try {
        const result = await dispatchDebugCommand(
          "motion.render.batch",
          {
            packageRoot: "../../fixtures/packages/batch-card",
            outDir,
            preset: imageCase.preset,
            dryRun: false
          },
          {
            tier: "render_motion",
            ffmpegRunner: runner,
            browserFrameRenderer: async (pkg, options) => {
              const framePath = options.outputPath ?? join(options.outDir, "frame.png");
              frameRequests.push({ path: framePath, format: options.format });
              await mkdir(dirname(framePath), { recursive: true });
              await writeFile(framePath, Buffer.concat([imageCase.bytes, Buffer.from(String(frameRequests.length))]));
              return {
                ok: true,
                output: {
                  path: framePath,
                  sha256: `${String(frameRequests.length).padStart(64, "0")}`,
                  width: pkg.motion.width,
                  height: pkg.motion.height,
                  atMs: options.atMs,
                  browser: { name: "chromium", version: "test" },
                  viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
                },
                receipt: {
                  schema: "shellx-motion/receipt@1",
                  id: `browser-preview-still-batch-${imageCase.preset}-${frameRequests.length}`,
                  operation: "preview.frame",
                  status: "passed",
                  packageId: pkg.manifest.id,
                  inputHashes: { motion: "d".repeat(64) },
                  createdAt: "2026-07-01T00:00:00.000Z",
                  lane: "browser",
                  output: { path: framePath },
                  warnings: []
                }
              };
            }
          }
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          const batchReceiptPath = join(outDir, "receipts", "batch-render.receipt.json");
          const batchReceipt = JSON.parse(await readFile(batchReceiptPath, "utf8")) as Record<string, any>;
          expect(result.result).toMatchObject({
            ok: true,
            packageId: "pkg_batch_card",
            dryRun: false,
            preset: imageCase.preset,
            rows: 2,
            receiptPath: batchReceiptPath,
            jobs: [
              {
                rowId: "ada",
                packageId: "pkg_batch_card_ada",
                outputPath: adaOutputPath,
                status: "passed",
                render: {
                  lane: "image",
                  preset: imageCase.preset,
                  output: { path: adaOutputPath, codec: imageCase.codec, container: "image", preset: imageCase.preset },
                  receipt: {
                    operation: "render.final",
                    status: "passed",
                    lane: "image",
                    artifacts: [
                      { role: "still_frame", path: adaOutputPath, status: "available", mediaType: imageCase.mimeType, primary: true }
                    ]
                  },
                  stillFrame: { outputPath: adaOutputPath, atMs: 0, codec: imageCase.codec, container: "image", preset: imageCase.preset }
                }
              },
              {
                rowId: "grace",
                packageId: "pkg_batch_card_grace",
                outputPath: graceOutputPath,
                status: "passed",
                render: {
                  lane: "image",
                  preset: imageCase.preset,
                  output: { path: graceOutputPath, codec: imageCase.codec, container: "image", preset: imageCase.preset },
                  stillFrame: { outputPath: graceOutputPath, atMs: 0, codec: imageCase.codec, container: "image", preset: imageCase.preset }
                }
              }
            ]
          });
          expect(batchReceipt).toMatchObject({
            operation: "render.batch",
            status: "passed",
            output: {
              preset: imageCase.preset,
              jobs: [
                { rowId: "ada", outputPath: adaOutputPath, status: "passed" },
                { rowId: "grace", outputPath: graceOutputPath, status: "passed" }
              ]
            }
          });
        }
        expect(frameRequests).toHaveLength(2); expect(frameRequests.every(({ path, format }) => format === imageCase.format && path.startsWith(`${join(outDir, "render")}/.shellx-motion-final-`))).toBe(true);
        expect(calls).toHaveLength(0);
        expect((await readFile(adaOutputPath)).subarray(0, imageCase.signature.length)).toEqual(imageCase.signature);
        expect((await readFile(graceOutputPath)).subarray(0, imageCase.signature.length)).toEqual(imageCase.signature);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    }
  }, 45_000);

  it("returns debug batch errors when PNG sequence rows fail the unique-frame quality gate", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-png-sequence-quality-fail-"));
    const calls: FfmpegCommand[] = [];
    const framePaths: string[] = [];
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      return { exitCode: 0, stdout: "ffmpeg should not be needed for PNG sequence batch renders", stderr: "" };
    };

    try {
      const result = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir,
          preset: "png-sequence",
          dryRun: false,
          minUniqueFrameHashes: 2
        },
        {
          tier: "render_motion",
          ffmpegRunner: runner,
          browserFrameRenderer: async (pkg, options) => {
            const framePath = options.outputPath ?? join(options.outDir, "frame.png");
            framePaths.push(framePath);
            await mkdir(dirname(framePath), { recursive: true, mode: 0o700 });
            await writeFile(framePath, CONTRAST_PNG);
            return {
              ok: true,
              output: {
                path: framePath,
                sha256: `${String(framePaths.length).padStart(64, "0")}`,
                width: pkg.motion.width,
                height: pkg.motion.height,
                atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: `browser-preview-static-batch-sequence-${framePaths.length}`,
                operation: "preview.frame",
                status: "passed",
                packageId: pkg.manifest.id,
                inputHashes: { motion: "d".repeat(64) },
                createdAt: "2026-07-01T00:00:00.000Z",
                lane: "browser",
                output: { path: framePath },
                warnings: []
              }
            };
          }
        }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("frame_quality_failed");
        expect(result.error.message).toBe("Batch row ada (pkg_batch_card_ada) failed: Rendered frame sequence has 1 unique frame; expected at least 2.");
        expect(result.warnings).toContain("Rendered frame sequence is static; verify this is intentional before using it as product output.");
      }
      const batchReceipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;
      expect(batchReceipt).toMatchObject({
        operation: "render.batch",
        status: "failed",
        output: {
          preset: "png-sequence",
          quality: { minUniqueFrameHashes: 2 },
          jobs: [
            { rowId: "ada", outputPath: join(outDir, "render", "pkg_batch_card_ada"), status: "failed" }
          ]
        }
      });
      expect(framePaths).toHaveLength(24);
      expect(calls).toHaveLength(0);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 45_000);

  it("renders batch/data rows through the debug API when dryRun is false", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-real-"));
    const calls: FfmpegCommand[] = [];
    const framePaths: string[] = [];
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      }
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, "fake batch output", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      const result = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir,
          preset: "mp4-h264",
          dryRun: false,
          minUniqueFrameHashes: 1
        },
        {
          tier: "render_motion",
          ffmpegRunner: runner,
          browserFrameRenderer: async (pkg, options) => {
            const framePath = options.outputPath ?? join(options.outDir, "frame.png");
            framePaths.push(framePath);
            await mkdir(dirname(framePath), { recursive: true });
            await writeFile(framePath, CONTRAST_PNG);
            return {
              ok: true,
              output: {
                path: framePath,
                sha256: `${String(framePaths.length).padStart(64, "0")}`,
                width: pkg.motion.width,
                height: pkg.motion.height,
                atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: `browser-preview-${framePaths.length}`,
                operation: "preview.frame",
                status: "passed",
                packageId: pkg.manifest.id,
                inputHashes: { motion: "d".repeat(64) },
                createdAt: "2026-07-01T00:00:00.000Z",
                lane: "browser",
                output: { path: framePath },
                warnings: []
              }
            };
          }
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const adaPackageDir = join(outDir, "packages", "pkg_batch_card_ada");
        const gracePackageDir = join(outDir, "packages", "pkg_batch_card_grace");
        const adaOutputPath = join(outDir, "render", "pkg_batch_card_ada.mp4");
        const graceOutputPath = join(outDir, "render", "pkg_batch_card_grace.mp4");
        const batchReceiptPath = join(outDir, "receipts", "batch-render.receipt.json");
        const adaManifest = JSON.parse(await readFile(join(adaPackageDir, "manifest.json"), "utf8"));
        const graceMotion = JSON.parse(await readFile(join(gracePackageDir, "motion.json"), "utf8"));
        const batchReceipt = JSON.parse(await readFile(batchReceiptPath, "utf8"));

        expect(result.receiptId).toMatch(/^batch-render-pkg_batch_card-/);
        expect(result.visibleState).toMatchObject({
          panel: "receipts",
          operation: "render.batch",
          packageId: "pkg_batch_card",
          rows: 2,
          status: BATCH_STATIC_FIXTURE_STATUS
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_batch_card",
          dryRun: false,
          preset: "mp4-h264",
          quality: { minUniqueFrameHashes: 1 },
          rows: 2,
          receiptPath: batchReceiptPath,
          jobs: [
            {
              rowId: "ada",
              packageId: "pkg_batch_card_ada",
              packageDir: adaPackageDir,
              outputPath: adaOutputPath,
              status: BATCH_STATIC_FIXTURE_STATUS,
              receiptPath: expect.stringContaining("ffmpeg-render-")
            },
            {
              rowId: "grace",
              packageId: "pkg_batch_card_grace",
              packageDir: gracePackageDir,
              outputPath: graceOutputPath,
              status: BATCH_STATIC_FIXTURE_STATUS,
              receiptPath: expect.stringContaining("ffmpeg-render-")
            }
          ],
          receipt: {
            operation: "render.batch",
            status: BATCH_STATIC_FIXTURE_STATUS,
            lane: "batch"
          }
        });
        expect(adaManifest).toMatchObject({ id: "pkg_batch_card_ada" });
        expect(graceMotion).toMatchObject({ id: "motion_batch_card_grace", name: "Batch Card Grace", background: "#111827" });
        expect(await readFile(adaOutputPath, "utf8")).toBe("fake batch output");
        expect(await readFile(graceOutputPath, "utf8")).toBe("fake batch output");
        expect(batchReceipt).toMatchObject({
          id: result.receiptId,
          operation: "render.batch",
          status: BATCH_STATIC_FIXTURE_STATUS,
          output: {
            rows: 2,
            jobs: [
              { rowId: "ada", packageId: "pkg_batch_card_ada", status: BATCH_STATIC_FIXTURE_STATUS },
              { rowId: "grace", packageId: "pkg_batch_card_grace", status: BATCH_STATIC_FIXTURE_STATUS }
            ]
          }
        });
      }
      expect(framePaths).toHaveLength(48);
      expect(calls.filter((call) => call.args[0] === "-version")).toHaveLength(2);
      expect(calls.filter((call) => call.args.includes("-framerate"))).toHaveLength(2);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("replays browser workflow evidence for debug batch/data render rows", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-workflow-"));
    const workflowDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-workflow-file-"));
    const workflowPath = join(workflowDir, "workflow.json");
    const workflowHash = "b".repeat(64);
    const calls: FfmpegCommand[] = [];
    const workflowRequests: unknown[] = [];
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      }
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, "fake batch output", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await writeFile(workflowPath, JSON.stringify({
      schema: "shellx-motion/browser-workflow@1",
      networkPolicy: "blocked-unless-declared",
      steps: [
        { action: "wait", ms: 5 },
        { action: "scroll", y: 12 }
      ],
      cursor: { visible: true, path: [{ x: 6, y: 9, atMs: 0 }] }
    }, null, 2));

    try {
      const result = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir,
          preset: "mp4-h264",
          workflowPath,
          dryRun: false,
          minUniqueFrameHashes: 1
        },
        {
          tier: "render_motion",
          scratchRoot: workflowDir,
          ffmpegRunner: runner,
          browserFrameRenderer: async (pkg, options) => {
            const framePath = options.outputPath ?? join(options.outDir, "frame.png");
            const workflow = options.workflow
              ? {
                  schema: options.workflow.schema,
                  networkPolicy: options.workflow.networkPolicy ?? "blocked-unless-declared",
                  stepCount: options.workflow.steps.length,
                  steps: options.workflow.steps.map((step) => ({ ...step })),
                  cursor: { visible: true, pointCount: 1 }
                }
              : undefined;
            const workflowTrace = options.workflow
              ? {
                  schema: "shellx-motion/browser-workflow-trace@1" as const,
                  workflowHash,
                  stepCount: options.workflow.steps.length,
                  steps: [
                    { index: 0, action: { action: "wait" as const, ms: 5 }, status: "passed" as const },
                    { index: 1, action: { action: "scroll" as const, x: 0, y: 12 }, status: "passed" as const }
                  ]
                }
              : undefined;
            workflowRequests.push(options.workflow ?? null);
            await mkdir(dirname(framePath), { recursive: true });
            await writeFile(framePath, CONTRAST_PNG);
            return {
              ok: true,
              output: {
                path: framePath,
                sha256: `${String(workflowRequests.length).padStart(64, "0")}`,
                width: pkg.motion.width,
                height: pkg.motion.height,
                atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 },
                ...(workflow ? { workflow } : {}),
                ...(workflowTrace ? { workflowTrace } : {})
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: `browser-preview-batch-workflow-${workflowRequests.length}`,
                operation: "preview.frame",
                status: "passed",
                packageId: pkg.manifest.id,
                inputHashes: {
                  motion: "d".repeat(64),
                  ...(workflow ? { workflow: workflowHash } : {})
                },
                createdAt: "2026-07-01T00:00:00.000Z",
                lane: "browser",
                output: {
                  path: framePath,
                  ...(workflow ? { workflow } : {}),
                  ...(workflowTrace ? { workflowTrace } : {})
                },
                warnings: []
              }
            };
          }
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const batchReceipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8"));
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_batch_card",
          dryRun: false,
          jobs: [
            {
              rowId: "ada",
              status: BATCH_STATIC_FIXTURE_STATUS,
              render: {
                ok: true,
                workflowPath,
                workflow: { stepCount: 2 },
                workflowTrace: { workflowHash, stepCount: 2 },
                receipt: {
                  inputHashes: { workflow: workflowHash },
                  output: {
                    workflow: { stepCount: 2 },
                    workflowTrace: { workflowHash, stepCount: 2 }
                  }
                }
              }
            },
            {
              rowId: "grace",
              status: BATCH_STATIC_FIXTURE_STATUS,
              render: {
                ok: true,
                workflowPath,
                workflow: { stepCount: 2 },
                workflowTrace: { workflowHash, stepCount: 2 },
                receipt: {
                  inputHashes: { workflow: workflowHash },
                  output: {
                    workflow: { stepCount: 2 },
                    workflowTrace: { workflowHash, stepCount: 2 }
                  }
                }
              }
            }
          ]
        });
        expect(batchReceipt).toMatchObject({
          operation: "render.batch",
          status: BATCH_STATIC_FIXTURE_STATUS,
          output: {
            jobs: [
              { rowId: "ada", render: { workflowTrace: { workflowHash, stepCount: 2 } } },
              { rowId: "grace", render: { workflowTrace: { workflowHash, stepCount: 2 } } }
            ]
          }
        });
      }
      expect(workflowRequests).toHaveLength(48);
      expect(workflowRequests[0]).toMatchObject({
        schema: "shellx-motion/browser-workflow@1",
        networkPolicy: "blocked-unless-declared",
        steps: [{ action: "wait", ms: 5 }, { action: "scroll", y: 12 }]
      });
      expect(calls.filter((call) => call.args[0] === "-version")).toHaveLength(2);
      expect(calls.filter((call) => call.args.includes("-framerate"))).toHaveLength(2);
    } finally {
      await rm(outDir, { recursive: true, force: true });
      await rm(workflowDir, { recursive: true, force: true });
    }
  });

  it("resumes debug batch/data rows without re-rendering matching idempotency keys", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-resume-"));
    const firstCalls: FfmpegCommand[] = [];
    const firstFramePaths: string[] = [];
    const firstRunner: FfmpegRunner = async (command) => {
      firstCalls.push(command);
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      }
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, "fake batch output", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const secondCalls: FfmpegCommand[] = [];
    const failOnRender: FfmpegRunner = async (command) => {
      secondCalls.push(command);
      return { exitCode: 1, stdout: "", stderr: `unexpected resume render: ${command.args.join(" ")}` };
    };
    const frameRenderer = async (pkg: any, options: any) => {
      const framePath = options.outputPath ?? join(options.outDir, "frame.png");
      firstFramePaths.push(framePath);
      await mkdir(dirname(framePath), { recursive: true });
      await writeFile(framePath, CONTRAST_PNG);
      return {
        ok: true as const,
        output: {
          path: framePath,
          sha256: `${String(firstFramePaths.length).padStart(64, "0")}`,
          width: pkg.motion.width,
          height: pkg.motion.height,
          atMs: options.atMs,
          browser: { name: "chromium", version: "test" },
          viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
        },
        receipt: {
          schema: "shellx-motion/receipt@1" as const,
          id: `browser-preview-${firstFramePaths.length}`,
          operation: "preview.frame",
          status: "passed" as const,
          packageId: pkg.manifest.id,
          inputHashes: { motion: "d".repeat(64) },
          createdAt: "2026-07-01T00:00:00.000Z",
          lane: "browser",
          output: { path: framePath },
          warnings: []
        }
      };
    };

    try {
      const first = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir,
          preset: "mp4-h264",
          dryRun: false
        },
        { tier: "render_motion", callerId: "test:batch-resume", ffmpegRunner: firstRunner, browserFrameRenderer: frameRenderer }
      );
      const resumed = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir,
          preset: "mp4-h264",
          dryRun: false,
          resume: true
        },
        {
          tier: "render_motion",
          callerId: "test:batch-resume",
          ffmpegRunner: failOnRender,
          browserFrameRenderer: async () => {
            throw new Error("resume should not render browser frames");
          }
        }
      );

      expect(first.ok).toBe(true);
      expect(resumed.ok).toBe(true);
      if (first.ok && resumed.ok) {
        const firstJobs = (first.result as { jobs: Array<Record<string, string>> }).jobs;
        const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;
        expect(resumed.result).toMatchObject({
          ok: true,
          packageId: "pkg_batch_card",
          dryRun: false,
          resume: true,
          resumedRows: 2,
          renderedRows: 0,
          jobs: [
            { rowId: "ada", status: "skipped", idempotencyKey: firstJobs[0].idempotencyKey, resume: { matched: true, sourceReceiptPath: firstJobs[0].receiptPath } },
            { rowId: "grace", status: "skipped", idempotencyKey: firstJobs[1].idempotencyKey, resume: { matched: true, sourceReceiptPath: firstJobs[1].receiptPath } }
          ]
        });
        expect(receipt).toMatchObject({
          operation: "render.batch",
          status: "passed",
          output: {
            resume: true,
            resumedRows: 2,
            renderedRows: 0,
            jobs: [
              { rowId: "ada", status: "skipped", idempotencyKey: firstJobs[0].idempotencyKey },
              { rowId: "grace", status: "skipped", idempotencyKey: firstJobs[1].idempotencyKey }
            ]
          }
        });
      }
      expect(secondCalls).toHaveLength(0);
      expect(await readFile(join(outDir, "render", "pkg_batch_card_ada.mp4"), "utf8")).toBe("fake batch output");
      expect(await readFile(join(outDir, "render", "pkg_batch_card_grace.mp4"), "utf8")).toBe("fake batch output");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("refuses changed-workflow batch resume rather than overwrite prior final media", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-resume-workflow-"));
    const workflowA = {
      schema: "shellx-motion/browser-workflow@1" as const,
      networkPolicy: "blocked-unless-declared" as const,
      steps: [{ action: "wait" as const, ms: 5 }],
      cursor: { visible: false }
    };
    const workflowB = {
      schema: "shellx-motion/browser-workflow@1" as const,
      networkPolicy: "blocked-unless-declared" as const,
      steps: [{ action: "wait" as const, ms: 15 }],
      cursor: { visible: false }
    };
    const firstCalls: FfmpegCommand[] = [];
    const secondCalls: FfmpegCommand[] = [];
    const workflowRequests: unknown[] = [];
    const firstRunner: FfmpegRunner = async (command) => {
      firstCalls.push(command);
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      }
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, "first batch output", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const secondRunner: FfmpegRunner = async (command) => {
      secondCalls.push(command);
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      }
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, "second batch output", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const frameRenderer = async (pkg: any, options: any) => {
      const framePath = options.outputPath ?? join(options.outDir, "frame.png");
      const workflowHash = hashBuffer(Buffer.from(JSON.stringify(options.workflow ?? null), "utf8"));
      const workflowSummary = {
        schema: options.workflow.schema,
        networkPolicy: options.workflow.networkPolicy ?? "blocked-unless-declared",
        stepCount: options.workflow.steps.length,
        steps: options.workflow.steps.map((step: Record<string, unknown>) => ({ ...step })),
        cursor: { visible: false, pointCount: 0 }
      };
      workflowRequests.push(options.workflow ?? null);
      await mkdir(dirname(framePath), { recursive: true });
      await writeFile(framePath, CONTRAST_PNG);
      return {
        ok: true as const,
        output: {
          path: framePath,
          sha256: `${String(workflowRequests.length).padStart(64, "0")}`,
          width: pkg.motion.width,
          height: pkg.motion.height,
          atMs: options.atMs,
          browser: { name: "chromium", version: "test" },
          viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 },
          workflow: workflowSummary,
          workflowTrace: { schema: "shellx-motion/browser-workflow-trace@1" as const, workflowHash, stepCount: options.workflow.steps.length, steps: [] }
        },
        receipt: {
          schema: "shellx-motion/receipt@1" as const,
          id: `browser-preview-resume-workflow-${workflowRequests.length}`,
          operation: "preview.frame",
          status: "passed" as const,
          packageId: pkg.manifest.id,
          inputHashes: { motion: "d".repeat(64), workflow: workflowHash },
          createdAt: "2026-07-01T00:00:00.000Z",
          lane: "browser",
          output: {
            path: framePath,
            workflow: workflowSummary,
            workflowTrace: { workflowHash, stepCount: options.workflow.steps.length }
          },
          warnings: []
        }
      };
    };

    try {
      const first = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir,
          preset: "mp4-h264",
          dryRun: false,
          workflow: workflowA
        },
        { tier: "render_motion", callerId: "test:batch-workflow-resume", ffmpegRunner: firstRunner, browserFrameRenderer: frameRenderer }
      );
      const resumed = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir,
          preset: "mp4-h264",
          dryRun: false,
          resume: true,
          workflow: workflowB
        },
        { tier: "render_motion", callerId: "test:batch-workflow-resume", ffmpegRunner: secondRunner, browserFrameRenderer: frameRenderer }
      );

      expect(first.ok).toBe(true);
      expect(resumed).toMatchObject({ ok: false, error: { code: "derived_output_exists" } });
      expect(secondCalls.filter((call) => call.args.includes("-framerate"))).toHaveLength(0);
      expect(workflowRequests).toHaveLength(48);
      expect(await readFile(join(outDir, "render", "pkg_batch_card_ada.mp4"), "utf8")).toBe("first batch output");
      expect(await readFile(join(outDir, "render", "pkg_batch_card_grace.mp4"), "utf8")).toBe("first batch output");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("runs batch/data quality manifests through the debug API", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-quality-manifest-"));
    const outDir = join(tempRoot, "batch");
    const manifestPath = join(tempRoot, "quality-manifest.json");
    const calls: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      if (command.executable.includes("ffprobe")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_type: "video", codec_name: "h264", width: 960, height: 540, avg_frame_rate: "24/1" }],
            format: { duration: "2.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
          }),
          stderr: ""
        };
      }
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
      }
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
      if (command.args.includes("-frames:v")) {
        await writeFile(outputPath, CONTRAST_PNG);
      } else {
        await writeFile(outputPath, `fake ${basename(outputPath)}`, "utf8");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      await writeFile(
        manifestPath,
        `${JSON.stringify({
          schema: "shellx-motion/quality-manifest@1",
          samples: [
            { id: "{{rowId}} sample", atMs: 500, minBrightPixels: 1, minEdgePixels: 0, maxChangedPixels: 0, maxMeanDiff: 0 }
          ]
        }, null, 2)}\n`,
        "utf8"
      );

      const result = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir,
          preset: "mp4-h264",
          dryRun: false,
          qualityManifestPath: manifestPath
        },
        {
          tier: "render_motion",
          scratchRoot: tempRoot,
          ffmpegRunner: runner,
          browserFrameRenderer: async (pkg, options) => {
            const framePath = options.outputPath ?? join(options.outDir, "frame.png");
            await mkdir(dirname(framePath), { recursive: true, mode: 0o700 });
            await writeFile(framePath, CONTRAST_PNG);
            return {
              ok: true,
              output: {
                path: framePath,
                sha256: "f".repeat(64),
                width: pkg.motion.width,
                height: pkg.motion.height,
                atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: `browser-preview-${pkg.manifest.id}-${options.atMs}`,
                operation: "preview.frame",
                status: "passed",
                packageId: pkg.manifest.id,
                inputHashes: { motion: "d".repeat(64) },
                createdAt: "2026-07-01T00:00:00.000Z",
                lane: "browser",
                output: { path: framePath },
                warnings: []
              }
            };
          }
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const qualityJobs = (result.result as { jobs: Array<Record<string, unknown>> }).jobs;
        const [adaAppliedPath, graceAppliedPath] = qualityJobs.map((job) => String(job.qualityManifestAppliedPath));
        const batchReceiptPath = join(outDir, "receipts", "batch-render.receipt.json");
        const adaApplied = JSON.parse(await readFile(adaAppliedPath, "utf8"));
        const graceApplied = JSON.parse(await readFile(graceAppliedPath, "utf8"));
        const batchReceipt = JSON.parse(await readFile(batchReceiptPath, "utf8"));
        expect(adaApplied.samples[0].id).toBe("ada sample");
        expect(graceApplied.samples[0].id).toBe("grace sample");
        expect(result.visibleState).toMatchObject({
          panel: "receipts",
          operation: "render.batch",
          packageId: "pkg_batch_card",
          qualityManifestPath: manifestPath,
          status: BATCH_STATIC_FIXTURE_STATUS
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_batch_card",
          qualityManifestPath: manifestPath,
          jobs: [
            {
              rowId: "ada",
              qualityManifestPath: manifestPath,
              qualityManifestAppliedPath: adaAppliedPath,
              qualityCheck: {
                ok: true,
                manifestPath: adaAppliedPath,
                samples: [
                  { id: "ada sample", framePath: join(outDir, "receipts", "quality", "pkg_batch_card_ada", "pkg_batch_card_ada-ada-sample-frame.png") }
                ]
              }
            },
            {
              rowId: "grace",
              qualityManifestPath: manifestPath,
              qualityManifestAppliedPath: graceAppliedPath,
              qualityCheck: {
                ok: true,
                manifestPath: graceAppliedPath,
                samples: [
                  { id: "grace sample", framePath: join(outDir, "receipts", "quality", "pkg_batch_card_grace", "pkg_batch_card_grace-grace-sample-frame.png") }
                ]
              }
            }
          ],
          receipt: {
            output: {
              qualityManifestPath: manifestPath,
              jobs: [
                { rowId: "ada", qualityManifestAppliedPath: adaAppliedPath, qualityCheck: { status: "passed" } },
                { rowId: "grace", qualityManifestAppliedPath: graceAppliedPath, qualityCheck: { status: "passed" } }
              ]
            }
          }
        });
        expect(batchReceipt).toMatchObject({
          output: {
            qualityManifestPath: manifestPath,
            jobs: [
              { rowId: "ada", qualityManifestAppliedPath: adaAppliedPath, qualityCheck: { status: "passed" } },
              { rowId: "grace", qualityManifestAppliedPath: graceAppliedPath, qualityCheck: { status: "passed" } }
            ]
          }
        });
      }
      const extractedFramePaths = calls
        .filter((call) => call.args.includes("-frames:v"))
        .map((call) => call.args.at(-1));
      // Verify/readback must see the private stages before their verified public publication.
      const mediaReadbacks = calls.filter((call) => call.executable.includes("ffprobe") && call.args.at(-1) !== "-version").map((call) => call.args.at(-1));
      expect(mediaReadbacks).toHaveLength(4);
      const publicationStages = mediaReadbacks.filter((path) => path?.startsWith(`${join(outDir, "render")}/.shellx-motion-final-`) && path.endsWith(".mp4"));
      const snapshots = mediaReadbacks.filter((path) => path?.startsWith(join(tmpdir(), "shellx-motion-ffmpeg-media-")) && path.endsWith(".mp4"));
      expect(publicationStages).toHaveLength(2);
      expect(snapshots).toHaveLength(2);
      expect(new Set(publicationStages).size).toBe(2);
      expect(new Set(snapshots).size).toBe(2);
      const qualityFrames = extractedFramePaths.filter((path) => path?.includes("/receipts/quality/"));
      expect(qualityFrames).toEqual([join(outDir, "receipts", "quality", "pkg_batch_card_ada", "pkg_batch_card_ada-ada-sample-frame.png"), join(outDir, "receipts", "quality", "pkg_batch_card_grace", "pkg_batch_card_grace-grace-sample-frame.png")]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs batch/data quality manifests against PNG still-frame outputs without invoking FFmpeg", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-png-frame-quality-manifest-"));
    const outDir = join(tempRoot, "batch");
    const manifestPath = join(tempRoot, "quality-manifest.json");
    const calls: FfmpegCommand[] = [];
    const framePaths: string[] = [];
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      return { exitCode: 1, stdout: "", stderr: "ffmpeg should not be needed for PNG still-frame quality manifests" };
    };

    try {
      await writeFile(
        manifestPath,
        `${JSON.stringify({
          schema: "shellx-motion/quality-manifest@1",
          samples: [
            { id: "{{rowId}} still", atMs: 0, minBrightPixels: 0, minEdgePixels: 1, maxChangedPixels: 0, maxMeanDiff: 0 }
          ]
        }, null, 2)}\n`,
        "utf8"
      );

      const result = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir,
          preset: "png-frame",
          dryRun: false,
          qualityManifestPath: manifestPath
        },
        {
          tier: "render_motion",
          scratchRoot: tempRoot,
          ffmpegRunner: runner,
          browserFrameRenderer: async (pkg, options) => {
            const framePath = options.outputPath ?? join(options.outDir, "frame.png");
            framePaths.push(framePath);
            await mkdir(dirname(framePath), { recursive: true, mode: 0o700 });
            await writeFile(framePath, CONTRAST_PNG);
            return {
              ok: true,
              output: {
                path: framePath,
                sha256: `${String(framePaths.length).padStart(64, "0")}`,
                width: pkg.motion.width,
                height: pkg.motion.height,
                atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: `browser-preview-still-quality-${framePaths.length}`,
                operation: "preview.frame",
                status: "passed",
                packageId: pkg.manifest.id,
                inputHashes: { motion: "d".repeat(64) },
                createdAt: "2026-07-01T00:00:00.000Z",
                lane: "browser",
                output: { path: framePath },
                warnings: []
              }
            };
          }
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const adaOutputPath = join(outDir, "render", "pkg_batch_card_ada.png");
        const graceOutputPath = join(outDir, "render", "pkg_batch_card_grace.png");
        const qualityJobs = (result.result as { jobs: Array<Record<string, unknown>> }).jobs;
        const [adaAppliedPath, graceAppliedPath] = qualityJobs.map((job) => String(job.qualityManifestAppliedPath));
        const batchReceipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_batch_card",
          preset: "png-frame",
          qualityManifestPath: manifestPath,
          jobs: [
            {
              rowId: "ada",
              outputPath: adaOutputPath,
              qualityManifestAppliedPath: adaAppliedPath,
              qualityCheck: {
                ok: true,
                inputPath: adaOutputPath,
                manifestPath: adaAppliedPath,
                samples: [{ id: "ada still", atMs: 0, framePath: adaOutputPath }]
              }
            },
            {
              rowId: "grace",
              outputPath: graceOutputPath,
              qualityManifestAppliedPath: graceAppliedPath,
              qualityCheck: {
                ok: true,
                inputPath: graceOutputPath,
                manifestPath: graceAppliedPath,
                samples: [{ id: "grace still", atMs: 0, framePath: graceOutputPath }]
              }
            }
          ]
        });
        expect(batchReceipt).toMatchObject({
          output: {
            preset: "png-frame",
            qualityManifestPath: manifestPath,
            jobs: [
              { rowId: "ada", outputPath: adaOutputPath, qualityManifestAppliedPath: adaAppliedPath, qualityCheck: { status: "passed" } },
              { rowId: "grace", outputPath: graceOutputPath, qualityManifestAppliedPath: graceAppliedPath, qualityCheck: { status: "passed" } }
            ]
          }
        });
      }
      expect(framePaths).toHaveLength(2); expect(framePaths.every((path) => path.startsWith(`${join(outDir, "render")}/.shellx-motion-final-`) && path.endsWith(".png"))).toBe(true);
      expect(calls).toHaveLength(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs batch/data quality manifests against PNG sequence sample frames without invoking FFmpeg", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-png-sequence-quality-manifest-"));
    const outDir = join(tempRoot, "batch");
    const manifestPath = join(tempRoot, "quality-manifest.json");
    const calls: FfmpegCommand[] = [];
    const framePaths: string[] = [];
    const runner: FfmpegRunner = async (command) => {
      calls.push(command);
      return { exitCode: 1, stdout: "", stderr: "ffmpeg should not be needed for PNG sequence quality manifests" };
    };

    try {
      await writeFile(
        manifestPath,
        `${JSON.stringify({
          schema: "shellx-motion/quality-manifest@1",
          samples: [
            { id: "{{rowId}} mid", atMs: 100, minBrightPixels: 1, minEdgePixels: 0, maxChangedPixels: 0, maxMeanDiff: 0 }
          ]
        }, null, 2)}\n`,
        "utf8"
      );

      const result = await dispatchDebugCommand(
        "motion.render.batch",
        {
          packageRoot: "../../fixtures/packages/batch-card",
          outDir,
          preset: "png-sequence",
          dryRun: false,
          qualityManifestPath: manifestPath
        },
        {
          tier: "render_motion",
          scratchRoot: tempRoot,
          ffmpegRunner: runner,
          browserFrameRenderer: async (pkg, options) => {
            const framePath = options.outputPath ?? join(options.outDir, "frame.png");
            framePaths.push(framePath);
            await mkdir(dirname(framePath), { recursive: true, mode: 0o700 });
            await writeFile(framePath, CONTRAST_PNG);
            return {
              ok: true,
              output: {
                path: framePath,
                sha256: `${String(framePaths.length).padStart(64, "0")}`,
                width: pkg.motion.width,
                height: pkg.motion.height,
                atMs: options.atMs,
                browser: { name: "chromium", version: "test" },
                viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
              },
              receipt: {
                schema: "shellx-motion/receipt@1",
                id: `browser-preview-sequence-quality-${framePaths.length}`,
                operation: "preview.frame",
                status: "passed",
                packageId: pkg.manifest.id,
                inputHashes: { motion: "d".repeat(64) },
                createdAt: "2026-07-01T00:00:00.000Z",
                lane: "browser",
                output: { path: framePath },
                warnings: []
              }
            };
          }
        }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const adaOutputPath = join(outDir, "render", "pkg_batch_card_ada");
        const graceOutputPath = join(outDir, "render", "pkg_batch_card_grace");
        const adaSampleFrame = join(adaOutputPath, "000002.png");
        const graceSampleFrame = join(graceOutputPath, "000002.png");
        const qualityJobs = (result.result as { jobs: Array<Record<string, unknown>> }).jobs;
        const [adaAppliedPath, graceAppliedPath] = qualityJobs.map((job) => String(job.qualityManifestAppliedPath));
        const batchReceipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8")) as Record<string, any>;
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_batch_card",
          preset: "png-sequence",
          qualityManifestPath: manifestPath,
          jobs: [
            {
              rowId: "ada",
              outputPath: adaOutputPath,
              qualityManifestAppliedPath: adaAppliedPath,
              qualityCheck: {
                ok: true,
                inputPath: adaOutputPath,
                manifestPath: adaAppliedPath,
                samples: [{ id: "ada mid", atMs: 100, framePath: adaSampleFrame }]
              }
            },
            {
              rowId: "grace",
              outputPath: graceOutputPath,
              qualityManifestAppliedPath: graceAppliedPath,
              qualityCheck: {
                ok: true,
                inputPath: graceOutputPath,
                manifestPath: graceAppliedPath,
                samples: [{ id: "grace mid", atMs: 100, framePath: graceSampleFrame }]
              }
            }
          ]
        });
        expect(batchReceipt).toMatchObject({
          output: {
            preset: "png-sequence",
            qualityManifestPath: manifestPath,
            jobs: [
              { rowId: "ada", outputPath: adaOutputPath, qualityManifestAppliedPath: adaAppliedPath, qualityCheck: { status: "passed" } },
              { rowId: "grace", outputPath: graceOutputPath, qualityManifestAppliedPath: graceAppliedPath, qualityCheck: { status: "passed" } }
            ]
          }
        });
      }
      expect(framePaths.filter((path) => path.endsWith("/000002.png") && path.includes("/.shellx-motion-final-")).length).toBe(2);
      expect(calls).toHaveLength(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("refuses real batch/data renders into non-empty output directories", async () => {
    const packageRoot = await writeDebugPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-non-empty-"));
    const sentinelPath = join(outDir, "keep.txt");
    try {
      await writeFile(join(packageRoot, "data.json"), `${JSON.stringify([{ id: "one" }])}\n`, "utf8");
      const manifestPath = join(packageRoot, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.data = { rows: "data.json" };
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await writeFile(sentinelPath, "do not delete", "utf8");

      const result = await dispatchDebugCommand(
        "motion.render.batch",
        { packageRoot, outDir, preset: "mp4-h264", dryRun: false },
        { tier: "render_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalid_args");
        expect(result.error.message).toBe("motion.render.batch outDir must be empty or absent before render.");
      }
      expect(await readFile(sentinelPath, "utf8")).toBe("do not delete");
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("refuses batch/data renders below render permission", async () => {
    const result = await dispatchDebugCommand(
      "motion.render.batch",
      { packageRoot: "../../fixtures/packages/batch-card", outDir: "../../.scratch/debug-batch-webm", preset: "webm-vp9" },
      { tier: "draft_motion" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("permission_denied");
      expect(result.error.message).toBe("motion.render.batch requires render_motion; this session holds draft_motion.");
    }
  });

  it("lists TemplateIR controls through the debug API", async () => {
    const result = await dispatchDebugCommand(
      "motion.template.controls",
      { packageRoot: "../../fixtures/packages/editable-lower-third" },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({
        ok: true,
        packageId: "pkg_editable_lower_third",
        templateId: "template_editable_lower_third",
        compatibleHosts: ["shellx-motion", "shellx-canvas", "shellx-cut"],
        params: expect.arrayContaining([
          expect.objectContaining({ id: "title", type: "text" }),
          expect.objectContaining({ id: "accentColor", type: "color" })
        ])
      });
    }
  });

  it("summarizes TemplateIR controls into a panel-ready inspector", async () => {
    const result = await dispatchDebugCommand(
      "motion.template.panel",
      { packageRoot: "../../fixtures/packages/editable-lower-third" },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.receiptId).toMatch(/^template-panel-pkg_editable_lower_third-/);
      expect(result.visibleState).toEqual({
        panel: "templateInspector",
        operation: "template.panel",
        packageId: "pkg_editable_lower_third",
        templateId: "template_editable_lower_third",
        groupCount: 2,
        paramCount: 4,
        controlCount: 4,
        bindingCount: 4,
        mediaParamCount: 0
      });
      expect(result.result).toMatchObject({
        ok: true,
        packageId: "pkg_editable_lower_third",
        templateId: "template_editable_lower_third",
        templateName: "Editable Lower Third",
        motionId: "motion_editable_lower_third",
        compatibleHosts: ["shellx-motion", "shellx-canvas", "shellx-cut"],
        compatibleLanes: ["native", "browser", "ffmpeg"],
        controlTypes: { text: 2, color: 1, number: 1 },
        groups: [
          expect.objectContaining({ id: "content", label: "Content", paramIds: ["title", "subtitle"], controlCount: 2 }),
          expect.objectContaining({ id: "style", label: "Style", paramIds: ["accentColor", "titleScale"], controlCount: 2 })
        ],
        controls: expect.arrayContaining([
          expect.objectContaining({
            paramId: "title",
            label: "Title",
            type: "text",
            widget: "text",
            groupId: "content",
            defaultValue: "Anna Valdez",
            currentValue: "Anna Valdez",
            bindingPaths: ["/layers/0/text"],
            layerIds: ["title"],
            bindingCount: 1
          }),
          expect.objectContaining({
            paramId: "titleScale",
            type: "number",
            widget: "slider",
            currentValue: 1,
            min: 0.75,
            max: 1.5,
            step: 0.05
          })
        ]),
        suggestedActions: [
          { id: "controls", command: "motion.template.controls", args: { packageRoot: expect.stringContaining("editable-lower-third") } },
          { id: "apply", command: "motion.template.apply", args: { packageRoot: expect.stringContaining("editable-lower-third") } },
          {
            id: "sendToCut",
            command: "motion.connector.template_to_cut",
            args: {
              packageRoot: expect.stringContaining("editable-lower-third"),
              outDir: expect.stringContaining("editable-lower-third-template-to-cut"),
              values: {
                title: "Anna Valdez",
                subtitle: "Product Lead",
                accentColor: "#13d3ff",
                titleScale: 1
              }
            }
          }
        ]
      });
    }
  });

  it("summarizes media TemplateIR controls into a panel-ready inspector", async () => {
    const packageRoot = await writeDebugTemplateMediaPackage();
    try {
      const result = await dispatchDebugCommand(
        "motion.template.panel",
        { packageRoot },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toMatchObject({
          panel: "templateInspector",
          operation: "template.panel",
          packageId: "pkg_debug_template_media",
          templateId: "template_debug_template_media",
          groupCount: 1,
          paramCount: 1,
          controlCount: 1,
          bindingCount: 2,
          mediaParamCount: 1
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_template_media",
          templateId: "template_debug_template_media",
          controlTypes: { media: 1 },
          groups: [expect.objectContaining({ id: "media", label: "Media", paramIds: ["headshot"], controlCount: 1 })],
          controls: [
            expect.objectContaining({
              paramId: "headshot",
              type: "media",
              widget: "media",
              media: true,
              currentValue: "assets/default-headshot.png",
              currentValueFound: true,
              bindingCount: 2,
              bindingPaths: ["/layers/0/source", "/layers/0/assetRef"],
              layerIds: ["headshot"]
            })
          ],
          suggestedActions: [
            { id: "controls", command: "motion.template.controls", args: { packageRoot } },
            { id: "apply", command: "motion.template.apply", args: { packageRoot } },
            { id: "mediaReplace", command: "motion.template.media.replace", args: { packageRoot } },
            {
              id: "sendToCut",
              command: "motion.connector.template_to_cut",
              args: {
                packageRoot,
                outDir: expect.stringContaining("debug-template-media-template-to-cut"),
                values: { headshot: "assets/default-headshot.png" }
              }
            }
          ],
          warnings: []
        });
        expect(result.warnings).toEqual([]);
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("warns about unreadable template panel bindings without failing", async () => {
    const packageRoot = await writeDebugTemplateMediaPackage();
    try {
      const templatePath = join(packageRoot, "template.json");
      const template = JSON.parse(await readFile(templatePath, "utf8")) as Record<string, any>;
      template.bindings = [
        { paramId: "headshot", target: { kind: "motion_path", path: "/layers/0/__proto__", layerId: "headshot" } },
        ...(template.bindings as unknown[]),
        { paramId: "headshot", target: { kind: "motion_path", path: "/layers/9/source", layerId: "missing" } }
      ];
      await writeFile(templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");

      const result = await dispatchDebugCommand(
        "motion.template.panel",
        { packageRoot },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          mediaParamCount: 1,
          controls: [
            expect.objectContaining({
              paramId: "headshot",
              currentValue: "assets/default-headshot.png",
              currentValueFound: true,
              bindingCount: 4,
              bindingPaths: ["/layers/0/__proto__", "/layers/0/source", "/layers/0/assetRef", "/layers/9/source"]
            })
          ]
        });
        expect(result.warnings).toEqual([
          expect.stringContaining("Template binding headshot target /layers/0/__proto__ was not read"),
          expect.stringContaining("Template binding headshot target /layers/9/source was not read")
        ]);
        expect(result.result).toMatchObject({ warnings: result.warnings });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("lists template catalog cards through the debug API", async () => {
    const result = await dispatchDebugCommand(
      "motion.template.catalog",
      { templateRoot: "../../fixtures/packages" },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visibleState).toEqual({
        panel: "templates",
        operation: "template.catalog",
        templateCount: 2,
        packageCount: 2,
        controlCount: 6
      });
      expect(result.result).toMatchObject({
        ok: true,
        templateCount: 2,
        packageCount: 2,
        templates: expect.arrayContaining([
          expect.objectContaining({
            packageId: "pkg_editable_lower_third",
            packageName: "Editable Lower Third",
            templateId: "template_editable_lower_third",
            templateName: "Editable Lower Third",
            compatibleHosts: ["shellx-motion", "shellx-canvas", "shellx-cut"],
            compatibleLanes: ["native", "browser", "ffmpeg"],
            controlCount: 4,
            paramCount: 4,
            controlTypes: { text: 2, color: 1, number: 1 },
            suggestedActions: [
              { id: "controls", command: "motion.template.controls", args: { packageRoot: expect.stringContaining("editable-lower-third") } },
              { id: "apply", command: "motion.template.apply", args: { packageRoot: expect.stringContaining("editable-lower-third") } },
              {
                id: "sendToCut",
                command: "motion.connector.template_to_cut",
                args: {
                  packageRoot: expect.stringContaining("editable-lower-third"),
                  outDir: expect.stringContaining("editable-lower-third-template-to-cut"),
                  values: {
                    title: "Anna Valdez",
                    subtitle: "Product Lead",
                    accentColor: "#13d3ff",
                    titleScale: 1
                  }
                }
              }
            ]
          })
        ])
      });
    }
  });

  it.skipIf(!productFamilyPresent("tutorial-overlay"))("catalogs the ShellX product starter pack with family and requirement filters", async () => {
    const result = await dispatchDebugCommand(
      "motion.template.catalog",
      {
        templateRoot: "../../templates/shellx-product-pack",
        targetHost: "shellx-motion",
        targetLane: "browser",
        aspectRatio: "16:9",
        targetCommercialUse: true,
        designFamily: "tutorial-overlay",
        requiresMedia: true,
        renderCost: "medium"
      },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visibleState).toMatchObject({
        panel: "templates",
        operation: "template.catalog",
        // Consolidated ShellX product pack holds 15 template families after the
        //  typed-compositing-graph merge added 4 footage-rich families
        // (cinematic-fog-title, editorial-liquid-surface, keyed-subject-promo,
        // tracked-callout-overlay). filteredTemplateCount is 2 because the new
        // tracked-callout-overlay derives the "tutorial-overlay" design family
        // (name contains "overlay") and passes all 6 requirement filters.
        templateCount: 15,
        packageCount: 15,
        compatibleTemplateCount: 15,
        filterCount: 6,
        filteredTemplateCount: 2,
        targetHost: "shellx-motion",
        targetLane: "browser"
      });
      expect(result.result).toMatchObject({
        ok: true,
        filters: {
          host: "shellx-motion",
          aspectRatio: "16:9",
          commercialUse: true,
          designFamily: "tutorial-overlay",
          requiresMedia: true,
          renderCost: "medium"
        },
        // After the  consolidation added tracked-callout-overlay, TWO
        // templates match the tutorial-overlay family for this query and tie on
        // score (both pass all 6 filters at filterFit.score 100 with an equivalent
        // targetFit). tracked-callout-overlay is only in the family because the
        // templateDesignFamilies regex matched the token "overlay" in its name,
        // whereas tutorial-overlay is an EXACT member (its name and a bestFor hint
        // literally spell out "tutorial overlay"). The family-ranking rule makes
        // the catalog sort rank exact membership
        // above regex-derived membership before the alphabetical templateName
        // tiebreak, so the recommendation is tutorial-overlay. Every other asserted
        // quality attribute below (rights, performance, filterFit, requirements) is
        // identical for both candidates -- only the package identity differs.
        recommendedTemplate: expect.objectContaining({
          packageId: "pkg_shellx_tutorial_overlay",
          templateId: "template_shellx_tutorial_overlay",
          preview: { poster: "preview/poster.png", thumbnail: "preview/poster.png" },
          requirements: expect.objectContaining({
            media: true,
            mediaSlotCount: 1,
            audio: false
          }),
          designFamilies: expect.arrayContaining(["tutorial-overlay"]),
          rights: expect.objectContaining({
            status: "ready",
            commercialUse: true,
            redistributionAllowed: true,
            attributionRequired: false
          }),
          performance: expect.objectContaining({
            status: "known",
            recommendedLane: "browser",
            renderCost: "medium",
            targetLaneMatchesRecommendation: true
          }),
          filterFit: expect.objectContaining({
            ok: true,
            unmatched: [],
            matched: expect.arrayContaining(["host", "aspectRatio", "commercialUse", "designFamily", "requiresMedia", "renderCost"])
          })
        }),
        templates: expect.arrayContaining([
          expect.objectContaining({ packageId: "pkg_shellx_launch_bumper", designFamilies: expect.arrayContaining(["saas-launch"]) }),
          expect.objectContaining({ packageId: "pkg_shellx_feature_announcement", designFamilies: expect.arrayContaining(["saas-launch"]) }),
          expect.objectContaining({ packageId: "pkg_shellx_lower_third_modern", designFamilies: expect.arrayContaining(["lower-third"]) }),
          expect.objectContaining({ packageId: "pkg_shellx_social_stat_card", designFamilies: expect.arrayContaining(["data-report", "social"]) }),
          expect.objectContaining({ packageId: "pkg_shellx_data_report_brief", designFamilies: expect.arrayContaining(["data-report"]) }),
          expect.objectContaining({ packageId: "pkg_shellx_kinetic_type", designFamilies: expect.arrayContaining(["kinetic-type"]) }),
          expect.objectContaining({ packageId: "pkg_shellx_media_launch", designFamilies: expect.arrayContaining(["media-rich"]) }),
          expect.objectContaining({ packageId: "pkg_shellx_audio_launch", designFamilies: expect.arrayContaining(["audio-backed"]) }),
          expect.objectContaining({ packageId: "pkg_shellx_product_metric_card", designFamilies: expect.arrayContaining(["data-report"]) }),
          expect.objectContaining({ packageId: "pkg_shellx_tutorial_overlay", designFamilies: expect.arrayContaining(["tutorial-overlay"]) }),
          expect.objectContaining({
            packageId: "pkg_shellx_cinematic_rain_launch",
            requirements: expect.objectContaining({ media: true, mediaSlotCount: 1 }),
            metadata: expect.objectContaining({
              story: expect.objectContaining({ kind: "cinematic-product-promo" }),
              qualityTargets: expect.objectContaining({ representativeFramesMs: [300, 1500, 3200, 5200] })
            })
          })
        ])
      });
    }
  });

  it.skipIf(!productFamilyPresent("tutorial-overlay"))("ranks exact design-family membership above regex-derived membership in recommendations", async () => {
    // Exact design-family membership must rank above regex-derived membership.
    // "tutorial-overlay" is an EXACT member of the tutorial-overlay family -- its
    // name and a bestFor hint literally spell out "tutorial overlay".
    // "tracked-callout-overlay" is only in that family because the design-family
    // regex matched the token "overlay" in its name (regex-derived membership).
    //
    // Phase 1 -- genuine tie: on this query both templates pass every filter and
    // target check (filterFit.score 100, equivalent targetFit), so the ONLY
    // differentiator is exact-vs-derived membership. The exact member must win,
    // even though the alphabetical templateName tiebreak would otherwise pick
    // "ShellX Tracked Callout Overlay" (< "ShellX Tutorial Overlay").
    const tie = await dispatchDebugCommand(
      "motion.template.catalog",
      {
        templateRoot: "../../templates/shellx-product-pack",
        targetHost: "shellx-motion",
        targetLane: "browser",
        aspectRatio: "16:9",
        targetCommercialUse: true,
        designFamily: "tutorial-overlay",
        requiresMedia: true,
        renderCost: "medium"
      },
      { tier: "read_motion" }
    );
    expect(tie.ok).toBe(true);
    if (tie.ok) {
      const catalog = debugTestRecord(tie.result);
      expect(debugTestRecord(catalog.recommendedTemplate).packageId).toBe("pkg_shellx_tutorial_overlay");

      const cards = debugTestRecordArray(catalog.templates);
      const exactCard = cards.find((card) => card.packageId === "pkg_shellx_tutorial_overlay");
      const derivedCard = cards.find((card) => card.packageId === "pkg_shellx_tracked_callout_overlay");
      expect(exactCard).toBeDefined();
      expect(derivedCard).toBeDefined();
      if (exactCard && derivedCard) {
        // Prove the win was NOT a score difference: both score a perfect filter fit
        // and an identical target fit, so this was a real tie broken by exactness.
        const exactFilterFit = debugTestRecord(exactCard.filterFit);
        const derivedFilterFit = debugTestRecord(derivedCard.filterFit);
        expect(exactFilterFit.ok).toBe(true);
        expect(derivedFilterFit.ok).toBe(true);
        expect(exactFilterFit.score).toBe(100);
        expect(derivedFilterFit.score).toBe(100);
        expect(debugTestRecord(exactCard.targetFit).score).toBe(100);
        expect(debugTestRecord(derivedCard.targetFit).score).toBe(100);
        // The exact/derived split that drove the tiebreak is observable on the cards:
        // both list "tutorial-overlay" for browsing, but only the exact member marks
        // it exact.
        expect(exactCard.designFamilies).toContain("tutorial-overlay");
        expect(exactCard.designFamiliesExact).toContain("tutorial-overlay");
        expect(derivedCard.designFamilies).toContain("tutorial-overlay");
        expect(derivedCard.designFamiliesExact).not.toContain("tutorial-overlay");
      }
    }

    // Phase 2 -- NOT a tie: exactness must never rescue an exact member that is
    // genuinely worse on real scoring criteria. tutorial-overlay does not support
    // 9:16 (outputBounds lists only 16:9 and 1:1) while the regex-derived
    // tracked-callout-overlay does. On a 9:16 query the exact member fails the
    // aspect-ratio check, so the derived member -- which scores strictly higher --
    // is recommended. (lower-third-modern is also a regex-derived family member but
    // likewise lacks 9:16, so it too drops out.)
    const notTie = await dispatchDebugCommand(
      "motion.template.catalog",
      {
        templateRoot: "../../templates/shellx-product-pack",
        targetHost: "shellx-motion",
        targetLane: "browser",
        aspectRatio: "9:16",
        designFamily: "tutorial-overlay"
      },
      { tier: "read_motion" }
    );
    expect(notTie.ok).toBe(true);
    if (notTie.ok) {
      const catalog = debugTestRecord(notTie.result);
      expect(debugTestRecord(catalog.recommendedTemplate).packageId).toBe("pkg_shellx_tracked_callout_overlay");

      const cards = debugTestRecordArray(catalog.templates);
      const exactCard = cards.find((card) => card.packageId === "pkg_shellx_tutorial_overlay");
      expect(exactCard).toBeDefined();
      if (exactCard) {
        // Still an exact family member -- exactness did not change; it simply lost
        // because it is genuinely worse (a failed, non-tied aspect-ratio check).
        expect(exactCard.designFamiliesExact).toContain("tutorial-overlay");
        const filterFit = debugTestRecord(exactCard.filterFit);
        expect(filterFit.ok).toBe(false);
        expect(filterFit.unmatched).toContain("aspectRatio");
      }
    }
  });

  it("scores template catalog cards against host and render-lane targets", async () => {
    const result = await dispatchDebugCommand(
      "motion.template.catalog",
      {
        templateRoot: "../../fixtures/packages",
        targetHost: "shellx-cut",
        targetLane: "browser",
        aspectRatio: "16:9",
        durationMs: 2400
      },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visibleState).toMatchObject({
        panel: "templates",
        operation: "template.catalog",
        templateCount: 2,
        compatibleTemplateCount: 2,
        targetHost: "shellx-cut",
        targetLane: "browser"
      });
      expect(result.result).toMatchObject({
        ok: true,
        target: {
          host: "shellx-cut",
          lane: "browser",
          aspectRatio: "16:9",
          durationMs: 2400
        },
        compatibleTemplateCount: 2,
        recommendedTemplate: expect.objectContaining({
          packageId: "pkg_editable_lower_third",
          templateId: "template_editable_lower_third",
          metadata: expect.objectContaining({
            suitability: expect.objectContaining({
              bestFor: expect.arrayContaining(["Cut Generate intros"]),
              notFor: expect.arrayContaining(["long-form end cards"])
            })
          }),
          performance: {
            status: "known",
            recommendedLane: "browser",
            renderCost: "medium",
            previewFps: 30,
            notes: ["Uses text and shape layers only."],
            targetLaneMatchesRecommendation: true,
            reasons: [
              "recommended lane browser",
              "render cost medium",
              "preview fps 30",
              "target lane browser matches recommended lane"
            ]
          },
          targetFit: {
            ok: true,
            score: 100,
            matched: ["host", "lane", "aspectRatio", "duration"],
            unmatched: [],
            reasons: [
              "host shellx-cut supported",
              "lane browser supported",
              "aspect ratio 16:9 supported",
              "duration 2400ms within bounds"
            ]
          }
        }),
        templates: expect.arrayContaining([
          expect.objectContaining({
            templateId: "template_editable_lower_third",
            targetFit: {
              ok: true,
              score: 100,
              matched: ["host", "lane", "aspectRatio", "duration"],
              unmatched: [],
              reasons: [
                "host shellx-cut supported",
                "lane browser supported",
                "aspect ratio 16:9 supported",
                "duration 2400ms within bounds"
              ]
            }
          })
        ])
      });
    }
  });

  it("uses template rights metadata when commercial template output is required", async () => {
    const templatesRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-template-rights-"));
    const personalRoot = join(templatesRoot, "personal-template");
    const commercialRoot = join(templatesRoot, "commercial-template");
    await writeDebugSuitabilityTemplatePackage(personalRoot, {
      packageId: "pkg_personal_template",
      templateId: "template_personal_template",
      name: "Personal Template",
      title: "Personal use only",
      bestFor: ["product demos"],
      notFor: [],
      license: {
        id: "CC-BY-NC-4.0",
        label: "Creative Commons BY-NC 4.0",
        url: "https://creativecommons.org/licenses/by-nc/4.0/",
        attribution: "Fixture author",
        attributionRequired: true,
        redistributionAllowed: true,
        commercialUse: false,
        notes: "Non-commercial demo only."
      }
    });
    await writeDebugSuitabilityTemplatePackage(commercialRoot, {
      packageId: "pkg_commercial_template",
      templateId: "template_commercial_template",
      name: "Commercial Template",
      title: "Commercial-ready",
      bestFor: ["product demos"],
      notFor: [],
      license: {
        id: "Apache-2.0",
        spdxId: "Apache-2.0",
        attributionRequired: false,
        redistributionAllowed: true,
        commercialUse: true
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
      inputExamples: [
        {
          title: "Commercial-ready"
        }
      ]
    });

    try {
      const result = await dispatchDebugCommand(
        "motion.template.catalog",
        {
          templateRoot: templatesRoot,
          request: "Create a product demo",
          targetHost: "shellx-cut",
          targetLane: "browser",
          targetCommercialUse: true
        },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.visibleState).toMatchObject({
          panel: "templates",
          operation: "template.catalog",
          templateCount: 2,
          compatibleTemplateCount: 1
        });
        expect(result.result).toMatchObject({
          ok: true,
          target: {
            host: "shellx-cut",
            lane: "browser",
            commercialUse: true
          },
          recommendedTemplate: expect.objectContaining({
            packageId: "pkg_commercial_template",
            metadata: expect.objectContaining({
              inputExamples: [
                {
                  title: "Commercial-ready"
                }
              ],
              preview: {
                poster: "preview/poster.png",
                loop: "preview/loop.mp4",
                thumbnail: "preview/thumb.webp"
              },
              assetsAttribution: [
                {
                  name: "Inter font",
                  license: "SIL-OFL-1.1",
                  author: "Rasmus Andersson",
                  url: "https://rsms.me/inter/",
                  path: "assets/fonts/inter.woff2"
                }
              ]
            }),
            rights: {
              status: "ready",
              licenseId: "Apache-2.0",
              spdxId: "Apache-2.0",
              attributionRequired: false,
              redistributionAllowed: true,
              commercialUse: true,
              reasons: [
                "commercial use declared",
                "redistribution allowed"
              ]
            },
            targetFit: expect.objectContaining({
              ok: true,
              matched: expect.arrayContaining(["commercialUse"])
            })
          }),
          templates: expect.arrayContaining([
            expect.objectContaining({
              packageId: "pkg_personal_template",
              rights: {
                status: "blocked",
                licenseId: "CC-BY-NC-4.0",
                licenseLabel: "Creative Commons BY-NC 4.0",
                licenseUrl: "https://creativecommons.org/licenses/by-nc/4.0/",
                attribution: "Fixture author",
                attributionRequired: true,
                redistributionAllowed: true,
                commercialUse: false,
                notes: "Non-commercial demo only.",
                reasons: [
                  "commercial use disallowed",
                  "attribution required",
                  "redistribution allowed"
                ]
              },
              targetFit: expect.objectContaining({
                ok: false,
                unmatched: expect.arrayContaining(["commercialUse"]),
                reasons: expect.arrayContaining(["commercial use disallowed by template license"])
              })
            })
          ])
        });
      }
    } finally {
      await rm(templatesRoot, { recursive: true, force: true });
    }
  });

  it("plans prompt-to-template application without mutating packages", async () => {
    const result = await dispatchDebugCommand(
      "motion.template.plan",
      {
        templateRoot: "../../fixtures/packages",
        request: "Create a lower third for Cut Generate",
        targetHost: "shellx-cut",
        targetLane: "browser",
        aspectRatio: "16:9",
        durationMs: 2400
      },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visibleState).toMatchObject({
        panel: "templates",
        operation: "template.plan",
        templateCount: 2,
        compatibleTemplateCount: 2,
        selectedTemplateId: "template_editable_lower_third",
        missingRequiredParamCount: 0,
        inputReadinessStatus: "ready-with-defaults",
        reviewRequired: true,
        targetHost: "shellx-cut",
        targetLane: "browser"
      });
      expect(result.result).toMatchObject({
        ok: true,
        request: "Create a lower third for Cut Generate",
        target: {
          host: "shellx-cut",
          lane: "browser",
          aspectRatio: "16:9",
          durationMs: 2400
        },
        selectedTemplate: expect.objectContaining({
          packageId: "pkg_editable_lower_third",
          templateId: "template_editable_lower_third",
          targetFit: expect.objectContaining({ ok: true, score: 100 })
        }),
        values: {
          title: "Anna Valdez",
          subtitle: "Product Lead",
          accentColor: "#13d3ff",
          titleScale: 1
        },
        requiredParams: ["title", "subtitle"],
        missingRequiredParams: [],
        providedValues: {},
        defaultedValues: {
          title: "Anna Valdez",
          subtitle: "Product Lead",
          accentColor: "#13d3ff",
          titleScale: 1
        },
        inputReadiness: {
          status: "ready-with-defaults",
          reviewRequired: true,
          counts: {
            totalParams: 4,
            requiredParams: 2,
            provided: 0,
            defaulted: 4,
            missingRequired: 0,
            optionalMissing: 0
          },
          params: [
            { paramId: "title", required: true, source: "default", value: "Anna Valdez" },
            { paramId: "subtitle", required: true, source: "default", value: "Product Lead" },
            { paramId: "accentColor", required: false, source: "default", value: "#13d3ff" },
            { paramId: "titleScale", required: false, source: "default", value: 1 }
          ]
        },
        suggestedActions: [
          {
            id: "reviewControls",
            command: "motion.template.controls",
            args: { packageRoot: expect.stringContaining("editable-lower-third") }
          },
          {
            id: "apply",
            command: "motion.template.apply",
            args: {
              packageRoot: expect.stringContaining("editable-lower-third"),
              values: {
                title: "Anna Valdez",
                subtitle: "Product Lead",
                accentColor: "#13d3ff",
                titleScale: 1
              }
            }
          },
          expect.objectContaining({
            id: "sendToCut",
            command: "motion.connector.template_to_cut"
          })
        ]
      });
    }
  });

  it("plans a cinematic template through an explicit authoring and review loop", async () => {
    const result = await dispatchDebugCommand(
      "motion.template.plan",
      {
        templateRoot: "../../templates/shellx-product-pack",
        request: "Create a cinematic product launch with a rainy night promo and real video effects",
        targetHost: "shellx-canvas",
        targetLane: "browser",
        aspectRatio: "16:9",
        durationMs: 6000,
        values: {
          title: "Weather becomes part of the story",
          subtitle: "A media-rich local render with scene-aware rain."
        }
      },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visibleState).toMatchObject({
        panel: "templates",
        operation: "template.plan",
        selectedTemplateId: "template_shellx_cinematic_rain_launch",
        targetHost: "shellx-canvas",
        targetLane: "browser"
      });
      expect(result.result).toMatchObject({
        ok: true,
        selectedTemplate: expect.objectContaining({
          packageId: "pkg_shellx_cinematic_rain_launch",
          templateId: "template_shellx_cinematic_rain_launch",
          requestFit: expect.objectContaining({ ok: true, score: 100 })
        }),
        authoringLoop: {
          story: expect.objectContaining({
            kind: "cinematic-product-promo",
            beats: [
              expect.objectContaining({ id: "establish" }),
              expect.objectContaining({ id: "promise" }),
              expect.objectContaining({ id: "resolve" })
            ]
          }),
          mediaSlots: [
            expect.objectContaining({ paramId: "heroMedia", role: "hero-background-scene", acceptedKinds: ["image"] })
          ],
          qualityTargets: expect.objectContaining({
            manifest: "quality/representative-frames.json",
            representativeFramesMs: [300, 1500, 3200, 5200],
            minDistinctFrames: 4,
            maxBlankFrames: 0
          }),
          qualityManifestPath: expect.stringContaining(join("cinematic-rain-launch", "quality", "representative-frames.json")),
          representativeFrames: [
            expect.objectContaining({ atMs: 300, beatIds: ["establish"], command: "motion.preview.frame" }),
            expect.objectContaining({ atMs: 1500, beatIds: ["establish", "promise"], command: "motion.preview.frame" }),
            expect.objectContaining({ atMs: 3200, beatIds: ["promise"], command: "motion.preview.frame" }),
            expect.objectContaining({ atMs: 5200, beatIds: ["resolve"], command: "motion.preview.frame" })
          ],
          gates: expect.arrayContaining([
            { id: "distinctFrames", required: true, threshold: 4 },
            { id: "blankFrames", required: true, threshold: 0 },
            { id: "textFit", required: true },
            { id: "safeAreas", required: true }
          ]),
          sequence: [
            { id: "apply", command: "motion.template.apply" },
            { id: "reviewFrames", command: "motion.preview.frame", after: ["apply"], repeatAtMs: [300, 1500, 3200, 5200] },
            { id: "render", command: "motion.render.final", after: ["reviewFrames"] },
            { id: "quality", command: "motion.quality.check", after: ["render"], inputArtifactRole: "rendered_media" },
            { id: "reviseOnFailure", command: "motion.agent.revision.plan", after: ["quality"], inputArtifactRole: "quality_receipt" },
            { id: "handoffCut", command: "motion.connector.template_to_cut", after: ["quality"] }
          ]
        }
      });
    }
  });

  it("plans prompt-to-template application with provided required inputs", async () => {
    const result = await dispatchDebugCommand(
      "motion.template.plan",
      {
        templateRoot: "../../fixtures/packages",
        request: "Create a lower third for Cut Generate",
        targetHost: "shellx-cut",
        targetLane: "browser",
        values: {
          title: "Dr. Mira Chen",
          subtitle: "Launch Demo"
        }
      },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visibleState).toMatchObject({
        panel: "templates",
        operation: "template.plan",
        selectedTemplateId: "template_editable_lower_third",
        missingRequiredParamCount: 0,
        inputReadinessStatus: "ready",
        reviewRequired: false
      });
      expect(result.result).toMatchObject({
        ok: true,
        values: {
          title: "Dr. Mira Chen",
          subtitle: "Launch Demo",
          accentColor: "#13d3ff",
          titleScale: 1
        },
        providedValues: {
          title: "Dr. Mira Chen",
          subtitle: "Launch Demo"
        },
        defaultedValues: {
          accentColor: "#13d3ff",
          titleScale: 1
        },
        inputReadiness: {
          status: "ready",
          reviewRequired: false,
          counts: {
            totalParams: 4,
            requiredParams: 2,
            provided: 2,
            defaulted: 2,
            missingRequired: 0,
            optionalMissing: 0
          },
          params: [
            { paramId: "title", required: true, source: "provided", value: "Dr. Mira Chen" },
            { paramId: "subtitle", required: true, source: "provided", value: "Launch Demo" },
            { paramId: "accentColor", required: false, source: "default", value: "#13d3ff" },
            { paramId: "titleScale", required: false, source: "default", value: 1 }
          ]
        },
        suggestedActions: expect.arrayContaining([
          expect.objectContaining({
            id: "apply",
            args: expect.objectContaining({
              values: {
                title: "Dr. Mira Chen",
                subtitle: "Launch Demo",
                accentColor: "#13d3ff",
                titleScale: 1
              }
            })
          })
        ])
      });
    }
  });

  it("uses template suitability hints when planning prompt-to-template selection", async () => {
    const templatesRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-template-suitability-"));
    const endCardRoot = join(templatesRoot, "end-card");
    const speakerRoot = join(templatesRoot, "speaker-id");
    await writeDebugSuitabilityTemplatePackage(endCardRoot, {
      packageId: "pkg_end_card",
      templateId: "template_end_card",
      name: "End Card",
      title: "Follow for more",
      bestFor: ["long-form end cards"],
      notFor: ["Cut Generate intros", "speaker IDs"]
    });
    await writeDebugSuitabilityTemplatePackage(speakerRoot, {
      packageId: "pkg_speaker_id",
      templateId: "template_speaker_id",
      name: "Speaker ID",
      title: "Dr. Mira Chen",
      bestFor: ["speaker IDs", "Cut Generate intros"],
      notFor: ["long-form end cards"]
    });

    try {
      const result = await dispatchDebugCommand(
        "motion.template.plan",
        {
          templateRoot: templatesRoot,
          request: "Create a speaker ID intro for Cut Generate",
          targetHost: "shellx-cut",
          targetLane: "browser",
          aspectRatio: "16:9",
          durationMs: 2400
        },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          catalog: {
            templateCount: 2,
            compatibleTemplateCount: 2
          },
          selectedTemplate: expect.objectContaining({
            packageId: "pkg_speaker_id",
            templateId: "template_speaker_id",
            requestFit: {
              ok: true,
              score: 100,
              matchedBestFor: ["speaker IDs", "Cut Generate intros"],
              matchedNotFor: [],
              reasons: [
                "request matches best-for speaker IDs",
                "request matches best-for Cut Generate intros"
              ]
            }
          }),
          values: { title: "Dr. Mira Chen" },
          suggestedActions: expect.arrayContaining([
            expect.objectContaining({
              id: "apply",
              args: expect.objectContaining({ packageRoot: speakerRoot })
            })
          ])
        });
      }
    } finally {
      await rm(templatesRoot, { recursive: true, force: true });
    }
  });

  it("prefers performance-aligned templates when request and target fit tie", async () => {
    const templatesRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-template-performance-"));
    const nativeRoot = join(templatesRoot, "alpha-native-heavy");
    const browserRoot = join(templatesRoot, "zulu-browser-fast");
    await writeDebugSuitabilityTemplatePackage(nativeRoot, {
      packageId: "pkg_native_heavy",
      templateId: "template_native_heavy",
      name: "Alpha Native Heavy",
      title: "Native heavy",
      bestFor: ["product demos"],
      notFor: [],
      performance: {
        recommendedLane: "native",
        renderCost: "high",
        previewFps: 12,
        notes: ["Prefers native previews."]
      }
    });
    await writeDebugSuitabilityTemplatePackage(browserRoot, {
      packageId: "pkg_browser_fast",
      templateId: "template_browser_fast",
      name: "Zulu Browser Fast",
      title: "Browser fast",
      bestFor: ["product demos"],
      notFor: [],
      performance: {
        recommendedLane: "browser",
        renderCost: "low",
        previewFps: 60,
        notes: ["Best for browser capture."]
      }
    });

    try {
      const result = await dispatchDebugCommand(
        "motion.template.plan",
        {
          templateRoot: templatesRoot,
          request: "Create a product demo",
          targetHost: "shellx-cut",
          targetLane: "browser",
          aspectRatio: "16:9",
          durationMs: 2400
        },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          selectedTemplate: expect.objectContaining({
            packageId: "pkg_browser_fast",
            templateId: "template_browser_fast",
            performance: {
              status: "known",
              recommendedLane: "browser",
              renderCost: "low",
              previewFps: 60,
              notes: ["Best for browser capture."],
              targetLaneMatchesRecommendation: true,
              reasons: [
                "recommended lane browser",
                "render cost low",
                "preview fps 60",
                "target lane browser matches recommended lane"
              ]
            },
            requestFit: {
              ok: true,
              score: 50,
              matchedBestFor: ["product demos"],
              matchedNotFor: [],
              reasons: ["request matches best-for product demos"]
            },
            targetFit: expect.objectContaining({
              ok: true,
              score: 100
            })
          })
        });
      }
    } finally {
      await rm(templatesRoot, { recursive: true, force: true });
    }
  });

  it("avoids rights-blocked templates in prompt selection when commercial output is required", async () => {
    const templatesRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-template-commercial-plan-"));
    const personalRoot = join(templatesRoot, "personal-best-match");
    const commercialRoot = join(templatesRoot, "commercial-safe-match");
    await writeDebugSuitabilityTemplatePackage(personalRoot, {
      packageId: "pkg_personal_best_match",
      templateId: "template_personal_best_match",
      name: "Personal Best Match",
      title: "Personal match",
      bestFor: ["product demos", "Cut Generate intros"],
      notFor: [],
      license: {
        id: "CC-BY-NC-4.0",
        attributionRequired: true,
        redistributionAllowed: true,
        commercialUse: false
      }
    });
    await writeDebugSuitabilityTemplatePackage(commercialRoot, {
      packageId: "pkg_commercial_safe_match",
      templateId: "template_commercial_safe_match",
      name: "Commercial Safe Match",
      title: "Commercial match",
      bestFor: ["product demos"],
      notFor: [],
      license: {
        id: "Apache-2.0",
        spdxId: "Apache-2.0",
        attributionRequired: false,
        redistributionAllowed: true,
        commercialUse: true
      }
    });

    try {
      const result = await dispatchDebugCommand(
        "motion.template.plan",
        {
          templateRoot: templatesRoot,
          request: "Create a product demo intro for Cut Generate",
          targetHost: "shellx-cut",
          targetLane: "browser",
          targetCommercialUse: true
        },
        { tier: "read_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toMatchObject({
          ok: true,
          catalog: {
            templateCount: 2,
            compatibleTemplateCount: 1
          },
          selectedTemplate: expect.objectContaining({
            packageId: "pkg_commercial_safe_match",
            templateId: "template_commercial_safe_match",
            rights: expect.objectContaining({
              status: "ready",
              commercialUse: true
            }),
            requestFit: {
              ok: true,
              score: 50,
              matchedBestFor: ["product demos"],
              matchedNotFor: [],
              reasons: ["request matches best-for product demos"]
            },
            targetFit: expect.objectContaining({
              ok: true,
              matched: expect.arrayContaining(["commercialUse"])
            })
          })
        });
      }
    } finally {
      await rm(templatesRoot, { recursive: true, force: true });
    }
  });

  it("refuses TemplateIR apply without an output directory because no receipt evidence can be emitted", async () => {
    const result = await dispatchDebugCommand(
      "motion.template.apply",
      {
        packageRoot: "../../fixtures/packages/editable-lower-third",
        values: {
          title: "Dr. Mira Chen",
          accentColor: "#ff006e",
          titleScale: 1.2
        }
      },
      { tier: "edit_motion" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_args");
      expect(result.error.message).toBe("motion.template.apply requires outDir.");
    }
  });

  it("applies TemplateIR values through the debug API with copied package and receipt evidence", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-template-apply-"));
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await dispatchDebugCommand(
        "motion.template.apply",
        {
          packageRoot: "../../fixtures/packages/editable-lower-third",
          outDir,
          receiptsRoot,
          values: {
            title: "Debug Template",
            accentColor: "#ff006e",
            titleScale: 1.15
          },
          createdBy: "codex-test"
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const patchedMotionPath = join(outDir, "motion.json");
        const receiptPath = join(outDir, "receipts", "template-apply.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const motion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(result.receiptId).toMatch(/^template-apply-/);
        expect(result.visibleState).toEqual({
          panel: "templateInspector",
          operation: "template.apply",
          packageId: "pkg_editable_lower_third",
          templateId: "template_editable_lower_third",
          packageDir: outDir,
          changedParams: ["title", "accentColor", "titleScale"],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_editable_lower_third",
          templateId: "template_editable_lower_third",
          packageDir: outDir,
          manifestPath: join(outDir, "manifest.json"),
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          changedParams: ["title", "accentColor", "titleScale"],
          changedBindings: [
            { paramId: "title", path: "/layers/0/text", oldValue: "Anna Valdez", newValue: "Debug Template" },
            { paramId: "accentColor", path: "/layers/2/fill", oldValue: "#13d3ff", newValue: "#ff006e" },
            { paramId: "titleScale", path: "/layers/0/transform/scale", oldValue: 1, newValue: 1.15 }
          ],
          validation: { ok: true },
          artifacts: expect.arrayContaining([
            expect.objectContaining({ role: "motion_package", path: outDir, status: "available", primary: true }),
            expect.objectContaining({ role: "template_apply_receipt", path: receiptPath, status: "available" })
          ])
        });
        expect(motion.layers[0]).toMatchObject({ id: "title", text: "Debug Template", transform: expect.objectContaining({ scale: 1.15 }) });
        expect(motion.layers[2]).toMatchObject({ id: "accent", fill: "#ff006e" });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "template.apply",
          status: "passed",
          packageId: "pkg_editable_lower_third",
          lane: "template",
          output: {
            packageDir: outDir,
            motionPath: patchedMotionPath,
            changedParams: ["title", "accentColor", "titleScale"],
            changedBindings: expect.arrayContaining([
              { paramId: "title", path: "/layers/0/text", oldValue: "Anna Valdez", newValue: "Debug Template" }
            ]),
            validation: { ok: true },
            createdBy: "codex-test"
          },
          artifacts: expect.arrayContaining([
            expect.objectContaining({ role: "motion_package", path: outDir, status: "available", primary: true }),
            expect.objectContaining({ role: "template_apply_receipt", path: receiptPath, status: "available" })
          ]),
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["template.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes.updates).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("refuses TemplateIR apply output dirs that already contain files", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-template-apply-non-empty-"));
    const sentinelPath = join(outDir, "keep.txt");
    try {
      await writeFile(sentinelPath, "do not delete", "utf8");

      const result = await dispatchDebugCommand(
        "motion.template.apply",
        {
          packageRoot: "../../fixtures/packages/editable-lower-third",
          outDir,
          values: { title: "Unsafe" }
        },
        { tier: "edit_motion" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalid_args");
        expect(result.error.message).toBe("motion.template.apply outDir must be empty or absent before package copy.");
      }
      expect(await readFile(sentinelPath, "utf8")).toBe("do not delete");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("replaces TemplateIR media slots through the debug API with copied asset and receipt evidence", async () => {
    const fixtureRoot = await writeDebugTemplateMediaPackage();
    const testRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-template-media-"));
    const packageRoot = join(testRoot, "package");
    const sourceRoot = join(testRoot, "source");
    const sourceAssetPath = join(sourceRoot, "headshot.png");
    await Promise.all([cp(fixtureRoot, packageRoot, { recursive: true }), mkdir(sourceRoot, { mode: 0o700 })]);
    await writeFile(sourceAssetPath, "replacement image", "utf8");
    const outDir = join(testRoot, "output");
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      const result = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(testRoot), async () => await dispatchDebugCommand(
        "motion.template.media.replace",
        {
          packageRoot,
          outDir,
          receiptsRoot,
          paramId: "headshot",
          assetPath: sourceAssetPath,
          assetRef: "assets/headshot.png",
          createdBy: "codex-test"
        },
        {
          tier: "edit_motion",
          authoringInputRoots: [dirname(packageRoot), sourceRoot],
          authoringOutputRoots: [dirname(outDir)],
        }
      ));

      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        const patchedManifestPath = join(outDir, "manifest.json");
        const patchedMotionPath = join(outDir, "motion.json");
        const copiedAssetPath = join(outDir, "assets", "headshot.png");
        const receiptPath = join(outDir, "receipts", "template-media-replace.receipt.json");
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const manifest = JSON.parse(await readFile(patchedManifestPath, "utf8"));
        const motion = JSON.parse(await readFile(patchedMotionPath, "utf8"));
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));

        expect(await readFile(copiedAssetPath, "utf8")).toBe("replacement image");
        expect(manifest.assets).toEqual(["assets/default-headshot.png", "assets/headshot.png"]);
        expect(motion.layers[0]).toMatchObject({ id: "headshot", source: "assets/headshot.png", assetRef: "assets/headshot.png" });
        expect(result.visibleState).toEqual({
          panel: "templateInspector",
          operation: "template.media.replace",
          packageId: "pkg_debug_template_media",
          templateId: "template_debug_template_media",
          packageDir: outDir,
          paramId: "headshot",
          assetRef: "assets/headshot.png",
          copiedAssetPath,
          changedBindings: [
            { paramId: "headshot", path: "/layers/0/source", oldValue: "assets/default-headshot.png", newValue: "assets/headshot.png" },
            { paramId: "headshot", path: "/layers/0/assetRef", oldValue: "assets/default-headshot.png", newValue: "assets/headshot.png" }
          ],
          receiptPath,
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_debug_template_media",
          templateId: "template_debug_template_media",
          packageDir: outDir,
          manifestPath: patchedManifestPath,
          motionPath: patchedMotionPath,
          receiptPath,
          hostReceiptPath,
          paramId: "headshot",
          assetRef: "assets/headshot.png",
          copiedAssetPath,
          changedParams: ["headshot"],
          changedBindings: [
            { paramId: "headshot", path: "/layers/0/source", oldValue: "assets/default-headshot.png", newValue: "assets/headshot.png" },
            { paramId: "headshot", path: "/layers/0/assetRef", oldValue: "assets/default-headshot.png", newValue: "assets/headshot.png" }
          ],
          manifestAssets: ["assets/default-headshot.png", "assets/headshot.png"],
          validation: { ok: true }
        });
        expect(receipt).toMatchObject({
          schema: "shellx-motion/receipt@1",
          id: result.receiptId,
          operation: "template.media.replace",
          status: "passed",
          packageId: "pkg_debug_template_media",
          lane: "debug-api",
          output: {
            packageDir: outDir,
            manifestPath: patchedManifestPath,
            motionPath: patchedMotionPath,
            paramId: "headshot",
            assetRef: "assets/headshot.png",
            copiedAssetPath,
            manifestAssets: ["assets/default-headshot.png", "assets/headshot.png"],
            createdBy: "codex-test"
          },
          warnings: []
        });
        expect(receipt.inputHashes["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["motion.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes["template.json"]).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.inputHashes[sourceAssetPath]).toMatch(/^[a-f0-9]{64}$/);
        expect(hostReceipt).toEqual(receipt);
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("refuses TemplateIR media replacement output dirs that already contain files", async () => {
    const fixtureRoot = await writeDebugTemplateMediaPackage();
    const testRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-template-media-non-empty-"));
    const packageRoot = join(testRoot, "package");
    const sourceRoot = join(testRoot, "source");
    const sourceAssetPath = join(sourceRoot, "headshot.png");
    const outDir = join(testRoot, "output");
    const sentinelPath = join(outDir, "keep.txt");
    try {
      await Promise.all([
        cp(fixtureRoot, packageRoot, { recursive: true }),
        mkdir(sourceRoot, { mode: 0o700 }),
        mkdir(outDir, { mode: 0o700 }),
      ]);
      await writeFile(sourceAssetPath, "replacement image", "utf8");
      await writeFile(sentinelPath, "do not delete", "utf8");

      const result = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(testRoot), async () => await dispatchDebugCommand(
        "motion.template.media.replace",
        {
          packageRoot,
          outDir,
          paramId: "headshot",
          assetPath: sourceAssetPath,
          assetRef: "assets/headshot.png"
        },
        {
          tier: "edit_motion",
          authoringInputRoots: [dirname(packageRoot), sourceRoot],
          authoringOutputRoots: [dirname(outDir)],
        }
      ));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalid_args");
        expect(result.error.message).toBe("motion.template.media.replace outDir must be empty or absent before package copy.");
      }
      expect(await readFile(sentinelPath, "utf8")).toBe("do not delete");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("rejects symlinked TemplateIR replacement assets without installing a package", async () => {
    if (process.platform === "win32") return;
    const fixtureRoot = await writeDebugTemplateMediaPackage();
    const testRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-template-media-symlink-output-"));
    const packageRoot = join(testRoot, "package");
    const sourceRoot = join(testRoot, "source");
    const sourceAssetPath = join(sourceRoot, "headshot.png");
    const linkedAssetPath = join(sourceRoot, "linked-headshot.png");
    const outDir = join(testRoot, "output");
    try {
      await Promise.all([
        cp(fixtureRoot, packageRoot, { recursive: true }),
        mkdir(sourceRoot, { mode: 0o700 }),
        mkdir(outDir, { mode: 0o700 }),
      ]);
      await writeFile(sourceAssetPath, "replacement image", "utf8");
      await symlink(sourceAssetPath, linkedAssetPath, "file");
      const result = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(testRoot), async () => await dispatchDebugCommand(
        "motion.template.media.replace",
        {
          packageRoot,
          outDir,
          paramId: "headshot",
          assetPath: linkedAssetPath,
          assetRef: "assets/headshot.png"
        },
        {
          tier: "edit_motion",
          authoringInputRoots: [dirname(packageRoot), sourceRoot],
          authoringOutputRoots: [dirname(outDir)],
        }
      ));
      expect(result).toMatchObject({ ok: false, error: { code: "template_media_replace_failed" } });
      expect(await readdir(outDir)).toEqual([]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("confines TemplateIR replacement assets to the staged assets directory", async () => {
    const fixtureRoot = await writeDebugTemplateMediaPackage();
    const testRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-template-media-target-output-"));
    const packageRoot = join(testRoot, "package");
    const sourceRoot = join(testRoot, "source");
    const sourceAssetPath = join(sourceRoot, "headshot.png");
    const outDir = join(testRoot, "output");
    try {
      await Promise.all([
        cp(fixtureRoot, packageRoot, { recursive: true }),
        mkdir(sourceRoot, { mode: 0o700 }),
        mkdir(outDir, { mode: 0o700 }),
      ]);
      await writeFile(sourceAssetPath, "replacement image", "utf8");
      const result = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(testRoot), async () => await dispatchDebugCommand(
        "motion.template.media.replace",
        {
          packageRoot,
          outDir,
          paramId: "headshot",
          assetPath: sourceAssetPath,
          assetRef: "manifest.json"
        },
        {
          tier: "edit_motion",
          authoringInputRoots: [dirname(packageRoot), sourceRoot],
          authoringOutputRoots: [dirname(outDir)],
        }
      ));
      expect(result).toMatchObject({ ok: false, error: { code: "template_media_replace_failed" } });
      expect(await readdir(outDir)).toEqual([]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("refuses TemplateIR apply below edit permission", async () => {
    const result = await dispatchDebugCommand(
      "motion.template.apply",
      { packageRoot: "../../fixtures/packages/editable-lower-third", values: { title: "Nope" } },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("permission_denied");
      expect(result.error.message).toBe("motion.template.apply requires edit_motion; this session holds read_motion.");
    }
  });

  it("refuses non-rendered Template-to-Cut requests through the debug API before delivery", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-template-to-cut-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.connector.template_to_cut",
        {
          packageRoot: "../../fixtures/cut-native-static-package",
          outDir,
          cutImportMode: "editable_lowering",
          values: {
            title: "Debug Template",
            accentColor: "#ff006e"
          }
        },
        { tier: "write_local" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({ code: "invalid_args", message: expect.stringContaining("only cutImportMode rendered_media") });
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("exports a Canvas bridge frame selection through the debug API", async () => {
    const canvasRoot = await writeCanvasBridgeRoot();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-canvas-bridge-"));
    const outPath = join(outDir, "frame-selection.json");
    const previousTrustedRoots = process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS;
    process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS = canvasRoot;
    try {
      const result = await dispatchDebugCommand(
        "motion.canvas.bridge_export",
        {
          canvasRoot,
          outPath,
          target: "debug",
          projectName: "Debug Canvas Project",
          frameName: "Debug Hero",
          selectedIds: ["rect-blue", "heading"],
          generatedAt: "2026-07-02T12:00:00.000Z"
        },
        { tier: "write_local", receiptsRoot: join(outDir, "host-receipts") }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^canvas-bridge-export-/);
        expect(result.visibleState).toMatchObject({
          panel: "receipts",
          operation: "canvas.bridge_export",
          ok: true,
          path: outPath,
          receiptPath: join(outDir, "canvas-bridge-export.receipt.json"),
          hostReceiptPath: expect.stringContaining("host-receipts")
        });
        expect(result.result).toMatchObject({
          ok: true,
          path: outPath,
          receiptPath: join(outDir, "canvas-bridge-export.receipt.json"),
          hostReceiptPath: expect.stringContaining("host-receipts"),
          schema: "shellx-canvas/frame-selection@1",
          selectedFrameId: "frame_debug",
          layerIds: ["rect-blue", "heading"],
          artifacts: expect.arrayContaining([
            expect.objectContaining({ role: "canvas_frame_selection", path: outPath, status: "available", primary: true }),
            expect.objectContaining({ role: "connector_receipt", path: join(outDir, "canvas-bridge-export.receipt.json"), status: "available" })
          ])
        });
      }
    } finally {
      if (previousTrustedRoots === undefined) {
        delete process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS;
      } else {
        process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS = previousTrustedRoots;
      }
      await rm(outDir, { recursive: true, force: true });
      await rm(canvasRoot, { recursive: true, force: true });
    }
  });

  it("ignores caller-supplied Canvas bridge trust roots in debug API args", async () => {
    const canvasRoot = await writeCanvasBridgeRoot();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-canvas-bridge-arg-trust-"));
    const previousTrustedRoots = process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS;
    delete process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS;
    try {
      const result = await dispatchDebugCommand(
        "motion.canvas.bridge_export",
        {
          canvasRoot,
          outPath: join(outDir, "frame-selection.json"),
          trustedCanvasRoots: [canvasRoot],
          target: "debug"
        },
        { tier: "write_local" }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("canvas_bridge_untrusted");
        expect(result.error.message).toContain("not a trusted Design Studio checkout");
      }
    } finally {
      if (previousTrustedRoots === undefined) {
        delete process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS;
      } else {
        process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS = previousTrustedRoots;
      }
      await rm(outDir, { recursive: true, force: true });
      await rm(canvasRoot, { recursive: true, force: true });
    }
  });

  itLinux("runs Canvas-to-MP4 through the debug API", async () => {
    const root = await mkdtemp("/dev/shm/shellx-motion-debug-canvas-mp4-");
    const outDir = join(root, "out");
    const canvasSelectionPath = join(root, "input", "frame-selection.json");
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      await mkdir(dirname(canvasSelectionPath), { recursive: true, mode: 0o700 });
      await cp(resolve("../../fixtures/canvas/shape-text-frame-selection.json"), canvasSelectionPath);
      const result = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => await dispatchDebugCommand(
        "motion.connector.canvas_to_mp4",
        {
          canvasSelectionPath,
          outDir,
          dryRunRender: true
        },
        { tier: "write_local", receiptsRoot }
      ));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^connector-canvas-mp4-/);
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8")) as Record<string, unknown>;
        expect(hostReceipt).toMatchObject({
          id: result.receiptId,
          operation: "connector.canvas_to_mp4",
          status: "passed"
        });
        expect(result.visibleState).toMatchObject({
          panel: "receipts",
          operation: "connector.canvas_to_mp4",
          ok: true,
          renderPath: expect.stringContaining("pkg_canvas_motion_export_frame_intro.mp4"),
          receiptPath: expect.stringContaining("canvas-mp4-export.receipt.json"),
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: true,
          render: {
            ok: true,
            dryRun: true,
            lane: "ffmpeg"
          },
          receiptPath: expect.stringContaining("canvas-mp4-export.receipt.json"),
          hostReceiptPath,
          artifacts: expect.arrayContaining([
            expect.objectContaining({ role: "motion_package", status: "available" }),
            expect.objectContaining({ role: "rendered_media", status: "planned", primary: true }),
            expect.objectContaining({ role: "connector_receipt", status: "available" })
          ]),
          warnings: []
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  itLinux("surfaces failed Canvas-to-MP4 connector receipts through the debug API", async () => {
    const root = await mkdtemp("/dev/shm/shellx-motion-debug-canvas-mp4-failed-");
    const outDir = join(root, "out");
    const canvasSelectionPath = join(outDir, "frame-selection.json");
    const receiptsRoot = join(outDir, "host-receipts");
    try {
      await mkdir(outDir, { recursive: true, mode: 0o700 });
      await writeFile(canvasSelectionPath, JSON.stringify(animatedCanvasSelectionFixture(), null, 2), "utf8");
      const result = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => await dispatchDebugCommand(
        "motion.connector.canvas_to_mp4",
        {
          canvasSelectionPath,
          outDir
        },
        {
          tier: "write_local",
          receiptsRoot,
          streamingFinalRenderer: debugConnectorStreamingFailureRenderer("ffmpeg_failed", "encoder exploded")
        }
      ));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({
          code: "connector_failed",
          message: "motion.connector.canvas_to_mp4 returned a failed connector receipt.",
          detail: { receiptPath: join(outDir, "canvas-mp4-export.receipt.json") }
        });
        expect(result.receiptId).toMatch(/^connector-canvas-mp4-/);
        const hostReceiptPath = join(receiptsRoot, `${result.receiptId}.receipt.json`);
        const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8")) as Record<string, unknown>;
        expect(hostReceipt).toMatchObject({
          id: result.receiptId,
          operation: "connector.canvas_to_mp4",
          status: "failed"
        });
        expect(result.visibleState).toMatchObject({
          panel: "receipts",
          operation: "connector.canvas_to_mp4",
          ok: false,
          renderPath: join(outDir, "render", "pkg_canvas_motion_export_frame_intro.mp4"),
          receiptPath: join(outDir, "canvas-mp4-export.receipt.json"),
          hostReceiptPath
        });
        expect(result.result).toMatchObject({
          ok: false,
          render: { ok: false, dryRun: false, frameLane: "browser" },
          receiptPath: join(outDir, "canvas-mp4-export.receipt.json"),
          hostReceiptPath,
          warnings: ["encoder exploded"]
        });
        const renderReceipt = JSON.parse(await readFile(join(outDir, "receipts", "ffmpeg-render.receipt.json"), "utf8")) as Record<string, any>;
        expect(renderReceipt.output).toMatchObject({
          frameTransportPlan: { delivery: "streamed", reason: "stream_default" },
          error: { code: "ffmpeg_failed", message: "encoder exploded", stagingOutputRemoved: true }
        });
        await expect(readdir(join(outDir, "frames"))).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  itLinux("defaults Canvas-to-MP4 debug connectors to real streamed renders through the host seam", async () => {
    const root = await mkdtemp("/dev/shm/shellx-motion-debug-canvas-mp4-real-");
    const outDir = join(root, "out");
    const canvasSelectionPath = join(outDir, "frame-selection.json");
    const streamed = debugConnectorStreamingRenderer("debug canvas");
    const colorReadback = debugConnectorDeliveredColorRunner();

    try {
      await mkdir(outDir, { recursive: true, mode: 0o700 });
      await writeFile(canvasSelectionPath, JSON.stringify(animatedCanvasSelectionFixture(), null, 2), "utf8");
      const result = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => await dispatchDebugCommand(
        "motion.connector.canvas_to_mp4",
        {
          canvasSelectionPath,
          outDir
        },
        { tier: "write_local", streamingFinalRenderer: streamed.render, ffmpegRunner: colorReadback.runner }
      ));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const connectorResult = result.result as { render: { dryRun: boolean; frameLane?: string; outputPath: string; receiptPath: string } };
        expect(connectorResult.render).toMatchObject({
          dryRun: false,
          frameLane: "browser",
          outputPath: join(outDir, "render", "pkg_canvas_motion_export_frame_intro.mp4")
        });
        expect(streamed.calls).toEqual([
          expect.objectContaining({ frameLane: "browser", quality: { minUniqueFrameHashes: 2 }, transport: { delivery: "streamed", reason: "stream_default" } })
        ]);
        expect(await readFile(connectorResult.render.outputPath)).toEqual(fakeMp4Bytes("debug canvas"));
        await expectDebugConnectorStreamedReceipt(connectorResult.render.receiptPath, outDir, { minUniqueFrameHashes: 2 });
        expectDebugConnectorDeliveredColorReadback(colorReadback.commands, streamed.calls[0]!.outputPath);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it.runIf(process.platform === "darwin")("refuses Canvas-to-MP4 on macOS before connector output or staging", async () => {
    await expectCanvasMp4ClosedTreeRefusal();
  });

  it.runIf(process.platform === "win32")("refuses Canvas-to-MP4 on Windows before connector output or staging", async () => {
    await expectCanvasMp4ClosedTreeRefusal();
  });

  it("refuses Canvas-to-Cut with an unsupported import mode", async () => {
    const result = await dispatchDebugCommand(
      "motion.connector.canvas_to_cut",
      {
        canvasSelectionPath: "../../fixtures/canvas/shape-text-frame-selection.json",
        outDir: "../../.scratch/debug-canvas-to-cut",
        cutImportMode: "timeline_magic"
      },
      { tier: "write_local" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_args");
      expect(result.error.message).toBe("motion.connector.canvas_to_cut P2B accepts only cutImportMode rendered_media.");
    }
  });

  itLinux("runs Cut Generate scripted-video JSON to Cut through the debug API", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-cut-generate-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.connector.cut_generate_to_cut",
        {
          script: scriptedVideo(),
          outDir,
          cutImportMode: "rendered_media",
          dryRunRender: true,
          createdAt: "2026-07-01T00:00:00.000Z"
        },
        { tier: "write_local" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toMatch(/^connector-cut-generate-cut-/);
        expect(result.visibleState).toMatchObject({
          panel: "receipts",
          operation: "connector.cut_generate_to_cut",
          ok: true,
          scriptInput: "inline",
          packageDir: expect.stringContaining(join(outDir, "package")),
          previewFramePath: expect.stringContaining("native-0.png"),
          renderedMediaPath: expect.stringContaining("pkg_script_launch_demo.mp4"),
          cutPlanPath: expect.stringContaining("cut-import-plan.json"),
          receiptPath: expect.stringContaining("connector-run.receipt.json")
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageDir: expect.stringContaining(outDir),
          preview: { ok: true, lane: "native" },
          render: {
            ok: true,
            required: true,
            dryRun: true,
            lane: "ffmpeg",
            outputPath: expect.stringContaining("pkg_script_launch_demo.mp4")
          },
          cutPlanPath: expect.stringContaining("cut-import-plan.json"),
          receiptPath: expect.stringContaining("connector-run.receipt.json"),
          artifacts: expect.arrayContaining([
            expect.objectContaining({ role: "motion_package", status: "available" }),
            expect.objectContaining({ role: "rendered_media", status: "planned", primary: true }),
            expect.objectContaining({ role: "cut_plan", status: "available" }),
            expect.objectContaining({ role: "connector_receipt", status: "available" })
          ]),
          warnings: [
            "Native renderer case-folded lowercase text to uppercase block glyphs on layer frame_hook_title: ok.",
            "Native renderer case-folded lowercase text to uppercase block glyphs on layer frame_hook_body: howtenrkfl."
          ]
        });
        const connectorResult = result.result as { receiptPath: string; scriptInput: string };
        const receipt = JSON.parse(await readFile(connectorResult.receiptPath, "utf8")) as Record<string, unknown>;
        expect(receipt).toMatchObject({
          id: result.receiptId,
          operation: "connector.cut_generate_to_cut",
          output: {
            script: { path: "inline-scripted-video.json" },
            cut: { ok: true, mode: "rendered_media" },
            render: { ok: true, dryRun: true }
          }
        });
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  itLinux("refuses Cut Generate scripted-video with an unsupported import mode", async () => {
    const result = await dispatchDebugCommand(
      "motion.connector.cut_generate_to_cut",
      {
        script: scriptedVideo(),
        outDir: "../../.scratch/debug-cut-generate",
        cutImportMode: "timeline_magic"
      },
      { tier: "write_local" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_args");
      expect(result.error.message).toBe("Unsupported Cut import mode: timeline_magic.");
    }
  });

  it.runIf(process.platform === "darwin")("refuses Cut Generate-to-Cut on macOS before connector output or staging", async () => {
    await expectCutGenerateClosedTreeRefusal();
  });

  it.runIf(process.platform === "win32")("refuses Cut Generate-to-Cut on Windows before connector output or staging", async () => {
    await expectCutGenerateClosedTreeRefusal();
  });

  it("refuses Script-to-Cut scripted-video with an unsupported import mode", async () => {
    const result = await dispatchDebugCommand(
      "motion.connector.script_to_cut",
      {
        script: scriptedVideo(),
        outDir: "../../.scratch/debug-script-cut",
        cutImportMode: "timeline_magic"
      },
      { tier: "write_local" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_args");
      expect(result.error.message).toBe("motion.connector.script_to_cut P2B accepts only cutImportMode rendered_media.");
    }
  });

  itLinux("packages an asset-free Canvas frame through the debug API with receipt and resource catalog evidence", async () => {
    const packageDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-canvas-package-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.canvas.package",
        {
          canvasSelectionPath: "../../fixtures/canvas/shape-text-frame-selection.json",
          packageDir,
          createdAt: "2026-07-01T00:00:00.000Z"
        },
        { tier: "write_local" }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receiptId).toBe("receipt_canvas_export_frame_intro");
        expect(result.visibleState).toEqual({
          panel: "receipts",
          operation: "canvas.package",
          packageId: "pkg_canvas_motion_export_frame_intro",
          packageDir,
          resourceCatalogPath: join(packageDir, "resource-catalog.json")
        });
        expect(result.result).toMatchObject({
          ok: true,
          packageId: "pkg_canvas_motion_export_frame_intro",
          motionId: "motion_canvas_frame_intro",
          selectedFrameId: "frame_intro",
          packageDir,
          manifestPath: join(packageDir, "manifest.json"),
          motionPath: join(packageDir, "motion.json"),
          receiptPath: join(packageDir, "receipts", "canvas-export.receipt.json"),
          resourceCatalogPath: join(packageDir, "resource-catalog.json"),
          assetRefs: [],
          copiedAssetRefs: [],
          missingAssetRefs: [],
          assetEvidence: []
        });
        const receipt = JSON.parse(await readFile(join(packageDir, "receipts", "canvas-export.receipt.json"), "utf8")) as Record<string, any>;
        const resourceCatalog = JSON.parse(await readFile(join(packageDir, "resource-catalog.json"), "utf8")) as Record<string, any>;
        expect(Object.keys(receipt.inputHashes)).toEqual(["input/canvas-selection.json"]);
        expect(receipt.output).toMatchObject({
          sourceApp: "shellx-canvas",
          selectedFrameId: "frame_intro",
          resourceCatalogPath: "resource-catalog.json"
        });
        expect(resourceCatalog).toMatchObject({
          schema: "shellx-motion/resource-catalog@1",
          packageId: "pkg_canvas_motion_export_frame_intro",
          resources: [
            expect.objectContaining({
              id: "pkg_canvas_motion_export_frame_intro",
              ref: ".",
              kind: "motion_package",
              source: expect.objectContaining({
                app: "shellx-canvas",
                sourceFrameId: "frame_intro",
                receiptId: "receipt_canvas_export_frame_intro"
              })
            })
          ]
        });
        expect(result.warnings).toEqual([]);
      }
    } finally {
      await rm(packageDir, { recursive: true, force: true });
    }
  });

  it("refuses a Canvas package whose declared asset bytes are unavailable", async () => {
    const packageDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-canvas-missing-asset-"));
    try {
      const result = await dispatchDebugCommand(
        "motion.canvas.package",
        {
          canvasSelectionPath: "../../fixtures/canvas/frame-selection.json",
          packageDir,
          createdAt: "2026-07-01T00:00:00.000Z"
        },
        { tier: "write_local" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "canvas_package_failed",
          message: "Canvas package cannot publish missing declared assets: assets/product-retouched.png."
        },
        warnings: []
      });
      await expect(readdir(packageDir)).resolves.toEqual([]);
    } finally {
      await rm(packageDir, { recursive: true, force: true });
    }
  });

  it("refuses Template-to-Cut below local write permission", async () => {
    const result = await dispatchDebugCommand(
      "motion.connector.template_to_cut",
      { packageRoot: "../../fixtures/packages/editable-lower-third", outDir: "../../.scratch/debug-template-to-cut", values: { title: "Nope" } },
      { tier: "render_motion" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("permission_denied");
      expect(result.error.message).toBe("motion.connector.template_to_cut requires write_local; this session holds render_motion.");
    }
  });
});

async function writeDebugPackageWithTimeline(root = ""): Promise<string> {
  root = root || await mkdtemp(join(tmpdir(), "shellx-motion-debug-timeline-"));
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_debug_timeline",
      name: "Debug Timeline",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["native", "ffmpeg"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_debug_timeline",
      name: "Debug Timeline",
      durationMs: 500,
      fps: 10,
      width: 64,
      height: 36,
      tracks: [
        { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] }
      ],
      scenes: [
        { id: "intro", name: "Intro", startMs: 0, durationMs: 500, trackIds: ["overlay"], markerIds: ["start", "beat"] }
      ],
      markers: [
        { id: "start", atMs: 0, label: "Start", type: "cue" },
        { id: "beat", atMs: 250, durationMs: 100, label: "Beat", type: "beat" }
      ],
      layers: [
        {
          id: "title",
          type: "text",
          text: "A",
          trackId: "overlay",
          startMs: 0,
          durationMs: 500
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeDebugPackageWithKeyframes(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-keyframes-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_debug_keyframes",
      name: "Debug Keyframes",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["native", "browser", "ffmpeg"], hosts: ["motion"] }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_debug_keyframes",
      name: "Debug Keyframes",
      durationMs: 500,
      fps: 10,
      width: 64,
      height: 36,
      tracks: [
        { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title", "panel"] }
      ],
      scenes: [
        { id: "intro", name: "Intro", startMs: 0, durationMs: 500, trackIds: ["overlay"] }
      ],
      markers: [
        { id: "start", atMs: 0, label: "Start", type: "cue" },
        { id: "settle", atMs: 500, label: "Settle", type: "cue" }
      ],
      layers: [
        {
          id: "title",
          type: "text",
          text: "Animated",
          trackId: "overlay",
          startMs: 0,
          durationMs: 500,
          keyframes: {
            opacity: [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 250, value: 0.8, easing: "ease-out" },
              { atMs: 500, value: 1, easing: "ease-in-out" }
            ],
            "transform.x": [
              { atMs: 0, value: -32, easing: "ease-out" },
              { atMs: 500, value: 0 }
            ]
          }
        },
        {
          id: "panel",
          type: "shape",
          shape: "rect",
          trackId: "overlay",
          startMs: 0,
          durationMs: 500,
          keyframes: {
            "style.fill": [
              { atMs: 0, value: "#111827", easing: "hold" },
              { atMs: 500, value: "#2563eb" }
            ]
          }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`,
    "utf8"
  );
  return root;
}

async function writeDebugPackageWithTransitions(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-transitions-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_debug_transitions",
      name: "Debug Transitions",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["native", "browser", "ffmpeg"], hosts: ["motion"] }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_debug_transitions",
      name: "Debug Transitions",
      durationMs: 600,
      fps: 10,
      width: 64,
      height: 36,
      tracks: [
        { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title", "panel", "static"] }
      ],
      scenes: [
        { id: "intro", name: "Intro", startMs: 0, durationMs: 600, trackIds: ["overlay"] }
      ],
      layers: [
        {
          id: "title",
          type: "text",
          text: "Transitions",
          trackId: "overlay",
          startMs: 0,
          durationMs: 500,
          transitions: {
            in: { type: "slide", durationMs: 120, easing: "ease-out", direction: "left", distance: 32 },
            out: { type: "fade", durationMs: 100, easing: "linear" }
          }
        },
        {
          id: "panel",
          type: "shape",
          shape: "rect",
          trackId: "overlay",
          startMs: 50,
          durationMs: 450,
          transitions: {
            in: { type: "wipe", durationMs: 180, easing: "ease-in", direction: "right" }
          }
        },
        {
          id: "static",
          type: "shape",
          shape: "rect",
          trackId: "overlay",
          startMs: 0,
          durationMs: 600
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`,
    "utf8"
  );
  return root;
}

function debugOtioTimelineFixture(): Record<string, unknown> {
  return {
    OTIO_SCHEMA: "Timeline.1",
    name: "Debug OTIO",
    metadata: {
      shellx_motion: {
        width: 640,
        height: 360,
        fps: 24
      }
    },
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      children: [
        {
          OTIO_SCHEMA: "Track.1",
          name: "Video",
          kind: "Video",
          children: [
            {
              OTIO_SCHEMA: "Clip.2",
              name: "Clip 01",
              media_reference: {
                OTIO_SCHEMA: "ExternalReference.1",
                target_url: "media/clip01.mp4"
              },
              source_range: {
                OTIO_SCHEMA: "TimeRange.1",
                start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: 24 },
                duration: { OTIO_SCHEMA: "RationalTime.1", value: 24, rate: 24 }
              },
              metadata: {
                shellx_motion: {
                  layerId: "clip_01",
                  layerType: "video"
                }
              }
            }
          ]
        }
      ]
    }
  };
}

function htmlSnippetImportFixture(): string {
  return `<!doctype html>
<html lang="en" data-shellx-motion-schema="shellx-motion/html-snippet@1" data-shellx-motion-package-id="pkg_html_debug">
<head><title>Debug HTML</title></head>
<body>
  <main class="shellx-motion-composition" data-composition-id="motion_html_debug" data-duration="900" data-fps="30" style="width: 640px; height: 360px; background: #101820;">
    <div class="shellx-motion-layer shellx-motion-text" data-layer-id="headline" data-layer-type="text" data-start="100" data-duration="700" style="left: 48px; top: 96px; width: 460px; height: 80px; color: #ffffff; font-size: 42px; font-weight: 700;">Debug HTML</div>
  </main>
</body>
</html>
`;
}

async function writeDebugPackageWithMultiTrackTimeline(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-multi-track-timeline-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_debug_multi_track_timeline",
      name: "Debug Multi Track Timeline",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["native", "ffmpeg"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_debug_multi_track_timeline",
      name: "Debug Multi Track Timeline",
      durationMs: 600,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] },
        { id: "audio", type: "audio", name: "Audio", order: 2, layerIds: ["music"] }
      ],
      scenes: [
        { id: "intro", name: "Intro", startMs: 0, durationMs: 500, trackIds: ["overlay"], markerIds: ["inside"] },
        { id: "music-scene", name: "Music Scene", startMs: 0, durationMs: 500, trackIds: ["audio"], markerIds: ["inside"] }
      ],
      markers: [
        { id: "before", atMs: 0, label: "Before", type: "cue" },
        { id: "overlap-in", atMs: 50, durationMs: 100, label: "Overlap In", type: "cue" },
        { id: "inside", atMs: 150, label: "Inside", type: "cue" },
        { id: "overlap-out", atMs: 280, durationMs: 100, label: "Overlap Out", type: "cue" },
        { id: "end-point", atMs: 300, label: "End Point", type: "cue" }
      ],
      layers: [
        {
          id: "title",
          type: "text",
          text: "Title",
          trackId: "overlay",
          startMs: 100,
          durationMs: 200
        },
        {
          id: "music",
          type: "audio",
          source: "assets/music.wav",
          trackId: "audio",
          startMs: 100,
          durationMs: 200
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function writeDebugPackageWithAudioMix(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-audio-mix-"));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "assets", "music.wav"), "fake music wav", "utf8");
  await writeFile(join(root, "assets", "voice.wav"), "fake voice wav", "utf8");
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_debug_audio_mix",
      name: "Debug Audio Mix",
      motion: "motion.json",
      assets: ["assets/music.wav", "assets/voice.wav"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["native", "browser", "ffmpeg"], hosts: ["motion"] }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_debug_audio_mix",
      name: "Debug Audio Mix",
      durationMs: 2400,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "music-track", type: "audio", name: "Music", order: 1, layerIds: ["music"], volume: 0.7, pan: -0.2, fadeInMs: 120, fadeOutMs: 180 },
        { id: "voice-track", type: "audio", name: "Voice", order: 2, layerIds: ["voice"], volume: 1 }
      ],
      layers: [
        {
          id: "music",
          type: "audio",
          source: "assets/music.wav",
          trackId: "music-track",
          startMs: 0,
          durationMs: 2400,
          volume: 0.6,
          keyframes: {
            pan: [
              { atMs: 0, value: -0.4 },
              { atMs: 2400, value: 0.2 }
            ]
          },
          ducking: { triggerLayerIds: ["voice"], duckToVolume: 0.2, attackMs: 100, releaseMs: 200 }
        },
        {
          id: "voice",
          type: "audio",
          source: "assets/voice.wav",
          trackId: "voice-track",
          startMs: 600,
          durationMs: 800,
          playbackRate: 1.25
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`,
    "utf8"
  );
  return root;
}

async function writeDebugPackageBrowserRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-package-browser-"));
  const brandRoot = join(root, "brand");
  const templateRoot = join(root, "template");
  const brokenRoot = join(root, "broken");
  await mkdir(join(brandRoot, "assets"), { recursive: true, mode: 0o700 });
  await mkdir(templateRoot, { recursive: true, mode: 0o700 });
  await mkdir(brokenRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(brandRoot, "assets", "product.png"), "product-bytes", "utf8");
  await writeFile(
    join(brandRoot, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_browser_brand",
      name: "Browser Brand",
      motion: "motion.json",
      assets: ["assets/product.png"],
      sourceApp: "shellx-canvas",
      compatibility: { lanes: ["native", "ffmpeg"], hosts: ["shellx-motion", "shellx-canvas"] },
      selectedFrameId: "frame_product"
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(brandRoot, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_browser_brand",
      name: "Browser Brand",
      durationMs: 1200,
      fps: 24,
      width: 1080,
      height: 1080,
      layers: [
        { id: "product", type: "image", assetId: "asset_product", startMs: 0, durationMs: 1200 }
      ],
      assets: [
        { id: "asset_product", source: { path: "assets/product.png", mimeType: "image/png" } }
      ],
      designTokens: {
        color: { accent: "#ff006e" },
        typography: { heading: { fontFamily: "Inter" } }
      },
      provenance: {
        sourceApp: "shellx-canvas",
        createdBy: "test",
        projectId: "canvas_project",
        selectedFrameId: "frame_product"
      }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(templateRoot, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_browser_template",
      name: "Browser Template",
      motion: "motion.json",
      template: "template.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["native", "browser", "ffmpeg"], hosts: ["shellx-motion", "shellx-cut"] }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(templateRoot, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_browser_template",
      name: "Browser Template",
      durationMs: 800,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "title", type: "text", text: "Template", startMs: 0, durationMs: 800 }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(templateRoot, "template.json"),
    `${JSON.stringify({
      schema: "shellx-motion/template@1",
      id: "template_browser",
      name: "Browser Template Controls",
      motion: "motion.json",
      compatibleLanes: ["native", "browser", "ffmpeg"],
      compatibleHosts: ["shellx-motion", "shellx-cut"],
      groups: [{ id: "content", label: "Content", order: 1 }],
      params: [{ id: "title", label: "Title", type: "text", defaultValue: "Template", group: "content", order: 1 }],
      controls: [{ paramId: "title", widget: "text", label: "Title" }],
      bindings: [{ paramId: "title", target: { kind: "motion_path", path: "/layers/0/text", layerId: "title" } }]
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(join(brokenRoot, "manifest.json"), "{ bad json\n", "utf8");
  return root;
}

async function writeDebugPackageWithCanvasAssetId(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-canvas-asset-"));
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "assets", "product.png"), "imagebytes", "utf8");
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_debug_canvas_asset",
      name: "Debug Canvas Asset",
      motion: "motion.json",
      assets: ["assets/product.png"],
      sourceApp: "shellx-canvas",
      compatibility: { lanes: ["native", "ffmpeg"], hosts: ["shellx-motion", "shellx-canvas"] }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_debug_canvas_asset",
      name: "Debug Canvas Asset",
      durationMs: 1000,
      fps: 10,
      width: 640,
      height: 360,
      layers: [
        {
          id: "product",
          type: "image",
          assetId: "asset_product",
          startMs: 0,
          durationMs: 1000
        }
      ],
      assets: [
        {
          schema: "shellx-motion/asset@1",
          id: "asset_product",
          kind: "image",
          source: {
            app: "shellx-canvas/image-editor",
            path: "assets/product.png",
            mimeType: "image/png"
          },
          hash: {
            sha256: "a".repeat(64)
          }
        }
      ],
      provenance: { sourceApp: "shellx-canvas", createdBy: "test" }
    }, null, 2)}\n`,
    "utf8"
  );
  return root;
}

async function writeDebugPackageWithMedia(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-media-"));
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "assets", "product.png"), "product image bytes", "utf8");
  await writeFile(join(root, "assets", "clip.mp4"), "video bytes", "utf8");
  await writeFile(join(root, "card.html"), "<!doctype html><main>Card</main>\n", "utf8");
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_debug_media",
      name: "Debug Media",
      motion: "motion.json",
      assets: ["assets/product.png", "assets/clip.mp4", "card.html"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["shellx-motion", "shellx-cut"] }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_debug_media",
      name: "Debug Media",
      durationMs: 1800,
      fps: 30,
      width: 640,
      height: 360,
      tracks: [
        { id: "visual", type: "video", name: "Visual", order: 1, layerIds: ["hero", "clip", "web-card", "remote", "placeholder"] },
        { id: "sound", type: "audio", name: "Sound", order: 2, layerIds: ["music"] }
      ],
      layers: [
        {
          id: "hero",
          type: "image",
          assetId: "asset_product",
          startMs: 0,
          durationMs: 900,
          trackId: "visual",
          fit: "contain",
          crop: { x: 0, y: 0, width: 640, height: 360 }
        },
        {
          id: "clip",
          type: "video",
          source: "assets/clip.mp4",
          startMs: 600,
          durationMs: 1000,
          trackId: "visual",
          trimStartMs: 250,
          trimDurationMs: 1000,
          loop: true,
          playbackRate: 1.25,
          includeAudio: true
        },
        {
          id: "music",
          type: "audio",
          source: "assets/missing.wav",
          startMs: 0,
          durationMs: 1800,
          trackId: "sound",
          volume: 0.8,
          muted: false,
          fadeInMs: 120,
          fadeOutMs: 240
        },
        {
          id: "web-card",
          type: "web",
          src: "card.html",
          startMs: 200,
          durationMs: 1200,
          trackId: "visual",
          allowedOrigins: ["https://example.com"]
        },
        {
          id: "remote",
          type: "image",
          src: "https://cdn.example.com/remote.png",
          startMs: 100,
          durationMs: 500,
          trackId: "visual"
        },
        {
          id: "placeholder",
          type: "image",
          startMs: 1200,
          durationMs: 300,
          trackId: "visual"
        }
      ],
      assets: [
        {
          schema: "shellx-motion/asset@1",
          id: "asset_product",
          kind: "image",
          source: { path: "assets/product.png", mimeType: "image/png" }
        },
        {
          schema: "shellx-motion/asset@1",
          id: "asset_clip",
          kind: "video",
          ref: "assets/clip.mp4"
        }
      ],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`,
    "utf8"
  );
  return root;
}

async function writeDebugPackageWithAssetAndBrandData(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-assets-"));
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "assets", "logo.png"), "pngbytes", "utf8");
  await writeFile(join(root, "assets", "music.wav"), "wavbytes\n\n", "utf8");
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_debug_assets",
      name: "Debug Assets",
      motion: "motion.json",
      assets: ["assets/logo.png", "assets/music.wav", "assets/missing.png"],
      sourceApp: "shellx-canvas",
      compatibility: { lanes: ["native", "ffmpeg"], hosts: ["shellx-motion", "shellx-canvas"] },
      selectedFrameId: "frame_hero"
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_debug_assets",
      name: "Debug Assets",
      durationMs: 1000,
      fps: 10,
      width: 640,
      height: 360,
      background: "#101828",
      layers: [
        {
          id: "logo",
          type: "image",
          assetRef: "assets/logo.png",
          startMs: 0,
          durationMs: 1000
        },
        {
          id: "music",
          type: "audio",
          source: "assets/music.wav",
          startMs: 0,
          durationMs: 1000
        },
        {
          id: "remote",
          type: "image",
          src: "https://cdn.example.com/remote.png",
          startMs: 0,
          durationMs: 1000
        }
      ],
      assets: [
        { id: "logo", ref: "assets/logo.png" },
        { id: "remote", ref: "https://cdn.example.com/remote.png" }
      ],
      designTokens: {
        color: { accent: "#ff006e", ink: "#101828" },
        typography: { heading: { fontFamily: "Inter", fontWeight: 800 } },
        logo: {
          primary: { assetRef: "assets/logo.png", alt: "ShellX" },
          mark: { assetRef: "https://cdn.example.com/remote.png", alt: "ShellX mark" }
        },
        spacing: { framePadding: 64 },
        radius: { card: 24 }
      },
      provenance: {
        sourceApp: "shellx-canvas",
        createdBy: "test",
        projectId: "canvas_project",
        selectedFrameId: "frame_hero"
      }
    }, null, 2)}\n`,
    "utf8"
  );
  return root;
}

async function writeDebugBatchPackageWithAudioLayer(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-audio-batch-"));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "data"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "assets", "music.wav"), "fake music wav bytes", "utf8");
  await writeFile(
    join(root, "data", "rows.json"),
    `${JSON.stringify({
      schema: "shellx-motion/data-rows@1",
      rows: [
        { id: "ada", name: "Ada", background: "#0f172a" },
        { id: "grace", name: "Grace", background: "#111827" }
      ]
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_debug_audio_batch",
      name: "Debug Audio Batch {{name}}",
      motion: "motion.json",
      assets: ["assets/music.wav"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["native", "ffmpeg"], hosts: ["motion"] },
      data: { rows: "data/rows.json" }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_debug_audio_batch",
      name: "Debug Audio Batch {{name}}",
      durationMs: 500,
      fps: 10,
      width: 64,
      height: 36,
      background: "{{background}}",
      layers: [
        {
          id: "title",
          type: "text",
          text: "Hello {{name}}",
          startMs: 0,
          durationMs: 500
        },
        {
          id: "music",
          type: "audio",
          source: "assets/music.wav",
          startMs: 0,
          durationMs: 500
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`,
    "utf8"
  );
  return root;
}

async function writeDebugTemplateMediaPackage(root = ""): Promise<string> {
  root = root || await mkdtemp(join(tmpdir(), "shellx-motion-debug-template-media-package-"));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "assets", "default-headshot.png"), "default image", "utf8");
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_debug_template_media",
      name: "Debug Template Media",
      motion: "motion.json",
      template: "template.json",
      assets: ["assets/default-headshot.png"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["native", "browser", "ffmpeg"], hosts: ["shellx-motion", "shellx-canvas", "shellx-cut"] },
      workflow: "template-media"
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_debug_template_media",
      name: "Debug Template Media",
      durationMs: 1000,
      fps: 10,
      width: 640,
      height: 360,
      layers: [
        {
          id: "headshot",
          type: "image",
          source: "assets/default-headshot.png",
          assetRef: "assets/default-headshot.png",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, scale: 1 }
        }
      ],
      assets: [{ id: "default-headshot", ref: "assets/default-headshot.png" }],
      provenance: { sourceApp: "shellx-motion", createdBy: "test", workflow: "template-media" }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "template.json"),
    `${JSON.stringify({
      schema: "shellx-motion/template@1",
      id: "template_debug_template_media",
      name: "Debug Template Media",
      motion: "motion.json",
      compatibleLanes: ["native", "browser", "ffmpeg"],
      compatibleHosts: ["shellx-motion", "shellx-canvas", "shellx-cut"],
      groups: [{ id: "media", label: "Media", order: 1 }],
      params: [{ id: "headshot", label: "Headshot", type: "media", defaultValue: "assets/default-headshot.png", group: "media", order: 1 }],
      controls: [{ paramId: "headshot", widget: "media", label: "Headshot" }],
      bindings: [
        { paramId: "headshot", target: { kind: "motion_path", path: "/layers/0/source", layerId: "headshot" } },
        { paramId: "headshot", target: { kind: "motion_path", path: "/layers/0/assetRef", layerId: "headshot" } }
      ]
    }, null, 2)}\n`
  );
  return root;
}

async function writeShortEditableLowerThirdTemplatePackage(outDir: string): Promise<string> {
  const packageRoot = join(outDir, "short-editable-lower-third");
  await cp(resolve("../../fixtures/packages/editable-lower-third"), packageRoot, { recursive: true });
  const motionPath = join(packageRoot, "motion.json");
  const motion = JSON.parse(await readFile(motionPath, "utf8")) as Record<string, any>;
  motion.durationMs = 1000;
  motion.fps = 2;
  motion.layers = motion.layers.map((layer: Record<string, any>) => ({
    ...layer,
    durationMs: 1000
  }));
  await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
  return packageRoot;
}

async function writeDebugSuitabilityTemplatePackage(
  root: string,
  input: {
    packageId: string;
    templateId: string;
    name: string;
    title: string;
    bestFor: string[];
    notFor: string[];
    license?: {
      id: string;
      label?: string;
      url?: string;
      attribution?: string;
      spdxId?: string;
      attributionRequired?: boolean;
      redistributionAllowed?: boolean;
      commercialUse?: boolean;
      notes?: string;
    };
    assetsAttribution?: Array<{
      name: string;
      license?: string;
      author?: string;
      url?: string;
      path?: string;
    }>;
    preview?: {
      poster?: string;
      loop?: string;
      thumbnail?: string;
    };
    inputExamples?: Array<Record<string, unknown>>;
    performance?: {
      recommendedLane?: string;
      renderCost?: "low" | "medium" | "high";
      previewFps?: number;
      notes?: string[];
    };
  }
): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: input.packageId,
      name: input.name,
      motion: "motion.json",
      template: "template.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["native", "browser", "ffmpeg"], hosts: ["shellx-motion", "shellx-cut"] },
      workflow: "template-suitability"
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: `motion_${input.templateId}`,
      name: input.name,
      durationMs: 2400,
      fps: 30,
      width: 1920,
      height: 1080,
      layers: [
        {
          id: "title",
          type: "text",
          text: input.title,
          startMs: 0,
          durationMs: 2400,
          transform: { x: 96, y: 760 },
          style: { fontSize: 72, color: "#ffffff" }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test", workflow: "template-suitability" }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "template.json"),
    `${JSON.stringify({
      schema: "shellx-motion/template@1",
      id: input.templateId,
      name: input.name,
      motion: "motion.json",
      compatibleLanes: ["native", "browser", "ffmpeg"],
      compatibleHosts: ["shellx-motion", "shellx-cut"],
      metadata: {
        inputSchema: {
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string", maxLength: 80 }
          }
        },
        outputBounds: {
          minWidth: 720,
          maxWidth: 3840,
          minHeight: 405,
          maxHeight: 2160,
          minDurationMs: 1200,
          maxDurationMs: 8000,
          aspectRatios: ["16:9"]
        },
        suitability: {
          bestFor: input.bestFor,
          notFor: input.notFor
        },
        ...(input.license ? { license: input.license } : {}),
        ...(input.assetsAttribution ? { assetsAttribution: input.assetsAttribution } : {}),
        ...(input.preview ? { preview: input.preview } : {}),
        ...(input.inputExamples ? { inputExamples: input.inputExamples } : {}),
        ...(input.performance ? { performance: input.performance } : {})
      },
      groups: [{ id: "content", label: "Content", order: 1 }],
      params: [{ id: "title", label: "Title", type: "text", defaultValue: input.title, group: "content", order: 1 }],
      controls: [{ paramId: "title", widget: "text", label: "Title" }],
      bindings: [
        { paramId: "title", target: { kind: "motion_path", path: "/layers/0/text", layerId: "title" } }
      ]
    }, null, 2)}\n`
  );
  return root;
}

async function writeCanvasBridgeRoot(): Promise<string> {
  const canvasRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-canvas-root-"));
  await mkdir(join(canvasRoot, "app", "server"), { recursive: true, mode: 0o700 });
  await writeFile(join(canvasRoot, "app", "package.json"), JSON.stringify({ name: "shellx-canvas" }), "utf8");
  await writeFile(
    join(canvasRoot, "app", "server", "motion-package.mjs"),
    `
      import { mkdir, writeFile } from "node:fs/promises";
      import { dirname } from "node:path";
      export function buildMotionFrameSelection(input) {
        return {
          schema: "shellx-canvas/frame-selection@1",
          selectedFrameId: "frame_" + input.target,
          project: { id: input.target, name: input.projectName },
          brand: { tokens: input.brandTokens },
          frames: [{
            id: "frame_" + input.target,
            name: input.frameName,
            durationMs: input.durationMs,
            fps: input.fps,
            width: input.doc.width,
            height: input.doc.height,
            layers: input.doc.layers[0].ops.map((op) => ({ id: op.id, kind: op.kind, startMs: 0, durationMs: input.durationMs }))
          }],
          imageEditorOutputs: []
        };
      }
      export async function writeMotionFrameSelection(selection, options) {
        await mkdir(dirname(options.outPath), { recursive: true, mode: 0o700 });
        await writeFile(options.outPath, JSON.stringify(selection, null, 2) + "\\n", "utf8");
        return { ok: true, path: options.outPath, schema: selection.schema };
      }
    `,
    "utf8"
  );
  return canvasRoot;
}

function animatedCanvasSelectionFixture(): Record<string, unknown> {
  const revealMotion = {
    motion: {
      in: { type: "slide", direction: "down", distance: 24, durationMs: 320, easing: "ease-out" },
      out: { type: "fade", durationMs: 260, easing: "ease-in" }
    },
    keyframes: {
      opacity: [
        { atMs: 0, value: 0, easing: "ease-out" },
        { atMs: 320, value: 1 },
        { atMs: 740, value: 1, easing: "ease-in" },
        { atMs: 1000, value: 0 }
      ]
    }
  };

  return {
    schema: "shellx-canvas/frame-selection@1",
    selectedFrameId: "frame_intro",
    project: { id: "canvas_motion_export", name: "Motion Export" },
    brand: { tokens: { color: { accent: "#2563eb", ink: "#101828" } } },
    frames: [
      {
        id: "frame_intro",
        name: "Intro",
        durationMs: 1000,
        fps: 2,
        width: 640,
        height: 360,
        background: "#f8fafc",
        layers: [
          {
            id: "panel",
            kind: "shape",
            shape: "rectangle",
            startMs: 0,
            durationMs: 1000,
            transform: { x: 48, y: 44, width: 250, height: 150, opacity: 1 },
            style: { fill: "#2563eb" },
            ...revealMotion
          },
          {
            id: "title",
            kind: "text",
            text: "Canvas export",
            startMs: 0,
            durationMs: 1000,
            transform: { x: 64, y: 240, width: 420, height: 60, opacity: 1 },
            style: { fontSize: 36, color: "#101828" },
            ...revealMotion
          }
        ]
      }
    ],
    imageEditorOutputs: []
  };
}

function debugReceipt(input: {
  id: string;
  operation: string;
  status: "passed" | "failed" | "warning" | "not_run";
  packageId: string;
  lane: string;
  output: unknown;
  artifacts?: Array<{ role: string; path: string; status: "available" | "planned" | "not_required" | "failed"; mediaType?: string; primary?: boolean }>;
  warnings?: string[];
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: input.id,
    operation: input.operation,
    status: input.status,
    packageId: input.packageId,
    inputHashes: { motion: "a".repeat(64) },
    createdAt: "2026-07-01T00:00:00.000Z",
    lane: input.lane,
    output: input.output,
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    warnings: input.warnings ?? []
  };
}

function restoreEnv(name: "SHELLX_MOTION_FFMPEG" | "SHELLX_MOTION_FFPROBE" | "SHELLX_MOTION_FFMPEG_TIMEOUT_MS", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function storyboardPanelScriptedVideo(): Record<string, unknown> {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "source-storyboard-demo",
    name: "Source Storyboard Demo",
    sourceApp: "shellx-motion",
    workflow: "source-to-scripted-video",
    intent: "source_to_storyboard",
    synopsis: "Review source-backed launch notes before compile.",
    review: { status: "needs-review", required: true },
    width: 1280,
    height: 720,
    fps: 30,
    frames: [
      {
        id: "problem",
        title: "Problem",
        body: "Teams need deterministic video exports.",
        caption: "Source: example.com",
        durationMs: 2000,
        background: "#0f172a",
        accent: "#38bdf8",
        reviewStatus: "needs-review",
        agentNote: "Check source claim wording before compile.",
        assetRefs: ["assets/problem.png"],
        sourceRefs: [
          { type: "article", title: "Launch notes", url: "https://example.com/articles/motion#problem" }
        ],
        tags: ["problem"],
        template: { id: "lower-third-source", engine: "native", variables: { emphasis: "problem" } },
        engine: { id: "native-text", mode: "text-card", capability: "native" }
      },
      {
        id: "handoff",
        title: "Cut handoff",
        body: "Scripted-video JSON can go directly to Cut.",
        durationMs: 2200,
        sourceRefs: [
          { type: "article", title: "Launch notes", url: "https://example.com/articles/motion#handoff" }
        ]
      }
    ]
  };
}

function storyboardReadinessIssueScriptedVideo(): Record<string, unknown> {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "source-readiness-issues",
    name: "Source Readiness Issues",
    sourceApp: "shellx-motion",
    workflow: "source-to-scripted-video",
    intent: "source_to_storyboard",
    review: { status: "needs-review", required: true },
    width: 1280,
    height: 720,
    fps: 30,
    frames: [
      {
        id: "intro",
        title: "Intro",
        body: "This frame is intentionally incomplete.",
        durationMs: 1000,
        reviewStatus: "needs-review",
        sourceRefs: [
          { type: "article", title: "Launch notes", url: "https://example.com/articles/motion#intro" }
        ]
      },
      {
        id: "details",
        title: "Details",
        body: "This frame has enough planning evidence.",
        durationMs: 1200,
        sourceRefs: [
          { type: "article", title: "Launch notes", url: "https://example.com/articles/motion#details" }
        ],
        template: { id: "lower-third-source", engine: "native" },
        engine: { id: "native-text" }
      }
    ]
  };
}

function debugTestRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected debug test record.");
  }
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) record[key] = entry;
  return record;
}

function debugTestRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error("Expected debug test record array.");
  return value.map(debugTestRecord);
}

function debugTestString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected debug test string.");
  return value;
}

function importedSourceMarkdown(): string {
  return buildSourceImportDocument({
    url: "https://github.com/nexu-io/html-video",
    title: "html-video reference workflow",
    kind: "repo",
    markdown: [
      "## HTML video workflows",
      "The reference project demonstrates source-driven HTML composition into video output.",
      "",
      "## Agent inputs",
      "Prompt, link, and repository inputs should become reviewable storyboard frames before timeline mutation.",
      "",
      "## ShellX placement",
      "Motion keeps package, receipt, source refs, and Cut handoff state separate from Canvas."
    ].join("\n")
  }).markdown;
}

function previewFailingScriptedVideo(): Record<string, unknown> {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "debug-preview-fail",
    name: "Debug Preview Fail",
    sourceApp: "shellx-cut",
    workflow: "generate",
    width: 640,
    height: 360,
    fps: 2,
    frames: [
      {
        id: "bad-preview",
        title: "Bad native preview",
        body: "Dry-run export must surface this failure",
        durationMs: 1000,
        background: "color(display-p3 1 0 0)",
        accent: "#38bdf8"
      }
    ]
  };
}

const CONTRAST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAEGNhTnYAAAABAAAAAQAAAAAAAAAAmdvqagAAABFJREFUCNdjZGBg+P///38GAA4EA/75rp4uAAAAAElFTkSuQmCC",
  "base64"
);
const ALPHA_2X2_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGNgYGBg+P///38Q3QAiADBkBH2F9jENAAAAAElFTkSuQmCC",
  "base64"
);
const BLACK_2X1_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGNgYGD4D8IABgMB/8+HxnAAAAAASUVORK5CYII=",
  "base64"
);
