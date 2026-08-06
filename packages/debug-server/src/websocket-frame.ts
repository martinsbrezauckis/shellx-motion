import type { Duplex } from "node:stream";

/** One fully decoded client frame. Fragmentation is intentionally unsupported. */
export type WebSocketFrame = { opcode: number; payload: Buffer<ArrayBufferLike> };

/** Decode complete masked client frames while retaining an incomplete trailing frame. */
export function readWebSocketFrames(
  buffer: Buffer<ArrayBufferLike>,
  maxPayloadBytes: number
): { frames: WebSocketFrame[]; remaining: Buffer<ArrayBufferLike>; error?: string } {
  const frames: WebSocketFrame[] = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    if (!masked) return { frames, remaining: Buffer.alloc(0), error: "WebSocket client frames must be masked." };
    let payloadLength = second & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (buffer.length - offset < 4) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (buffer.length - offset < 10) break;
      const largeLength = buffer.readBigUInt64BE(offset + 2);
      if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        return { frames, remaining: Buffer.alloc(0), error: "WebSocket frame length is invalid." };
      }
      payloadLength = Number(largeLength);
      headerLength = 10;
    }
    if (payloadLength > maxPayloadBytes) {
      return { frames, remaining: Buffer.alloc(0), error: `WebSocket frame exceeds ${maxPayloadBytes} bytes.` };
    }

    const frameLength = headerLength + 4 + payloadLength;
    if (buffer.length - offset < frameLength) break;

    const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
    const payloadStart = offset + headerLength + 4;
    const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + payloadLength));
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = payload[index] ^ mask[index % 4];
    }
    frames.push({ opcode, payload });
    offset += frameLength;
  }
  return { frames, remaining: buffer.subarray(offset) };
}

export function writeWebSocketText(socket: Duplex, text: string): void {
  writeWebSocketFrame(socket, 0x1, Buffer.from(text, "utf8"));
}

export function writeWebSocketFrame(socket: Duplex, opcode: number, payload: Buffer): void {
  const length = payload.byteLength;
  if (length < 126) {
    socket.write(Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]));
    return;
  }
  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    socket.write(Buffer.concat([header, payload]));
    return;
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  socket.write(Buffer.concat([header, payload]));
}

export function rejectWebSocketUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n`);
  socket.destroy();
}

export function closeWebSocketWithPolicyError(socket: Duplex, reason: string): void {
  if (socket.destroyed) return;
  const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
  const payload = Buffer.alloc(2 + reasonBytes.byteLength);
  payload.writeUInt16BE(1008, 0);
  reasonBytes.copy(payload, 2);
  writeWebSocketFrame(socket, 0x8, payload);
  socket.end();
}
