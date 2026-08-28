import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { actionCoverageReport, type CoverageFixture } from "./actions-coverage";

const repoRoot = resolve(import.meta.dirname, "..");
const fixture = JSON.parse(readFileSync(resolve(repoRoot, "fixtures/debug/coverage.expected.json"), "utf8")) as CoverageFixture;
const registeredCommands = (JSON.parse(readFileSync(resolve(repoRoot, "schemas/debug.json"), "utf8")) as { commands: string[] }).commands;

describe("debug coverage scope report", () => {
  it("reports the fixture-defined mapped subset and all of its limits", () => {
    const report = actionCoverageReport(fixture, registeredCommands);

    expect(report.ok).toBe(true);
    expect(report.scope).toEqual({
      id: "fixture-defined-visible-surface-command-parity",
      visibleSurfaceCount: 9,
      visibleSurfaces: ["assets", "brand", "packages", "preview", "prompt", "receipts", "templateInspector", "timeline", "tracking"],
      doesNotMeasure: [
        "commands outside the named surface map",
        "handler execution",
        "action-discovery completeness",
        "receipt behavior",
        "unit or line coverage"
      ]
    });
    expect(report.commandScope).toEqual({
      mappedRegisteredCommands: 160,
      totalRegisteredCommands: 300,
      registeredCommandsOutsideScope: 140
    });
    expect(report.fixtureParity).toEqual({
      matchedRequiredCommands: 160,
      requiredCommands: 160,
      mappedCommands: 160
    });
    expect(report.uncovered).toEqual([]);
    expect(report.missingCommands).toEqual([]);
    expect(report.unexpectedCommands).toEqual([]);
    expect(report.unregisteredCommands).toEqual([]);
    expect(report.invalidFixture).toEqual({
      emptyVisibleSurfaces: false,
      emptyRequiredCommands: false,
      duplicateVisibleSurfaces: [],
      duplicateRequiredCommands: []
    });
  });

  it("fails rather than making an ambiguous fixture look fully covered", () => {
    const report = actionCoverageReport({
      visibleSurfaces: ["assets", "assets"],
      requiredCommands: ["motion.assets.panel", "motion.unknown"]
    }, ["motion.assets.panel", "motion.media.panel"]);

    expect(report.ok).toBe(false);
    expect(report.unregisteredCommands).toEqual(["motion.package.asset.import", "motion.unknown"]);
    expect(report.invalidFixture).toEqual({
      emptyVisibleSurfaces: false,
      emptyRequiredCommands: false,
      duplicateVisibleSurfaces: ["assets"],
      duplicateRequiredCommands: []
    });
  });
});
