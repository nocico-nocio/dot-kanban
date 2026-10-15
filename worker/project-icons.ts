import { readRequestBytes } from "./request-body.ts";
const maxIconBytes = 96 * 1024;
const signature = [137, 80, 78, 71, 13, 10, 26, 10];

export function validProjectIcon(bytes: Uint8Array): boolean {
  if (
    bytes.length < 45 ||
    bytes.length > maxIconBytes ||
    signature.some((value, index) => bytes[index] !== value)
  )
    return false;
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452) return false;
  const width = header.getUint32(16),
    height = header.getUint32(20);
  return width > 0 && width <= 128 && height > 0 && height <= 128;
}

export async function readProjectIcon(request: Request): Promise<Uint8Array | null> {
  if (
    request.headers.get("content-type")?.split(";")[0] !== "image/png" ||
    !request.body ||
    Number(request.headers.get("content-length")) > maxIconBytes
  )
    return null;
  const bytes = await readRequestBytes(request, maxIconBytes);
  if (!bytes) return null;
  return validProjectIcon(bytes) ? bytes : null;
}
