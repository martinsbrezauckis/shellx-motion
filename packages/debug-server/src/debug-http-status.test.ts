import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadMotionPackage,
  MotionJobCoordinator,
  MotionJobLeaseDirectory,
  MotionJobRegistry
} from "@shellx-motion/core";
import {
  createTrustedWorkspaceAnchor,
  withTrustedWorkspaceAnchor
} from "@shellx-motion/core/internal/trusted-host-workspace";
import { renderMotionGpuPreview } from "@shellx-motion/renderer-browser";
import { describe, expect, it } from "vitest";
import type { MotionDebugContext, MotionDebugResult } from "@shellx-motion/debug-api";
import { startMotionDebugServer, type MotionDebugServerHandle } from "./index.js";
import { statusForRawDebugResult } from "./debug-http-status.js";
import { dispatchGuarded } from "./guarded-dispatch.js";

const TOKEN = "debug-http-status-token-000000000000000000000000";

function failed(code: string): MotionDebugResult {
  return { ok: false, error: { code, message: code }, warnings: [] };
}

function post(server: MotionDebugServerHandle, body: unknown): Promise<Response> {
  return globalThis.fetch(new URL("/debug", server.url), {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function testRoot(): Promise<string> {
  const scratch = join(process.cwd(), ".scratch");
  await mkdir(scratch, { recursive: true });
  return await mkdtemp(join(scratch, "v262-debug-http-status-"));
}

async function writeFinalPackage(root: string, options: { scene3dAnimation?: boolean; audioMaster?: boolean } = {}): Promise<string> {
  const packageRoot = join(root, options.scene3dAnimation ? "scene3d-refusal" : options.audioMaster ? "audio-refusal" : "plain");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: `debug-http-${options.scene3dAnimation ? "scene3d" : options.audioMaster ? "audio" : "plain"}`,
    name: "Debug HTTP status fixture",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion-test",
    compatibility: { lanes: ["ffmpeg"], hosts: ["shellx-motion"] }
  }, null, 2)}\n`);
  await writeFile(join(packageRoot, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "debug-http-motion",
    name: "Debug HTTP status fixture",
    durationMs: 1_000,
    fps: 30,
    width: 100,
    height: 50,
    assets: [],
    provenance: { sourceApp: "shellx-motion-test", createdBy: "test" },
    layers: options.scene3dAnimation ? [{
      id: "world",
      type: "scene3d",
      startMs: 0,
      durationMs: 1_000,
      scene3d: {
        schema: "shellx-motion/scene3d@1",
        camera: { position: [0, 2, 6], target: [0, 0, 0], fovDeg: 45, near: 0.1, far: 100 },
        lighting: { ambient: 0.25, direction: [0, -1, -1], intensity: 1, color: "#ffffff" },
        backgroundColor: "#101820",
        objects: [{ id: "beacon", primitive: "box", position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1, color: "#00aaff", emissive: 0.1 }]
      }
    }] : [{
      id: "shape",
      type: "shape",
      shape: "rect",
      fill: "#ffffff",
      startMs: 0,
      durationMs: 1_000,
      transform: { x: 0, y: 0, width: 10, height: 10 }
    }],
    ...(options.scene3dAnimation ? {
      scene3dAnimation: {
        schema: "shellx-motion/scene3d-animation@1",
        tracks: [{
          id: "camera-fov",
          locator: { layerId: "world", scope: "camera", property: "fovDeg" },
          keyframes: [{ atUs: 500_000, value: 50, easing: "ease-in" }]
        }]
      }
    } : {}),
    ...(options.audioMaster ? { audio: { master: { volume: 0.8 } } } : {})
  }, null, 2)}\n`);
  return packageRoot;
}

type CallerCorrectableFinalFixture = "browser-html" | "browser-motion" | "native-text" | "resource-preflight" | "static-sequence";

async function writeCallerCorrectableFinalPackage(root: string, fixture: CallerCorrectableFinalFixture): Promise<string> {
  const packageRoot = join(root, fixture);
  const isBrowserHtml = fixture === "browser-html";
  const isBrowserMotion = fixture === "browser-motion";
  const isNativeText = fixture === "native-text";
  const durationMs = fixture === "static-sequence" ? 36_001_000 : 1_000;
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: `debug-http-${fixture}`,
    name: `Debug HTTP ${fixture} refusal fixture`,
    motion: "motion.json",
    assets: isBrowserHtml ? ["card.html"] : [],
    sourceApp: "shellx-motion-test",
    compatibility: { lanes: ["browser", "native", "ffmpeg"], hosts: ["shellx-motion"] },
    ...((isBrowserHtml || isBrowserMotion) ? { quality: { maxFontFallbacks: 0 } } : {})
  }, null, 2)}\n`);
  await writeFile(join(packageRoot, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: `debug-http-${fixture}-motion`,
    name: `Debug HTTP ${fixture} refusal fixture`,
    durationMs,
    fps: 1,
    width: 64,
    height: 36,
    assets: [],
    provenance: { sourceApp: "shellx-motion-test", createdBy: "test" },
    layers: isBrowserHtml ? [{
      id: "interactive", type: "web", source: "card.html", startMs: 0, durationMs
    }] : (isBrowserMotion || isNativeText) ? [{
      id: "title", type: "text", text: isNativeText ? "lowercase" : "Motion text", startMs: 0, durationMs
    }] : [{
      id: "shape", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs,
      transform: { x: 0, y: 0, width: 10, height: 10 }
    }]
  }, null, 2)}\n`);
  if (isBrowserHtml) await writeFile(join(packageRoot, "card.html"), "<canvas id=\"dynamic\"></canvas>\n");
  return packageRoot;
}

async function eventually<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await read();
    if (matches(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for coordinator state.");
}

// The Debug Server accepts a host-owned prompt runtime rather than importing providers itself.
// This is the exact injected boundary: the route still runs production prompt handling and must
// preserve the runtime's unknown-agent result all the way to its raw HTTP status.
const unknownAgentRuntime = {
  runPrompt: async (input: { agentId?: string }) => ({
    ok: false as const,
    error: { code: "agent_unknown", message: `${input.agentId ?? "codex"} is not configured.` }
  })
};

const queueTimeoutRenderer: NonNullable<MotionDebugContext["streamingFinalRenderer"]> = async (input) => ({
  ok: false,
  transport: input.transport ?? { delivery: "streamed", reason: "stream_default" },
  error: { code: "job_queue_timeout", message: "The host queue timed out before admission." }
});

describe("raw Debug HTTP status policy", () => {
  it.each([
    ["permission_denied", 403],
    ["invalid_args", 400],
    ["unknown_command", 404],
    ["job_unknown", 404],
    ["job_not_visible", 404],
    ["receipt_not_found", 404],
    ["job_expired", 410],
    ["derived_output_exists", 409],
    ["streaming_evidence_conflict", 409],
    ["job_not_terminal", 409],
    ["job_not_retryable", 409],
    ["authoring_path_not_approved", 403],
    ["render_path_not_approved", 403],
    ["unsafe_input_path", 422],
    ["gpu_resource_refused", 422],
    ["property.unsupported", 422],
    ["unsupported_layer", 422],
    ["motion_scene3d_animation_unavailable", 422],
    ["motion_relations_unavailable", 422],
    ["motion_behaviors_unavailable", 422],
    ["audio_master_invalid", 422],
    ["audio_master_unavailable", 422],
    ["render_resource_preflight_exceeded", 422],
    ["render_static_sequence_limit_exceeded", 422],
    ["native_text_not_deliverable", 422],
    ["browser_html_typography_unverified", 422],
    ["browser_motion_typography_unverified", 422],
    ["unsupported_frame_lane", 422],
    ["job_queue_full", 429],
    ["job_queue_timeout", 429],
    ["too_many_requests", 429],
    ["agent_unknown", 404],
    ["capability_unavailable", 503],
    ["ffmpeg_not_configured", 503],
    ["gpu_browser_unavailable", 503],
    ["unlisted_unavailable", 500],
    ["gpu_execution_refused", 500],
    ["unlisted_refused", 500],
    ["unlisted_unsupported", 500],
    ["unsupported_unlisted", 500],
    ["render_unlisted_preflight_exceeded", 500],
    ["review_html_bundle_failed", 500]
  ])("maps %s to HTTP %i", (code, status) => {
    expect(statusForRawDebugResult(failed(code))).toBe(status);
  });

  it("changes only raw POST /debug status selection and preserves typed bodies", async () => {
    const server = await startMotionDebugServer({
      port: 0,
      capabilityToken: TOKEN,
      grantedTier: "draft_motion",
      // Keep this test transport-only: a missing scratch root is not retained as an artifact
      // authority, so no package/output path is opened while these refusal envelopes are tested.
      context: { scratchRoot: join(process.cwd(), ".scratch", "debug-http-status-uncreated") },
      useDefaultTemplateRoots: false
    });
    try {
      const unknown = await post(server, { command: "motion.debug.missing", args: {} });
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({
        ok: false,
        command: "motion.debug.missing",
        error: { code: "unknown_command" }
      });

      const unavailable = await post(server, { command: "motion.agent.health", args: {} });
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({
        ok: false,
        command: "motion.agent.health",
        error: { code: "capability_unavailable", message: expect.stringContaining("did not inject") }
      });

      const bodyLimit = await post(server, { command: "x".repeat(1_000_000), args: {} });
      expect(bodyLimit.status).toBe(413);
      expect(await bodyLimit.json()).toMatchObject({
        ok: false,
        error: { code: "invalid_request", message: expect.stringContaining("exceeds 1000000 bytes") }
      });

      const mcp = await globalThis.fetch(new URL("/rpc", server.url), {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "mcp-status-unchanged",
          method: "tools/call",
          params: { name: "motion_agent_health", arguments: { args: {} } }
        })
      });
      expect(mcp.status).toBe(200);
      expect(await mcp.json()).toMatchObject({
        jsonrpc: "2.0",
        id: "mcp-status-unchanged",
        result: { isError: true, structuredContent: { error: { code: "capability_unavailable" } } }
      });

      const jsonRpc = await globalThis.fetch(new URL("/rpc", server.url), {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "json-rpc-status-unchanged",
          method: "motion.debug.dispatch",
          params: { command: "motion.agent.health", args: {} }
        })
      });
      expect(jsonRpc.status).toBe(200);
      expect(await jsonRpc.json()).toMatchObject({
        jsonrpc: "2.0",
        id: "json-rpc-status-unchanged",
        result: { ok: false, command: "motion.agent.health", error: { code: "capability_unavailable" } }
      });
    } finally {
      await server.close();
    }
  });

  it("maps real coordinator terminal-state controls to raw HTTP conflict responses", async () => {
    const root = await testRoot();
    const callerId = "debug-http-status-owner";
    const coordinator = new MotionJobCoordinator({
      leases: new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") }),
      records: new MotionJobRegistry({ recordRoot: join(root, "records") }),
      eventsRoot: join(root, "events")
    });
    const jobId = "debug-http-terminal";
    const submitted = await coordinator.submit({
      jobId,
      callerId,
      lane: "ffmpeg",
      operation: "render.final",
      execute: async () => ({ ok: true })
    });
    expect(submitted).toMatchObject({ ok: true, value: { jobId } });
    await eventually(
      async () => await coordinator.jobView().get({ jobId, callerId }),
      (answer) => answer.ok && answer.job.state === "succeeded"
    );
    const server = await startMotionDebugServer({
      port: 0,
      capabilityToken: TOKEN,
      grantedTier: "render_motion",
      useDefaultTemplateRoots: false,
      context: { callerId, jobCoordinator: coordinator, jobView: coordinator.jobView(), scratchRoot: join(root, "scratch") }
    });
    try {
      const cancelled = await post(server, { command: "motion.job.cancel", args: { jobId } });
      expect(cancelled.status).toBe(409);
      expect(await cancelled.json()).toMatchObject({
        ok: false,
        command: "motion.job.cancel",
        error: { code: "job_not_terminal", suggestedAction: expect.stringMatching(/job id and caller identity/i) }
      });

      const retried = await post(server, { command: "motion.job.retry", args: { jobId } });
      expect(retried.status).toBe(409);
      expect(await retried.json()).toMatchObject({
        ok: false,
        command: "motion.job.retry",
        error: { code: "job_not_retryable", suggestedAction: expect.stringMatching(/retry only a failed job/i) }
      });
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps real streamed-final lane and audio production-handler refusals", async () => {
    const root = await testRoot();
    const scene3dPackage = await writeFinalPackage(root, { scene3dAnimation: true });
    const audioPackage = await writeFinalPackage(root, { audioMaster: true });
    try {
      // The actual HTTP listener has no host-workspace-anchor input by design. On managed WSL,
      // its full POSIX parent walk correctly refuses /home before this handler can see the lane
      // fixture. Invoke the production Debug Server dispatcher in the same opaque host-anchor
      // scope instead: this does not relax topology and keeps the real final-render path covered.
      const anchor = await createTrustedWorkspaceAnchor(root);
      const lane = await withTrustedWorkspaceAnchor(anchor, async () => await dispatchGuarded(
        "motion.render.final",
        { packageRoot: scene3dPackage, outputPath: join(root, "scene3d.mp4"), preset: "mp4-h264", frameLane: "browser" },
        {
          tier: "render_motion",
          jobView: null,
          scratchRoot: join(root, "scratch"),
          ffmpegRunner: async () => ({ exitCode: 0, stdout: "ffmpeg version debug-http-status", stderr: "" })
        }
      ));
      expect(lane).toMatchObject({
        ok: false,
        error: { code: "motion_scene3d_animation_unavailable", message: expect.stringContaining("FFmpeg browser-frame delivery") }
      });

      const audio = await withTrustedWorkspaceAnchor(anchor, async () => await dispatchGuarded(
        "motion.render.final",
        { packageRoot: audioPackage, outputPath: join(root, "audio.mp4"), preset: "mp4-h264", frameLane: "browser" },
        {
          tier: "render_motion",
          jobView: null,
          scratchRoot: join(root, "scratch"),
          ffmpegRunner: async () => ({ exitCode: 0, stdout: "ffmpeg version debug-http-status", stderr: "" })
        }
      ));
      expect(audio).toMatchObject({
        ok: false,
        error: { code: "audio_master_unavailable", message: expect.stringContaining("resolved audio input") }
      });
      expect(statusForRawDebugResult(lane)).toBe(422);
      expect(statusForRawDebugResult(audio)).toBe(422);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an opaque GPU execution-wrapper refusal at HTTP 500", async () => {
    const root = await testRoot();
    const packageRoot = await writeFinalPackage(root);
    const anchor = await createTrustedWorkspaceAnchor(root);
    try {
      // This is the real GPU preview wrapper. Its host runtime seam throws an untyped execution
      // error, which the wrapper deliberately returns as opaque `gpu_execution_refused`.
      const result = await withTrustedWorkspaceAnchor(anchor, async () => await renderMotionGpuPreview(
        await loadMotionPackage(packageRoot),
        {
          outDir: join(root, "gpu-wrapper"),
          sessionOptions: {
            openRuntime: async () => { throw new Error("opaque GPU runtime execution failure"); }
          }
        }
      ));
      expect(result).toMatchObject({
        ok: false,
        error: { code: "gpu_execution_refused", message: "opaque GPU runtime execution failure" }
      });
      if (result.ok) throw new Error("Expected the GPU preview wrapper to refuse the opaque runtime failure.");
      expect(statusForRawDebugResult({ ok: false, error: result.error, warnings: [] })).toBe(500);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps caller-correctable final refusals and missing FFmpeg from production dispatch", async () => {
    const root = await testRoot();
    const plainPackage = await writeFinalPackage(root);
    const resourcePreflightPackage = await writeCallerCorrectableFinalPackage(root, "resource-preflight");
    const staticSequencePackage = await writeCallerCorrectableFinalPackage(root, "static-sequence");
    const nativeTextPackage = await writeCallerCorrectableFinalPackage(root, "native-text");
    const browserHtmlPackage = await writeCallerCorrectableFinalPackage(root, "browser-html");
    const browserMotionPackage = await writeCallerCorrectableFinalPackage(root, "browser-motion");
    const nativeJpegPath = join(root, "native.jpeg");
    const anchor = await createTrustedWorkspaceAnchor(root);
    const dispatchFinal = async (
      args: Parameters<typeof dispatchGuarded>[1],
      context: Omit<Parameters<typeof dispatchGuarded>[2], "tier"> = {}
    ) => await withTrustedWorkspaceAnchor(anchor, async () => await dispatchGuarded(
      "motion.render.final",
      args,
      { tier: "render_motion", jobView: null, scratchRoot: join(root, "scratch"), ...context }
    ));

    try {
      // The raw listener cannot receive an opaque workspace authority. Exercise its production
      // dispatcher under the exact host authority, then assert the raw-route classifier separately.
      const results = [
        ["render_resource_preflight_exceeded", await dispatchFinal({
          packageRoot: resourcePreflightPackage,
          outputPath: join(root, "resource.mp4"),
          qualityManifestPath: join(resourcePreflightPackage, "quality.json"),
          dryRun: true
        }, {
          materializedFrameSequencePreflight: { jobPolicy: { maxProcessTreeRssBytes: 64 * 1024 * 1024 } }
        })],
        ["render_static_sequence_limit_exceeded", await dispatchFinal({
          packageRoot: staticSequencePackage,
          outputPath: join(root, "static.mp4"),
          qualityManifestPath: join(staticSequencePackage, "quality.json"),
          dryRun: true
        })],
        ["native_text_not_deliverable", await dispatchFinal({
          packageRoot: nativeTextPackage,
          outputPath: join(root, "native.mp4"),
          frameLane: "native",
          dryRun: true
        })],
        // This reaches the real final-render handler and returns before any image/output work.
        ["unsupported_frame_lane", await dispatchFinal({
          packageRoot: plainPackage,
          outputPath: nativeJpegPath,
          preset: "jpeg-frame",
          frameLane: "native"
        })],
        ["browser_html_typography_unverified", await dispatchFinal({
          packageRoot: browserHtmlPackage,
          outputPath: join(root, "browser-html.mp4"),
          dryRun: true
        })],
        ["browser_motion_typography_unverified", await dispatchFinal({
          packageRoot: browserMotionPackage,
          outputPath: join(root, "browser-motion.mp4"),
          dryRun: true
        })]
      ] as const;

      for (const [code, result] of results) {
        expect(result).toMatchObject({ ok: false, error: { code } });
        expect(statusForRawDebugResult(result)).toBe(422);
      }
      await expect(access(nativeJpegPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(statusForRawDebugResult(failed("render_unlisted_preflight_exceeded"))).toBe(500);

      let ffmpegProbes = 0;
      const missingFfmpegPath = join(root, "missing-ffmpeg.mp4");
      const missingFfmpeg = await dispatchFinal({
        packageRoot: plainPackage,
        outputPath: missingFfmpegPath,
        preset: "mp4-h264",
        frameLane: "native"
      }, {
        ffmpegRunner: async ({ args }) => {
          ffmpegProbes += 1;
          expect(args).toEqual(["-version"]);
          return { exitCode: 127, stdout: "", stderr: "spawn ffmpeg ENOENT" };
        }
      });
      expect(missingFfmpeg).toMatchObject({
        ok: false,
        error: { code: "ffmpeg_not_configured" }
      });
      expect(statusForRawDebugResult(missingFfmpeg)).toBe(503);
      expect(ffmpegProbes).toBe(1);
      await expect(access(missingFfmpegPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps a host queue-timeout seam and an injected unknown agent", async () => {
    const root = await testRoot();
    const packageRoot = await writeFinalPackage(root);
    const anchor = await createTrustedWorkspaceAnchor(root);
    const server = await startMotionDebugServer({
      port: 0,
      capabilityToken: TOKEN,
      grantedTier: "draft_motion",
      useDefaultTemplateRoots: false,
      // Keep an absent explicit scratch root: the raw prompt refusal opens no artifacts, while
      // the Debug Server must not retain the managed-WSL default path for this transport test.
      context: { scratchRoot: join(root, "scratch"), promptRuntime: unknownAgentRuntime }
    });
    try {
      // See the anchor note above: this is the final production dispatch seam, retained as a
      // direct call only because managed WSL correctly blocks caller-owned /home ancestors.
      const queueTimeout = await withTrustedWorkspaceAnchor(anchor, async () => await dispatchGuarded(
        "motion.render.final",
        { packageRoot, outputPath: join(root, "queue-timeout.mp4"), preset: "mp4-h264", frameLane: "browser" },
        {
          tier: "render_motion",
          jobView: null,
          scratchRoot: join(root, "scratch"),
          ffmpegRunner: async () => ({ exitCode: 0, stdout: "ffmpeg version debug-http-status", stderr: "" }),
          streamingFinalRenderer: queueTimeoutRenderer
        }
      ));
      expect(queueTimeout).toMatchObject({
        ok: false,
        error: { code: "job_queue_timeout", message: "The host queue timed out before admission." }
      });
      expect(statusForRawDebugResult(queueTimeout)).toBe(429);

      const unknownAgent = await post(server, {
        command: "motion.prompt.run",
        args: { request: "inspect the package", agentId: "not-configured" }
      });
      expect(unknownAgent.status).toBe(404);
      expect(await unknownAgent.json()).toMatchObject({
        ok: false,
        command: "motion.prompt.run",
        error: { code: "agent_unknown", message: expect.stringContaining("not-configured is not configured") }
      });
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
