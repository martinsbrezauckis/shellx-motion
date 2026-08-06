import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { upsertBrowserWorkflowCatalog } from "./browser-workflow-catalog";

describe("browser workflow catalog", () => {
  it("creates a reusable baseline entry for a deterministic browser workflow capture", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-browser-workflow-catalog-"));
    const catalogPath = join(tempRoot, "browser-workflows.catalog.json");
    try {
      const result = await upsertBrowserWorkflowCatalog({
        catalogPath,
        capture: {
          packageId: "pkg_web",
          workflowHash: "a".repeat(64),
          atMs: 750,
          outputSha256: "b".repeat(64),
          outputPath: join(tempRoot, "frame.png"),
          receiptPath: join(tempRoot, "capture.receipt.json"),
          tracePath: join(tempRoot, "workflow.trace.json"),
          createdAt: "2026-07-02T08:00:00.000Z",
          browser: { name: "chromium", version: "test" },
          viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
          workflow: { stepCount: 2, networkPolicy: "blocked-unless-declared" },
          captureReadiness: {
            schema: "shellx-motion/browser-capture-readiness@1",
            page: "loaded",
            stylesheets: "settled",
            fonts: "ready",
            animationPolicy: "screenshot-disabled",
            media: "settled-after-time-seek",
            waitMs: 14,
            diagnostics: {
              stylesheetLinkCount: 1,
              fontFaceCount: 2,
              fontFaceLoadAttemptCount: 2,
              fontFaceLoadedCount: 2,
              finiteAnimationCount: 1,
              finiteAnimationMaxMs: 1200,
              finiteTransitionCount: 1,
              finiteTransitionMaxMs: 650
            }
          }
        }
      });
      const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as Record<string, any>;

      expect(result).toMatchObject({
        ok: true,
        catalogPath,
        drift: {
          status: "new",
          key: "pkg_web:a".concat("a".repeat(63), ":750")
        },
        entry: {
          packageId: "pkg_web",
          workflowHash: "a".repeat(64),
          atMs: 750,
          baseline: { outputSha256: "b".repeat(64) },
          latest: { outputSha256: "b".repeat(64) },
          history: [{ outputSha256: "b".repeat(64) }]
        }
      });
      expect(catalog).toMatchObject({
        schema: "shellx-motion/browser-workflow-catalog@1",
        entries: [
          {
            key: "pkg_web:a".concat("a".repeat(63), ":750"),
            drift: { status: "new" },
            baseline: {
              outputPath: join(tempRoot, "frame.png"),
              tracePath: join(tempRoot, "workflow.trace.json"),
              workflow: { stepCount: 2, networkPolicy: "blocked-unless-declared" },
              captureReadiness: {
                schema: "shellx-motion/browser-capture-readiness@1",
                fonts: "ready",
                waitMs: 14,
                diagnostics: {
                  stylesheetLinkCount: 1,
                  finiteAnimationMaxMs: 1200
                }
              }
            }
          }
        ]
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports matched and changed drift against the original baseline", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-browser-workflow-drift-"));
    const catalogPath = join(tempRoot, "browser-workflows.catalog.json");
    const baseCapture = {
      packageId: "pkg_web",
      workflowHash: "c".repeat(64),
      atMs: 100,
      outputSha256: "d".repeat(64),
      outputPath: join(tempRoot, "first.png"),
      receiptPath: join(tempRoot, "first.receipt.json"),
      createdAt: "2026-07-02T08:00:00.000Z",
      browser: { name: "chromium", version: "test" },
      viewport: { width: 640, height: 360, deviceScaleFactor: 1 },
      workflow: { stepCount: 1, networkPolicy: "blocked-unless-declared" }
    };
    try {
      await upsertBrowserWorkflowCatalog({ catalogPath, capture: baseCapture });

      const matched = await upsertBrowserWorkflowCatalog({
        catalogPath,
        capture: {
          ...baseCapture,
          outputPath: join(tempRoot, "second.png"),
          receiptPath: join(tempRoot, "second.receipt.json"),
          createdAt: "2026-07-02T08:01:00.000Z"
        }
      });
      const changed = await upsertBrowserWorkflowCatalog({
        catalogPath,
        capture: {
          ...baseCapture,
          outputSha256: "e".repeat(64),
          outputPath: join(tempRoot, "third.png"),
          receiptPath: join(tempRoot, "third.receipt.json"),
          createdAt: "2026-07-02T08:02:00.000Z"
        }
      });

      expect(matched.drift).toMatchObject({
        status: "matched",
        baselineOutputSha256: "d".repeat(64),
        currentOutputSha256: "d".repeat(64)
      });
      expect(changed.drift).toMatchObject({
        status: "changed",
        baselineOutputSha256: "d".repeat(64),
        previousOutputSha256: "d".repeat(64),
        currentOutputSha256: "e".repeat(64)
      });
      expect(changed.entry.baseline.outputSha256).toBe("d".repeat(64));
      expect(changed.entry.latest.outputSha256).toBe("e".repeat(64));
      expect(changed.entry.history.map((capture) => capture.outputSha256)).toEqual([
        "d".repeat(64),
        "d".repeat(64),
        "e".repeat(64)
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
