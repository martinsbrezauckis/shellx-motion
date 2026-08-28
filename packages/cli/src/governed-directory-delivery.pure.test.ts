import { describe, expect, it, vi } from "vitest";
import { PublicationCommitUncertainError, type DerivedOutputPublication } from "@shellx-motion/core";
import { DirectoryBundleCommitUncertainError, publishGovernedDirectoryBundle } from "./governed-directory-delivery.js";

function fakeDirectory(events: string[], publishError?: Error): DerivedOutputPublication {
  const evidence = { sha256: "a".repeat(64), entryCount: 2 };
  return {
    outputPath: "/governed/capture",
    verifyDirectory: vi.fn(async () => { events.push("verify"); return evidence; }),
    publishDirectory: vi.fn(async () => {
      events.push("rename");
      if (publishError) throw publishError;
    })
  } as unknown as DerivedOutputPublication;
}

describe("governed directory delivery (pure injection)", () => {
  it("publishes only after a closed private-inventory verification", async () => {
    const events: string[] = [];
    await expect(publishGovernedDirectoryBundle(fakeDirectory(events), ["frame.png", "receipt.json"])).resolves.toMatchObject({ entryCount: 2 });
    expect(events).toEqual(["verify", "rename"]);
  });

  it("keeps a pre-attempt publication failure ordinary", async () => {
    const events: string[] = [];
    const failure = new Error("injected pre-attempt publication refusal");
    await expect(publishGovernedDirectoryBundle(fakeDirectory(events, failure), ["frame.png", "receipt.json"])).rejects.toBe(failure);
    expect(events).toEqual(["verify", "rename"]);
  });

  it("maps only authenticated Core post-rename uncertainty with immutable evidence", async () => {
    const events: string[] = [];
    const evidence = {
      publicPath: "/governed/capture",
      kind: "directory" as const,
      expectedIdentity: { dev: 1, ino: 2 },
      expected: { sha256: "b".repeat(64), entryCount: 2, entries: ["frame.png", "receipt.json"] }
    };
    const failure = new PublicationCommitUncertainError(evidence, new Error("injected post-rename inventory verification"));
    await expect(publishGovernedDirectoryBundle(fakeDirectory(events, failure), ["frame.png", "receipt.json"])).rejects.toMatchObject({
      code: "directory_bundle_commit_uncertain",
      outputPath: evidence.publicPath,
      expectedPublication: evidence
    });
    expect(events).toEqual(["verify", "rename"]);
  });
});
