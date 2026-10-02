import { z } from "zod";
import { dirname, resolve } from "node:path";
import { loadProfile } from "./profile.js";

export const hexSchema = z.string().regex(/^#[0-9a-f]{6}$/i, "Use a six-digit hex color, such as #183C35.");
export const brandColorSchema = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Use a CSS-safe role such as primary or ink."),
  hex: hexSchema,
}).strict();
export const brandFontSchema = z.object({ path: z.string().min(1), label: z.string().trim().min(1).max(80).optional() }).strict();
export const brandSchema = z.object({
  name: z.string().trim().min(1).max(100),
  tagline: z.string().trim().max(180).optional(),
  description: z.string().trim().max(700).optional(),
  colors: z.array(brandColorSchema).min(1).max(8).refine(cs => new Set(cs.map(c => c.role)).size === cs.length, "Color roles must be unique."),
  fonts: z.object({ heading: brandFontSchema, body: brandFontSchema.optional() }).strict().optional(),
  logos: z.object({ mark: z.string().min(1).optional(), wordmark: z.string().min(1).optional(), monoDark: z.string().min(1).optional(), monoLight: z.string().min(1).optional() }).strict().optional(),
}).strict();
export type BrandIdentity = z.infer<typeof brandSchema>;

/** Profile-owned paths are relative to that profile. Per-call paths retain caller semantics. */
export function resolveBrandPaths(raw: BrandIdentity, base: string): BrandIdentity {
  const b = brandSchema.parse(raw);
  return {
    ...b,
    fonts: b.fonts && {
      heading: { ...b.fonts.heading, path: resolve(base, b.fonts.heading.path) },
      body: b.fonts.body && { ...b.fonts.body, path: resolve(base, b.fonts.body.path) },
    },
    logos: b.logos && {
      mark: b.logos.mark && resolve(base, b.logos.mark),
      wordmark: b.logos.wordmark && resolve(base, b.logos.wordmark),
      monoDark: b.logos.monoDark && resolve(base, b.logos.monoDark),
      monoLight: b.logos.monoLight && resolve(base, b.logos.monoLight),
    },
  };
}

export function resolveBrand(explicit?: BrandIdentity, outDir?: string): BrandIdentity {
  if (explicit) return resolveBrandPaths(explicit, process.cwd());
  const loaded = loadProfile(outDir && resolve(outDir));
  if (!loaded?.profile.brand) throw new Error("Provide brand settings, or add brand to the project's .gptimage.json.");
  return resolveBrandPaths(loaded.profile.brand, dirname(loaded.path));
}

export function brandColor(brand: BrandIdentity, role: string, fallback: string): string {
  return brand.colors.find(c => c.role === role)?.hex ?? fallback;
}

export const safeNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/, "Use a filename stem with letters, digits, hyphens or underscores.");

export function brandTokens(brand: BrandIdentity) {
  return {
    name: brand.name,
    colors: Object.fromEntries(brand.colors.map(c => [c.role, c.hex.toUpperCase()])),
    typography: brand.fonts ? { heading: brand.fonts.heading.label, body: brand.fonts.body?.label } : undefined,
  };
}

export function brandCss(brand: BrandIdentity): string {
  return `:root {\n${brand.colors.map(c => `  --brand-${c.role}: ${c.hex.toUpperCase()};`).join("\n")}\n}\n`;
}
