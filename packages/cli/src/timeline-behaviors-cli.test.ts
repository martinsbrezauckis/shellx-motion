import { describe, expect, it } from "vitest";
import { timelineBehaviorDebugArgs } from "./timeline-behaviors-cli.js";

const UPSERT = "motion.timeline.behaviors.upsert" as const;
const REMOVE = "motion.timeline.behaviors.remove" as const;
const option = (argv: string[], name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

describe("timeline behavior CLI projection", () => {
  it("accepts equal resolved output aliases for each mutation command", () => {
    expect(timelineBehaviorDebugArgs(UPSERT, ["--out", "/out/.", "--package-dir", "/out", "--binding-json", "{}"], "/source", option))
      .toEqual({ packageRoot: "/source", outDir: "/out/.", binding: {} });
    expect(timelineBehaviorDebugArgs(REMOVE, ["--out", "/out/.", "--package-dir", "/out", "--target-layer-id", "layer"], "/source", option))
      .toEqual({ packageRoot: "/source", outDir: "/out/.", targetLayerId: "layer" });
  });

  it("refuses conflicting output aliases for each mutation command", () => {
    for (const command of [UPSERT, REMOVE]) {
      expect(() => timelineBehaviorDebugArgs(command, ["--out", "/first", "--package-dir", "/second"], "/source", option))
        .toThrow("requires --out and --package-dir to resolve to the same directory");
    }
  });
});
