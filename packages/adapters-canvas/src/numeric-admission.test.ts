import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CanvasFixtureError,
  convertCanvasFrameToMotionPackage,
  parseCanvasFrameSelection,
  type CanvasFixtureProblem
} from "./index";

async function loadFixture(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(resolve("../../fixtures/canvas/frame-selection.json"), "utf8")) as Record<string, any>;
}

function problemsFor(fixture: unknown): CanvasFixtureProblem[] {
  try {
    parseCanvasFrameSelection(fixture);
  } catch (error) {
    if (error instanceof CanvasFixtureError) return error.problems;
    throw error;
  }
  throw new Error("expected the fixture to be rejected");
}

describe("Canvas numeric admission", () => {
  it("rejects non-public Canvas timing and dimensions before a receipt can be created", async () => {
    const fixture = await loadFixture();
    fixture.frames[0].durationMs = 0;
    fixture.frames[0].fps = -1;
    fixture.frames[0].width = 1.5;
    fixture.frames[0].height = 0;
    fixture.frames[0].layers[0].startMs = -1;
    fixture.frames[0].layers[0].durationMs = 0;
    fixture.imageEditorOutputs[0].width = 1.5;
    fixture.imageEditorOutputs[0].height = 0;

    expect(problemsFor(fixture)).toEqual(expect.arrayContaining([
      { path: "frames[0].durationMs", message: "must be a positive finite number" },
      { path: "frames[0].fps", message: "must be a positive finite number" },
      { path: "frames[0].width", message: "must be a positive integer" },
      { path: "frames[0].height", message: "must be a positive integer" },
      { path: "frames[0].layers[0].startMs", message: "must be a non-negative finite number" },
      { path: "frames[0].layers[0].durationMs", message: "must be a positive finite number" },
      { path: "imageEditorOutputs[0].width", message: "must be a positive integer" },
      { path: "imageEditorOutputs[0].height", message: "must be a positive integer" }
    ]));
  });

  it("accepts positive odd Canvas and PNG dimensions", async () => {
    const fixture = await loadFixture();
    fixture.frames[0].width = 1081;
    fixture.frames[0].height = 1919;
    fixture.imageEditorOutputs[0].width = 921;
    fixture.imageEditorOutputs[0].height = 1021;

    const result = convertCanvasFrameToMotionPackage(fixture);

    expect(result.motion).toMatchObject({ width: 1081, height: 1919 });
    expect(result.motion.assets[0]).toMatchObject({ size: { width: 921, height: 1021 } });
  });

  it("refuses a converted Motion document that fails Core validation before creating a receipt", async () => {
    const fixture = await loadFixture();
    fixture.frames[0].layers[1].id = fixture.frames[0].layers[0].id;

    expect(() => convertCanvasFrameToMotionPackage(fixture)).toThrow(
      "Canvas conversion produced an invalid Motion document at /layers/1/id: duplicate layer id."
    );
  });
});
