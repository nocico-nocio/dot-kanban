// Bound the stream itself: Content-Length may be missing or incorrect.
export async function readRequestBytes(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(request.headers.get("content-length")) > maxBytes) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (length + value.byteLength > maxBytes) {
        await reader.cancel();
        return null;
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  return bytes.slice(0, length);
}

export async function readRequestText(request: Request, maxBytes: number): Promise<string | null> {
  const bytes = await readRequestBytes(request, maxBytes);
  if (!bytes) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
