import { describe, expect, it } from "vitest";
import { dispatchDomainCommand } from "./router.js";

describe("native final-render routing", () => {
  it("passes an explicit GPU final-video selection to the FFmpeg executor without selecting a fallback lane", async () => {
    let selected: string | undefined;
    const result = await dispatchDomainCommand(
      "render",
      "motion.render.final",
      { packageRoot: "/trusted/package", outputPath: "/trusted/final.mp4", frameLane: "gpu" },
      {
        executeFfmpegFinalRender: async (request) => {
          selected = request.frameLane;
          return { ok: true as const, warnings: [] };
        }
      }
    );

    expect(result).toMatchObject({ ok: true });
    expect(selected).toBe("gpu");
  });

  it("passes strict GPU segmented resume to the same FFmpeg executor without caller proof", async () => {
    let selected: Record<string, unknown> | undefined;
    const result = await dispatchDomainCommand(
      "render",
      "motion.render.final",
      {
        packageRoot: "/trusted/package",
        outputPath: "/trusted/final.mp4",
        frameLane: "gpu",
        segmented: { segmentFrames: 24, resume: true }
      },
      {
        executeFfmpegFinalRender: async (request) => {
          selected = request as unknown as Record<string, unknown>;
          return { ok: true as const, warnings: [] };
        }
      }
    );

    expect(result).toMatchObject({ ok: true });
    expect(selected).toMatchObject({
      frameLane: "gpu",
      segmented: { segmentFrames: 24, resume: true }
    });
    expect(selected).not.toHaveProperty("producer");
    expect(selected).not.toHaveProperty("createRangeProducer");
    expect(selected).not.toHaveProperty("storeRoot");
    for (const field of ["browserLocation", "browserSessionFactory", "openVideoProvider", "providerFactory", "openHybridCapture", "hybridCapture", "capturePlan"]) {
      expect(selected).not.toHaveProperty(field);
    }
  });

  it("refuses GPU reuse before selecting a final-render executor", async () => {
    let calls = 0;
    const result = await dispatchDomainCommand(
      "render",
      "motion.render.final",
      { packageRoot: "/trusted/package", outputPath: "/trusted/final.mp4", frameLane: "gpu", segmented: { segmentFrames: 24 }, reuseAttested: true },
      { executeFfmpegFinalRender: async () => { calls += 1; return { ok: true as const, warnings: [] }; } }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: expect.stringContaining("post-render identity is evidence only") }
    });
    expect(calls).toBe(0);
  });

  it("refuses browser workflow before the GPU segmented executor is selected", async () => {
    let calls = 0;
    const result = await dispatchDomainCommand(
      "render",
      "motion.render.final",
      {
        packageRoot: "/trusted/package",
        outputPath: "/trusted/final.mp4",
        frameLane: "gpu",
        segmented: { segmentFrames: 24 },
        workflowPath: "/trusted/workflow.json"
      },
      { executeFfmpegFinalRender: async () => { calls += 1; return { ok: true as const, warnings: [] }; } }
    );

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("Segmented final delivery does not support browser workflows") } });
    expect(calls).toBe(0);
  });

  it("refuses browser workflows before selecting a final-render executor", async () => {
    let calls = 0;
    const result = await dispatchDomainCommand(
      "render",
      "motion.render.final",
      {
        packageRoot: "/trusted/package",
        outputPath: "/trusted/final.mp4",
        frameLane: "native",
        workflowPath: "/trusted/workflow.json"
      },
      {
        executeFfmpegFinalRender: async () => {
          calls += 1;
          return { ok: true as const, warnings: [] };
        }
      }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_args",
        message: "Browser workflows require frameLane browser; native final rendering never falls back to browser."
      }
    });
    expect(calls).toBe(0);
  });
});
