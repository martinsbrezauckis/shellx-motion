import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PublicationCommitUncertainError } from "@shellx-motion/core";
import { corePublicationUncertaintyFields } from "./cli-publication-uncertainty.js";

describe("CLI Core publication uncertainty", () => {
  it("keeps the authenticated Core evidence rather than relabeling a possibly committed delivery as ordinary failure", () => {
    const error = new PublicationCommitUncertainError({
      publicPath: "/governed/archive.sxmotion",
      kind: "file",
      expectedIdentity: { dev: 7, ino: 9 },
      expected: { sha256: "a".repeat(64), byteLength: 12 }
    }, new Error("post-link verification failed"));

    expect(corePublicationUncertaintyFields(error)).toMatchObject({
      possiblyCommitted: true,
      publicPaths: ["/governed/archive.sxmotion"],
      expectedPublications: [{ publicPath: "/governed/archive.sxmotion" }],
      error: { code: "publication_commit_uncertain", publicationCommitPhase: "output" }
    });
  });

  it("routes every shipped CLI Core directory/file publisher through the shared truthful envelope", async () => {
    const source = await readFile(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");
    for (const command of ["package-create", "review-html-bundle", "package-archive", "package-extract"]) {
      expect(source).toContain(`publicationCommitUncertainCliFailure(\"${command}\", error)`);
    }
  });
});
