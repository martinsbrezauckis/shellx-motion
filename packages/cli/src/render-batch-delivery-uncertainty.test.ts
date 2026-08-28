import { describe, expect, it } from "vitest";
import {
  readRenderCommitUncertainDelivery,
  readRenderBatchChildDelivery,
  renderBatchBookkeepingDeliveryFields,
  renderBatchChildDeliveryJobFields,
  renderBatchFailureReceipt,
  renderCommitUncertainErrorFields,
  renderCommitUncertainJobFields,
  renderCommitUncertainReceiptJobFields,
  renderCommitUncertainResponseFields
} from "./render-batch-delivery-uncertainty.js";

describe("render-batch delegated post-link uncertainty", () => {
  it("preserves a delegated paired result in the row, batch receipt, error, and response", () => {
    const delivery = readRenderCommitUncertainDelivery({
      ok: false,
      renderCommitUncertain: true,
      outputPath: "/public/final.mp4",
      receiptPath: "/public/final.render.receipt.json",
      expectedPublications: [{ publicPath: "/public/final.mp4", expected: { sha256: "a".repeat(64), byteLength: 9 } }]
    });
    expect(delivery).toMatchObject({ outputPath: "/public/final.mp4", receiptPath: "/public/final.render.receipt.json", expectedPublications: [{ publicPath: "/public/final.mp4" }] });
    expect(renderCommitUncertainJobFields(delivery)).toEqual({
      renderCommitUncertain: true,
      renderOutputPath: "/public/final.mp4",
      renderReceiptPath: "/public/final.render.receipt.json",
      expectedPublications: [{ publicPath: "/public/final.mp4", expected: { sha256: "a".repeat(64), byteLength: 9 } }]
    });
    expect(renderCommitUncertainReceiptJobFields({ ...renderCommitUncertainJobFields(delivery) })).toEqual(renderCommitUncertainJobFields(delivery));
    expect(renderCommitUncertainErrorFields(delivery)).toMatchObject({ renderCommitUncertain: true, receiptPath: "/public/final.render.receipt.json", expectedPublications: [{ publicPath: "/public/final.mp4" }] });
    expect(renderCommitUncertainResponseFields(delivery)).toMatchObject({ renderCommitUncertain: true, outputPath: "/public/final.mp4", renderReceiptPath: "/public/final.render.receipt.json", expectedPublications: [{ publicPath: "/public/final.mp4" }] });
    expect(renderBatchFailureReceipt({ packageId: "pkg", rowHash: "a".repeat(64), preset: "mp4-h264", delivery })).toMatchObject({
      id: "render-commit-uncertain-pkg",
      status: "warning",
      output: { renderCommitUncertain: true, outputPath: "/public/final.mp4", receiptPath: "/public/final.render.receipt.json", expectedPublications: [{ publicPath: "/public/final.mp4" }] }
    });
  });

  it("does not manufacture uncertainty from incomplete delegated failure data", () => {
    expect(readRenderCommitUncertainDelivery({ renderCommitUncertain: true, outputPath: "/public/final.mp4" })).toBeUndefined();
    expect(readRenderCommitUncertainDelivery({ renderCommitUncertain: true, receiptPath: "/public/final.receipt.json" })).toBeUndefined();
  });

  it("retains both an already-committed child and phase-specific evidence uncertainty for later batch bookkeeping failures", () => {
    const committed = readRenderBatchChildDelivery({
      ok: true, outputPath: "/public/first.mp4", receiptPath: "/public/first.render.receipt.json"
    });
    const receiptUncertain = readRenderBatchChildDelivery({
      ok: false,
      possiblyCommitted: true,
      publicationCommitPhase: "receipt",
      publicPaths: ["/public/second.render.receipt.json"],
      expectedPublications: [{ publicPath: "/public/second.render.receipt.json" }]
    });
    expect(committed).toEqual({ kind: "committed", outputPath: "/public/first.mp4", receiptPath: "/public/first.render.receipt.json" });
    expect(receiptUncertain).toEqual({ kind: "evidence_uncertain", phase: "receipt", publicPaths: ["/public/second.render.receipt.json"], expectedPublications: [{ publicPath: "/public/second.render.receipt.json" }] });
    expect(renderBatchBookkeepingDeliveryFields([
      { ...renderBatchChildDeliveryJobFields(committed) },
      { ...renderBatchChildDeliveryJobFields(receiptUncertain) }
    ])).toEqual({
      batchCommitted: true,
      committedDeliveries: [{ outputPath: "/public/first.mp4", receiptPath: "/public/first.render.receipt.json" }],
      possiblyCommitted: true,
      uncertainDeliveries: [{ phase: "receipt", publicPaths: ["/public/second.render.receipt.json"], expectedPublications: [{ publicPath: "/public/second.render.receipt.json" }] }]
    });
  });

  it("labels a receipt-or-secondary uncertainty as uncertain rather than a synthetic render failure", () => {
    const delivery = readRenderBatchChildDelivery({
      ok: false,
      possiblyCommitted: true,
      publicationCommitPhase: "secondary",
      publicPaths: ["/public/final.browser-capture.html"]
    });
    expect(renderBatchFailureReceipt({ packageId: "pkg", rowHash: "b".repeat(64), preset: "png-frame", delivery })).toMatchObject({
      id: "render-commit-uncertain-pkg",
      status: "warning",
      output: {
        possiblyCommitted: true,
        publicationCommitPhase: "secondary",
        publicPaths: ["/public/final.browser-capture.html"]
      }
    });
  });
});
