import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DerivedOutputPublicationError, PublicationCommitUncertainError, type DerivedOutputPublication, type OperationReceipt } from "@shellx-motion/core";
import { PairedOutputReceiptCommitUncertainError, PairedOutputReceiptPublication, assertPairedReceiptAcceptance } from "./paired-output-receipt-publication.js";

const bytes = "private preview bytes";
const sha256 = createHash("sha256").update(bytes).digest("hex");

function receipt(stagePath: string): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1", id: "pure-pair", operation: "preview.frame", status: "passed",
    packageId: "pkg", inputHashes: { motion: "a".repeat(64) }, createdAt: "2026-08-21T00:00:00.000Z", lane: "browser",
    output: { path: stagePath, sha256 }, warnings: []
  };
}

function fakePublication(name: string, events: string[], options: {
  publishError?: Error;
  verifyPublishedError?: Error;
  revokeError?: Error;
  abortError?: Error;
} = {}): DerivedOutputPublication {
  const evidence = { sha256, byteLength: Buffer.byteLength(bytes) };
  return {
    outputPath: `/public/${name}`,
    stagingPath: `/private/${name}`,
    verifyFile: vi.fn(async () => { events.push(`${name}.verify`); return evidence; }),
    publishFile: vi.fn(async () => { events.push(`${name}.publish`); if (options.publishError) throw options.publishError; }),
    verifyPublishedFile: vi.fn(async () => { events.push(`${name}.verify-published`); if (options.verifyPublishedError) throw options.verifyPublishedError; return evidence; }),
    revokePublishedFile: vi.fn(async () => { events.push(`${name}.revoke`); if (options.revokeError) throw options.revokeError; }),
    abort: vi.fn(async () => { events.push(`${name}.abort`); if (options.abortError) throw options.abortError; })
  } as unknown as DerivedOutputPublication;
}

async function staged(options: {
  output?: DerivedOutputPublication;
  receipt?: DerivedOutputPublication;
  writeError?: Error;
  faults?: Parameters<typeof PairedOutputReceiptPublication.acquire>[0]["faults"];
} = {}) {
  const events: string[] = [];
  const output = options.output ?? fakePublication("output", events);
  const sidecar = options.receipt ?? fakePublication("receipt", events);
  const acquired: DerivedOutputPublication[] = [output, sidecar];
  const pair = await PairedOutputReceiptPublication.acquire({
    outputPath: output.outputPath,
    receiptPath: sidecar.outputPath,
    outputArtifact: { role: "preview_frame", mediaType: "image/png", primary: true },
    receiptArtifact: { role: "preview_receipt", mediaType: "application/json" },
    ...(options.faults ? { faults: options.faults } : {}),
    testHooks: {
      acquirePublication: async () => {
        const publication = acquired.shift();
        if (!publication) throw new Error("unexpected publication acquisition");
        return publication;
      },
      writeReceiptStage: async () => {
        events.push("receipt.write");
        if (options.writeError) throw options.writeError;
      }
    }
  });
  const value = receipt(output.stagingPath);
  let stageError: unknown;
  try {
    await pair.stageReceipt(value);
  } catch (error) {
    stageError = error;
  }
  return { pair, value, events, output, sidecar, stageError };
}

describe("paired output receipt publication (pure injection)", () => {
  it("orders verified receipt publication before the last output commit", async () => {
    const value = await staged();
    await value.pair.commit();

    expect(value.events).toEqual([
      "output.verify", "receipt.write", "receipt.verify", "receipt.publish", "receipt.verify-published", "output.publish", "receipt.abort"
    ]);
    expect(value.value.output).toMatchObject({ path: "/public/output", sha256 });
    expect(assertPairedReceiptAcceptance("/public/receipt", value.value)).toEqual({ outputPath: "/public/output", sha256, secondaryArtifactHashes: {} });
  });

  it("cleans private reservations on receipt staging/commit failure before output is attempted", async () => {
    const stageFailure = await staged({ writeError: new Error("injected receipt staging") });
    expect(stageFailure.stageError).toBeInstanceOf(Error);
    expect(stageFailure.events).toContain("output.abort");
    expect(stageFailure.events).toContain("receipt.abort");

    const commitFailure = await staged();
    (commitFailure.sidecar.publishFile as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      commitFailure.events.push("receipt.publish");
      throw new Error("injected receipt commit");
    });
    await expect(commitFailure.pair.commit()).rejects.toThrow("injected receipt commit");
    expect(commitFailure.events).toContain("output.abort");
    expect(commitFailure.events).toContain("receipt.abort");
    expect(commitFailure.events).not.toContain("output.publish");
  });

  it("cleans private reservations when receipt preflight fails before staging", async () => {
    const value = await staged({ faults: { afterReceiptPreflight: () => { throw new Error("injected receipt preflight"); } } });

    expect(value.stageError).toBeInstanceOf(Error);
    expect(value.events).toContain("output.verify");
    expect(value.events).toContain("output.abort");
    expect(value.events).toContain("receipt.abort");
    expect(value.events).not.toContain("receipt.write");
    expect(value.events).not.toContain("output.publish");
  });

  it("revokes only the retained exact receipt on cancellation before output", async () => {
    const value = await staged();
    let cancellationChecks = 0;
    await expect(value.pair.commit({ cancelled: () => ++cancellationChecks >= 2 })).rejects.toThrow(/cancelled/i);
    expect(value.events).toContain("receipt.revoke");
    expect(value.events).not.toContain("output.publish");
  });

  it("retains a receipt after an uncertain output commit", async () => {
    const value = await staged({ faults: { afterOutputCommitAttempt: () => { throw new Error("injected post-link output verification"); } } });

    await expect(value.pair.commit()).rejects.toBeInstanceOf(PairedOutputReceiptCommitUncertainError);
    expect(value.events).toContain("receipt.publish");
    expect(value.events).toContain("output.publish");
    expect(value.events).not.toContain("receipt.revoke");
    expect(value.events).toContain("output.abort");
    expect(value.events).toContain("receipt.abort");
  });

  it("keeps primary success when retained receipt cleanup fails", async () => {
    const events: string[] = [];
    const output = fakePublication("output", events);
    const sidecar = fakePublication("receipt", events, { abortError: new Error("injected retained cleanup failure") });
    const value = await staged({ output, receipt: sidecar });

    await expect(value.pair.commit()).resolves.toBeUndefined();
    expect(events).toContain("output.publish");
    expect(events).toContain("receipt.abort");
    expect(events).not.toContain("receipt.revoke");
  });

  it("keeps an authenticated primary post-link failure distinct from receipt and secondary uncertainty", async () => {
    const events: string[] = [];
    const output = fakePublication("output", events, {
      publishError: new PublicationCommitUncertainError({
        publicPath: "/public/output", kind: "file", expectedIdentity: { dev: 1, ino: 4 },
        expected: { sha256, byteLength: Buffer.byteLength(bytes) }
      }, new Error("output post-link check"))
    });
    const sidecar = fakePublication("receipt", events);
    const value = await staged({ output, receipt: sidecar });

    await expect(value.pair.commit()).rejects.toMatchObject({
      code: "paired_output_commit_uncertain", phase: "output", publicPaths: [output.outputPath],
      expectedPublications: [{ publicPath: output.outputPath }]
    });
    expect(events).toContain("receipt.publish");
    expect(events).toContain("output.publish");
    expect(events).not.toContain("receipt.revoke");
  });

  it("revokes the retained receipt and propagates an ordinary primary pre-link Core refusal", async () => {
    const events: string[] = [];
    const refusal = new DerivedOutputPublicationError("derived_output_exists", "primary pre-link refusal", "/public/output");
    const output = fakePublication("output", events, {
      publishError: refusal
    });
    const sidecar = fakePublication("receipt", events);
    const value = await staged({ output, receipt: sidecar });

    await expect(value.pair.commit()).rejects.toBe(refusal);
    expect(events).toContain("receipt.publish");
    expect(events).toContain("output.publish");
    expect(events).toContain("receipt.revoke");
    expect(events).toContain("output.abort");
    expect(events).toContain("receipt.abort");
  });

  it("keeps an authenticated receipt post-link failure phase-specific without inventing output uncertainty", async () => {
    const value = await staged();
    const uncertain = new PublicationCommitUncertainError({
      publicPath: value.sidecar.outputPath,
      kind: "file",
      expectedIdentity: { dev: 1, ino: 2 },
      expected: { sha256, byteLength: Buffer.byteLength(bytes) }
    }, new Error("receipt post-link check"));
    (value.sidecar.publishFile as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      value.events.push("receipt.publish");
      throw uncertain;
    });

    await expect(value.pair.commit()).rejects.toMatchObject({
      code: "paired_output_commit_uncertain",
      phase: "receipt",
      publicPaths: [value.sidecar.outputPath],
      expectedPublications: [{ publicPath: value.sidecar.outputPath }]
    });
    expect(value.events).not.toContain("output.publish");
    expect(value.events).not.toContain("receipt.revoke");
  });

  it("publishes receipt-bound browser evidence before the primary output", async () => {
    const events: string[] = [];
    const output = fakePublication("output", events);
    const sidecar = fakePublication("receipt", events);
    const html = fakePublication("html", events);
    const acquired = [output, sidecar, html];
    const pair = await PairedOutputReceiptPublication.acquire({
      outputPath: output.outputPath,
      receiptPath: sidecar.outputPath,
      outputArtifact: { role: "preview_frame", mediaType: "image/png", primary: true },
      receiptArtifact: { role: "preview_receipt", mediaType: "application/json" },
      testHooks: {
        acquirePublication: async () => {
          const publication = acquired.shift();
          if (!publication) throw new Error("unexpected publication acquisition");
          return publication;
        },
        writeReceiptStage: async () => { events.push("receipt.write"); },
        inspectSecondaryStage: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
        copySecondaryStage: async () => { events.push("html.copy"); }
      }
    });
    const value = receipt(output.stagingPath);
    const htmlArtifact = await pair.stageSecondaryArtifact({
      stagedPath: "/private/browser-capture-html/composition.html",
      outputPath: "/public/html",
      artifact: { role: "browser_capture_html", mediaType: "text/html" },
      inputHashKey: "browser-capture-html"
    });
    value.artifacts = [htmlArtifact];
    await pair.stageReceipt(value);
    await pair.commit();

    expect(events).toEqual([
      "html.copy", "html.verify", "output.verify", "receipt.write", "receipt.verify",
      "receipt.publish", "receipt.verify-published", "html.publish", "html.verify-published", "output.publish", "receipt.abort", "html.abort"
    ]);
    expect(value.output).toMatchObject({ pairedSecondaryArtifactHashes: { "/public/html": sha256 } });
    expect(value.inputHashes).toMatchObject({ "browser-capture-html": sha256 });
  });

  it("revokes exact published browser evidence and receipt when cancellation precedes the primary", async () => {
    const events: string[] = [];
    const output = fakePublication("output", events);
    const sidecar = fakePublication("receipt", events);
    const html = fakePublication("html", events);
    const acquired = [output, sidecar, html];
    const pair = await PairedOutputReceiptPublication.acquire({
      outputPath: output.outputPath,
      receiptPath: sidecar.outputPath,
      outputArtifact: { role: "preview_frame" },
      receiptArtifact: { role: "preview_receipt" },
      testHooks: {
        acquirePublication: async () => acquired.shift() ?? Promise.reject(new Error("unexpected publication acquisition")),
        writeReceiptStage: async () => { events.push("receipt.write"); },
        inspectSecondaryStage: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
        copySecondaryStage: async () => { events.push("html.copy"); }
      }
    });
    const value = receipt(output.stagingPath);
    await pair.stageSecondaryArtifact({
      stagedPath: "/private/browser-capture-html/composition.html",
      outputPath: html.outputPath,
      artifact: { role: "browser_capture_html", mediaType: "text/html" },
      inputHashKey: "browser-capture-html"
    });
    await pair.stageReceipt(value);
    let checks = 0;

    await expect(pair.commit({ cancelled: () => ++checks >= 3 })).rejects.toThrow(/cancelled/i);
    expect(events).toContain("html.revoke");
    expect(events).toContain("receipt.revoke");
    expect(events).not.toContain("output.publish");
  });

  it("revokes the receipt and propagates the first ordinary secondary pre-link Core refusal", async () => {
    const events: string[] = [];
    const refusal = new DerivedOutputPublicationError("derived_output_exists", "first secondary pre-link refusal", "/public/html");
    const output = fakePublication("output", events);
    const sidecar = fakePublication("receipt", events);
    const html = fakePublication("html", events, { publishError: refusal });
    const acquired = [output, sidecar, html];
    const pair = await PairedOutputReceiptPublication.acquire({
      outputPath: output.outputPath, receiptPath: sidecar.outputPath,
      outputArtifact: { role: "preview_frame" }, receiptArtifact: { role: "preview_receipt" },
      testHooks: {
        acquirePublication: async () => acquired.shift() ?? Promise.reject(new Error("unexpected publication acquisition")),
        writeReceiptStage: async () => { events.push("receipt.write"); },
        inspectSecondaryStage: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
        copySecondaryStage: async () => { events.push("html.copy"); }
      }
    });
    await pair.stageSecondaryArtifact({ stagedPath: "/private/browser-capture-html/composition.html", outputPath: html.outputPath, artifact: { role: "browser_capture_html" }, inputHashKey: "html" });
    await pair.stageReceipt(receipt(output.stagingPath));

    await expect(pair.commit()).rejects.toBe(refusal);
    expect(events).toContain("receipt.publish");
    expect(events).toContain("html.publish");
    expect(events).toContain("receipt.revoke");
    expect(events).not.toContain("html.revoke");
    expect(events).not.toContain("output.publish");
    expect(events).toContain("output.abort");
    expect(events).toContain("receipt.abort");
    expect(events).toContain("html.abort");
  });

  it("revokes prior published evidence and receipt after a later ordinary secondary pre-link Core refusal", async () => {
    const events: string[] = [];
    const refusal = new DerivedOutputPublicationError("derived_output_exists", "later secondary pre-link refusal", "/public/trace");
    const output = fakePublication("output", events);
    const sidecar = fakePublication("receipt", events);
    const html = fakePublication("html", events);
    const trace = fakePublication("trace", events, { publishError: refusal });
    const acquired = [output, sidecar, html, trace];
    const pair = await PairedOutputReceiptPublication.acquire({
      outputPath: output.outputPath, receiptPath: sidecar.outputPath,
      outputArtifact: { role: "preview_frame" }, receiptArtifact: { role: "preview_receipt" },
      testHooks: {
        acquirePublication: async () => acquired.shift() ?? Promise.reject(new Error("unexpected publication acquisition")),
        writeReceiptStage: async () => { events.push("receipt.write"); },
        inspectSecondaryStage: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
        copySecondaryStage: async () => { events.push("secondary.copy"); }
      }
    });
    await pair.stageSecondaryArtifact({ stagedPath: "/private/browser-capture-html/composition.html", outputPath: html.outputPath, artifact: { role: "browser_capture_html" }, inputHashKey: "html" });
    await pair.stageSecondaryArtifact({ stagedPath: "/private/trace.json", outputPath: trace.outputPath, artifact: { role: "browser_workflow_trace" }, inputHashKey: "trace" });
    await pair.stageReceipt(receipt(output.stagingPath));

    await expect(pair.commit()).rejects.toBe(refusal);
    expect(events).toContain("html.publish");
    expect(events).toContain("html.verify-published");
    expect(events).toContain("trace.publish");
    expect(events).toContain("html.revoke");
    expect(events).toContain("receipt.revoke");
    expect(events).not.toContain("trace.revoke");
    expect(events).not.toContain("output.publish");
    expect(events).toContain("output.abort");
    expect(events).toContain("receipt.abort");
    expect(events).toContain("html.abort");
    expect(events).toContain("trace.abort");
  });

  it("returns delivery uncertainty after the first secondary link cannot be post-checked", async () => {
    const events: string[] = [];
    const output = fakePublication("output", events);
    const sidecar = fakePublication("receipt", events);
    const html = fakePublication("html", events, { verifyPublishedError: new Error("after first secondary link") });
    const acquired = [output, sidecar, html];
    const pair = await PairedOutputReceiptPublication.acquire({
      outputPath: output.outputPath, receiptPath: sidecar.outputPath,
      outputArtifact: { role: "preview_frame" }, receiptArtifact: { role: "preview_receipt" },
      testHooks: {
        acquirePublication: async () => acquired.shift() ?? Promise.reject(new Error("unexpected publication acquisition")),
        writeReceiptStage: async () => { events.push("receipt.write"); },
        inspectSecondaryStage: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
        copySecondaryStage: async () => { events.push("html.copy"); }
      }
    });
    await pair.stageSecondaryArtifact({ stagedPath: "/private/browser-capture-html/composition.html", outputPath: html.outputPath, artifact: { role: "browser_capture_html" }, inputHashKey: "html" });
    await pair.stageReceipt(receipt(output.stagingPath));

    await expect(pair.commit()).rejects.toBeInstanceOf(PairedOutputReceiptCommitUncertainError);
    expect(events).toContain("receipt.publish");
    expect(events).toContain("html.publish");
    expect(events).not.toContain("html.revoke");
    expect(events).not.toContain("receipt.revoke");
    expect(events).not.toContain("output.publish");
  });

  it("keeps an authenticated secondary post-link failure phase-specific with its exact public evidence", async () => {
    const events: string[] = [];
    const output = fakePublication("output", events);
    const sidecar = fakePublication("receipt", events);
    const html = fakePublication("html", events, {
      publishError: new PublicationCommitUncertainError({
        publicPath: "/public/html", kind: "file", expectedIdentity: { dev: 1, ino: 3 },
        expected: { sha256, byteLength: Buffer.byteLength(bytes) }
      }, new Error("secondary post-link check"))
    });
    const acquired = [output, sidecar, html];
    const pair = await PairedOutputReceiptPublication.acquire({
      outputPath: output.outputPath, receiptPath: sidecar.outputPath,
      outputArtifact: { role: "preview_frame" }, receiptArtifact: { role: "preview_receipt" },
      testHooks: {
        acquirePublication: async () => acquired.shift() ?? Promise.reject(new Error("unexpected publication acquisition")),
        writeReceiptStage: async () => { events.push("receipt.write"); },
        inspectSecondaryStage: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
        copySecondaryStage: async () => { events.push("html.copy"); }
      }
    });
    await pair.stageSecondaryArtifact({ stagedPath: "/private/browser-capture-html/composition.html", outputPath: html.outputPath, artifact: { role: "browser_capture_html" }, inputHashKey: "html" });
    await pair.stageReceipt(receipt(output.stagingPath));

    await expect(pair.commit()).rejects.toMatchObject({
      code: "paired_output_commit_uncertain", phase: "secondary", publicPaths: [html.outputPath],
      expectedPublications: [{ publicPath: html.outputPath }]
    });
    expect(events).toContain("receipt.publish");
    expect(events).toContain("html.publish");
    expect(events).not.toContain("html.revoke");
    expect(events).not.toContain("receipt.revoke");
    expect(events).not.toContain("output.publish");
  });

  it("retains earlier secondary evidence when a later secondary link becomes uncertain", async () => {
    const events: string[] = [];
    const output = fakePublication("output", events);
    const sidecar = fakePublication("receipt", events);
    const html = fakePublication("html", events);
    const trace = fakePublication("trace", events, { verifyPublishedError: new Error("after second secondary link") });
    const acquired = [output, sidecar, html, trace];
    const pair = await PairedOutputReceiptPublication.acquire({
      outputPath: output.outputPath, receiptPath: sidecar.outputPath,
      outputArtifact: { role: "preview_frame" }, receiptArtifact: { role: "preview_receipt" },
      testHooks: {
        acquirePublication: async () => acquired.shift() ?? Promise.reject(new Error("unexpected publication acquisition")),
        writeReceiptStage: async () => { events.push("receipt.write"); },
        inspectSecondaryStage: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
        copySecondaryStage: async () => { events.push("secondary.copy"); }
      }
    });
    await pair.stageSecondaryArtifact({ stagedPath: "/private/browser-capture-html/composition.html", outputPath: html.outputPath, artifact: { role: "browser_capture_html" }, inputHashKey: "html" });
    await pair.stageSecondaryArtifact({ stagedPath: "/private/trace.json", outputPath: trace.outputPath, artifact: { role: "browser_workflow_trace" }, inputHashKey: "trace" });
    await pair.stageReceipt(receipt(output.stagingPath));

    await expect(pair.commit()).rejects.toBeInstanceOf(PairedOutputReceiptCommitUncertainError);
    expect(events).toContain("html.publish");
    expect(events).toContain("html.verify-published");
    expect(events).toContain("trace.publish");
    expect(events).not.toContain("html.revoke");
    expect(events).not.toContain("trace.revoke");
    expect(events).not.toContain("receipt.revoke");
    expect(events).not.toContain("output.publish");
  });

  it("preserves a retargeted receipt name while still releasing both private reservations", async () => {
    const events: string[] = [];
    const output = fakePublication("output", events);
    const sidecar = fakePublication("receipt", events, { revokeError: Object.assign(new Error("retargeted receipt"), { code: "derived_output_stage_invalid" }) });
    const value = await staged({ output, receipt: sidecar });
    let checks = 0;

    await expect(value.pair.commit({ cancelled: () => ++checks >= 2 })).rejects.toThrow("retargeted receipt");
    expect(events).toContain("receipt.revoke");
    expect(events).toContain("output.abort");
    expect(events).toContain("receipt.abort");
    expect(events).not.toContain("output.publish");
  });

  it("rejects a receipt-only success shape when its required primary artifact is absent", () => {
    const value = receipt("/private/output");
    value.output = { path: "/public/output", sha256 };
    value.artifacts = [{ role: "preview_receipt", path: "/public/receipt", status: "available" }];
    expect(() => assertPairedReceiptAcceptance("/public/receipt", value)).toThrow(/paired CLI delivery|output artifact/i);
  });
});
