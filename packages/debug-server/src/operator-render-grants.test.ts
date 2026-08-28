import { describe, expect, it } from "vitest";
import { createOperatorRenderGrants, grantOperatorRenderRoot } from "./operator-receipt-grants.js";

describe("Workbench render root grants", () => {
  it("extends session authority only from a completed native picker selection", () => {
    const grants = createOperatorRenderGrants();
    grantOperatorRenderRoot(grants, "package-root", "/srv/motion/packages/lower-third");
    grantOperatorRenderRoot(grants, "quality-manifest", "/srv/motion/quality/baseline.json");
    grantOperatorRenderRoot(grants, "render-output", "/srv/motion/renders/lower-third.mp4");
    grantOperatorRenderRoot(grants, "receipts-root", "/srv/motion/receipts");

    expect([...grants.packageRoots]).toEqual(["/srv/motion/packages/lower-third"]);
    expect([...grants.inputRoots]).toEqual(["/srv/motion/packages/lower-third", "/srv/motion/quality"]);
    expect([...grants.outputRoots]).toEqual(["/srv/motion/renders"]);
  });
});
