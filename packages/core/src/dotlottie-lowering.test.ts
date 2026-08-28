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

  it("keeps selected state-machine data inert while reconverging a selected precomposition output hash", () => {
    const sourceText = JSON.stringify({
      v: "5.12.2", fr: 10, ip: 0, op: 10, w: 100, h: 80,
      layers: [{ ind: 1, ty: 0, nm: "scene", refId: "scene", ip: 0, op: 10, st: 0, sr: 1, bm: 0 }],
      assets: [{ id: "scene", w: 40, h: 20, layers: [{ ind: 2, ty: 1, nm: "solid", ip: 0, op: 10, sw: 4, sh: 3, sc: "#ff0000" }] }]
    });
    const selected = { id: "scene", background: 0x112233ff, stateMachine: { id: "unused", states: ["idle", "play"] } } as never;
    const lowered = lowerSelectedDotLottieToMotion({ adapterId: "adapter.lottie", sourcePath: "animations/scene.json", sourceText, normalizedPackagePath: "pkg_dotlottie_precomp", animation: selected });
    const output = lowered.receipt.output as Record<string, unknown>;
    expect(lowered.motion.background).toBe("#112233ff");
    expect(output).toMatchObject({ motionSha256: hashBuffer(Buffer.from(`${JSON.stringify(lowered.motion, null, 2)}\n`, "utf8")), lottieGpuPrecomposition: { outputMotionSha256: hashBuffer(Buffer.from(`${JSON.stringify(lowered.motion, null, 2)}\n`, "utf8")) } });
    expect(lowered.diagnostics.receipt.output).toMatchObject({ lottieGpuPrecomposition: { outputMotionSha256: hashBuffer(Buffer.from(`${JSON.stringify(lowered.motion, null, 2)}\n`, "utf8")) } });
    expect(sourceText).toContain('"scene"');
  });
});
