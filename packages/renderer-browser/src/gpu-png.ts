import { deflateSync } from "node:zlib";

/** Encode tightly packed straight-alpha sRGB readback as a PNG. */
export function encodeGpuPng(input: { rgba: Uint8Array; width: number; height: number }): Buffer {
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 1 || input.height < 1) {
    throw new Error("GPU PNG dimensions must be positive integers.");
  }
  if (input.rgba.byteLength !== input.width * input.height * 4) {
    throw new Error("GPU PNG RGBA byte length does not match its dimensions.");
  }
  const scanlines = Buffer.allocUnsafe((input.width * 4 + 1) * input.height);
  for (let y = 0; y < input.height; y += 1) {
    const sourceRow = y * input.width * 4;
    const outputRow = y * (input.width * 4 + 1);
    scanlines[outputRow] = 0;
    for (let x = 0; x < input.width; x += 1) {
      const source = sourceRow + x * 4;
      const output = outputRow + 1 + x * 4;
      scanlines[output] = input.rgba[source];
      scanlines[output + 1] = input.rgba[source + 1];
      scanlines[output + 2] = input.rgba[source + 2];
      scanlines[output + 3] = input.rgba[source + 3];
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(input.width, 0);
  ihdr.writeUInt32BE(input.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(scanlines, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const result = Buffer.allocUnsafe(12 + data.byteLength);
  result.writeUInt32BE(data.byteLength, 0);
  result.write(type, 4, 4, "ascii");
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return result;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
