import { describe, expect, it } from "vitest";
import {
  CanvasFixtureError,
  MAX_CANVAS_EDIT_STACK_ENTRIES_PER_OUTPUT,
  MAX_CANVAS_FIXTURE_ERROR_MESSAGE_BYTES,
  MAX_CANVAS_FIXTURE_PROBLEMS,
  MAX_CANVAS_FRAME_COUNT,
  MAX_CANVAS_IMAGE_EDITOR_OUTPUTS,
  MAX_CANVAS_LAYERS_PER_FRAME,
  MAX_CANVAS_SAFE_AREAS_PER_FRAME,
  MAX_CANVAS_TOTAL_LAYER_COUNT,
  convertCanvasFrameToMotionPackage,
  type CanvasFixtureProblem
} from "./index";

describe("Canvas fixture bounded validation", () => {
  function fixtureErrorFor(fixture: unknown): CanvasFixtureError {
    try {
      convertCanvasFrameToMotionPackage(fixture);
    } catch (error) {
      if (error instanceof CanvasFixtureError) return error;
      throw error;
    }
    throw new Error("expected the fixture to be rejected");
  }

  function boundedFixture(): any {
    return {
      schema: "shellx-canvas/frame-selection@1",
      selectedFrameId: "frame_intro",
      project: { id: "bounds_probe", name: "Bounds Probe" },
      brand: { tokens: {} },
      frames: [{
        id: "frame_intro",
        name: "Intro",
        durationMs: 1000,
        fps: 2,
        width: 640,
        height: 360,
        layers: [validLayer(0)]
      }],
      imageEditorOutputs: []
    };
  }

  function validLayer(index: number): Record<string, unknown> {
    return { id: `layer_${index}`, kind: "shape", startMs: 0, durationMs: 1000 };
  }

  function validOutput(index: number): Record<string, unknown> {
    return {
      id: `output_${index}`,
      assetId: `asset_${index}`,
      kind: "image",
      path: `assets/output_${index}.png`,
      mimeType: "image/png",
      width: 1,
      height: 1,
      sha256: "0".repeat(64),
      editStack: []
    };
  }

  it("refuses bounded Canvas frame, layer, asset-output, safe-area, and edit-stack cardinalities before conversion", () => {
    const cases: Array<{ fixture: any; expected: CanvasFixtureProblem }> = [];

    const tooManyFrames = boundedFixture();
    tooManyFrames.frames = Array.from({ length: MAX_CANVAS_FRAME_COUNT + 1 }, (_, index) => ({
      ...tooManyFrames.frames[0],
      id: `frame_${index}`
    }));
    cases.push({
      fixture: tooManyFrames,
      expected: { path: "fixture.frames", message: `must contain at most ${MAX_CANVAS_FRAME_COUNT} frames` }
    });

    const tooManyLayers = boundedFixture();
    tooManyLayers.frames[0].layers = Array.from({ length: MAX_CANVAS_LAYERS_PER_FRAME + 1 }, (_, index) => validLayer(index));
    cases.push({
      fixture: tooManyLayers,
      expected: { path: "frames[0].layers", message: `must contain at most ${MAX_CANVAS_LAYERS_PER_FRAME} layers` }
    });

    const tooManyAggregateLayers = boundedFixture();
    tooManyAggregateLayers.frames = Array.from({ length: 5 }, (_, frameIndex) => ({
      ...tooManyAggregateLayers.frames[0],
      id: `aggregate_${frameIndex}`,
      layers: Array.from(
        { length: frameIndex < 4 ? MAX_CANVAS_LAYERS_PER_FRAME : 1 },
        (_, layerIndex) => validLayer(frameIndex * MAX_CANVAS_LAYERS_PER_FRAME + layerIndex)
      )
    }));
    cases.push({
      fixture: tooManyAggregateLayers,
      expected: { path: "fixture.frames", message: `must contain at most ${MAX_CANVAS_TOTAL_LAYER_COUNT} aggregate layers` }
    });

    const tooManyOutputs = boundedFixture();
    tooManyOutputs.imageEditorOutputs = Array.from(
      { length: MAX_CANVAS_IMAGE_EDITOR_OUTPUTS + 1 },
      (_, index) => validOutput(index)
    );
    cases.push({
      fixture: tooManyOutputs,
      expected: {
        path: "fixture.imageEditorOutputs",
        message: `must contain at most ${MAX_CANVAS_IMAGE_EDITOR_OUTPUTS} image-editor outputs`
      }
    });

    const tooManySafeAreas = boundedFixture();
    tooManySafeAreas.frames[0].safeAreas = Object.fromEntries(
      Array.from({ length: MAX_CANVAS_SAFE_AREAS_PER_FRAME + 1 }, (_, index) => [
        `area_${index}`,
        { top: 0, right: 0, bottom: 0, left: 0 }
      ])
    );
    cases.push({
      fixture: tooManySafeAreas,
      expected: {
        path: "frames[0].safeAreas",
        message: `must contain at most ${MAX_CANVAS_SAFE_AREAS_PER_FRAME} safe areas`
      }
    });

    const tooManyEditStackEntries = boundedFixture();
    tooManyEditStackEntries.imageEditorOutputs = [{
      ...validOutput(0),
      editStack: Array.from({ length: MAX_CANVAS_EDIT_STACK_ENTRIES_PER_OUTPUT + 1 }, () => ({}))
    }];
    cases.push({
      fixture: tooManyEditStackEntries,
      expected: {
        path: "imageEditorOutputs[0].editStack",
        message: `must contain at most ${MAX_CANVAS_EDIT_STACK_ENTRIES_PER_OUTPUT} edit-stack entries`
      }
    });

    for (const { fixture, expected } of cases) {
      expect(fixtureErrorFor(fixture).problems).toContainEqual(expected);
    }
  });

  it("caps Canvas diagnostic collection and its duplicate Error message with deterministic summaries", () => {
    const malformedOutputs = boundedFixture();
    malformedOutputs.imageEditorOutputs = Array.from({ length: MAX_CANVAS_IMAGE_EDITOR_OUTPUTS }, () => ({}));
    const collectionError = fixtureErrorFor(malformedOutputs);

    expect(collectionError.problems).toHaveLength(MAX_CANVAS_FIXTURE_PROBLEMS);
    expect(collectionError.omittedProblemCount).toBeGreaterThan(0);
    expect(collectionError.problems.at(-1)).toEqual({
      path: "fixture",
      message: `${collectionError.omittedProblemCount} additional Canvas fixture problems omitted after the ${MAX_CANVAS_FIXTURE_PROBLEMS}-problem limit.`
    });
    expect(collectionError.message).toContain(`${collectionError.omittedProblemCount} omitted after the ${MAX_CANVAS_FIXTURE_PROBLEMS}-problem limit`);

    const verboseKinds = boundedFixture();
    verboseKinds.frames[0].layers = Array.from({ length: MAX_CANVAS_FIXTURE_PROBLEMS }, (_, index) => ({
      ...validLayer(index),
      kind: "x".repeat(MAX_CANVAS_FIXTURE_ERROR_MESSAGE_BYTES)
    }));
    const messageError = fixtureErrorFor(verboseKinds);

    expect(messageError.problems).toHaveLength(MAX_CANVAS_FIXTURE_PROBLEMS);
    expect(Buffer.byteLength(messageError.message, "utf8")).toBeLessThanOrEqual(MAX_CANVAS_FIXTURE_ERROR_MESSAGE_BYTES);
    expect(messageError.message).toContain(`listed problems omitted from the error message after the ${MAX_CANVAS_FIXTURE_ERROR_MESSAGE_BYTES}-byte limit.`);
  });
});
