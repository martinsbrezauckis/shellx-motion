/**
 * workbench-contract.test.ts — server-to-browser contract tests for the workbench.
 *
 * Why this file exists: the browser surfaces are plain static JS served by this
 * package, so nothing type-checked them against the Debug API responses they read.
 * Both receipts panels drifted onto `result.receipts` / `result.rows` — fields the
 * server has never emitted — and every valid receipt rendered as "No receipts
 * found" with no test failing. A shape assertion written by hand would have drifted
 * with them, so these tests do three things instead:
 *
 *   1. start a REAL debug server and dispatch the REAL command over HTTP;
 *   2. lift the browser's binding function out of the shipped `.js` by its
 *      `@contract` marker (the exact code the browser runs — not a copy);
 *   3. run that function on the real response and assert on what it returns.
 *
 * A field rename on the server therefore fails here even though the browser code
 * is untyped. The `@contract` marked functions are kept self-contained in the
 * browser sources precisely so they can be extracted and executed here.
 *
 * Covered contracts: motion.receipts.panel, motion.timeline.panel (the
 * motion-density render gate) and motion.job.get (the render progress view).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { MotionJobLeaseDirectory, MotionJobRegistry, MotionJobView } from "@shellx-motion/core";
import { startMotionDebugServer, type MotionDebugServerHandle } from "./index";

const servers: MotionDebugServerHandle[] = [];
const tempRoots: string[] = [];
const TERMINAL_JOB_FIXTURE_NOW_MS = 1_785_681_431_004;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Shipped browser sources, addressed relative to this file so cwd cannot matter. */
const BROWSER_SOURCES = {
  workbench: fileURLToPath(new URL("../workbench/workbench.js", import.meta.url))
} as const;

/** Repo-root fixtures/templates used as real packages for the timeline contract. */
const STATIC_PACKAGE_ROOT = fileURLToPath(new URL("../../../fixtures/packages/lower-third", import.meta.url));
const MOTION_PACKAGE_ROOT = fileURLToPath(new URL("../../../templates/shellx-product-pack/feature-announcement", import.meta.url));

/**
 * Lift a named function out of a browser source and make it callable here.
 *
 * Brace-matched from the declaration so the extracted text is the real body, and
 * evaluated in isolation — which is also what proves the function is genuinely
 * self-contained. If someone gives it a closure dependency, this throws.
 *
 * @param source Absolute path to the browser `.js` file.
 * @param name The exported-by-convention function name to lift.
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
  const declarationText = text.slice(declaration, end);
  // Trust boundary: the evaluated text is a repo-owned source file addressed by a
  // path derived from import.meta.url — never request data and never a test input.
  // Executing the shipped browser code verbatim is the whole point of this test;
  // a hand-copied duplicate would drift alongside the bug it is meant to catch.
  return new Function(`"use strict"; return (${declarationText});`)() as T;
}

interface ReceiptsPanelView {
  rows: Array<Record<string, unknown>>;
  receiptCount: number;
  failedCount: number;
  warningCount: number;
  truncated: boolean;
}

interface MotionRequirementView {
  requiresMotion: boolean;
  reasons: string[];
}

interface JobStatusView {
  state: string;
  ended: boolean;
  started: boolean;
  pollAfterMs: number;
  label: string;
  detail: string;
}

const TEST_CAPABILITY_TOKEN = "workbench-contract-token-0000000000000000000000";

/** Start a real loopback server and return an authenticated POST /debug dispatcher. */
async function debugServer(context: Record<string, unknown> = {}) {
  const handle = await startMotionDebugServer({
    host: "127.0.0.1",
    port: 0,
    capabilityToken: TEST_CAPABILITY_TOKEN,
    grantedTier: "render_motion",
    context: { renderPackageRoots: [STATIC_PACKAGE_ROOT, MOTION_PACKAGE_ROOT], ...context }
  });
  servers.push(handle);
  const dispatch = async (command: string, args: unknown = {}, requestedTier = "read_motion") => {
    const response = await fetch(new URL("/debug", handle.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CAPABILITY_TOKEN}` },
      body: JSON.stringify({ command, args, requestedTier })
    });
    return await response.json() as { ok: boolean; result?: Record<string, unknown>; error?: { code: string } };
  };
  return { handle, dispatch };
}

/** A minimal but real `shellx-motion/receipt@1` file the receipts reader accepts. */
async function writeReceipt(root: string, file: string, receipt: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, file), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function receipt(input: { id: string; operation: string; status: string; createdAt: string; outputPath: string; warnings?: string[] }): Record<string, unknown> {
  return {
    schema: "shellx-motion/receipt@1",
    id: input.id,
    operation: input.operation,
    status: input.status,
    packageId: "pkg_contract",
    inputHashes: { motion: "a".repeat(64) },
    createdAt: input.createdAt,
    lane: "ffmpeg",
    output: { path: input.outputPath },
    artifacts: [{ role: "rendered_media", path: input.outputPath, status: "available", mediaType: "video/mp4", primary: true }],
    warnings: input.warnings ?? []
  };
}

describe("motion.receipts.panel — the field both browser panels bind to", () => {
  it.each(Object.entries(BROWSER_SOURCES))(
    "%s reads the rows a real motion.receipts.panel response carries",
    async (_name, source) => {
      const root = await mkdtemp(join(tmpdir(), "shellx-motion-workbench-contract-"));
      tempRoots.push(root);
      await writeReceipt(root, "render.receipt.json", receipt({
        id: "render-contract-1", operation: "render.final", status: "passed",
        createdAt: "2026-08-01T10:00:00.000Z", outputPath: join(root, "out.mp4")
      }));
      await writeReceipt(root, "preview.receipt.json", receipt({
        id: "preview-contract-1", operation: "preview.frame", status: "warning",
        createdAt: "2026-08-01T09:00:00.000Z", outputPath: join(root, "frame.png"), warnings: ["font fallback"]
      }));
      // The host nominates the receipt root; a caller naming its own is refused by the
      // Debug API receipts fence, which is the trust model the shipped server now runs.
      const { dispatch } = await debugServer({ receiptsRoot: root });
      const readRows = await liftBrowserFunction<(result: unknown) => ReceiptsPanelView>(source, "readReceiptsPanelRows");

      const response = await dispatch("motion.receipts.panel", { receiptsRoot: root, limit: 20 });
      expect(response.ok).toBe(true);
      const view = readRows(response.result);

      // The bug this test exists for: two valid receipts rendering as "none found".
      expect(view.rows).toHaveLength(2);
      expect(view.rows.map((row) => row.id)).toEqual(["render-contract-1", "preview-contract-1"]);
      expect(view.receiptCount).toBe(2);
      expect(view.warningCount).toBe(1);
      expect(view.truncated).toBe(false);
      // Every field the row renderers read must actually be present on a real row.
      expect(view.rows[0]).toMatchObject({ operation: "render.final", status: "passed", createdAt: "2026-08-01T10:00:00.000Z" });
    },
    30000
  );

  it.each(Object.entries(BROWSER_SOURCES))(
    "%s reports a capped page as a page, not as the whole root",
    async (_name, source) => {
      const root = await mkdtemp(join(tmpdir(), "shellx-motion-workbench-contract-"));
      tempRoots.push(root);
      for (let index = 0; index < 4; index += 1) {
        await writeReceipt(root, `render-${index}.receipt.json`, receipt({
          id: `render-contract-${index}`, operation: "render.final", status: "passed",
          createdAt: `2026-08-0${index + 1}T10:00:00.000Z`, outputPath: join(root, `out-${index}.mp4`)
        }));
      }
      // The host nominates the receipt root; a caller naming its own is refused by the
      // Debug API receipts fence, which is the trust model the shipped server now runs.
      const { dispatch } = await debugServer({ receiptsRoot: root });
      const readRows = await liftBrowserFunction<(result: unknown) => ReceiptsPanelView>(source, "readReceiptsPanelRows");

      const response = await dispatch("motion.receipts.panel", { receiptsRoot: root, limit: 2 });
      const view = readRows(response.result);

      // `recentReceipts` is limit-capped while `receiptCount` counts the root, so a
      // surface that showed only rows.length would under-report a busy root.
      expect(view.rows).toHaveLength(2);
      expect(view.receiptCount).toBe(4);
      expect(view.truncated).toBe(true);
    },
    30000
  );

  it("returns no rows for the fields the browsers used to read", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-workbench-contract-"));
    tempRoots.push(root);
    await writeReceipt(root, "render.receipt.json", receipt({
      id: "render-contract-1", operation: "render.final", status: "passed",
      createdAt: "2026-08-01T10:00:00.000Z", outputPath: join(root, "out.mp4")
    }));
    // The host nominates the receipt root; a caller naming its own is refused by the
      // Debug API receipts fence, which is the trust model the shipped server now runs.
      const { dispatch } = await debugServer({ receiptsRoot: root });

    const response = await dispatch("motion.receipts.panel", { receiptsRoot: root, limit: 20 });

    // Pinning the absence documents WHY the old binding failed, so nobody
    // "restores" the fallback thinking it was a harmless belt-and-braces read.
    expect(response.result).not.toHaveProperty("receipts");
    expect(response.result).not.toHaveProperty("rows");
    expect(Array.isArray(response.result?.recentReceipts)).toBe(true);
  }, 45_000);
});

describe("motion.timeline.panel — the motion-density render gate", () => {
  it.each(Object.entries(BROWSER_SOURCES))(
    "%s leaves the gate off for a package that declares no motion",
    async (_name, source) => {
      const { dispatch } = await debugServer();
      const requires = await liftBrowserFunction<(panel: unknown) => MotionRequirementView>(source, "motionDensityRequirement");

      const response = await dispatch("motion.timeline.panel", { packageRoot: STATIC_PACKAGE_ROOT });
      expect(response.ok, JSON.stringify(response.error)).toBe(true);
      const requirement = requires(response.result);

      // fixtures/packages/lower-third is a single full-span text layer with no
      // keyframes and no transitions. Rendered, it produces exactly one unique
      // frame hash — verified against the real engine — so forcing
      // minUniqueFrameHashes: 2 failed a render that did exactly what was asked.
      expect(requirement.requiresMotion).toBe(false);
      expect(requirement.reasons).toEqual([]);
    },
    30000
  );

  it.each(Object.entries(BROWSER_SOURCES))(
    "%s keeps the gate on for a package that declares motion",
    async (_name, source) => {
      const { dispatch } = await debugServer();
      const requires = await liftBrowserFunction<(panel: unknown) => MotionRequirementView>(source, "motionDensityRequirement");

      const response = await dispatch("motion.timeline.panel", { packageRoot: MOTION_PACKAGE_ROOT });
      expect(response.ok, JSON.stringify(response.error)).toBe(true);
      const requirement = requires(response.result);

      // The gate exists to catch a dead render; dropping it for everything would
      // trade one false failure for a silent one.
      expect(requirement.requiresMotion).toBe(true);
      expect(requirement.reasons.join(" ")).toMatch(/transitions|keyframed|enter or leave/);
    },
    30000
  );

  it.each(Object.entries(BROWSER_SOURCES))(
    "%s treats an unreadable timeline as no declared motion rather than guessing",
    async (_name, source) => {
      const requires = await liftBrowserFunction<(panel: unknown) => MotionRequirementView>(source, "motionDensityRequirement");

      expect(requires(undefined)).toEqual({ requiresMotion: false, reasons: [] });
      expect(requires({})).toEqual({ requiresMotion: false, reasons: [] });
    }
  );
});

describe("motion.job.get — the render progress view", () => {
  /** A server whose job surface reads a temp lease/record pair, as a host would. */
  async function jobServer() {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-workbench-jobs-"));
    tempRoots.push(root);
    const leases = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
    const records = new MotionJobRegistry({
      recordRoot: join(root, "records"),
      now: () => TERMINAL_JOB_FIXTURE_NOW_MS
    });
    const { dispatch } = await debugServer({ jobView: new MotionJobView({ leases, records }), callerId: "workbench:contract" });
    return { leases, records, dispatch };
  }

  it("reports a queued job as waiting for a slot, never as rendering", async () => {
    const { leases, dispatch } = await jobServer();
    // admitted:false is exactly how MotionHostJob announces a render before the
    // first governed operation is admitted.
    await leases.announce({ jobId: "workbench:render-pending", lane: "ffmpeg", operation: "render.final", callerId: "workbench:contract", visibility: "host", admitted: false });
    const readJob = await liftBrowserFunction<(job: unknown) => JobStatusView>(BROWSER_SOURCES.workbench, "readJobStatusView");

    const response = await dispatch("motion.job.get", { jobId: "workbench:render-pending" });
    expect(response.ok, JSON.stringify(response.error)).toBe(true);
    const view = readJob((response.result as { job: unknown }).job);

    expect(view.state).toBe("pending");
    expect(view.started).toBe(false);
    expect(view.ended).toBe(false);
    expect(view.label).toBe("Queued");
    // The spec is explicit: pending must not be presented as "rendering".
    expect(view.detail).toMatch(/waiting for a machine slot/i);
    expect(view.detail).not.toMatch(/rendering/i);
    // A poll interval the client can obey, which is also the "keep polling" signal.
    expect(view.pollAfterMs).toBeGreaterThan(0);
  }, 45_000);

  it("reports an admitted job as running with work actually happening", async () => {
    const { leases, dispatch } = await jobServer();
    await leases.announce({ jobId: "workbench:render-running", lane: "ffmpeg", operation: "render.final", callerId: "workbench:contract", visibility: "host", admitted: true });
    const readJob = await liftBrowserFunction<(job: unknown) => JobStatusView>(BROWSER_SOURCES.workbench, "readJobStatusView");

    const response = await dispatch("motion.job.get", { jobId: "workbench:render-running" });
    const view = readJob((response.result as { job: unknown }).job);

    expect(view.state).toBe("running");
    expect(view.started).toBe(true);
    expect(view.ended).toBe(false);
    expect(view.label).toBe("Rendering");
  }, 45_000);

  it("stops polling exactly when the contract says the job will not change again", async () => {
    const { records, dispatch } = await jobServer();
    await records.record({
      schema: "shellx-motion/job-record@1",
      jobId: "workbench:render-done",
      callerId: "workbench:contract",
      lane: "ffmpeg",
      operation: "render.final",
      lifecycle: "ended",
      outcome: "succeeded",
      createdAtMs: 1_785_681_391_000,
      startedAtMs: 1_785_681_391_004,
      endedAtMs: 1_785_681_431_004,
      durationMs: 40_000,
      queueWaitMs: 4,
      warnings: []
    });
    const readJob = await liftBrowserFunction<(job: unknown) => JobStatusView>(BROWSER_SOURCES.workbench, "readJobStatusView");

    const response = await dispatch("motion.job.get", { jobId: "workbench:render-done" });
    expect(response.ok, JSON.stringify(response.error)).toBe(true);
    const view = readJob((response.result as { job: unknown }).job);

    expect(view.state).toBe("succeeded");
    // pollAfterMs absent on a terminal record is the machine-readable stop signal.
    expect(view.pollAfterMs).toBe(0);
    expect(view.ended).toBe(true);
  }, 45_000);

  it("answers a query error as a query error, not as a failed render", async () => {
    const { dispatch } = await jobServer();

    const response = await dispatch("motion.job.get", { jobId: "workbench:render-never-existed" });

    // The poll loop keys off this code to distinguish "not announced yet" from a
    // record that vanished; collapsing it into a render failure is the bug the
    // integration spec warns about.
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("job_unknown");
  }, 45_000);
});
