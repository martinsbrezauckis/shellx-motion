import { describe, expect, it } from "vitest";
import { createNativeRenderSession, renderNativePreviewFrame } from "./index.js";
import { withNativePrivateOutputPublication } from "./private-output-publication.js";

const forgedPublication = Object.freeze({
  outputPath: "/public/forged.png",
  stagingPath: "/private/forged.png",
  verifyFile: async () => ({ sha256: "a".repeat(64), byteLength: 1 }),
  abort: async () => undefined
});

function prototypeForgery() {
  return Object.assign(Object.create({ privateOutputPublication: forgedPublication }), {
    packageRoot: "/not-opened"
  });
}

describe("Native private output publication capabilities", () => {
  it("refuses structural and prototype Native preview fields before loading a package", async () => {
    await expect(renderNativePreviewFrame({
      packageRoot: "/not-opened",
      privateOutputPublication: forgedPublication
    } as never)).rejects.toThrow("renderer-minted capability");
    await expect(renderNativePreviewFrame(prototypeForgery() as never)).rejects.toThrow("renderer-minted capability");
  });

  it("refuses structural and prototype Native session fields before loading a package", async () => {
    await expect(createNativeRenderSession({
      packageRoot: "/not-opened",
      privateOutputPublication: forgedPublication
    } as never)).rejects.toThrow("renderer-minted capability");
    await expect(createNativeRenderSession(prototypeForgery() as never)).rejects.toThrow("renderer-minted capability");
  });

  it("does not let an installed caller mint a capability around a structural publication", () => {
    expect(() => withNativePrivateOutputPublication({ packageRoot: "/not-opened" }, forgedPublication as never))
      .toThrow("Core-minted publication");
  });
});
