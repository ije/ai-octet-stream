const enc = new TextEncoder();
const dec = new TextDecoder();
const voidMessage = new Uint8Array();

/** Check if a value is an object. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stringify an error. */
export function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Serialize a message. */
export function serialize(kind: number, data?: unknown) {
  if (kind < 0 || kind > 31) {
    throw new RangeError("Invalid message kind");
  }
  const isRaw = typeof data === "string";
  const payload = data === undefined
    ? voidMessage
    : enc.encode(isRaw && data !== "" ? data : JSON.stringify(data));
  const payloadLen = payload.byteLength;
  const lenBits = payloadLen <= 0xff ? 0 : (payloadLen <= 0xffff ? 0b01 : 0b11);
  const headSize = 2 + lenBits;
  const buffer = new Uint8Array(headSize + payloadLen);
  buffer[0] = (kind << 3) | lenBits << 1 | (isRaw ? 1 : 0);
  if (headSize === 2) {
    buffer[1] = payloadLen;
  } else {
    const view = new DataView(buffer.buffer);
    if (headSize === 3) {
      view.setUint16(1, payloadLen);
    } else {
      view.setUint32(1, payloadLen);
    }
  }
  if (payloadLen > 0) {
    buffer.set(payload, headSize);
  }
  return buffer;
}

/** Deserialize a stream of messages. */
export async function* deserialize(stream: ReadableStream<Uint8Array>): AsyncGenerator<[kind: number, data: unknown]> {
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value || value.byteLength === 0) {
      continue;
    }
    if (buffer.byteLength === 0) {
      buffer = value;
    } else {
      const buf = new Uint8Array(buffer.byteLength + value.byteLength);
      buf.set(buffer, 0);
      buf.set(value, buffer.byteLength);
      buffer = buf;
    }
    let offset = 0;
    while (buffer.byteLength - offset >= 2) {
      const view = new DataView(buffer.buffer, buffer.byteOffset + offset, buffer.byteLength - offset);
      const head = view.getUint8(0);
      const kind = head >> 3;
      const lenBits = (head >> 1) & 0b11;
      const isRaw = (head & 1) === 1;
      let headSize = 2;
      let payloadLen = view.getUint8(1);
      if (lenBits > 0) {
        if (lenBits !== 0b01 && lenBits !== 0b11) {
          throw new Error("Invalid message frame");
        }
        headSize += lenBits;
        if (buffer.byteLength - offset < headSize) {
          break;
        }
        payloadLen = lenBits === 0b01 ? view.getUint16(1) : view.getUint32(1);
      }
      const payloadEnd = offset + headSize + payloadLen;
      if (buffer.byteLength < payloadEnd) {
        break;
      }

      let payload: unknown = undefined;
      if (payloadLen > 0) {
        const payloadRaw = dec.decode(buffer.subarray(offset + headSize, payloadEnd));
        payload = isRaw ? payloadRaw : JSON.parse(payloadRaw);
      }

      yield [kind, payload];
      offset = payloadEnd;
    }
    if (offset > 0) {
      buffer = buffer.subarray(offset);
    }
  }
}

/** Read a SSE stream and yield the data lines. */
export async function* readSSEStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const trimCR = (line: string) => line.endsWith("\r") ? line.slice(0, -1) : line;
  const reader = stream.getReader();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      const line = trimCR(buffer);
      if (line.startsWith("data: ")) {
        yield line.slice(6);
      }
      break;
    }
    buffer += dec.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (let line of lines) {
      line = trimCR(line);
      if (line.startsWith("data: ")) {
        yield line.slice(6);
      }
    }
  }
}
