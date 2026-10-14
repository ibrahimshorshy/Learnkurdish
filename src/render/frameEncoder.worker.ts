/**
 * JPEG encoder worker.
 *
 * Encoding is the entire cost of the fast render path — measured at ~33ms a
 * frame at 1080p versus 0.4ms to draw one. Chrome serializes canvas encodes
 * onto a single background thread, so issuing several toBlob calls at once on
 * the main thread buys nothing. Workers each get their own thread and their own
 * OffscreenCanvas, which is the only way to actually use the other cores.
 *
 * Frames arrive as transferred ImageBitmaps, so no pixel data is copied between
 * threads.
 */

interface EncodeRequest {
  index: number;
  bitmap: ImageBitmap;
  quality: number;
}

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

self.onmessage = async (event: MessageEvent<EncodeRequest>) => {
  const { index, bitmap, quality } = event.data;

  try {
    if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      ctx = canvas.getContext("2d", { alpha: false });
    }
    if (!ctx) throw new Error("Worker could not get a 2D context.");

    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    (self as unknown as Worker).postMessage({ index, blob });
  } catch (err) {
    bitmap.close?.();
    (self as unknown as Worker).postMessage({
      index,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
