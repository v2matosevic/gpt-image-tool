// A tiny font made from original test geometry, under this repository's MIT license.
// It proves file parsing, coverage, metrics and path output. It is not a design specimen.
import opentype from 'opentype.js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const chars = [...new Set([...Array.from({length: 95}, (_, i) => String.fromCodePoint(i + 32)), ...'čćžšđČĆŽŠĐéÉ'])];
const glyphs = [new opentype.Glyph({name: '.notdef', advanceWidth: 600, path: new opentype.Path()})];
for (const char of chars) {
  const p = new opentype.Path();
  if (char !== ' ') {
    p.moveTo(50, 0); p.lineTo(50, 700); p.lineTo(480, 700); p.lineTo(550, 550); p.lineTo(550, 0); p.close();
    p.moveTo(175, 150); p.lineTo(425, 150); p.lineTo(425, 550); p.lineTo(175, 550); p.close();
  }
  glyphs.push(new opentype.Glyph({ name: `uni${char.codePointAt(0).toString(16)}`, unicode: char.codePointAt(0), advanceWidth: 600, path: p }));
}
const font = new opentype.Font({ familyName: 'Harness Fixture', styleName: 'Regular', unitsPerEm: 1000, ascender: 800, descender: -200, glyphs });
font.tables.os2.usWeightClass = 400;
writeFileSync(fileURLToPath(new URL('./brand-font.ttf', import.meta.url)), Buffer.from(font.toArrayBuffer()));
