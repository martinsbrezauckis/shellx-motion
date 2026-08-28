import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodeGpuPng } from "./gpu-png";
import { gpuStraightRgba } from "./gpu-straight-rgba";

describe("encodeGpuPng", () => {
  it("converts premultiplied readback once and writes a straight-alpha PNG", () => {
    const rgba = gpuStraightRgba({ rgba: new Uint8Array([64, 32, 0, 128]), width: 1, height: 1 });
    const png = encodeGpuPng({ rgba, width: 1, height: 1 });
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const idatLength = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString("ascii")).toBe("IDAT");
    const row = inflateSync(png.subarray(41, 41 + idatLength));
    expect([...row]).toEqual([0, 128, 64, 0, 128]);
  });

  it("refuses malformed readback dimensions rather than emitting ambiguous pixels", () => {
    expect(() => encodeGpuPng({ rgba: new Uint8Array(3), width: 1, height: 1 })).toThrow("byte length");
  });

  it("normalizes transparent GPU readback and validates its exact shape", () => {
    expect([...gpuStraightRgba({ rgba: new Uint8Array([80, 20, 10, 0]), width: 1, height: 1 })]).toEqual([0, 0, 0, 0]);
    expect(() => gpuStraightRgba({ rgba: new Uint8Array(3), width: 1, height: 1 })).toThrow("byte length");
  });

  it("preserves a fractional matte alpha while restoring straight raw RGBA", () => {
    // A [128, 64, 32] source covered by a 0.25 luma matte is stored premultiplied
    // as [32, 16, 8, 64]. The streaming boundary must not send those darkened RGB
    // values to FFmpeg as if they were straight samples.
    expect([...gpuStraightRgba({ rgba: new Uint8Array([32, 16, 8, 64]), width: 1, height: 1 })])
      .toEqual([128, 64, 32, 64]);
  });
});
