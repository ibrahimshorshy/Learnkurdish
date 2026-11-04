// Offline, frame-exact render to MP4 (no audio): node tools/render-video.mjs [width=720] [fps=30] [workers=4] [out=chess-battle-720p.mp4] [pace=1.15]
// Needs: ffmpeg on PATH and the `playwright` package with Chromium. Software GL is slow (minutes), a GPU is much faster.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const [width = 720, fps = 30, workers = 4, outFile = `chess-battle-${width}p.mp4`, pace = 1.15] = process.argv.slice(2);
const W = +width, FPS = +fps, N = +workers;
const here = path.dirname(fileURLToPath(import.meta.url));
const url = 'file://' + path.resolve(here, '../chess-battle.html') + '?t=0';
const tmp = path.resolve(here, '../.frames');
mkdirSync(tmp, { recursive: true });
const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'];

const probe = await chromium.launch({ args });
const pp = await probe.newPage();
await pp.goto(url);
await pp.evaluate((p) => window.__show.setPace(p), +pace);
const total = await pp.evaluate(() => window.__total());
await probe.close();
const frames = Math.ceil(total * FPS);
const stepPer = 60 / FPS;
console.log(`${total.toFixed(1)}s → ${frames} frames @ ${FPS}fps, ${W}x${Math.round(W * 16 / 9)}, ${N} workers`);

let done = 0;
const t0 = Date.now();
// contiguous chunks keep each worker stepping forward only
const chunk = Math.ceil(frames / N);
async function run(k) {
  const b = await chromium.launch({ args });
  const p = await b.newPage();
  await p.goto(url);
  await p.evaluate(([w, pc]) => { window.__show.setPace(pc); window.__setSize(w); }, [W, +pace]);
  for (let f = k * chunk; f < Math.min(frames, (k + 1) * chunk); f++) {
    const d = await p.evaluate((s) => window.__frameAt(s), Math.round(f * stepPer));
    writeFileSync(path.join(tmp, `f${String(f).padStart(5, '0')}.jpg`), Buffer.from(d.split(',')[1], 'base64'));
    if (++done % 60 === 0) console.log(`${done}/${frames}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  await b.close();
}
await Promise.all(Array.from({ length: N }, (_, k) => run(k)));
await new Promise((res, rej) => {
  const ff = spawn('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(tmp, 'f%05d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '17', '-preset', 'medium', '-movflags', '+faststart', outFile], { stdio: 'inherit' });
  ff.on('exit', (c) => (c ? rej(new Error('ffmpeg ' + c)) : res()));
});
console.log('wrote', outFile);
