import { readRequestBytes } from "./request-body.ts";
import { taskImageMaxBytes, taskImageMaxDimension } from "../shared/task-images";

export async function readTaskImage(request: Request): Promise<Uint8Array | null> {
  if (
    request.headers.get("content-type")?.split(";")[0] !== "image/png" ||
    !request.body ||
    Number(request.headers.get("content-length")) > taskImageMaxBytes
  )
    return null;
  const bytes = await readRequestBytes(request, taskImageMaxBytes);
  if (!bytes) return null;
  if (bytes.length < 45 || [137, 80, 78, 71, 13, 10, 26, 10].some((v, i) => bytes[i] !== v))
    return null;
  const header = new DataView(bytes.buffer);
  if (header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452) return null;
  const width = header.getUint32(16),
    height = header.getUint32(20);
  return width > 0 &&
    width <= taskImageMaxDimension &&
    height > 0 &&
    height <= taskImageMaxDimension
    ? bytes
    : null;
}
