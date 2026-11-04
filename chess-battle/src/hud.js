// 2D arcade HUD drawn on top of the 3D frame (so it ends up in the recorded video too).
import { INTRO, QUALITY } from './show.js';
import { CONFIG } from './data.js';

const FONT = 'Impact, "Arial Black", "Haettenschweiler", sans-serif';
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const easeOutBack = (t) => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

function txt(ctx, s, x, y, o = {}) {
  const { size = 60, color = '#fff', stroke = '#12062e', sw = size * 0.16, align = 'center', glow = null, rot = 0, scale = 1, alpha = 1, font = FONT, base = 'middle', maxW = 0 } = o;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y); ctx.rotate(rot); ctx.scale(scale, scale);
  ctx.font = `${size}px ${font}`;
  if (maxW) { const w = ctx.measureText(s).width * scale; if (w > maxW) ctx.scale(maxW / w, maxW / w); }
  ctx.textAlign = align; ctx.textBaseline = base; ctx.lineJoin = 'round'; ctx.miterLimit = 2;
  if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = size * 0.45; }
  if (stroke && sw) { ctx.lineWidth = sw; ctx.strokeStyle = stroke; ctx.strokeText(s, 0, 0); }
  ctx.shadowBlur = glow ? size * 0.25 : 0;
  ctx.fillStyle = color; ctx.fillText(s, 0, 0);
  ctx.restore();
}
function slant(ctx, x, y, w, h, sk, fill) {
  ctx.beginPath(); ctx.moveTo(x + sk, y); ctx.lineTo(x + w + sk, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
}
function fmt(sec) { sec = Math.max(0, sec); const m = Math.floor(sec / 60), s = Math.floor(sec % 60), t = Math.floor((sec % 1) * 10); return sec < 20 ? `${m}:${String(s).padStart(2, '0')}.${t}` : `${m}:${String(s).padStart(2, '0')}`; }

let scan = null;
function scanPattern(ctx) {
  if (scan) return scan;
  const c = document.createElement('canvas'); c.width = 4; c.height = 6;
  const g = c.getContext('2d'); g.fillStyle = 'rgba(0,0,0,0.16)'; g.fillRect(0, 0, 4, 2);
  return (scan = ctx.createPattern(c, 'repeat'));
}

export function drawHud(ctx, show, W, H) {
  const S = W / 1080;
  ctx.save();
  ctx.scale(S, S);
  const rt = show.rt, t = show.t;

  // ---- fighter bars
  const hero = CONFIG.hero, vil = CONFIG.villain;
  const sideBar = (side, left) => {
    const cfg = side === hero.side ? hero : vil;
    const BW = 400;
    const x = left ? 40 : 1080 - 40 - BW;
    const y = 160;
    const hp = show.hpShow[side], tgt = show.hp[side];
    const col = left ? ['#ff3d8e', '#ffd23f'] : ['#19d9ff', '#7cff4d'];
    ctx.save();
    // frame
    slant(ctx, x - 6, y - 6, BW + 12, 54, left ? 18 : -18, '#0a0420');
    ctx.strokeStyle = left ? '#ff3d8e' : '#19d9ff'; ctx.lineWidth = 4; ctx.stroke();
    // lag bar + hp
    const w = BW;
    const bx = left ? x : x + w * (1 - hp), bw = w * hp;
    const lagW = w * clamp(hp + 0.0);
    ctx.save();
    slant(ctx, x, y, w, 42, left ? 18 : -18); ctx.clip();
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, hp < 0.35 ? '#ff3b5c' : col[0]); g.addColorStop(1, hp < 0.35 ? '#ff9a2e' : col[1]);
    ctx.fillStyle = '#fff'; // damage flash
    const lag = Math.max(hp, tgt);
    ctx.fillRect(left ? x : x + w * (1 - Math.max(hp, tgt)), y, w * Math.max(hp, tgt), 42);
    ctx.fillStyle = g; ctx.fillRect(left ? x : x + w * (1 - hp), y, w * hp, 42);
    ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fillRect(x, y, w, 12);
    ctx.restore();
    ctx.restore();
    const ax = left ? x : x + BW;
    txt(ctx, cfg.name.toUpperCase(), ax, y + 76, { size: 36, align: left ? 'left' : 'right', color: '#fff', maxW: 400 });
    txt(ctx, `${cfg.tag}  ${cfg.elo}`, ax, y + 116, { size: 26, align: left ? 'left' : 'right', color: left ? '#ffd23f' : '#7cff4d', sw: 5 });
    const low = show.clocks[side] < 20;
    const cx = left ? x + BW : x;
    txt(ctx, fmt(show.clocks[side]), cx, y + 116, { size: 40, align: left ? 'right' : 'left', color: low ? '#ff3b5c' : '#fff', glow: low ? '#ff3b5c' : null });
    txt(ctx, String(Math.round(show.score[side])).padStart(6, '0'), ax, y + 152, { size: 24, align: left ? 'left' : 'right', color: '#b8a8ff', sw: 5 });
  };
  sideBar(hero.side, true);
  sideBar(vil.side, false);
  // center VS / round
  txt(ctx, 'VS', 540, 190, { size: 62, color: '#ffd23f', glow: '#ff3d8e', rot: -0.08 });
  txt(ctx, `MOVE ${Math.max(1, Math.min(35, show.cur < show.plan.length ? show.plan[show.cur].a.moveNo : 35))}`, 540, 240, { size: 26, color: '#fff', sw: 5 });

  // ---- chain / combo (left)
  if (show.chain.n >= 2 && rt - show.chain.t0 < 2.4) {
    const u = clamp((rt - show.chain.t0) / 0.25);
    txt(ctx, `${show.chain.n} HIT COMBO!`, 40, 420, { size: 70, align: 'left', color: '#ffd23f', glow: '#ff3d8e', rot: -0.1, scale: 0.6 + 0.4 * easeOutBack(u), alpha: clamp((2.4 - (rt - show.chain.t0)) * 3) });
  }

  // ---- intro
  if (t < INTRO + 0.4) {
    const u = t / INTRO;
    if (u < 0.78) {
      const a = clamp(u * 6) * clamp((0.78 - u) * 8);
      ctx.fillStyle = `rgba(10,4,32,${0.55 * a})`; ctx.fillRect(0, 0, 1080, 1920);
      const sc = 0.7 + 0.3 * easeOutBack(clamp(u * 4));
      const hl = CONFIG.hook.split(' '); const mid = Math.ceil(hl.length / 2);
      txt(ctx, hl.slice(0, mid).join(' '), 540, 640, { size: 112, color: '#fff', glow: '#ff3d8e', alpha: a, scale: sc, sw: 18, maxW: 1000 });
      txt(ctx, hl.slice(mid).join(' '), 540, 770, { size: 112, color: '#ffd23f', glow: '#ff3d8e', alpha: a, scale: sc, sw: 18, maxW: 1000 });
      txt(ctx, CONFIG.villain.name.toUpperCase(), 250, 960, { size: 60, color: '#6ff0ff', glow: '#19d9ff', alpha: a, scale: clamp(u * 5) });
      txt(ctx, 'VS', 540, 960, { size: 84, color: '#ffd23f', glow: '#ff3d8e', alpha: a, rot: -0.1 });
      txt(ctx, CONFIG.hero.name.toUpperCase(), 830, 960, { size: 60, color: '#ff6fb1', glow: '#ff3d8e', alpha: a, scale: clamp(u * 5) });
    } else {
      const v = (u - 0.78) / 0.22;
      txt(ctx, 'FIGHT!', 540, 880, { size: 260, color: '#ffd23f', glow: '#ff3b5c', scale: 0.5 + 0.9 * easeOutBack(clamp(v * 2.5)) + v * 0.3, alpha: 1 - clamp((v - 0.75) * 4), rot: -0.06, sw: 30 });
    }
  }

  // ---- banners
  for (const b of show.banners) {
    const u = (rt - b.t0) / b.dur;
    const a = clamp((1 - u) * 5);
    const sc = 0.4 + 0.7 * easeOutBack(clamp((rt - b.t0) / 0.22)) + u * 0.12;
    txt(ctx, b.text, 540, 1920 * b.y + 20 * Math.sin(rt * 50) * Math.max(0, 0.3 - (rt - b.t0)), { size: b.size, color: b.color, glow: b.color, scale: sc, alpha: a, rot: -0.05 });
  }

  // ---- words & floaters
  for (const w of show.words) {
    const u = (rt - w.t0) / 0.9, p = show.project(w.pos);
    txt(ctx, w.text, p.x, p.y - u * 60, { size: 78, color: w.color, glow: w.color, scale: 0.5 + easeOutBack(clamp(u * 5)) * 0.7, alpha: 1 - clamp((u - 0.6) * 2.5), rot: -0.12 });
  }
  for (const f of show.floaters) {
    const u = (rt - f.t0) / 1.3, p = show.project(f.pos);
    txt(ctx, f.text, p.x + 60, p.y - 20 - u * 120, { size: f.big ? 120 : 84, color: '#fff', stroke: '#ff3b5c', sw: 14, alpha: 1 - clamp((u - 0.6) * 2.5), scale: 0.6 + easeOutBack(clamp(u * 6)) * 0.5 });
  }

  // ---- move-quality badge on the board
  if (show.badge && rt - show.badge.t0 < 1.4) {
    const b = show.badge, u = rt - b.t0, sq = b.sq;
    const v = show.project(new (show.camera.position.constructor)(sq.charCodeAt(0) - 97 - 3.5, 1.9, 3.5 - (sq.charCodeAt(1) - 49)));
    const sc = 0.3 + 0.8 * easeOutBack(clamp(u / 0.25));
    const a = 1 - clamp((u - 1.0) * 2.5);
    ctx.save(); ctx.globalAlpha = a; ctx.translate(v.x, v.y - 30); ctx.scale(sc, sc);
    ctx.beginPath(); ctx.arc(0, 0, 54, 0, 7); ctx.fillStyle = b.q.color; ctx.shadowColor = b.q.color; ctx.shadowBlur = 30; ctx.fill();
    ctx.lineWidth = 7; ctx.strokeStyle = '#fff'; ctx.stroke(); ctx.shadowBlur = 0;
    ctx.restore();
    txt(ctx, b.q.sym, v.x, v.y - 30, { size: 62, color: '#fff', stroke: 'rgba(0,0,0,0.45)', sw: 6, scale: sc, alpha: a });
    txt(ctx, b.q.label, v.x, v.y + 60 * sc, { size: 40, color: b.q.color, glow: b.q.color, scale: sc, alpha: a, sw: 9 });
  }

  // ---- caption strip (bottom)
  const pl = show.cur < show.plan.length ? show.plan[show.cur] : null;
  if (pl && pl.a.caption && pl.started && pl.a.i !== 69) {
    const cap = pl.a.caption, lt = (t - pl.start) / pl.dur;
    const u = clamp(((t - pl.start) * pl.speed - 0.2) / 0.3), out = clamp((1 - lt) * 8);
    if (u > 0) {
      const a = Math.min(1, u) * out;
      ctx.save(); ctx.globalAlpha = a * 0.78; ctx.fillStyle = '#0a0420'; slant(ctx, 60, 1340, 960, cap.sub ? 250 : 190, 30); ctx.fill();
      ctx.strokeStyle = cap.color; ctx.lineWidth = 6; ctx.stroke(); ctx.restore();
      txt(ctx, cap.text, 540, cap.sub ? 1416 : 1435, { size: cap.text.length > 16 ? 96 : 130, maxW: 900, color: cap.color, glow: cap.color, alpha: a, scale: 0.6 + 0.4 * easeOutBack(u), rot: -0.02 });
      if (cap.sub) txt(ctx, cap.sub.toUpperCase(), 540, 1530, { size: 46, color: '#fff', alpha: a, sw: 8, maxW: 900 });
    }
  }

  // ---- move ticker (bottom)
  if (pl && pl.started && !pl.a.mate && !(pl.a.caption && (t - pl.start) * pl.speed > 0.2)) {
    const a = pl.a;
    txt(ctx, `${a.moveNo}${a.color === 'w' ? '.' : '...'} ${a.san}`, 540, 1600, { size: 52, color: a.color === 'w' ? '#6ff0ff' : '#ff6fb1', sw: 9 });
  }

  // ---- K.O. + winner card
  if (show.koAt !== undefined && show.over || show.koAt !== undefined) {
    const k = rt - show.koAt;
    if (k >= 0) {
      const u = clamp(k / 0.3);
      if (k < 2.6) txt(ctx, 'K.O.', 540, 760, { size: 420, color: '#ffd23f', glow: '#ff3b5c', scale: 0.3 + 0.9 * easeOutBack(u) + Math.sin(k * 30) * 0.01 * Math.max(0, 1 - k), rot: -0.08, sw: 44, alpha: 1 - clamp((k - 2.2) * 2.5) });
      if (k > 0.6) {
        const w = clamp((k - 0.6) / 0.4);
        ctx.fillStyle = `rgba(10,4,32,${0.55 * clamp((k - 2.0) / 0.8)})`; ctx.fillRect(0, 0, 1080, 1920);
        txt(ctx, 'CHECKMATE', 540, k < 2.6 ? 1010 : 520, { size: 150, color: '#ff3b5c', glow: '#ff3b5c', scale: 0.5 + 0.5 * easeOutBack(w), alpha: w });
      }
      if (k > 2.6) {
        const w = clamp((k - 2.6) / 0.5), w2 = clamp((k - 3.4) / 0.5), w3 = clamp((k - 4.2) / 0.5);
        txt(ctx, CONFIG.hero.name.toUpperCase(), 540, 700, { size: 104, maxW: 980, color: '#ff6fb1', glow: '#ff3d8e', scale: 0.5 + 0.5 * easeOutBack(w), alpha: w });
        txt(ctx, 'WINS!', 540, 880, { size: 190, color: '#ffd23f', glow: '#ff3d8e', scale: 0.5 + 0.5 * easeOutBack(w2), alpha: w2, rot: -0.05 });
        txt(ctx, CONFIG.winnerLine, 540, 1060, { size: 62, color: '#7cff4d', glow: '#7cff4d', alpha: w3 });
        txt(ctx, CONFIG.cta, 540, 1480, { maxW: 960, size: 54, color: '#fff', glow: '#19d9ff', alpha: w3 * (0.75 + 0.25 * Math.sin(rt * 6)) });
      }
    }
  }

  // ---- CRT scanlines
  ctx.fillStyle = scanPattern(ctx); ctx.globalAlpha = 0.6; ctx.fillRect(0, 0, 1080, 1920); ctx.globalAlpha = 1;
  ctx.restore();
}
