import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { loadMotionPackage, validateAgainstPublishedSchema, type MotionJobStatus, type MotionJobView } from "@shellx-motion/core";
import { debugCommandContract } from "../command-metadata.js";
import {
  AGENT_SNAPSHOT_SCHEMA_DOCUMENT,
  MAX_AGENT_SNAPSHOT_BYTES,
  buildMotionAgentSnapshot,
} from "./agent-snapshot.js";

const LOWER_THIRD = fileURLToPath(new URL("../../../../fixtures/packages/lower-third", import.meta.url));

function snapshotServices(observedAt: string, options: { status?: string; complete?: boolean; jobs?: MotionJobStatus[]; jobCallerId?: string; hostileName?: boolean } = {}) {
  return {
    now: () => new Date(observedAt),
    engineVersion: "0.2.0-test",
    packageLoader: async (root: string) => {
      const pkg = await loadMotionPackage(root);
      return options.hostileName ? { ...pkg, manifest: { ...pkg.manifest, name: `\u001b[31m${"😀".repeat(400)} /host/package/secret` } } : pkg;
    },
    snapshotPackageRoots: [dirname(LOWER_THIRD)],
    receiptsRoot: "/host/receipts",
    snapshotReceiptRoots: ["/host/receipts"],
    isPathInsideTrustedRoot: async (root: string, candidate: string) => root === candidate || candidate.startsWith(`${root}/`),
    readSnapshotTimelineState: async (pkg: Awaited<ReturnType<typeof loadMotionPackage>>) => ({
      state: {
        schema: "shellx-motion/timeline-state@1" as const,
        packageId: pkg.manifest.id,
        motionId: pkg.motion.id,
        durationMs: pkg.motion.durationMs,
        playheadMs: 125,
        selectedRange: { startMs: 10, endMs: 200 },
        viewport: { startMs: 0, endMs: 500, zoom: 1.5 },
        // Deliberately varies with the injected observation clock. Snapshot identity must not.
        updatedAt: observedAt
      },
      statePath: "/host/package/.shellx-motion/timeline-state.json",
      warnings: []
    }),
    readSnapshotReceipts: async () => ({
      complete: options.complete ?? true,
      entries: Array.from({ length: 6 }, (_, index) => ({
        receipt: {
          id: `receipt-${index}`,
          operation: "render.final",
          status: index === 0 ? options.status ?? "passed" : "passed",
          packageId: "lower-third",
          lane: "ffmpeg",
          createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
          warnings: index === 0 ? ["\u001b[31mproblem at /secret/package/output.mp4 and C:\\secret\\artifact.mp4\n"] : []
        }
      }))
    }),
    ...(options.jobs ? {
      jobView: { list: async () => options.jobs ?? [] } as unknown as MotionJobView,
      ...(options.jobCallerId ? { jobCallerId: options.jobCallerId } : {})
    } : {})
  };
}

function job(index: number): MotionJobStatus {
  return {
    schema: "shellx-motion/job-status@1",
    jobId: `job-${index}`,
    callerId: "caller-a",
    lane: "ffmpeg",
    operation: "render.final",
    lifecycle: index === 0 ? "running" : "ended",
    outcome: index === 0 ? null : "succeeded",
    state: index === 0 ? "running" : "succeeded",
    createdAtMs: 1_700_000_000_000 + index,
    cancelRequested: { requestedBy: "caller-a", requestedAtMs: 1_700_000_000_000 + index },
    warnings: Array.from({ length: index }, () => "warning"),
    ...(index === 0 ? { pollAfterMs: 2_000 } : {})
  };
}

describe("motion.agent.snapshot", () => {
  it("has a stable content id across observation clocks and a fully schema-valid bounded projection", async () => {
    const first = await buildMotionAgentSnapshot(
      { packageRoot: LOWER_THIRD, request: "make title blue and preview it" },
      snapshotServices("2026-08-09T00:00:00.000Z", { jobCallerId: "caller-a", jobs: [job(0), job(1), job(2), job(3), job(4)] })
    );
    const second = await buildMotionAgentSnapshot(
      { packageRoot: LOWER_THIRD, request: "make title blue and preview it" },
      snapshotServices("2026-08-09T01:00:00.000Z", { jobCallerId: "caller-a", jobs: [job(0), job(1), job(2), job(3), job(4)] })
    );

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    if (!first.ok || !second.ok) throw new Error("snapshot fixture unexpectedly failed");
    const snapshot = first.result as Record<string, any>;
    expect(snapshot.snapshotId).toBe((second.result as Record<string, unknown>).snapshotId);
    expect(snapshot.observedAt).not.toBe((second.result as Record<string, unknown>).observedAt);
    expect(snapshot.freshness.package.observedAt).not.toBe((second.result as Record<string, any>).freshness.package.observedAt);
    expect(validateAgainstPublishedSchema(AGENT_SNAPSHOT_SCHEMA_DOCUMENT, snapshot)).toEqual([]);
    expect(validateAgainstPublishedSchema(AGENT_SNAPSHOT_SCHEMA_DOCUMENT, {
      ...snapshot,
      state: { ...snapshot.state, motion: { ...snapshot.state.motion, unexpected: true } }
    })).toContainEqual({ path: "/state/motion/unexpected", message: "unexpected property" });
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(MAX_AGENT_SNAPSHOT_BYTES);
    expect(snapshot).toMatchObject({
      schema: "shellx-motion/agent-snapshot@1",
      freshness: { cache: { scope: "private", mode: "none", maxAgeMs: 0 }, jobs: { scope: "own", complete: true } },
      identity: { package: { fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } },
      state: { timeline: { playheadMs: 125 }, motion: { keyframeCount: expect.any(Number) } },
      selection: { status: "unavailable", persisted: false },
      receipts: { count: 6, countExact: true, statusCounts: { passed: 6 }, recent: expect.any(Array) },
      jobs: { count: 5, countExact: true, recent: expect.any(Array) },
      truncation: { receiptRows: { omitted: 2, exact: true }, jobRows: { omitted: 2, exact: true } }
    });
    expect(snapshot.receipts.recent).toHaveLength(4);
    expect(snapshot.receipts.recent[0]).toHaveProperty("createdAt");
    expect(snapshot.jobs.recent[0]).toMatchObject({ createdAtMs: expect.any(Number), pollAfterMs: 2_000, warningCount: 0 });
    expect(JSON.stringify(snapshot)).not.toContain(LOWER_THIRD);
  });

  it("returns an empty, inexact job projection with a warning when no authenticated owner principal is available", async () => {
    const result = await buildMotionAgentSnapshot(
      { packageRoot: LOWER_THIRD },
      snapshotServices("2026-08-09T00:00:00.000Z", { jobs: [job(0)] })
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("snapshot fixture unexpectedly failed");
    expect(result.result).toMatchObject({
      freshness: { jobs: { scope: "own", available: false, complete: false } },
      jobs: { count: 0, countExact: false, recent: [] },
      truncation: { jobRows: { omitted: 0, exact: false } },
      warnings: expect.arrayContaining([
        { source: "jobs", message: expect.stringContaining("authenticated owner principal") }
      ])
    });
  });

  it("derives plan requirements from Debug metadata for a non-hardcoded edit command", async () => {
    const result = await buildMotionAgentSnapshot(
      { request: "make title blue and preview it" },
      snapshotServices("2026-08-09T00:00:00.000Z")
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("snapshot fixture unexpectedly failed");
    const steps = (result.result as any).actions.request.plan.steps as Array<{ command: string; requiredArgs: string[] }>;
    const style = steps.find((step) => step.command === "motion.timeline.layer.style.set");
    const render = steps.find((step) => step.command === "motion.preview.frame");
    expect(style?.requiredArgs).toEqual(debugCommandContract("motion.timeline.layer.style.set")?.argsSchema?.required ?? []);
    expect(render?.requiredArgs).toEqual(debugCommandContract("motion.preview.frame")?.argsSchema?.required ?? []);
  });

  it("keeps schema-defined root alternatives visible in compact action plans", async () => {
    const result = await buildMotionAgentSnapshot(
      { request: "list motion templates" },
      snapshotServices("2026-08-09T00:00:00.000Z")
    );

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("snapshot fixture unexpectedly failed");
    const steps = (result.result as any).actions.request.plan.steps as Array<Record<string, unknown>>;
    const catalog = steps.find((step) => step.command === "motion.template.catalog");
    expect(catalog).toMatchObject({
      requiredArgGroups: [{
        mode: "anyOf",
        alternatives: [["templateRoot"], ["packageRoot"], ["packageRoots"]]
      }]
    });
    expect(catalog).not.toHaveProperty("requiredArgs");
  });

  it("does not echo caller request text and sanitizes bounded hostile names and warnings", async () => {
    const request = `please inspect /caller/secret \u001b[31m${"😀".repeat(180)}`;
    const result = await buildMotionAgentSnapshot(
      { packageRoot: LOWER_THIRD, request },
      snapshotServices("2026-08-09T00:00:00.000Z", { status: "failed", hostileName: true })
    );

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("snapshot fixture unexpectedly failed");
    const serialized = JSON.stringify(result.result);
    const snapshot = result.result as any;
    expect(serialized).not.toContain(request);
    expect(serialized).not.toContain("/caller/secret");
    expect(serialized).not.toContain("/host/package/secret");
    expect(snapshot.identity.package.name).toContain("…");
    const warning = snapshot.warnings[0]?.message as string;
    expect(warning).toContain("[path]");
    expect(warning).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    expect(warning).not.toContain("/secret/package");
    expect(warning).not.toContain("C:\\secret");
    expect(validateAgainstPublishedSchema(AGENT_SNAPSHOT_SCHEMA_DOCUMENT, snapshot)).toEqual([]);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(MAX_AGENT_SNAPSHOT_BYTES);
  });

  it("marks receipt facts and omitted rows as inexact when bounded discovery is incomplete", async () => {
    const result = await buildMotionAgentSnapshot(
      { packageRoot: LOWER_THIRD },
      snapshotServices("2026-08-09T00:00:00.000Z", { complete: false })
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("snapshot fixture unexpectedly failed");
    expect(result.result).toMatchObject({
      freshness: { receipts: { available: true, complete: false } },
      receipts: { count: 6, countExact: false, statusCountsExact: false },
      truncation: { receiptRows: { omitted: 2, exact: false }, receiptDiscoveryIncomplete: true }
    });
  });

  it("rejects unknown, inherited, and accessor arguments without invoking caller getters", async () => {
    let accessed = 0;
    const accessor = Object.create(null, {
      request: { enumerable: true, get: () => { accessed += 1; return "render"; } }
    });
    const inherited = Object.create({ request: "render" });
    for (const args of [{ unexpected: true }, accessor, inherited]) {
      await expect(buildMotionAgentSnapshot(args, snapshotServices("2026-08-09T00:00:00.000Z"))).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    }
    expect(accessed).toBe(0);
  });

  it("fails closed when an injected observation clock is invalid", async () => {
    const result = await buildMotionAgentSnapshot(
      {},
      { ...snapshotServices("2026-08-09T00:00:00.000Z"), now: () => new Date("not-a-date") }
    );
    expect(result).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
  });

  it("fails closed when a caller names a package outside approved snapshot roots or sends an over-limit request", async () => {
    const rootRefusal = await buildMotionAgentSnapshot(
      { packageRoot: LOWER_THIRD },
      { ...snapshotServices("2026-08-09T00:00:00.000Z"), snapshotPackageRoots: ["/not-the-fixture"] }
    );
    const requestRefusal = await buildMotionAgentSnapshot(
      { request: "😀".repeat(257) },
      snapshotServices("2026-08-09T00:00:00.000Z")
    );
    const receiptsRootRefusal = await buildMotionAgentSnapshot(
      { receiptsRoot: "/outside-host-receipts" },
      snapshotServices("2026-08-09T00:00:00.000Z")
    );
    expect(rootRefusal).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved", message: expect.not.stringContaining(LOWER_THIRD) } });
    expect(requestRefusal).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(receiptsRootRefusal).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.not.stringContaining("/outside-host-receipts") } });
  });

  it("fails closed at the final UTF-8 byte ceiling after per-field bounds", async () => {
    const astral = (scalars: number): string => "😀".repeat(scalars);
    const warnings = ["😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣"]
      .map((lead) => `${lead}${"😀".repeat(239)}`);
    // Four compact receipt rows contribute 8,320 bytes and eight distinct retained warnings add
    // 7,680 more before JSON punctuation or the required fixed snapshot fields.
    const boundedContentBytes = 4 * (160 + 96 + 40 + 160 + 64) * 4 + 8 * 240 * 4;
    expect(boundedContentBytes).toBe(16_000);
    expect(boundedContentBytes).toBeGreaterThan(MAX_AGENT_SNAPSHOT_BYTES);
    const result = await buildMotionAgentSnapshot(
      {},
      {
        ...snapshotServices("2026-08-09T00:00:00.000Z"),
        readSnapshotReceipts: async () => ({
          complete: true,
          entries: Array.from({ length: 4 }, (_, index) => ({
            receipt: {
              id: astral(160),
              operation: astral(96),
              status: "warning",
              packageId: astral(160),
              lane: astral(64),
              createdAt: astral(40),
              warnings: [warnings[index * 2], warnings[index * 2 + 1]]
            }
          }))
        })
      }
    );
    expect(result).toMatchObject({ ok: false, error: { code: "snapshot_too_large" } });
  });
});
