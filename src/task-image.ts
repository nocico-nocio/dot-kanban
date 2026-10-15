import { taskImageMaxBytes, taskImageMaxDimension } from "../shared/task-images";

export async function prepareTaskImage(file: File): Promise<Blob> {
  if (
    file.size > 10 * 1024 * 1024 ||
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)
  )
    throw new Error("image_upload_invalid");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > 40_000_000
    )
      throw new Error("image_upload_invalid");
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("image_upload_invalid");
    let scale = Math.min(
      1,
      taskImageMaxDimension / Math.max(image.naturalWidth, image.naturalHeight),
    );
    for (let attempt = 0; attempt < 10; attempt++) {
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (blob && blob.size <= taskImageMaxBytes) return blob;
      scale *= 0.8;
    }
    throw new Error("image_upload_invalid");
  } finally {
    URL.revokeObjectURL(url);
  }
}
