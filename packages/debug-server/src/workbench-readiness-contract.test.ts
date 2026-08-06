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
import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
 * Which of the three external tools a fixture machine has.
 *
 * Written as an explicit allow-list rather than "throw unless the path says ffprobe", because
 * Chromium's resolved path is whatever browser the HOST happens to carry — a fixture that decides
 * by exclusion silently made every one of these machines browser-less the moment Chromium joined
 * the probe, and the tests then failed for a reason none of them was about.
 */
function machineWith(tools: Array<"ffmpeg" | "ffprobe" | "chromium">): FfmpegRunner {
  return async (command) => {
    const name = (command.executable.split(/[\\/]/).at(-1) ?? "").replace(/\.exe$/i, "");
    const tool = /^(chrome|chromium|google chrome)/i.test(name)
      ? "chromium"
      : name.startsWith("ffprobe") ? "ffprobe" : "ffmpeg";
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
 * workbench most needs to get right: its render dialog drives `motion.render.final`, which
 * rasterizes through the browser lane ONLY, so here Chromium really is an encode blocker with no
 * flag to route around it.
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
