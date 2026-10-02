import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { encodePng } from "./bgremove.js";
import { fitTo, loadRGBA } from "./imageops.js";
import { escapeXml } from "./typeset.js";
import { rasterizeSvg, svgDocument } from "./vector.js";

/** Labels are annotations, not a claim about the brand font. Artwork is never regenerated. */
export async function createContactSheet(paths: string[], outputPath: string, labels?: string[]): Promise<string> {
  if (!paths.length || paths.length > 30) throw new Error("A contact sheet needs 1–30 images.");
  const cols = Math.min(3, paths.length), cell = 400, row = 334;
  const width = cols * cell, height = Math.ceil(paths.length / cols) * row;
  const blocks: string[] = [`<rect width="100%" height="100%" fill="#ECECE8"/>`];
  for (let i = 0; i < paths.length; i++) {
    const src = await loadRGBA(paths[i]!);
    const x = i % cols * cell, y = Math.floor(i / cols) * row;
    const preview = fitTo(src, 352, 272, "contain");
    const ground = labels?.[i] ? labels[i]!.includes("inverse") ? "#252525" : "#FFFFFF" : i % 2 ? "#252525" : "#FFFFFF";
    blocks.push(`<rect x="${x + 12}" y="${y + 12}" width="376" height="284" fill="${ground}"/>`,
      `<image x="${x + 24}" y="${y + 18}" width="352" height="272" href="data:image/png;base64,${encodePng(preview).toString("base64")}"/>`,
      `<text x="${x + 16}" y="${y + 319}" font-family="sans-serif" font-size="14" fill="#222222">${escapeXml((labels?.[i] ?? `Concept ${i + 1}`).slice(0, 48))}</text>`);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, await rasterizeSvg(svgDocument(blocks.join(""), width, height, "Image review contact sheet")));
  await writeFile(`${outputPath}.json`, JSON.stringify({ images: paths.map((path, i) => ({ path, label: labels?.[i] ?? `Concept ${i + 1}` })), width, height }, null, 2));
  return outputPath;
}
