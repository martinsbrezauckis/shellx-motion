import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withStreamingFinalLaunchRevalidation, revalidateStreamingFinalLaunch } from "../streaming-final-lineage-revalidation.js";

vi.mock("../streaming-final-encode-policy-stages.js", () => ({
  finalizeStreamingFinalEncodePolicy: async (input: { runner(command: { executable: string; args: string[]; shell: false }): Promise<unknown> }) => {
    await input.runner({ executable: "ffprobe", args: ["-show_format", "final.staging.mp4"], shell: false });
    throw new Error("the final readback fence should refuse before this mock can finish");
  }
}));

const roots: string[] = [];

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("segmented final delivery launch fence", () => {
  it("removes unpublished final staging when a final readback fence refuses", async () => {
    const { finishSegmentedFinalDelivery } = await import("./segmented-final-adapter-delivery.js");
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-final-readback-lineage-"));
    roots.push(root);
    const stagingPath = join(root, "final.staging.mp4");
    await writeFile(stagingPath, "unpublished-final-staging");
    let cleanup = "not_started";
    const recorded: unknown[] = [];

    await expect(withStreamingFinalLaunchRevalidation(
      async () => { throw new Error("stable lineage changed before final readback"); },
      async () => await finishSegmentedFinalDelivery({
        prepared: {} as never,
        transformed: { attempts: [attempt("software")] },
        concat: { attempts: [{ source: "software", outcome: "succeeded" }], output: { exitCode: 0, stdout: "", stderr: "" }, cleanupCauses: [], stagingCleanup: "not_started" },
        paths: { stagingPath, outputPath: join(root, "final.mp4") } as never,
        authority: { async assertCurrent() {} } as never,
        manifest: {
          plan: { frameCount: 0, ranges: [] },
          timeline: { durationMs: 1_000, fps: 1, width: 16, height: 16 },
          completed: []
        } as never,
        segments: [],
        verifiedPrefixSegments: 0,
        observedMaxConcurrentPngHandoffs: 0,
        producer: {} as never,
        concatListSha256: "a".repeat(64),
        quality: { warnings: [], frameCount: 1, blankFrames: 0, uniqueFrameHashes: 1 } as never,
        runner: async () => {
          await revalidateStreamingFinalLaunch();
          throw new Error("runner must stop at the launch fence");
        },
        updatePhase() {},
        provisionalFailure: () => undefined,
        setStagingCleanup: (value) => { cleanup = value; },
        setPublication() {},
        recordLocalFailure: (value) => { recorded.push(value); }
      })
    )).rejects.toThrow("stable lineage changed before final readback");

    expect(cleanup).toBe("removed");
    expect(recorded).toMatchObject([{ phase: "finalize", partialOutput: { status: "unverified" } }]);
    await expect(lstat(stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function attempt(source: "hardware" | "software") {
  return { source, command: { executable: "ffmpeg", args: ["-i", "segments.ffconcat", "final.mp4"], shell: false as const } };
}
