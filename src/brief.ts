// Structured direction and explicit reference roles shared by preview, generation and editing.
import { z } from "zod";

const line = z.string().trim().min(1).max(2000);
export const creativeBriefSchema = z.object({
  purpose: line.optional(),
  audience: line.optional(),
  brandName: line.optional(),
  direction: line.optional(),
  composition: line.optional(),
  palette: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).max(8).optional(),
  mustInclude: z.array(line).max(20).optional(),
  avoid: z.array(line).max(20).optional(),
  preserve: z.array(line).max(20).optional(),
}).strict();
export type CreativeBrief = z.infer<typeof creativeBriefSchema>;

export const referenceSchema = z.object({
  path: z.string().min(1),
  role: z.enum(["subject", "style", "photography", "texture", "composition", "palette", "logo"]),
  instruction: line.optional(),
}).strict();
export type ImageReference = z.infer<typeof referenceSchema>;

export function briefClauses(input?: CreativeBrief): string[] {
  if (!input) return [];
  const b = creativeBriefSchema.parse(input);
  return [
    b.purpose && `Intended use: ${b.purpose}`,
    b.audience && `Audience: ${b.audience}`,
    b.brandName && `Brand context: ${b.brandName}; do not add its name as lettering unless text is explicitly requested`,
    b.direction && `Art direction: ${b.direction}`,
    b.composition && `Composition requirements: ${b.composition}`,
    b.palette?.length && `Use this declared palette: ${b.palette.join(", ")}`,
    b.mustInclude?.length && `Required visible elements: ${b.mustInclude.join("; ")}`,
    b.preserve?.length && `Preserve these invariants: ${b.preserve.join("; ")}`,
    b.avoid?.length && `Do not include: ${b.avoid.join("; ")}`,
  ].filter((x): x is string => typeof x === "string");
}

const ROLES: Record<ImageReference["role"], string> = {
  subject: "subject/content reference; preserve its identity and geometry",
  style: "aesthetic reference only; borrow treatment, materials and lighting, not its subject or lettering",
  photography: "photography reference only; match lighting, grade and lens feel, not its subject, logo or lettering",
  texture: "material reference only; match surface texture and finish, not its subject or lettering",
  composition: "layout reference only; borrow placement and negative space, not its subject, logo or copy",
  palette: "color reference only; do not reproduce any shapes, lettering or subject",
  logo: "approved logo reference; preserve its design when requested, do not scatter its shapes into the scene; exact reproduction still requires local compositing",
};

export function referenceClauses(refs: ImageReference[], offset = 0): string[] {
  return refs.map((raw, i) => {
    const r = referenceSchema.parse(raw);
    return `Reference image ${i + 1 + offset}: ${ROLES[r.role]}${r.instruction ? `. Specific instruction: ${r.instruction}` : ""}`;
  });
}

export function validateReferenceCount(count: number): void {
  if (count > 16) throw new Error(`At most 16 reference images are supported; received ${count}.`);
}
