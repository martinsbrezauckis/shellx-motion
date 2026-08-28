/**
 * workbench-readiness-contract.test.ts — the three states the browser readiness surfaces may show.
 *
 * Covers the readiness-parity invariant's UI half. The workbench render dialog and the About page both read
 * `motion.platform.requirements`, and both got it wrong in ways that are invisible to a shape test:
 *
 *   - the render dialog built "final encode unavailable" from EVERY non-ready tool, so a machine
 *     with FFmpeg present and FFprobe missing was told it could not encode;
 *   - both surfaces HID their readiness row when the probe or transport failed, and an absent row is
 *     indistinguishable from a healthy machine — the failure state rendered as the success state.
 *
 * Method, following `workbench-contract.test.ts`: start a REAL debug server, dispatch the REAL
 * command over HTTP, lift the browser's `@contract` binding out of the shipped `.js` (the exact code
 * the browser runs, not a copy) and run it on the real response. `ready` and `blocked` are produced
 * by injecting an `ffmpegRunner` into the server context — which is also an end-to-end proof that
 * `motion.platform.requirements` now answers about the host's own render runner. `unverified` is
 * driven by handing the binding the null a failed `fetch`/`api` call yields in the browser.
 *
 * NOT covered here: the rendered pixels. These tests prove the state machine and every string it
 * produces; they do not open a browser, so the visual appearance of the row is unobserved.
 *
 * Dependencies: `./index` (real server), `../workbench/workbench.js`, `../workbench/about.js`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { MotionToolName } from "@shellx-motion/core";
import { pinMotionToolExecutables, type MotionToolPins } from "@shellx-motion/core/test-support";
import type { MotionDebugContext } from "@shellx-motion/debug-api";
import { startMotionDebugServer, type MotionDebugServerHandle } from "./index";

/**
 * The host FFmpeg seam, taken from the debug context rather than imported from renderer-ffmpeg:
 * this package does not depend on renderer-ffmpeg, and the context is the door a host actually
 * injects through — which is the thing under test.
 */
type FfmpegRunner = NonNullable<MotionDebugContext["ffmpegRunner"]>;

const servers: MotionDebugServerHandle[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const WORKBENCH_JS = fileURLToPath(new URL("../workbench/workbench.js", import.meta.url));
const WORKBENCH_HTML = fileURLToPath(new URL("../workbench/index.html", import.meta.url));
const WORKBENCH_CSS = fileURLToPath(new URL("../workbench/workbench.css", import.meta.url));
const ABOUT_JS = fileURLToPath(new URL("../workbench/about.js", import.meta.url));
const TEST_CAPABILITY_TOKEN = "workbench-readiness-token-000000000000000000000";

interface RenderReadinessView {
  state: "ready" | "blocked" | "unverified";
  label: string;
  detail: string;
  blockedBy: string[];
  quality: string;
}

interface ToolReadinessView {
  state: "verified" | "unverified";
  tools: Array<{ name: string; value: string }>;
  note: string;
}

interface GpuReadinessView {
  state: "available" | "requires-hardware-proof" | "unsupported" | "unverified";
  label: string;
  detail: string;
  refusals: Array<{ code: string; message: string }>;
}

interface ActiveGpuProofView {
  state: "available" | "unverified";
  label: string;
  detail: string;
  fingerprint?: string;
  sha256?: string;
}

/**
 * Lift a named function out of a browser source and make it callable here.
 *
 * Brace-matched from the declaration so the extracted text is the real body, and evaluated in
 * isolation — which is also what proves the function is genuinely self-contained. A closure
 * dependency makes this throw, which is the point.
 */
async function liftBrowserFunction<T extends (...args: never[]) => unknown>(source: string, name: string): Promise<T> {
  const text = await readFile(source, "utf8");
  const declaration = text.indexOf(`function ${name}(`);
  expect(declaration, `${source} must declare ${name}`).toBeGreaterThan(-1);
  const bodyStart = text.indexOf("{", declaration);
  let depth = 0;
  let end = -1;
  for (let index = bodyStart; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) { end = index + 1; break; }
    }
  }
  expect(end, `${name} in ${source} must have a balanced body`).toBeGreaterThan(-1);
  // Trust boundary: the evaluated text is a repo-owned source file addressed by a path derived from
  // import.meta.url — never request data and never a test input.
  return new Function(`"use strict"; return (${text.slice(declaration, end)});`)() as T;
}

/** Start a real loopback server with an injected FFmpeg runner and return a POST /debug dispatcher. */
async function debugServer(ffmpegRunner?: FfmpegRunner) {
  const handle = await startMotionDebugServer({
    host: "127.0.0.1",
    port: 0,
    capabilityToken: TEST_CAPABILITY_TOKEN,
    grantedTier: "read_motion",
    context: ffmpegRunner ? { ffmpegRunner } : {}
  });
  servers.push(handle);
  return async (args: unknown = {}) => {
    const response = await fetch(new URL("/debug", handle.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CAPABILITY_TOKEN}` },
      body: JSON.stringify({ command: "motion.platform.requirements", args, requestedTier: "read_motion" })
    });
    return await response.json() as { ok: boolean; result?: Record<string, unknown> };
  };
}

/**
 * The three external tools, pinned to paths this suite created, for every test in this file.
 *
 * The server under test runs a REAL platform probe, and that probe resolves a real executable path
 * from the real machine before the injected runner is ever consulted. So without a pin these fixture
 * machines are only as reliable as the fixture's ability to recognise whatever browser the host
 * carries — and it could not: `/^(chrome|chromium|google chrome)/i` does not match
 * `/usr/bin/google-chrome`, so on CI the browser probe was classified as FFmpeg and two of these
 * tests failed for a reason none of them is about.
 */
let pins: MotionToolPins;
beforeAll(() => { pins = pinMotionToolExecutables("workbench-readiness"); });
afterAll(() => pins.release());

/**
 * Which of the three external tools a fixture machine has.
 *
 * Matched on the exact pinned path, so no name heuristic decides what a probe was asking about. An
 * executable this suite did not pin throws a distinguishable error rather than being sorted into
 * some tool's answer: it means the pin is not in force, which is a different failure from "this
 * fixture machine does not have that tool".
 */
function machineWith(tools: ReadonlyArray<MotionToolName>): FfmpegRunner {
  return async (command) => {
    const tool = pins.toolFor(command.executable);
    if (!tool) throw new Error(`This suite pinned the tool executables, but the probe resolved ${command.executable}.`);
    if (!tools.includes(tool)) throw Object.assign(new Error(`spawn ${command.executable} ENOENT`), { code: "ENOENT" });
    return { exitCode: 0, stdout: `${tool} version 7.1-fixture`, stderr: "" };
  };
}

/** Every tool answers a version probe: the machine can encode, read back and rasterize. */
const ALL_READY = machineWith(["ffmpeg", "ffprobe", "chromium"]);

/** FFmpeg and the browser are fine; FFprobe is not installed. The case the dialog used to misreport. */
const FFPROBE_ABSENT = machineWith(["ffmpeg", "chromium"]);

/** FFmpeg is not installed. A genuine `render.final` blocker. */
const FFMPEG_ABSENT = machineWith(["ffprobe", "chromium"]);

/**
 * FFmpeg and FFprobe are installed; no browser is. The lane-dependence case, and the one the
 * workbench most needs to get right: its default Browser render drives `motion.render.final`
 * through the browser lane, so here Chromium really is an encode blocker for that selected lane.
 */
const CHROMIUM_ABSENT = machineWith(["ffmpeg", "ffprobe"]);

/** Nothing is installed — the case that exposed the "every non-ready tool is a blocker" bug. */
const BOTH_ABSENT = machineWith([]);

describe("workbench render dialog — readiness row states", () => {
  it("READY: names the encoder and reports quality readback separately", async () => {
    const dispatch = await debugServer(ALL_READY);
    const view = await liftBrowserFunction<(result: unknown) => RenderReadinessView>(WORKBENCH_JS, "readRenderReadinessView");

    const response = await dispatch({ operation: "render.final" });
    expect(response.ok).toBe(true);
    const row = view(response.result);

    expect(row.state).toBe("ready");
    expect(row.label).toBe("This machine can encode final media.");
    expect(row.detail).toContain("ffmpeg version 7.1-fixture");
    expect(row.detail).toContain("Quality readback available");
    expect(row.blockedBy).toEqual([]);
  }, 45_000);

  it("READY with FFprobe missing: still ready, and FFprobe is reported as a quality-readback fact", async () => {
    const dispatch = await debugServer(FFPROBE_ABSENT);
    const view = await liftBrowserFunction<(result: unknown) => RenderReadinessView>(WORKBENCH_JS, "readRenderReadinessView");

    const response = await dispatch({ operation: "render.final" });
    const row = view(response.result);

    // THE bug: this row used to read "Final encode is unavailable: ffprobe is missing" for a
    // machine whose encode the engine would have completed.
    expect(row.state).toBe("ready");
    expect(row.blockedBy).toEqual([]);
    expect(row.label).not.toContain("unavailable");
    expect(row.quality).toBe("Quality readback unavailable: ffprobe is missing. Encoding is unaffected.");
    expect(row.detail).toContain("Encoding is unaffected");
  }, 45_000);

  it("BLOCKED: only a real render.final blocker blocks, with the install commands", async () => {
    const dispatch = await debugServer(FFMPEG_ABSENT);
    const view = await liftBrowserFunction<(result: unknown) => RenderReadinessView>(WORKBENCH_JS, "readRenderReadinessView");

    const response = await dispatch({ operation: "render.final" });
    const row = view(response.result);

    expect(row.state).toBe("blocked");
    expect(row.blockedBy).toEqual(["ffmpeg"]);
    expect(row.label).toBe("Final encode is unavailable: ffmpeg is missing.");
    expect(row.detail).toContain("Install:");
    // FFprobe is ready here, so the row says so instead of staying silent about the readback.
    expect(row.quality).toContain("Quality readback available");
  }, 45_000);

  it("BLOCKED on a browser-less machine: the dialog says so instead of offering a render that fails", async () => {
    const dispatch = await debugServer(CHROMIUM_ABSENT);
    const view = await liftBrowserFunction<(result: unknown) => RenderReadinessView>(WORKBENCH_JS, "readRenderReadinessView");

    const response = await dispatch({ operation: "render.final" });
    const row = view(response.result);

    // Before Chromium was modelled this row read "This machine can encode final media." and the
    // submitted render died on "No Chrome/Chromium executable found for browser renderer".
    expect(row.state).toBe("blocked");
    expect(row.blockedBy).toEqual(["chromium"]);
    expect(row.label).toBe("Final encode is unavailable: chromium is missing.");
    // The install commands offered are the browser's, not FFmpeg's.
    expect(row.detail).toContain("npx playwright-core install chromium");
    // Encoding and readback are both fine; only the rasterizer is absent.
    expect(row.quality).toContain("Quality readback available");
  }, 45_000);

  it("BLOCKED with both tools absent: FFprobe is NOT named as preventing the encode", async () => {
    const dispatch = await debugServer(BOTH_ABSENT);
    const view = await liftBrowserFunction<(result: unknown) => RenderReadinessView>(WORKBENCH_JS, "readRenderReadinessView");

    const response = await dispatch({ operation: "render.final" });
    const row = view(response.result);

    // The exact regression the regression named: the previous binding listed EVERY non-ready tool, so
    // this said "Final encode is unavailable: ffmpeg is missing, ffprobe is missing." — untrue of
    // FFprobe, which the scoped operation does not treat as a render.final blocker. Chromium IS one,
    // so it belongs here and FFprobe still does not: the scoping is by operation, not by count.
    expect(row.state).toBe("blocked");
    expect(row.blockedBy).toEqual(["ffmpeg", "chromium"]);
    expect(row.label).toBe("Final encode is unavailable: ffmpeg is missing, chromium is missing.");
    expect(row.label).not.toContain("ffprobe");
    // FFprobe still gets reported — as the readback fact it is, not as an encode blocker.
    expect(row.quality).toBe("Quality readback unavailable: ffprobe is missing. Encoding is unaffected.");
  }, 45_000);

  it("UNVERIFIED: a failed probe produces a row that says so, never an absent row", async () => {
    const view = await liftBrowserFunction<(result: unknown) => RenderReadinessView>(WORKBENCH_JS, "readRenderReadinessView");

    // What the browser has after `api(...)` throws: no result at all.
    for (const failure of [null, undefined, {}, { ok: false }, { ok: true, platform: { tools: [] } }]) {
      const row = view(failure);
      expect(row.state).toBe("unverified");
      expect(row.label).toBe("Could not verify what this machine can render.");
      expect(row.detail).toContain("did not answer");
      expect(row.blockedBy).toEqual([]);
    }
  });
});

describe("workbench GPU lane — source-only readiness states", () => {
  it("requires active hardware proof even when the source-only record finds trusted Chromium", async () => {
    const view = await liftBrowserFunction<(result: unknown) => GpuReadinessView>(WORKBENCH_JS, "readGpuReadinessView");

    const row = view({
      ok: true,
      gpu: {
        status: "requires-hardware-proof",
        trustedChromium: { status: "present", source: "playwright", version: "Chromium 129" },
        adapterDeviceProof: { status: "not-tested", requiredCommand: "host-owned motion.platform.gpu.probe" },
        refusals: [{
          code: "gpu_hardware_proof_required",
          message: "Trusted Chromium is present, but this source-only check did not launch WebGPU. Supply a fresh host-owned active GPU proof to establish adapter and device readiness."
        }]
      }
    });

    // A Chromium version source is not a WebGPU adapter/device probe, so a clean fixture remains
    // explicitly unproven. This is deliberately a browser-only fixture: it never launches Chromium.
    expect(row.state).toBe("requires-hardware-proof");
    expect(row.label).toBe("GPU hardware proof is required.");
    expect(row.detail).toContain("source-only check did not launch WebGPU");
    expect(row.refusals.map((refusal) => refusal.code)).toContain("gpu_hardware_proof_required");
  }, 45_000);

  it("preserves typed source refusals without turning them into an availability claim", async () => {
    const view = await liftBrowserFunction<(result: unknown) => GpuReadinessView>(WORKBENCH_JS, "readGpuReadinessView");

    const row = view({
      ok: true,
      gpu: {
        status: "requires-hardware-proof",
        refusals: [{
          code: "gpu_prior_receipt_not_live_proof",
          message: "A prior GPU preview or render receipt is not live adapter/device proof for the currently selected browser."
        }]
      }
    });

    expect(row.state).toBe("requires-hardware-proof");
    expect(row.label).toBe("GPU hardware proof is required.");
    expect(row.detail).toContain("prior GPU preview or render receipt");
    expect(row.refusals).toEqual([{
      code: "gpu_prior_receipt_not_live_proof",
      message: "A prior GPU preview or render receipt is not live adapter/device proof for the currently selected browser."
    }]);
  });

  it("shows active GPU readiness only from an explicit active-proof source record", async () => {
    const view = await liftBrowserFunction<(result: unknown) => GpuReadinessView>(WORKBENCH_JS, "readGpuReadinessView");

    const row = view({
      ok: true,
      gpu: {
        status: "available",
        adapterDeviceProof: { status: "active-host-proof", adapterFingerprint: "adapter-proof-7a" },
        refusals: []
      }
    });

    expect(row.state).toBe("available");
    expect(row.label).toBe("GPU hardware proof is active.");
    expect(row.detail).toContain("fresh adapter/device proof");
    expect(row.detail).toContain("adapter-proof-7a");
  });

  it("refuses a forged available status without a bounded active adapter/device proof", async () => {
    const view = await liftBrowserFunction<(result: unknown) => GpuReadinessView>(WORKBENCH_JS, "readGpuReadinessView");

    for (const adapterDeviceProof of [
      undefined,
      { status: "not-tested", adapterFingerprint: "adapter-proof-7a" },
      { status: "active-host-proof", adapterFingerprint: "" },
      { status: "active-host-proof", adapterFingerprint: "a".repeat(513) }
    ]) {
      const row = view({ ok: true, gpu: { status: "available", adapterDeviceProof, refusals: [] } });
      expect(row.state).toBe("unverified");
      expect(row.label).toBe("Could not verify GPU readiness.");
      expect(row.detail).toContain("no hardware availability is claimed");
    }
  });

  it("keeps a failed GPU readiness request visibly unverified", async () => {
    const view = await liftBrowserFunction<(result: unknown) => GpuReadinessView>(WORKBENCH_JS, "readGpuReadinessView");

    for (const failure of [null, undefined, {}, { ok: false }, { ok: true, gpu: { status: "unknown" } }]) {
      const row = view(failure);
      expect(row.state).toBe("unverified");
      expect(row.label).toBe("Could not verify GPU readiness.");
      expect(row.detail).toContain("no hardware availability is claimed");
    }
  });

  it("binds strict preview and final requests to the published GPU lane fields", async () => {
    const source = await readFile(WORKBENCH_JS, "utf8");

    expect(source).toContain('api("motion.preview.frame", { packageRoot: state.packageRoot, lane, atMs: requestedAtMs }, "render_motion")');
    expect(source).toMatch(/preset,\s+frameLane,\s+jobId,/);
    expect(source).toContain('![' + '"mp4-h264", "webm-vp9", "webm-vp9-alpha", "mov-prores"' + '].includes(preset)');
    expect(source).toContain('...(manifest && frameLane !== "gpu" ? { qualityManifestPath: manifest } : {})');
  });

  it("offers both opaque and transparent streamed GPU final presets without enabling still delivery", async () => {
    const [html, source] = await Promise.all([
      readFile(WORKBENCH_HTML, "utf8"),
      readFile(WORKBENCH_JS, "utf8")
    ]);

    for (const preset of ["mp4-h264", "webm-vp9", "webm-vp9-alpha", "mov-prores"]) {
      expect(html).toContain(`option value="${preset}"`);
      expect(source).toContain(`"${preset}"`);
    }
    expect(source).toContain('"webm-vp9-alpha": ".webm"');
    expect(source).toContain('"mov-prores": ".mov"');
    expect(html).toContain("preserve the straight-RGBA transport for transparent delivery");
  });

  it("exposes the explicit governed active proof without turning the source-only check into a hardware claim", async () => {
    const [html, source] = await Promise.all([
      readFile(WORKBENCH_HTML, "utf8"),
      readFile(WORKBENCH_JS, "utf8")
    ]);

    expect(html).toContain('id="gpuProofButton"');
    expect(source).toContain('api("motion.platform.gpu.probe", { confirm: true }, "render_motion")');
    expect(source).toContain('ui.gpuProofButton.disabled = !state.connected || !tierAllows(state.grantedTier, "render_motion")');
    expect(source).toContain("function readActiveGpuProofView(answer)");
    expect(source).toContain('proof.schema === "shellx-motion/gpu-active-host-proof@1"');
    expect(source).toContain('receipt.operation === "gpu.hardware.probe"');
    expect(source).toContain("frame.width === 4");
    expect(source).toContain('/^[a-f0-9]{64}$/.test(sha256)');
    expect(source).toContain("Motion returned an incomplete active GPU proof");
    expect(source).toContain("const view = readActiveGpuProofView(answer);");
  });

  it("accepts only a complete active GPU proof in the executable Workbench binding", async () => {
    const view = await liftBrowserFunction<(answer: unknown) => ActiveGpuProofView>(WORKBENCH_JS, "readActiveGpuProofView");
    const row = view({
      ok: true,
      result: {
        proof: {
          schema: "shellx-motion/gpu-active-host-proof@1",
          runtime: { adapterFingerprint: "b".repeat(64) },
          receipt: { operation: "gpu.hardware.probe", status: "passed" }
        },
        frame: { width: 4, height: 4, sha256: "c".repeat(64) }
      }
    });

    expect(row.state).toBe("available");
    expect(row.label).toBe("GPU hardware proof passed.");
    expect(row.detail).toContain("governed 4 × 4 hardware frame");
    expect(row.fingerprint).toBe("b".repeat(64));
    expect(row.sha256).toBe("c".repeat(64));

    // The function is extracted and evaluated in isolation above. This asserts that the UI click
    // handler uses that same executable validator instead of keeping a second inline parser.
    const source = await readFile(WORKBENCH_JS, "utf8");
    expect(source).toContain("const view = readActiveGpuProofView(answer);");
  }, 45_000);

  it("fails closed when any bounded active-proof evidence is absent or malformed", async () => {
    const view = await liftBrowserFunction<(answer: unknown) => ActiveGpuProofView>(WORKBENCH_JS, "readActiveGpuProofView");
    const complete = {
      ok: true,
      result: {
        proof: {
          schema: "shellx-motion/gpu-active-host-proof@1",
          runtime: { adapterFingerprint: "a".repeat(512) },
          receipt: { operation: "gpu.hardware.probe", status: "passed" }
        },
        frame: { width: 4, height: 4, sha256: "b".repeat(64) }
      }
    };
    const malformed = [
      null,
      { ...complete, ok: false },
      { ...complete, result: { ...complete.result, proof: { ...complete.result.proof, schema: "unexpected" } } },
      { ...complete, result: { ...complete.result, proof: { ...complete.result.proof, receipt: { operation: "render.final", status: "passed" } } } },
      { ...complete, result: { ...complete.result, proof: { ...complete.result.proof, receipt: { operation: "gpu.hardware.probe", status: "failed" } } } },
      { ...complete, result: { ...complete.result, frame: { width: 3, height: 4, sha256: "b".repeat(64) } } },
      { ...complete, result: { ...complete.result, frame: { width: 4, height: 4, sha256: "not-a-sha" } } },
      { ...complete, result: { ...complete.result, proof: { ...complete.result.proof, runtime: { adapterFingerprint: "" } } } },
      { ...complete, result: { ...complete.result, proof: { ...complete.result.proof, runtime: { adapterFingerprint: "   " } } } },
      { ...complete, result: { ...complete.result, proof: { ...complete.result.proof, runtime: { adapterFingerprint: "a".repeat(513) } } } }
    ];

    for (const answer of malformed) {
      const row = view(answer);
      expect(row.state).toBe("unverified");
      expect(row.label).toBe("GPU hardware proof did not pass.");
      expect(row.detail).toContain("hardware availability was not accepted");
    }
  });

  it("keeps strict GPU preview identity and one readiness announcer across compact and dialog states", async () => {
    const [html, source, css] = await Promise.all([
      readFile(WORKBENCH_HTML, "utf8"),
      readFile(WORKBENCH_JS, "utf8"),
      readFile(WORKBENCH_CSS, "utf8")
    ]);

    expect(html).toContain('id="previewRegion" aria-label="Browser preview monitor"');
    expect(html).toContain('id="previewImage" alt="Browser-rendered Motion preview"');
    expect(html).toContain('id="previewControlsScrollHint"');
    expect(html).toContain('id="renderGpuReadiness" hidden role="note" aria-live="off"');
    expect(source).toContain('"Strict GPU-rendered Motion preview"');
    expect(source).toContain("function updateGpuReadinessAnnouncement()");
    expect(source).toContain('ui.gpuReadiness.setAttribute("aria-live", announceInRenderDialog ? "off" : "polite")');
    expect(source).toContain('ui.renderGpuReadiness.setAttribute("aria-live", announceInRenderDialog ? "polite" : "off")');
    expect(css).toContain("max-height: calc(100dvh - 30px)");
    expect(css).toContain("scroll-snap-type: x proximity");
    expect(css).toContain(".compact-scroll-cue { display: inline-flex");
  });
});

describe("workbench About page — external tool readiness states", () => {
  it("VERIFIED: lists every tool and derives blockers from operations[].blockedBy", async () => {
    const dispatch = await debugServer(FFPROBE_ABSENT);
    const view = await liftBrowserFunction<(result: unknown) => ToolReadinessView>(ABOUT_JS, "readToolReadinessView");

    const response = await dispatch({});
    const block = view(response.result);

    expect(block.state).toBe("verified");
    expect(block.tools).toEqual([
      { name: "ffmpeg", value: "Ready" },
      { name: "ffprobe", value: "missing" },
      { name: "chromium", value: "Ready" }
    ]);
    // Scoped by operation: the missing FFprobe blocks quality.check, and nothing else.
    expect(block.note).toBe("Unavailable here: quality.check (needs ffprobe).");
  }, 45_000);

  it("VERIFIED and healthy: says every tool is present", async () => {
    const dispatch = await debugServer(ALL_READY);
    const view = await liftBrowserFunction<(result: unknown) => ToolReadinessView>(ABOUT_JS, "readToolReadinessView");

    const block = view((await dispatch({})).result);

    expect(block.state).toBe("verified");
    expect(block.note).toContain("Every external tool Motion needs is present");
  }, 45_000);

  it("UNVERIFIED: a failed probe keeps the block, valued 'could not verify'", async () => {
    const view = await liftBrowserFunction<(result: unknown) => ToolReadinessView>(ABOUT_JS, "readToolReadinessView");

    for (const failure of [null, undefined, {}, { ok: true, platform: { tools: [] } }]) {
      const block = view(failure);
      expect(block.state).toBe("unverified");
      // The rows stay: an empty identity block reads as "nothing is wrong". All three of them —
      // omitting Chromium would understate the dependency set a user is being told to go check.
      expect(block.tools).toEqual([
        { name: "ffmpeg", value: "could not verify" },
        { name: "ffprobe", value: "could not verify" },
        { name: "chromium", value: "could not verify" }
      ]);
      expect(block.note).toContain("Could not verify");
      // And it must not be mistaken for a report that something is missing.
      expect(block.note).toContain("not a report that anything is missing");
    }
  });
});
