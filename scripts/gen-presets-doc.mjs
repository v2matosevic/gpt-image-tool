// Regenerate docs/PRESETS.md from the built registry. Run after `npm run build`: `npm run docs:presets`.
import { writeFileSync } from "node:fs";
import { ALL_PRESETS, ALL_MODIFIERS, CATEGORIES } from "../dist/presets/index.js";

const titleCat = {
  photography: "Photography",
  illustration: "Illustration",
  design: "Design",
  render3d: "3D / Render",
  specialized: "Specialized",
  webdev: "Web & App Dev",
};

let out = "# Preset & modifier catalog\n\n";
out += `_Auto-generated from \`src/presets/lib/*.ts\` — ${ALL_PRESETS.length} presets, ${ALL_MODIFIERS.length} modifiers. Regenerate with \`npm run docs:presets\`._\n\n`;
out += "Call `generate_image({ subject, preset })` with any `id` below. Recommended size/quality/format are applied unless you override them. `T` = defaults to a transparent background.\n\n";

for (const c of CATEGORIES) {
  const ps = ALL_PRESETS.filter((p) => p.category === c);
  out += `## ${titleCat[c] ?? c} (${ps.length})\n\n`;
  out += "| id | title | description | recommended |\n|---|---|---|---|\n";
  for (const p of ps) {
    const rec = `${p.recommended.size} · ${p.recommended.quality} · ${p.recommended.format}${p.background === "transparent" ? " · **T**" : ""}`;
    out += `| \`${p.id}\` | ${p.title} | ${p.description.replace(/\|/g, "\\|")} | ${rec} |\n`;
  }
  out += "\n";
}

out += `## Modifiers (${ALL_MODIFIERS.length})\n\nLayer onto any preset via \`modifiers: [...]\`. They overlay their dimension(s); per-call \`style\` still wins.\n\n`;
const byKind = {};
for (const m of ALL_MODIFIERS) (byKind[m.kind] ??= []).push(m);
for (const k of Object.keys(byKind)) {
  out += `**${k}** — ${byKind[k].map((m) => `\`${m.id}\``).join(", ")}\n\n`;
}

writeFileSync(new URL("../docs/PRESETS.md", import.meta.url), out);
console.log(`wrote docs/PRESETS.md (${ALL_PRESETS.length} presets, ${ALL_MODIFIERS.length} modifiers)`);
