import { describe, expect, it } from "vitest";
import { hashBuffer } from "./receipts";
import { dotLottieRgbaU32, lowerSelectedDotLottieToMotion } from "./dotlottie-lowering";

const solidAnimation = JSON.stringify({
  v: "5.12.2",
  fr: 30,
  ip: 0,
  op: 30,
  w: 100,
  h: 100,
  nm: "Container background",
  assets: [],
  layers: [{
    ind: 1,
    ty: 1,
    nm: "Solid",
    sw: 10,
    sh: 10,
    sc: "#ffffff",
    ip: 0,
    op: 30,
    ks: {
      p: { a: 0, k: [20, 20] },
      a: { a: 0, k: [0, 0] },
      s: { a: 0, k: [100, 100] },
      r: { a: 0, k: 0 },
      o: { a: 0, k: 100 }
    }
  }]
});

describe("dotLottie lowering", () => {
  it("maps manifest u32 RGBA backgrounds and reconverges the lowering receipt", () => {
    const lowered = lowerSelectedDotLottieToMotion({
      adapterId: "adapter.lottie",
      sourcePath: "source/selected-animation.json",
      sourceText: solidAnimation,
      normalizedPackagePath: "pkg_dotlottie_test",
      createdAt: "2026-07-13T00:00:00.000Z",
      animation: { id: "hero", background: 0x2244ccff }
    });

    const motionSha256 = hashBuffer(Buffer.from(`${JSON.stringify(lowered.motion, null, 2)}\n`, "utf8"));
    expect(lowered.motion.background).toBe("#2244ccff");
    expect(lowered.receipt).toMatchObject({
      id: `adapter-lowering-lottie-${motionSha256.slice(0, 16)}`,
      output: {
        motionSha256,
        dotLottieBackground: { source: 0x2244ccff, motion: "#2244ccff" }
      }
    });
  });

  it("rejects values outside the u32 domain", () => {
    expect(dotLottieRgbaU32(0)).toBe("#00000000");
    expect(dotLottieRgbaU32(0xffffffff)).toBe("#ffffffff");
    expect(() => dotLottieRgbaU32(-1)).toThrow("u32 RGBA");
    expect(() => dotLottieRgbaU32(0x1_0000_0000)).toThrow("u32 RGBA");
  });
});
