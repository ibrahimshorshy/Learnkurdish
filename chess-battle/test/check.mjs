// Sanity checks for the PGN parser and the story-beat indices (run: npm test).
import assert from 'node:assert/strict';
import { parsePgn } from '../src/pgn.js';
import { PGN, CAPTIONS } from '../src/data.js';

const { headers, plies } = parsePgn(PGN);
assert.equal(headers.White, 'ganteng-indo');
assert.equal(headers.Black, 'ibrahimbngrdy');
assert.equal(plies.length, 70, 'mainline only: 35 moves each, variations dropped');
assert.equal(plies[69].san, 'Qf3#');
assert.ok(plies[69].mate, 'last move is mate');
assert.equal(plies.filter((p) => p.captured).length, 17);

const expect = { 8: 'Ng5', 10: 'Nxf7', 11: 'Kxf7', 15: 'c5', 17: 'Kg8', 19: 'Nc6', 21: 'Ne4', 31: 'Kxh8', 49: 'Qh6', 69: 'Qf3#' };
for (const [i, san] of Object.entries(expect)) {
  assert.equal(plies[i].san, san, `ply ${i}`);
  assert.ok(CAPTIONS[i], `caption for ply ${i}`);
}
assert.equal(plies[0].clock, 181.8);
assert.equal(plies[49].effects[0].type, 'Blunder');
assert.equal(plies[17].effects[0].type, 'GreatFind');
assert.equal(plies[7].clock, 184, 'clock split across a line break still parses');
console.log('ok — 70 plies, 17 captures, story beats line up');
