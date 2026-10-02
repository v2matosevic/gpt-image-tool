// Font files, not machine font-family lookup: reproducible glyph outlines with explicit coverage.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import opentype from "opentype.js";
import { escapeXml } from "./typeset.js";

export interface OutlineFont {
  font: opentype.Font;
  path: string;
  name: string;
  family: string;
  subfamily: string;
  weight: number;
  style: "normal" | "italic";
  sha256: string;
}

export async function loadOutlineFont(path: string): Promise<OutlineFont> {
  const bytes = await readFile(path);
  let font: opentype.Font;
  try {
    font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  } catch (e) {
    throw new Error(`Cannot read font ${path}. Supply a static TTF, OTF or WOFF file (not WOFF2): ${e instanceof Error ? e.message : e}`);
  }
  if (font.tables.fvar) throw new Error(`Variable font ${path} needs a static font instance; axis selection is not supported.`);
  const names = font.names as any;
  const nameFor = (key: string): string | undefined => {
    const record = names[key] ?? names.windows?.[key] ?? names.unicode?.[key] ?? names.macintosh?.[key];
    return record?.en ?? (record && Object.values(record)[0] as string | undefined);
  };
  const family = nameFor("preferredFamily") ?? nameFor("typographicFamily") ?? nameFor("fontFamily") ?? "Unnamed font";
  const subfamily = nameFor("preferredSubfamily") ?? nameFor("typographicSubfamily") ?? nameFor("fontSubfamily") ?? "Regular";
  const name = nameFor("fullName") ?? family;
  return { font, path: resolve(path), name, family, subfamily, weight: font.tables.os2?.usWeightClass ?? 400,
    style: /italic|oblique/i.test(subfamily) ? "italic" : "normal", sha256: createHash("sha256").update(bytes).digest("hex") };
}

export interface OutlinedText { body: string; width: number; height: number; advanceWidth: number; bearingY: number; }

export function outlineText(font: OutlineFont, text: string, color = "#111111", fontSize = 100, options: { tracking?: number; accentWord?: string; accentColor?: string } = {}): OutlinedText {
  text = text.normalize("NFC");
  if (!text.trim() || text.length > 2000) throw new Error("Outlined text must contain 1–2000 characters.");
  if (/[\r\n]/.test(text)) throw new Error("Outline one line at a time; line breaks need an explicit layout.");
  const missing = [...new Set([...text].filter(c => !/\s/.test(c) && font.font.charToGlyphIndex(c) === 0))];
  if (missing.length) throw new Error(`Font ${font.name} is missing glyphs: ${missing.join(" ")}. Supply a font covering the exact text.`);
  const render = { kerning: true, letterSpacing: (options.tracking ?? 0) / fontSize, ...(options.accentWord ? { features: { liga: false, rlig: false } } : {}) };
  const path = font.font.getPath(text, 0, 0, fontSize, render);
  const box = path.getBoundingBox();
  if (![box.x1, box.x2, box.y1, box.y2].every(Number.isFinite) || box.x2 <= box.x1 || box.y2 <= box.y1) {
    throw new Error(`Font ${font.name} produced no visible outlines for this text.`);
  }
  // Serialize commands directly: opentype 2's toPathData has a different flipY default from 1.x.
  const n = (v: number) => Number(v.toFixed(3));
  const serialize = (commands: opentype.PathCommand[]) => commands.map(c => {
    if (c.type === "Z") return "Z";
    if (c.type === "M" || c.type === "L") return `${c.type}${n(c.x)} ${n(c.y)}`;
    if (c.type === "Q") return `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`;
    return `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`;
  }).join("");
  let paths = `<path fill="${escapeXml(color)}" d="${serialize(path.commands)}"/>`;
  if (options.accentWord && options.accentColor) {
    const escaped = options.accentWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu"))];
    const ranges = matches.map(m => ({ start: [...text.slice(0, m.index)].length, end: [...text.slice(0, m.index! + m[0].length)].length }));
    let index = 0;
    paths = "";
    font.font.forEachGlyph(text, 0, 0, fontSize, render, (glyph, x, y, size) => {
      const fill = ranges.some(r => index >= r.start && index < r.end) ? options.accentColor! : color;
      paths += `<path fill="${escapeXml(fill)}" d="${serialize(glyph.getPath(x, y, size, render, font.font).commands)}"/>`;
      index++;
    });
  }
  return {
    body: `<g transform="translate(${n(-box.x1)} ${n(-box.y1)})">${paths}</g>`,
    width: box.x2 - box.x1,
    height: box.y2 - box.y1,
    advanceWidth: font.font.getAdvanceWidth(text, fontSize, render),
    bearingY: box.y1,
  };
}

export function wrapOutlineText(font: OutlineFont, text: string, size: number, width: number, tracking = 0): string[] {
  const measure = (s: string) => font.font.getAdvanceWidth(s, size, { kerning: true, letterSpacing: tracking / size });
  const lines: string[] = [];
  for (const paragraph of text.normalize("NFC").split(/\r?\n/)) {
    let current = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (current && measure(`${current} ${word}`) <= width) { current += ` ${word}`; continue; }
      if (current) { lines.push(current); current = ""; }
      for (const char of word) {
        if (current && measure(current + char) > width) { lines.push(current); current = ""; }
        current += char;
      }
    }
    lines.push(current);
  }
  return lines;
}

export function fitOutline(text: OutlinedText, x: number, y: number, width: number, height: number): string {
  const scale = Math.min(width / text.width, height / text.height);
  return `<g transform="translate(${x} ${y}) scale(${scale})">${text.body}</g>`;
}
