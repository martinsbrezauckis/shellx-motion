import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withStreamingFinalLaunchRevalidation, revalidateStreamingFinalLaunch } from "../streaming-final-lineage-revalidation.js";
import { runSegmentedConcatAttempts } from "./segmented-final-adapter-concat.js";

const roots: string[] = [];

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("segmented concat launch fences", () => {
  it("stops before the prepared software fallback starts after one failed hardware process", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-concat-lineage-"));
    roots.push(root);
    let launches = 0;
    let checks = 0;
    const result = await withStreamingFinalLaunchRevalidation(
      async () => {
        checks += 1;
        if (checks === 2) throw new Error("stable lineage changed before software concat fallback");
      },
      async () => await runSegmentedConcatAttempts(
        [attempt("hardware"), attempt("software")],
        join(root, "final.staging.mp4"),
        { jobId: "concat-lineage", scratchRoot: root, signal: new AbortController().signal, watchProcess() {}, reportProcessContainment() {}, reportSandbox() {} },
        async () => {
          await revalidateStreamingFinalLaunch();
          launches += 1;
          return {
            closed: Promise.resolve({ exitCode: 1, stdout: "", stderr: "controlled hardware failure" }),
            async write() { return { backpressured: false, bufferedInputBytes: 0, inputHighWaterMarkBytes: 16_384 }; },
            async end() { return { exitCode: 1, stdout: "", stderr: "controlled hardware failure" }; },
            async abort() { return { exitCode: 1, stdout: "", stderr: "controlled abort" }; }
          };
        },
        { reportProcessContainment() {}, reportSandbox() {} },
        () => { throw new Error("a lineage fence is not a local-job error"); }
      )
    );

    expect({ launches, checks }).toEqual({ launches: 1, checks: 2 });
    expect(result).toMatchObject({
      attempts: [{ source: "hardware", outcome: "failed" }],
      stagingCleanup: "missing",
      primaryCause: expect.objectContaining({ message: "stable lineage changed before software concat fallback" })
    });
  });
});

function attempt(source: "hardware" | "software") {
  return { source, command: { executable: "ffmpeg", args: ["-i", "segments.ffconcat", "final.mp4"], shell: false as const } };
}
