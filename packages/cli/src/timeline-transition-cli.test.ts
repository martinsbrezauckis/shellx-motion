import { describe, expect, it } from "vitest";
import { debugCommandName } from "./debug-subcommands.js";
import { timelineTransitionDebugArgs } from "./timeline-transition-cli.js";

const option = (argv: string[], name: string) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

describe("transition preset CLI projection", () => {
  it("maps discovery and closed apply arguments without inventing fields", () => {
    expect(debugCommandName("transition-presets")).toBe("motion.timeline.transition.presets");
    expect(debugCommandName("transition-preset-apply")).toBe("motion.timeline.transition.preset.apply");
    expect(timelineTransitionDebugArgs("motion.timeline.transition.presets", [], option, () => undefined)).toEqual({});
    expect(timelineTransitionDebugArgs("motion.timeline.transition.preset.apply", [
      "--package", "/source", "--out", "/out", "--layer", "title", "--preset", "scan-sweep",
      "--duration-ms", "520", "--direction", "right", "--distance", "96", "--easing", "ease-out",
    ], option, (argv) => option(argv, "--package"))).toEqual({
      packageRoot: "/source", outDir: "/out", receiptsRoot: undefined, createdBy: undefined,
      layerId: "title", preset: "scan-sweep", durationMs: 520, direction: "right", distance: 96, easing: "ease-out",
    });
  });
});
