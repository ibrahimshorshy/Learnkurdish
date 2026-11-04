import { Show } from './show.js';
import { drawHud } from './hud.js';
import { Sfx } from './audio.js';

const $ = (id) => document.getElementById(id);
const out = $('out');
const ctx = out.getContext('2d');
const params = new URLSearchParams(location.search);
let W = 540, H = 960;
const show = new Show(W, H);
const sfx = new Sfx();
let playing = false, started = false, recorder = null, chunks = [], last = 0, recStop = false;

function setSize(w) {
  W = w; H = Math.round((w * 16) / 9);
  out.width = W; out.height = H;
  show.resize(W, H);
}
function frame() {
  show.render();
  ctx.drawImage(show.glCanvas, 0, 0, W, H);
  drawHud(ctx, show, W, H);
}
function drainSfx() {
  for (const [n, a] of show.sfxEvents) if (sfx[n]) sfx[n](...a);
  show.sfxEvents.length = 0;
}
function tick(now) {
  requestAnimationFrame(tick);
  if (!last) last = now;
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (playing) {
    show.advance(dt);
    drainSfx();
    $('scrub').value = Math.round((show.rt >= 0 ? Math.min(1, show.t / show.endT) : 0) * 1000);
    if (show.t >= show.endT) finish();
  }
  frame();
}
function finish() {
  playing = false; sfx.stopMusic();
  $('play').textContent = '▶ Play';
  if (recorder && !recStop) { recStop = true; setTimeout(() => recorder.stop(), 600); }
}
function start(fromZero = true) {
  sfx.resume();
  if (fromZero) { show.reset(); }
  playing = true; started = true;
  $('play').textContent = '⏸ Pause';
  if (sfx.on) sfx.startMusic();
  $('start').style.display = 'none';
}
$('go').onclick = () => start(true);
$('play').onclick = () => {
  if (!started) return start(true);
  if (show.t >= show.endT) return start(true);
  playing = !playing;
  $('play').textContent = playing ? '⏸ Pause' : '▶ Play';
  if (playing) { sfx.resume(); if (sfx.on) sfx.startMusic(); } else sfx.stopMusic();
};
$('restart').onclick = () => start(true);
$('pace').onchange = (e) => { const t = show.t; show.setPace(+e.target.value); show.seek(Math.min(t, show.endT)); };
$('qual').onchange = (e) => setSize(+e.target.value);
$('snd').onchange = (e) => { sfx.on = e.target.checked; if (!sfx.on) sfx.stopMusic(); else if (playing) sfx.startMusic(); };
$('scrub').onchange = (e) => { show.seek((+e.target.value / 1000) * show.endT); sfx.stopMusic(); playing = false; $('play').textContent = '▶ Play'; started = true; $('start').style.display = 'none'; };

$('rec').onclick = () => {
  if (recorder) return;
  const msg = $('msg');
  if (!out.captureStream || typeof MediaRecorder === 'undefined') { msg.textContent = 'This browser cannot record the canvas. Use desktop Chrome or Edge.'; return; }
  setSize(1080); $('qual').value = '1080';
  sfx.resume();
  const stream = out.captureStream(60);
  if (sfx.dest) sfx.dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const types = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mime = types.find((t) => MediaRecorder.isTypeSupported(t));
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 14_000_000, audioBitsPerSecond: 192_000 });
  chunks = []; recStop = false;
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const ext = recorder.mimeType.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type: recorder.mimeType });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `chess-battle.${ext}`; a.click();
    msg.textContent = `Saved chess-battle.${ext} (${(blob.size / 1e6).toFixed(1)} MB, 1080×1920).` + (ext === 'webm' ? ' TikTok prefers MP4: ffmpeg -i chess-battle.webm -c:v libx264 -c:a aac chess-battle.mp4' : '');
    recorder = null; $('rec').disabled = false; $('rec').textContent = '● Record video';
  };
  recorder.start(250);
  $('rec').disabled = true; $('rec').textContent = '● Recording… keep this tab open';
  msg.textContent = 'Recording in real time at 1080×1920 with sound. It stops by itself at the end.';
  start(true);
};

// ---- test / automation hooks
window.__show = show;
window.__shot = (t) => { show.seek(t); frame(); return out.toDataURL('image/png'); };
window.__total = () => show.endT;
window.__plan = () => show.plan.map((p) => [p.i, p.a.san, +p.start.toFixed(2), +p.dur.toFixed(2)]);
if (params.has('t')) { started = true; $('start').style.display = 'none'; show.seek(+params.get('t')); }
if (params.has('autoplay')) start(true);
requestAnimationFrame(tick);
