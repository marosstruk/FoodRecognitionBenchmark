import sharp from "sharp";

/**
 * Normalizes any input image (PNG/JPEG/HEIC-less formats sharp can read) to a JPEG whose
 * longest side is at most `maxSide`, honoring EXIF orientation. Copilot models accept
 * at most ~3 MB per image, so phone photos must be downscaled.
 */
export async function normalizeImage(input: Buffer | string, maxSide: number, quality = 90): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
}
