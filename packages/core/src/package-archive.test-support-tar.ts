/** Minimal tar writer for archive refusal tests. */
export function createTestTar(entries: Array<{ path: string; data: Buffer; type?: string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    writeString(header, 0, 100, entry.path);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.data.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    writeString(header, 156, 1, entry.type ?? "0");
    writeString(header, 257, 6, "ustar");
    writeString(header, 263, 2, "00");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeChecksum(header, checksum);
    chunks.push(header, entry.data);
    const padding = entry.data.byteLength % 512 === 0 ? 0 : 512 - (entry.data.byteLength % 512);
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function writeString(buffer: Buffer, offset: number, length: number, value: string): void {
  Buffer.from(value, "utf8").copy(buffer, offset, 0, length);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
}

function writeChecksum(buffer: Buffer, value: number): void {
  buffer.write(value.toString(8).padStart(6, "0"), 148, 6, "ascii");
  buffer[154] = 0;
  buffer[155] = 0x20;
}
