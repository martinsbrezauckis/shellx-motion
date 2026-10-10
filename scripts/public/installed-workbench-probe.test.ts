import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { installedWorkbenchProbeSource } from "./installed-workbench-probe.mjs";

describe("installed Workbench probe source", () => {
  it("remains valid generated ESM after template-literal processing", () => {
    const source = installedWorkbenchProbeSource();
    expect(source).toContain("shellx-motion-mcp\\.mjs");
    expect(() => execFileSync(process.execPath, ["--input-type=module", "--check"], {
      input: source,
      encoding: "utf8"
    })).not.toThrow();
  });
});
