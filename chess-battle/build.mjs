// Bundles src/main.js (three.js + chess.js included) and inlines it into one self-contained HTML file.
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const out = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  write: false,
  legalComments: 'none',
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync('src/index.template.html', 'utf8').replace('/*__BUNDLE__*/', () => js);
writeFileSync('chess-battle.html', html);
console.log(`chess-battle.html  ${(html.length / 1024).toFixed(0)} KB`);
