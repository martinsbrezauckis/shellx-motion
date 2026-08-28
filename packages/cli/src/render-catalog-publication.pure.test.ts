import { describe, expect, it, vi } from "vitest";
import type { OperationReceipt, PreparedBrowserWorkflowCatalogUpsert } from "@shellx-motion/core";
import {
  abortPreparedRenderCatalog,
  commitPreparedRenderCatalog,
  decidePreparedRenderCatalog
} from "./render-receipt-file.js";

function receipt(): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: "render-catalog-pure",
    operation: "render.final",
    status: "passed",
    packageId: "pkg",
    inputHashes: { workflow: "a".repeat(64) },
    createdAt: "2026-08-21T00:00:00.000Z",
    lane: "ffmpeg",
    output: { path: "/governed/final.mp4", sha256: "b".repeat(64) },
    warnings: []
  };
}

function plan(events: string[], options: { commitError?: Error } = {}): PreparedBrowserWorkflowCatalogUpsert {
  const result = {
    ok: true as const,
    catalogPath: "/governed/catalog.json",
    drift: {
      status: "changed" as const,
      key: "pkg:a",
      baselineOutputSha256: "c".repeat(64),
      currentOutputSha256: "b".repeat(64)
    },
    entry: {} as never,
    catalog: {} as never
  };
  return {
    result,
    commit: vi.fn(async () => {
      events.push("catalog.commit");
      if (options.commitError) throw options.commitError;
      return result;
    }),
    abort: vi.fn(async () => { events.push("catalog.abort"); })
  };
}

describe("render catalog retained-publication decision (pure injection)", () => {
  it("keeps a changed catalog candidate private and aborts it for fail-on-drift", async () => {
    const events: string[] = [];
    const candidate = plan(events);
    const result = decidePreparedRenderCatalog(receipt(), candidate, true);

    expect(result.error).toMatchObject({ code: "browser_workflow_drift_detected" });
    expect(events).toEqual([]);
    expect(result.artifacts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "browser_workflow_catalog" })
    ]));

    await abortPreparedRenderCatalog(result);
    expect(events).toEqual(["catalog.abort"]);
  });

  it("commits a catalog only after the caller accepts delivery and exposes an injected commit failure", async () => {
    const events: string[] = [];
    const result = decidePreparedRenderCatalog(receipt(), plan(events), false);

    expect(events).toEqual([]);
    await expect(commitPreparedRenderCatalog(result)).resolves.toMatchObject({ workflowCatalogPath: "/governed/catalog.json" });
    expect(events).toEqual(["catalog.commit"]);

    const failure = decidePreparedRenderCatalog(receipt(), plan(events, { commitError: new Error("injected catalog commit") }), false);
    await expect(commitPreparedRenderCatalog(failure)).rejects.toThrow("injected catalog commit");
    expect(events).toEqual(["catalog.commit", "catalog.commit"]);
  });
});
