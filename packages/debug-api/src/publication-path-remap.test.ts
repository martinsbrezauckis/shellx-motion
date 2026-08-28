import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { remapPublicationPaths } from "./publication-path-remap.js";

describe("publication path remapping", () => {
  it("maps only verified stage paths and quality-frame siblings", () => {
    const stagingPath = join("/delivery", ".shellx-motion-final-123.mp4");
    const outputPath = join("/delivery", "final.mp4");
    const qualityDirectory = join("/scratch", "quality");
    const stageStem = ".shellx-motion-final-123";
    const incidental = `diagnostic retained ${stageStem} verbatim`;
    const values = {
      exact: stagingPath,
      descendant: join(stagingPath, "000001.png"),
      qualityFrame: join(qualityDirectory, `${stageStem}-intro-frame.png`),
      incidental,
      foreignQualityNamedPath: join("/other", `${stageStem}-intro-frame.png`),
      otherQualityArtifact: join(qualityDirectory, `${stageStem}-notes.json`)
    };

    remapPublicationPaths(values, stagingPath, outputPath, qualityDirectory);

    expect(values).toEqual({
      exact: outputPath,
      descendant: join(outputPath, "000001.png"),
      qualityFrame: join(qualityDirectory, "final-intro-frame.png"),
      incidental,
      foreignQualityNamedPath: join("/other", `${stageStem}-intro-frame.png`),
      otherQualityArtifact: join(qualityDirectory, `${stageStem}-notes.json`)
    });
  });
});
