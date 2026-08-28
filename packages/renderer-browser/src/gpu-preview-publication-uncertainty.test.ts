import { describe, expect, it } from "vitest";
import { PublicationCommitUncertainError } from "@shellx-motion/core";
import { gpuPreviewPublicationUncertainty } from "./gpu-preview-publication-uncertainty.js";

describe("direct GPU preview post-link uncertainty", () => {
  it("retains authenticated public path and exact file identity after a deterministic output postcheck fault", () => {
    const postLink = new PublicationCommitUncertainError({
      publicPath: "/governed/gpu-preview.png",
      kind: "file",
      expectedIdentity: { dev: 7, ino: 9 },
      expected: { sha256: "d".repeat(64), byteLength: 31 }
    }, new Error("injected post-link verification failure"));
    expect(gpuPreviewPublicationUncertainty(postLink)).toEqual({
      code: "publication_commit_uncertain",
      message: postLink.message,
      possiblyCommitted: true,
      publicPaths: ["/governed/gpu-preview.png"],
      expectedPublications: [{
        publicPath: "/governed/gpu-preview.png",
        kind: "file",
        expectedIdentity: { dev: 7, ino: 9 },
        expected: { sha256: "d".repeat(64), byteLength: 31 }
      }]
    });
  });
});
