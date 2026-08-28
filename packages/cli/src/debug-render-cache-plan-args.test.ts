import { describe, expect, it } from "vitest";
import { debugRenderCachePlanArgs } from "./debug-render-cache-plan-args";
import { debugCommandName } from "./debug-subcommands";

describe("debug render-cache-plan CLI projection", () => {
  it("maps only the compact observation command and its bounded identity selectors", () => {
    const argv = ["render-cache-plan", "--package", "pkg", "--output", "out/frame.png", "--preset", "png-frame", "--frame-lane", "native", "--at-ms", "4"];
    const values = new Map<string, string>([["--package", "/pkg"], ["--output", "/out/frame.png"], ["--preset", "png-frame"], ["--frame-lane", "native"], ["--at-ms", "4"]]);
    const args = debugRenderCachePlanArgs(argv, () => values.get("--package"), (_argv, name) => values.get(name), (value) => `resolved:${value}`);

    expect(debugCommandName("render-cache-plan")).toBe("motion.render.cache.plan");
    expect(args).toEqual({ packageRoot: "/pkg", outputPath: "/out/frame.png", preset: "png-frame", frameLane: "native", atMs: 4 });
    expect(Object.keys(args)).not.toEqual(expect.arrayContaining(["cacheRoot", "descriptorPath", "receiptsRoot", "idempotencyKey", "workflow"]));
  });
});
