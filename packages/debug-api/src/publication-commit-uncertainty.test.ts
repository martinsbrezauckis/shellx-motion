import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PublicationCommitUncertainError } from "@shellx-motion/core";
import { dispatchDomainCommand } from "./domains/router.js";
import { debugBatchRenderedDelivery } from "./debug-batch-outcomes.js";
import { debugFinalOutputFailure } from "./render-final-support.js";
import { sourceCommittedObserverFailure } from "./domains/authoring-source-publication-failure.js";

function uncertain(path: string): PublicationCommitUncertainError {
  return new PublicationCommitUncertainError({
    publicPath: path,
    kind: "file",
    expectedIdentity: { dev: 1, ino: 2 },
    expected: { sha256: "a".repeat(64), byteLength: 9 }
  }, new Error("deterministic post-link observation failure"));
}

describe("publication uncertainty result boundaries", () => {
  it("keeps OTIO and HTML adapter publication uncertainty explicit at the Debug authoring boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-publication-"));
    const packageRoot = join(root, "package");
    await mkdir(packageRoot);
    try {
      const otioPath = join(root, "timeline.otio");
      const otio = await dispatchDomainCommand("authoring", "motion.otio.export", {
        packageRoot,
        outPath: otioPath
      }, {
        authoringInputRoots: [root],
        authoringOutputRoots: [root],
        otioExporter: async () => { throw uncertain(otioPath); }
      });
      expect(otio).toMatchObject({
        ok: false,
        error: { code: "publication_commit_uncertain", detail: { possiblyCommitted: true, publicPaths: [otioPath] } },
        result: { possiblyCommitted: true, publicPaths: [otioPath] }
      });

      const htmlPath = join(root, "snippet");
      const html = await dispatchDomainCommand("authoring", "motion.html.snippet.export", {
        packageRoot,
        outDir: htmlPath
      }, {
        authoringInputRoots: [root],
        authoringOutputRoots: [root],
        htmlSnippetExporter: async () => { throw uncertain(htmlPath); }
      });
      expect(html).toMatchObject({
        ok: false,
        error: { code: "publication_commit_uncertain", detail: { possiblyCommitted: true, publicPaths: [htmlPath] } },
        result: { possiblyCommitted: true, publicPaths: [htmlPath] }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps package archive uncertainty explicit at the Debug workspace boundary", async () => {
    const archivePath = "/host-approved/archive.sxmotion";
    const result = await dispatchDomainCommand("workspace", "motion.package.archive", {
      packageRoot: "/host-approved/package",
      archivePath
    }, {
      archivePackage: async () => { throw uncertain(archivePath); }
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "publication_commit_uncertain", detail: { possiblyCommitted: true, publicPaths: [archivePath] } },
      result: { possiblyCommitted: true, publicPaths: [archivePath] }
    });
  });

  it("routes Core publication uncertainty through the shared timeline package-edit executor used by shape geometry and every timeline mutation", async () => {
    const source = await readFile(fileURLToPath(new URL("./domains/timeline-package-edit.ts", import.meta.url)), "utf8");
    expect(source).toContain("isPublicationCommitUncertain");
    expect(source).toContain("possiblyCommitted: true, publicPaths: [error.evidence.publicPath]");
    expect(source).toContain("result: { possiblyCommitted: true, publicPaths: [error.evidence.publicPath]");
  });

  it("emits one canonical plural final-delivery envelope for injected still and sequence post-link faults", () => {
    for (const path of ["/governed/still.png", "/governed/sequence"] as const) {
      const result = debugFinalOutputFailure(uncertain(path));
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "publication_commit_uncertain",
          detail: {
            possiblyCommitted: true,
            publicPaths: [path],
            expectedPublications: [{ publicPath: path, expected: { sha256: "a".repeat(64), byteLength: 9 } }]
          }
        },
        result: {
          possiblyCommitted: true,
          publicPaths: [path],
          expectedPublications: [{ publicPath: path }]
        }
      });
    }
  });

  it("keeps accumulated public delivery evidence in a Debug render-batch failure result", async () => {
    const [indexSource, outcomeSource] = await Promise.all([
      readFile(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8"),
      readFile(fileURLToPath(new URL("./debug-batch-outcomes.ts", import.meta.url)), "utf8")
    ]);
    expect(outcomeSource).toContain("export function debugBatchDeliveryFields(jobs:");
    expect(outcomeSource).toContain("expectedPublications: [...job.expectedPublications]");
    expect(indexSource).toContain("const delivery = debugBatchDeliveryFields(renderedJobs);");
    expect(outcomeSource).toContain("expectedPublications: [...uncertainty.expectedPublications]");
    expect(indexSource).toContain("result: { jobs: renderedJobs, receipt, receiptPath: join(receiptsRoot, \"batch-render.receipt.json\"), ...delivery }");
  });

  it("turns a Debug receipt-or-secondary post-link result into warning-grade batch evidence", () => {
    const delivery = debugBatchRenderedDelivery({
      ok: false,
      error: {
        code: "paired_output_commit_uncertain",
        message: "secondary observation failed",
        detail: {
          possiblyCommitted: true,
          publicationCommitPhase: "secondary",
          publicPaths: ["/governed/final.browser-capture.html"],
          expectedPublications: [{
            publicPath: "/governed/final.browser-capture.html",
            kind: "file",
            expectedIdentity: { dev: 1, ino: 2 },
            expected: { sha256: "b".repeat(64), byteLength: 12 }
          }]
        }
      } as never,
      warnings: []
    });
    expect(delivery).toMatchObject({
      possiblyCommittedPaths: ["/governed/final.browser-capture.html"],
      uncertaintyFields: {
        possiblyCommitted: true,
        publicationCommitPhase: "secondary",
        expectedPublications: [{ publicPath: "/governed/final.browser-capture.html" }]
      }
    });
    expect(delivery.rowWarnings).toEqual(["Render delivery may have committed; inspect the reported public evidence before retrying."]);
  });

  it("normalizes migrated singular root evidence before Debug batch bookkeeping", () => {
    const delivery = debugBatchRenderedDelivery({
      ok: false,
      error: {
        code: "publication_commit_uncertain",
        message: "streamed post-link observation failed",
        possiblyCommitted: true,
        publicPath: "/governed/streamed.mp4",
        expected: {
          publicPath: "/governed/streamed.mp4",
          kind: "file",
          expectedIdentity: { dev: 3, ino: 4 },
          expected: { sha256: "c".repeat(64), byteLength: 15 }
        }
      } as never,
      warnings: []
    });
    expect(delivery).toMatchObject({
      possiblyCommittedPaths: ["/governed/streamed.mp4"],
      uncertaintyFields: {
        possiblyCommitted: true,
        publicPaths: ["/governed/streamed.mp4"],
        expectedPublications: [{ publicPath: "/governed/streamed.mp4", expected: { sha256: "c".repeat(64), byteLength: 15 } }]
      }
    });
  });

  it("keeps both already-committed authoring bundles observable when the host receipt observer throws", () => {
    for (const code of ["source_import_receipt_observer_failed", "source_storyboard_receipt_observer_failed"] as const) {
      const result = sourceCommittedObserverFailure(code, new Error("injected host writeReceipt failure after local commit"), {
        outputPath: `/governed/${code}`,
        receiptPath: `/governed/${code}/receipts/local.json`,
        receipt: {
          schema: "shellx-motion/receipt@1", id: `${code}-receipt`, operation: "source.import", status: "passed",
          packageId: "test", inputHashes: {}, createdAt: "2026-08-21T00:00:00.000Z", lane: "debug-api", output: {}, warnings: []
        },
        artifacts: [{ role: "local_artifact", path: `/governed/${code}/artifact`, status: "available" }],
        output: { primaryPath: `/governed/${code}/artifact` }
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code, detail: { sourceCommitted: true, publicPaths: [`/governed/${code}`], receiptPath: `/governed/${code}/receipts/local.json` } },
        result: { sourceCommitted: true, outputPath: `/governed/${code}`, receiptId: `${code}-receipt`, primaryPath: `/governed/${code}/artifact` }
      });
      expect(JSON.stringify(result)).not.toContain("possiblyCommitted");
    }
  });
});
