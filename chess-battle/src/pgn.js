// PGN -> list of plies with clocks, annotations (chess.com NAGs / c_effect) and replayed board data.
import { Chess } from 'chess.js';

export function parsePgn(pgn) {
  const headers = {};
  let headEnd = 0;
  for (const m of pgn.matchAll(/^\[(\w+) "(.*)"\]\s*$/gm)) { headers[m[1]] = m[2]; headEnd = m.index + m[0].length; }
  let body = pgn.slice(headEnd);

  // comments -> placeholders (they may contain parentheses), then drop variations
  const comments = [];
  body = body.replace(/\{([^}]*)\}/g, (_, c) => {
    comments.push(c);
    return ` @C${comments.length - 1}@ `;
  });
  let flat = '';
  let depth = 0;
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0) flat += ch;
  }

  const raw = [];
  for (const tok of flat.split(/\s+/).filter(Boolean)) {
    let m;
    if (/^\d+\.+$/.test(tok)) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) continue;
    if ((m = tok.match(/^\$(\d+)$/))) { if (raw.length) raw[raw.length - 1].nag = +m[1]; continue; }
    if ((m = tok.match(/^@C(\d+)@$/))) { if (raw.length) raw[raw.length - 1].comment = comments[+m[1]]; continue; }
    raw.push({ san: tok.replace(/^\d+\.+/, '') });
  }

  const chess = new Chess();
  const plies = [];
  raw.forEach((r, i) => {
    const mv = chess.move(r.san);
    const c = r.comment || '';
    const clk = c.match(/\[%clk\s+([\d:.]+)\]/);
    let secs = null;
    if (clk) {
      const parts = clk[1].split(':').map(Number);
      secs = parts.reduce((a, v) => a * 60 + v, 0);
    }
    const effects = [];
    for (const e of c.matchAll(/\[%c_effect\s+([^\]]*)\]/g)) {
      for (const part of e[1].split(',')) {
        const sq = part.split(';')[0];
        const ty = part.match(/type;(\w+)/);
        if (ty) effects.push({ sq, type: ty[1] });
      }
    }
    const note = c.replace(/\[%[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
    plies.push({
      i, san: mv.san, color: mv.color, piece: mv.piece, from: mv.from, to: mv.to,
      captured: mv.captured || null, flags: mv.flags, promotion: mv.promotion || null,
      check: chess.inCheck(), mate: chess.isCheckmate(),
      moveNo: Math.floor(i / 2) + 1, nag: r.nag || 0, clock: secs, effects, note,
    });
  });
  return { headers, plies };
}
