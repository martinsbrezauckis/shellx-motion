import { describe, expect, it } from "vitest";
import { canonicalAttestedReuseHostPath } from "./attested-render-reuse-root.js";

describe("attested reuse host path aliases", () => {
  it("translates only Darwin system aliases and leaves caller-created paths untouched", () => {
    expect(canonicalAttestedReuseHostPath("/var/folders/render", "darwin")).toBe("/private/var/folders/render");
    expect(canonicalAttestedReuseHostPath("/tmp/render", "darwin")).toBe("/private/tmp/render");
    expect(canonicalAttestedReuseHostPath("/etc/hosts", "darwin")).toBe("/private/etc/hosts");
    expect(canonicalAttestedReuseHostPath("/various/render", "darwin")).toBe("/various/render");
    expect(canonicalAttestedReuseHostPath("/custom/alias/render", "darwin")).toBe("/custom/alias/render");
    expect(canonicalAttestedReuseHostPath("/var/folders/render", "linux")).toBe("/var/folders/render");
  });
});
