// A deliberately bounded SVG input contract for distributable logo masters.
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { readFile } from "node:fs/promises";
import { escapeXml } from "./typeset.js";
import { loadSharp } from "./imageops.js";

export interface VectorArtwork { body: string; viewBox: string; width: number; height: number; vector: boolean; }
const TAGS = new Set(["svg", "g", "defs", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "use", "title", "desc"]);
const PRESENTATION = new Set(["fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "opacity", "clip-path", "clip-rule", "mask", "color", "stop-color", "stop-opacity", "vector-effect", "paint-order", "display", "visibility"]);

export function parseVectorSvg(raw: string, prefix = "asset", allowRaster = false): VectorArtwork {
  if (Buffer.byteLength(raw) > 10_000_000) throw new Error("SVG master exceeds the 10 MB input limit.");
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw new Error("SVG masters cannot contain document types or entities.");
  if (/<\?xml-stylesheet/i.test(raw)) throw new Error("External SVG stylesheets are not supported.");
  const doc = new DOMParser({ onError: (level, message) => { throw new Error(`Invalid SVG (${level}): ${message}`); } }).parseFromString(raw, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.localName !== "svg") throw new Error("Expected an SVG logo master.");
  const elements = [root, ...Array.from(root.getElementsByTagName("*"))];
  for (const el of elements) {
    if (!TAGS.has(el.localName ?? "") && !(allowRaster && el.localName === "image")) throw new Error(`SVG logo contains unsupported <${el.localName}>. Use outlined vectors with inline fills; raster images, text, filters and scripts are not vector masters.`);
    const style = el.getAttribute("style");
    if (style) {
      for (const declaration of style.split(";").filter(d => d.trim())) {
        const colon = declaration.indexOf(":"), property = declaration.slice(0, colon).trim(), value = declaration.slice(colon + 1).trim();
        if (colon < 0 || !PRESENTATION.has(property) || /[\\@]/.test(value)) throw new Error("SVG inline styles must use simple presentation properties without escapes or external resources.");
        el.setAttribute(property, value);
      }
      el.removeAttribute("style");
    }
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.localName ?? a.name) || a.localName === "base" || /[\\]|(?:javascript:|@import|expression\s*\()/i.test(a.value)) throw new Error("SVG active content and resource escapes are not supported.");
      const embeddedRaster = el.localName === "image" && /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(a.value);
      const urls = [...a.value.matchAll(/url\(([^)]*)\)/gi)].map(m => m[1]!.trim().replace(/^['"]|['"]$/g, ""));
      if ((a.localName === "href" && !a.value.startsWith("#") && !embeddedRaster) || urls.some(url => !/^#[^\s]+$/.test(url))) throw new Error("SVG masters must be self-contained; external resources are not supported.");
      if (a.name === "id") el.setAttribute(a.name, `${prefix}-${a.value}`);
      else if (a.localName === "href" && a.value.startsWith("#")) el.setAttribute(a.name, `#${prefix}-${a.value.slice(1)}`);
      else if (a.value.includes("url(")) el.setAttribute(a.name, a.value.replace(/url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)/g, `url(#${prefix}-$1)`));
    }
  }
  const view = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  let vb: number[];
  if (view?.length === 4 && view.every(Number.isFinite)) vb = view;
  else {
    const w = root.getAttribute("width") ?? "";
    const h = root.getAttribute("height") ?? "";
    if (!/^\d+(?:\.\d+)?(?:px)?$/.test(w) || !/^\d+(?:\.\d+)?(?:px)?$/.test(h)) throw new Error("SVG needs a numeric viewBox or pixel width and height.");
    vb = [0, 0, parseFloat(w), parseFloat(h)];
  }
  if (vb[2]! <= 0 || vb[3]! <= 0 || vb.some(v => Math.abs(v) > 1_000_000)) throw new Error("SVG dimensions must be positive and its viewBox within one million units.");
  // Keep root presentation attributes (fill, stroke, transforms), but size using the viewBox.
  root.removeAttribute("width"); root.removeAttribute("height");
  root.setAttribute("viewBox", vb.join(" "));
  root.setAttribute("width", String(vb[2])); root.setAttribute("height", String(vb[3]));
  return { body: new XMLSerializer().serializeToString(root), viewBox: vb.join(" "), width: vb[2]!, height: vb[3]!, vector: !elements.some(el => el.localName === "image") };
}

/** Recolor sanitized geometry. Callers rasterize and compare the silhouette before delivering it. */
export function recolorVector(body: string, color: string): string {
  const doc = new DOMParser().parseFromString(body, "image/svg+xml");
  const root = doc.documentElement!;
  root.setAttribute("fill", color);
  for (const el of [root, ...Array.from(root.getElementsByTagName("*"))]) {
    for (const attr of ["fill", "stroke"]) if (el.hasAttribute(attr) && el.getAttribute(attr) !== "none") el.setAttribute(attr, color);
    if (el.hasAttribute("style")) el.setAttribute("style", el.getAttribute("style")!.replace(/(fill|stroke)\s*:\s*(?!none\b)[^;]+/g, `$1:${color}`));
  }
  return new XMLSerializer().serializeToString(root);
}

export async function loadVectorSvg(path: string, prefix?: string): Promise<VectorArtwork> {
  return parseVectorSvg(await readFile(path, "utf8"), prefix);
}

export function svgDocument(body: string, width: number, height: number, title?: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${title ? `<title>${escapeXml(title)}</title>` : ""}${body}</svg>`;
}

export async function rasterizeSvg(svg: string): Promise<Buffer> {
  const sharp = await loadSharp();
  if (!sharp) throw new Error("Branding exports require sharp. Run npm ci for the documented installation.");
  return sharp(Buffer.from(svg), { limitInputPixels: 40_000_000 }).png().toBuffer();
}
