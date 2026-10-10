import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planRenderSegments } from "./render-segment-plan.js";
import { spoolRenderSegmentsAdmitted } from "./render-segment-spool.js";
import { afterEach, describe, expect, it } from "vitest";
import { withStreamingFinalLaunchRevalidation } from "../streaming-final-lineage-revalidation.js";

const roots: string[] = [];
const HASH = "a".repeat(64);

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("range producer encoder-setup cleanup", () => {
  it("aborts an already-acquired range producer when FFmpeg setup fails before produce or checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-range-cleanup-"));
    roots.push(root);
    const packageRoot = join(root, "package");
    await mkdir(packageRoot);
    await writeFile(join(packageRoot, "manifest.json"), "{}\n");
    await writeFile(join(packageRoot, "motion.json"), "{}\n");
    const calls: string[] = [];
    const result = await spoolRenderSegmentsAdmitted({
      package: { rootPath: packageRoot, id: "range-cleanup", manifestSha256: HASH },
      timeline: { motionSha256: HASH, frameCount: 1, durationMs: 1_000, fps: 1, width: 1, height: 1 },
      frameLane: "native", producer: { frameLane: "native" }, plan: planRenderSegments({ frameCount: 1, segmentFrames: 1 }),
      store: { intent: "create", rootPath: join(root, "store") },
      createRangeProducer: () => ({
        async abort() { calls.push("lease-release"); },
        async produce() { throw new Error("produce must not run after encoder setup refusal"); }
      }),
      processFactory: async () => { calls.push("encoder-setup"); throw new Error("controlled encoder setup refusal"); },
      job: { jobId: "range-cleanup", scratchRoot: root, signal: new AbortController().signal, watchProcess() {}, reportProcessContainment() {}, reportSandbox() {} }
    });
    expect(result).toMatchObject({ ok: false, error: { code: "segment_encoder_failed", evidence: { verifiedPrefixSegments: 0 } } });
    expect(calls).toEqual(["encoder-setup", "lease-release"]);
    await expect(readFile(join(root, "store", "manifest.json"), "utf8")).resolves.toContain('"completed":[]');
  });

  it("refuses before range creation with no encoder, and aborts an encoder if the producer fence fails after it starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-range-lineage-"));
    roots.push(root);
    const packageRoot = join(root, "package");
    await mkdir(packageRoot);
    await writeFile(join(packageRoot, "manifest.json"), "{}\n");
    await writeFile(join(packageRoot, "motion.json"), "{}\n");
    const base = {
      package: { rootPath: packageRoot, id: "range-lineage", manifestSha256: HASH },
      timeline: { motionSha256: HASH, frameCount: 1, durationMs: 1_000, fps: 1, width: 1, height: 1 },
      frameLane: "native" as const, producer: { frameLane: "native" as const }, plan: planRenderSegments({ frameCount: 1, segmentFrames: 1 }),
      job: { jobId: "range-lineage", scratchRoot: root, signal: new AbortController().signal, watchProcess() {}, reportProcessContainment() {}, reportSandbox() {} }
    };
    let factories = 0, starts = 0, aborts = 0, produces = 0, producerAborts = 0, readbacks = 0;
    const early = await withStreamingFinalLaunchRevalidation(
      async () => { throw new Error("stable lineage changed before range factory"); },
      async () => await spoolRenderSegmentsAdmitted({
        ...base, store: { intent: "create" as const, rootPath: join(root, "early") },
        createRangeProducer: () => { factories += 1; throw new Error("must not create"); },
        processFactory: async () => { starts += 1; throw new Error("must not start"); }
      })
    );
    expect(early).toMatchObject({ ok: false, error: { code: "segment_producer_failed", primaryCause: expect.objectContaining({ message: "stable lineage changed before range factory" }) } });
    expect({ factories, starts }).toEqual({ factories: 0, starts: 0 });

    const staged = await withStreamingFinalLaunchRevalidation(async () => {
      if (starts > 0) throw new Error("stable lineage changed before range producer");
    }, async () => await spoolRenderSegmentsAdmitted({
      ...base, store: { intent: "create" as const, rootPath: join(root, "staged") },
      createRangeProducer: () => ({
        async abort() { producerAborts += 1; },
        async produce() { produces += 1; }
      }),
      verifyReadback: async () => { readbacks += 1; throw new Error("FFprobe must not run after the producer fence"); },
      processFactory: async () => {
        starts += 1;
        let resolved = false;
        let close!: (result: { exitCode: number; stdout: string; stderr: string }) => void;
        const closed = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => { close = resolve; });
        return {
          closed,
          async write() { return { backpressured: false, bufferedInputBytes: 0, inputHighWaterMarkBytes: 16_384 }; },
          async end() { return { exitCode: 0, stdout: "", stderr: "" }; },
          async abort() { aborts += 1; if (!resolved) { resolved = true; close({ exitCode: 1, stdout: "", stderr: "aborted" }); } return { exitCode: 1, stdout: "", stderr: "aborted" }; }
        };
      }
    }));
    expect(staged).toMatchObject({ ok: false, error: { code: "segment_producer_failed", primaryCause: expect.objectContaining({ message: "stable lineage changed before range producer" }) } });
    expect({ starts, aborts, produces, producerAborts, readbacks }).toEqual({ starts: 1, aborts: 1, produces: 0, producerAborts: 1, readbacks: 0 });
  });
});
