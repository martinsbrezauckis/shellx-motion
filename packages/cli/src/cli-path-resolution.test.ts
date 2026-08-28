import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCliInputPath, resolveCliOutputPath } from "./cli-path-resolution";

const originalInitCwd = process.env.INIT_CWD;
const sourceRoot = resolve(import.meta.dirname, "../../..");

afterEach(() => {
  if (originalInitCwd === undefined) delete process.env.INIT_CWD;
  else process.env.INIT_CWD = originalInitCwd;
});

describe("CLI path resolution", () => {
  it("anchors source-checkout paths to the checkout when INIT_CWD is inherited from its parent", () => {
    process.env.INIT_CWD = resolve(sourceRoot, "..");

    expect(resolveCliInputPath("fixtures/packages/lower-third")).toBe(resolve(sourceRoot, "fixtures/packages/lower-third"));
    expect(resolveCliOutputPath(".scratch/example")).toBe(resolve(sourceRoot, ".scratch/example"));
  });

  it("retains a source-checkout caller below the checkout", () => {
    process.env.INIT_CWD = resolve(sourceRoot, "fixtures");

    expect(resolveCliInputPath("packages/lower-third")).toBe(resolve(sourceRoot, "fixtures/packages/lower-third"));
    expect(resolveCliOutputPath("output")).toBe(resolve(sourceRoot, "fixtures/output"));
  });
});
