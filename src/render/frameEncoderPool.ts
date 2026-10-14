/**
 * Pool of JPEG encoder workers.
 *
 * Hands each frame to whichever worker is free and returns blobs in submission
 * order. Falls back to encoding on the main thread where workers or
 * OffscreenCanvas are unavailable, so the fast path still works rather than
 * failing outright.
 */

export interface FrameEncoder {
  /** Queues a frame. Resolves once that frame's JPEG is ready. */
  encode(index: number, bitmap: ImageBitmap): Promise<Blob>;
  readonly size: number;
  destroy(): void;
}

function supportsWorkers(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap === "function"
  );
}

export function createFrameEncoder(quality: number): FrameEncoder {
  // Leave a core for the main thread, which still has to draw every frame.
  const desired = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));

  if (!supportsWorkers()) {
    return {
      size: 0,
      async encode(_index, bitmap) {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d", { alpha: false })?.drawImage(bitmap, 0, 0);
        bitmap.close();
        return new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error("Frame encoding failed."))),
            "image/jpeg",
            quality
          );
        });
      },
      destroy() {},
    };
  }

  const workers: Worker[] = [];
  const idle: Worker[] = [];
  const waiting: Array<(worker: Worker) => void> = [];
  const pending = new Map<number, { resolve: (b: Blob) => void; reject: (e: Error) => void }>();

  const release = (worker: Worker) => {
    const next = waiting.shift();
    if (next) next(worker);
    else idle.push(worker);
  };

  for (let i = 0; i < desired; i++) {
    const worker = new Worker(new URL("./frameEncoder.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<{ index: number; blob?: Blob; error?: string }>) => {
      const { index, blob, error } = event.data;
      const entry = pending.get(index);
      pending.delete(index);
      release(worker);
      if (!entry) return;
      if (blob) entry.resolve(blob);
      else entry.reject(new Error(error || "Frame encoding failed in the worker."));
    };
    worker.onerror = (event) => {
      release(worker);
      console.warn("Frame encoder worker error:", event.message);
    };
    workers.push(worker);
    idle.push(worker);
  }

  const takeWorker = (): Promise<Worker> => {
    const free = idle.pop();
    if (free) return Promise.resolve(free);
    return new Promise<Worker>((resolve) => waiting.push(resolve));
  };

  return {
    size: workers.length,
    async encode(index, bitmap) {
      const worker = await takeWorker();
      return new Promise<Blob>((resolve, reject) => {
        pending.set(index, { resolve, reject });
        worker.postMessage({ index, bitmap, quality }, [bitmap]);
      });
    },
    destroy() {
      workers.forEach((w) => w.terminate());
      workers.length = 0;
      idle.length = 0;
      waiting.length = 0;
      pending.clear();
    },
  };
}
