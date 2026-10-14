/**
 * Font loader and canvas glyph-cache warmup.
 *
 * Canvas silently falls back to a default face for any font the browser has
 * not finished loading, and it does so *per glyph*. If recording starts before
 * the webfonts are rasterized, the first frames render in the fallback face and
 * then visibly reflow. Loading every family/weight/size combination up front,
 * then forcing a measure and a paint of representative glyphs, removes that.
 */

const FAMILIES = ["UniSIRWAN Dubai", "Noto Naskh Arabic", "Inter"];

/** Sizes the renderer actually asks for, at 1x. Scaled sizes reuse the cache. */
const SIZES = [16, 18, 20, 22, 24, 26, 28, 32, 34, 38, 40, 44, 46, 58, 64];
const STYLES = ["300", "normal", "500", "600", "bold", "italic"];

let warmed: Promise<void> | null = null;

export const ensureAllFontsLoaded = async (): Promise<void> => {
  if (warmed) return warmed;

  warmed = (async () => {
    if (typeof document === "undefined") return;

    try {
      if (document.fonts) {
        await document.fonts.ready;

        const requests: Promise<unknown>[] = [];
        for (const family of FAMILIES) {
          for (const size of SIZES) {
            for (const style of STYLES) {
              requests.push(document.fonts.load(`${style} ${size}px '${family}'`).catch(() => {}));
            }
          }
        }
        await Promise.allSettled(requests);
      }

      // Force the 2D text engine to build its glyph atlas for each script we
      // draw. document.fonts.ready alone does not populate that cache.
      const probe = document.createElement("canvas");
      probe.width = 160;
      probe.height = 160;
      const ctx = probe.getContext("2d");
      if (ctx) {
        const samples: Array<[string, string]> = [
          ["bold 60px 'UniSIRWAN Dubai', sans-serif", "چۆنی؟ باشم، زۆر سوپاس. ڕۆژت باش"],
          ["500 34px 'UniSIRWAN Dubai', sans-serif", "کاتی دەستپێکردن چۆنی ڕێک گەڵاڵە"],
          ["300 24px 'UniSIRWAN Dubai', sans-serif", "ئایا کەس لێرە هەیە"],
          ["bold 34px 'Noto Naskh Arabic', serif", "مرحبا بالعالم"],
          ["bold 38px 'Inter', sans-serif", "Ready to listen 123"],
          ["italic 22px 'Inter', sans-serif", "shlonak zayn"],
        ];
        for (const [font, text] of samples) {
          ctx.font = font;
          ctx.measureText(text);
          ctx.fillText(text, 8, 60);
        }
      }

      // Let layout metrics settle before the first recorded frame.
      await new Promise((resolve) => setTimeout(resolve, 60));
    } catch (err) {
      console.warn("Font preloading note:", err);
    }
  })();

  return warmed;
};
