import { describe, expect, it } from "vitest";
import { admitGpuChromaKey } from "./gpu-frame-chroma-key-admission";

const matte = { denoiseRadiusPx: 0, growShrinkPx: 0, chokePx: 0, featherPx: 0, blackClip: 0, whiteClip: 1 };
const key = { keyColor: { r: 0, g: 1, b: 0, a: 1 }, similarity: 0.12, smoothness: 0.18, shadow: 0.5, spillSuppression: 0.9, spillBalance: -0.25, edgeColorCorrection: 0.5, matte };

describe("GPU chroma-key execution admission", () => {
  it("requires exact zero cleanup fields and refuses cleanup structural/range drift", () => {
    expect(admitGpuChromaKey(key)).toEqual(key);
    expect(admitGpuChromaKey({ ...key, matte: { ...matte } })).toEqual(key);
    expect(admitGpuChromaKey({ ...key, matte: undefined })).toBeUndefined();
    expect(admitGpuChromaKey({ ...key, matte: { ...matte, featherPx: 33 } })).toBeUndefined();
    expect(admitGpuChromaKey({ ...key, matte: { ...matte, blackClip: 1, whiteClip: 0 } })).toBeUndefined();
    expect(admitGpuChromaKey({ ...key, spillBalance: -1.01 })).toBeUndefined();
    expect(admitGpuChromaKey({ ...key, cleanup: { featherPx: 1 } })).toBeUndefined();
    expect(admitGpuChromaKey({ ...key, keyColor: { ...key.keyColor, a: 0.5 } })).toBeUndefined();
  });
});
