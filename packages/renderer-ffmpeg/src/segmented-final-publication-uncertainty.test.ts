import { describe, expect, it } from "vitest";
import { SegmentedPublicationIdentityError } from "./segmented-final-internal/segmented-final-adapter-store.js";
import { segmentedPublicationUncertainty } from "./segmented-final.js";

describe("direct segmented final post-link uncertainty", () => {
  it("retains the canonical destination and verified SHA/byte length when an injected after-link proof fails", () => {
    const failure = new SegmentedPublicationIdentityError({
      publicPath: "/governed/segmented.mp4",
      kind: "file",
      expectedIdentity: { dev: 19, ino: 23 },
      expected: { sha256: "f".repeat(64), byteLength: 101 }
    }, new Error("injected after-link destination replacement during postcheck"));
    expect(segmentedPublicationUncertainty(failure)).toEqual({
      possiblyCommitted: true,
      publicPaths: ["/governed/segmented.mp4"],
      expectedPublications: [{
        publicPath: "/governed/segmented.mp4",
        kind: "file",
        expectedIdentity: { dev: 19, ino: 23 },
        expected: { sha256: "f".repeat(64), byteLength: 101 }
      }]
    });
  });
});
