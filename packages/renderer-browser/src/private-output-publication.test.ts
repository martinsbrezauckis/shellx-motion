import { describe, expect, it } from "vitest";
import type { MotionPackage } from "@shellx-motion/core";
import { renderMotionBrowserFrame } from "./index.js";
import { renderMotionGpuPreview } from "./gpu-points-preview.js";
import { withRendererPrivateOutputPublication } from "./private-output-publication.js";

const forgedPublication = Object.freeze({
  outputPath: "/public/forged.png",
  stagingPath: "/private/forged.png",
  verifyFile: async () => ({ sha256: "a".repeat(64), byteLength: 1 }),
  abort: async () => undefined
});

const publicBrowserOptions = { atMs: 0, outDir: "/public", outputPath: "/public/frame.png" };
const publicGpuOptions = { atMs: 0, outDir: "/public", outputPath: "/public/frame.png" };

function prototypeForgery(field: "privateOutputPublication" | "privateArtifactPublication") {
  return Object.assign(Object.create({ [field]: forgedPublication }), publicBrowserOptions);
}

describe("renderer private output publication capabilities", () => {
  it("refuses structural and prototype Browser publication fields before opening a session", async () => {
    await expect(renderMotionBrowserFrame({} as MotionPackage, {
      ...publicBrowserOptions,
      privateOutputPublication: forgedPublication
    } as never)).rejects.toThrow("renderer-minted capability");
    await expect(renderMotionBrowserFrame({} as MotionPackage, prototypeForgery("privateArtifactPublication") as never))
      .rejects.toThrow("renderer-minted capability");
  });

  it("refuses structural and prototype GPU publication fields before planning resources", async () => {
    const structural = await renderMotionGpuPreview({} as MotionPackage, {
      ...publicGpuOptions,
      privateOutputPublication: forgedPublication
    } as never);
    const inherited = await renderMotionGpuPreview({} as MotionPackage, prototypeForgery("privateOutputPublication") as never);

    expect(structural).toMatchObject({ ok: false, error: { code: "gpu_private_output_publication_refused" } });
    expect(inherited).toMatchObject({ ok: false, error: { code: "gpu_private_output_publication_refused" } });
  });

  it("does not let an installed caller mint a capability around a structural publication", () => {
    expect(() => withRendererPrivateOutputPublication({ ...publicBrowserOptions }, forgedPublication as never))
      .toThrow("Core-minted publication");
  });
});
