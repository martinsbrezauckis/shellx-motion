import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCollisionCheckpointProofCases,
  parseCollisionCheckpointProofArguments,
} from "./c6g-collision-checkpoint-proof-contract";

const commit = "a".repeat(40);

describe("C6G collision checkpoint proof harness", () => {
  it("builds only the two fixed stories and their exact checkpoint topology", () => {
    const cases = buildCollisionCheckpointProofCases();
    expect(cases.map((entry) => ({
      slug: entry.slug,
      checkpoints: entry.plan.checkpoints.map((checkpoint) => checkpoint.id),
      layers: entry.targetLayerIds,
      rendererInvoked: entry.lowering.evidence.rendererInvoked,
    }))).toEqual([
      { slug: "bingo", checkpoints: ["idle", "mixing", "selected", "reveal"], layers: ["c6g-bingo-balls", "c6g-bingo-cage"], rendererInvoked: false },
      { slug: "wrecking", checkpoints: ["intact", "impact", "falling", "end"], layers: ["c6g-wrecking-scene"], rendererInvoked: false },
    ]);
    expect(cases.map((entry) => entry.pkg.manifest.assets)).toEqual([[], []]);
    expect(cases.map((entry) => entry.plan.frames.length)).toEqual([61, 61]);
  });

  it("admits only an absolute fresh-run location below repository scratch and an exact commit", () => {
    const outputRoot = join(process.cwd(), ".scratch", "c6g-proof-test-arguments");
    expect(parseCollisionCheckpointProofArguments(["--output-root", outputRoot, "--expected-commit", commit])).toEqual({ outputRoot, expectedCommit: commit });
    expect(() => parseCollisionCheckpointProofArguments(["--output-root", "relative", "--expected-commit", commit])).toThrow("Usage:");
    expect(() => parseCollisionCheckpointProofArguments(["--output-root", process.cwd(), "--expected-commit", commit])).toThrow("Output root must be a child");
    expect(() => parseCollisionCheckpointProofArguments(["--output-root", outputRoot, "--expected-commit", "not-a-commit"])).toThrow("Usage:");
  });
});
