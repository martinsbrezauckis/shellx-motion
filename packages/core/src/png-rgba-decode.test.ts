import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, decodePngRgba } from "./png-rgba-decode";

describe("decodePngRgba scanline boundaries", () => {
  it("refuses a validly compressed stream that is shorter than its IHDR scanlines", () => {
    expect(() => decodePngRgba(png(Buffer.from([0]))))
      .toThrow(/must inflate to exactly 4 bytes for its 1x1 scanlines; received 1/);
  });

  it("refuses a validly compressed stream that exceeds its IHDR scanlines", () => {
    expect(() => decodePngRgba(png(Buffer.from([0, 0x11, 0x22, 0x33, 0x44]))))
      .toThrow(/inflates past the 4 bytes its own IHDR declares/);
  });

  it("enforces a caller RGBA ceiling from IHDR before IDAT inflation or pixel allocation", () => {
    expect(() => decodePngRgba(png(Buffer.from([0]), 3_840, 2_160), { maxRgbaByteLength: 16 * 1024 * 1024 }))
      .toThrow(/decoded RGBA byte ceiling 16777216.*refusing before IDAT inflation or pixel allocation/);
  });
});

function png(inflated: Buffer, width = 1, height = 1): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(inflated)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.byteLength);
  return chunk;
}
