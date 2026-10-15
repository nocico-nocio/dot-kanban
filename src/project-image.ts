export async function prepareProjectIcon(file: File): Promise<Blob> {
  if (file.size > 2 * 1024 * 1024 || !file.type.startsWith("image/"))
    throw new Error("icon_upload_invalid");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth > 8192 ||
      image.naturalHeight > 8192
    )
      throw new Error("icon_upload_invalid");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("icon_upload_invalid");
    const scale = Math.min(128 / image.naturalWidth, 128 / image.naturalHeight);
    const width = image.naturalWidth * scale,
      height = image.naturalHeight * scale;
    context.drawImage(image, (128 - width) / 2, (128 - height) / 2, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob || blob.size > 96 * 1024) throw new Error("icon_upload_invalid");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}
