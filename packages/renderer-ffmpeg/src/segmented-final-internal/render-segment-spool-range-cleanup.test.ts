import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planRenderSegments } from "./render-segment-plan.js";
import { spoolRenderSegmentsAdmitted } from "./render-segment-spool.js";
import { afterEach, describe, expect, it } from "vitest";

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
});
