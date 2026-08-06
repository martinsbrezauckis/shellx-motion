import { describe, expect, it } from "vitest";
import { listTemplateParityGaps, summarizeTemplateParityProgram, templateParityProgram } from "./template-parity";

describe("template product parity roadmap", () => {
  it("tracks the eleven visible product gaps as machine-readable roadmap entries", () => {
    const program = templateParityProgram();

    expect(program.schema).toBe("shellx-motion/template-parity@1");
    expect(program.updatedAt).toBe("2026-07-06");
    expect(program.gaps.map((gap) => gap.id)).toEqual([
      "template-catalog",
      "media-rich-templates",
      "audio-lane-examples",
      "transition-library",
      "kinetic-typography",
      "data-chart-templates",
      "asset-generator-connectors",
      "template-browser-editor",
      "agent-authoring-loop",
      "advanced-imports",
      "design-variety"
    ]);

    expect(program.assetRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "codex-subscription-cli",
        role: "planning-code-template-authoring-verification"
      }),
      expect.objectContaining({
        id: "grok-build-cli",
        role: "generated-image-video-asset-source"
      })
    ]));
    expect(program.qualityGates).toEqual(expect.arrayContaining([
      "real-mp4-render",
      "audio-stream-check",
      "preview-final-frame-parity",
      "source-asset-provenance",
      "human-contact-sheet-review",
      "shellx-cut-canvas-receipts"
    ]));
  });

  it("maps every gap into an implementation phase with product-surface proof", () => {
    const program = templateParityProgram();
    const phaseGapIds = new Set(program.phases.flatMap((phase) => phase.gapIds));

    expect(phaseGapIds).toEqual(new Set(program.gaps.map((gap) => gap.id)));
    for (const gap of listTemplateParityGaps()) {
      expect(gap.shellxSurfaces).toEqual(expect.arrayContaining(["motion"]));
      expect(gap.proof.length).toBeGreaterThanOrEqual(2);
      expect(program.phases.some((phase) => phase.gapIds.includes(gap.id))).toBe(true);
    }
  });

  it("summarizes roadmap status for debug panels and agent planning", () => {
    expect(summarizeTemplateParityProgram()).toEqual({
      gapCount: 11,
      phaseCount: 7,
      assetRouteCount: 2,
      qualityGateCount: 6,
      firstPhase: "P0",
      finalPhase: "P6",
      shellxSurfaces: ["canvas", "cut", "motion"]
    });
  });
});
