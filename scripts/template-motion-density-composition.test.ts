import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderReceiptPathForOutput } from "../packages/cli/src/render-receipt-file";
import { motionDensityCompositionPaths, stripFilmGrainEffects } from "./template-motion-density-composition";

describe("film-grain-stripped motion-density alternate", () => {
  it("removes only declared film grain and preserves composition effects", () => {
    const motion: Record<string, unknown> = {
      layers: [
        { id: "finish", effects: { vignette: { amount: 0.2 }, filmGrain: { amount: 0.01, seed: 1 } } },
        { id: "copy", effects: { shadow: { blur: 4 } } },
        { id: "plain" }
      ]
    };

    expect(stripFilmGrainEffects(motion)).toBe(1);
    expect(motion).toEqual({
      layers: [
        { id: "finish", effects: { vignette: { amount: 0.2 } } },
        { id: "copy", effects: { shadow: { blur: 4 } } },
        { id: "plain" }
      ]
    });
  });

  it("does not claim that a package without film grain has a composition alternate", () => {
    const motion: Record<string, unknown> = { layers: [{ id: "copy", effects: { vignette: { amount: 0.2 } } }] };
    expect(stripFilmGrainEffects(motion)).toBe(0);
  });

  it("isolates the grain-stripped final and its sibling receipt from the main render", () => {
    const proofPackagesRoot = join("/proof", "packages");
    const framesRoot = join("/proof", "frames");
    const rendersRoot = join("/proof", "renders");
    const packageDirName = "cinematic-rain-launch";
    const packageId = "pkg_cinematic_rain_launch";
    const mainOutputPath = join(rendersRoot, `${packageDirName}.mp4`);
    const alternate = motionDensityCompositionPaths({ packageDirName, proofPackagesRoot, framesRoot, rendersRoot });

    expect(alternate).toEqual({
      packageRoot: join(proofPackagesRoot, `${packageDirName}-motion-density-composition`),
      scratchRoot: join(framesRoot, `${packageDirName}-motion-density-composition`),
      outputPath: join(rendersRoot, `${packageDirName}-motion-density-composition`, `${packageDirName}.mp4`)
    });
    expect(dirname(alternate.outputPath)).not.toBe(dirname(mainOutputPath));
    expect(renderReceiptPathForOutput(packageId, alternate.outputPath, "ffmpeg"))
      .not.toBe(renderReceiptPathForOutput(packageId, mainOutputPath, "ffmpeg"));
  });
});
