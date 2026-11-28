// Recipes: saved subgraphs for common jobs, following the working order artists use: many cheap
// thumbnails for composition, then lighting and value, then colour, then one final. Each returns an
// ordinary create spec, so the result is a normal graph the agent edits like any other.

import { StudioError } from "./store.js";
import { cmd } from "./say.js";

export interface RecipeArgs { subject: string; path?: string }
interface Spec { nodes: unknown[]; connections: unknown[]; groups: unknown[]; next: string }

const G = (id: string, stage: string) => ({ id, stage });

export const RECIPES: Record<string, { summary: string; needs?: string; build: (a: RecipeArgs) => Spec }> = {
  lookbook: {
    summary: "One subject across settings: thumbnails per setting, pick an anchor, variations as edits of the anchor, handoff.",
    build: a => ({
      groups: [G("thumbs", "concept"), G("variations", "art")],
      nodes: [
        { ref: "subject", type: "prompt", group: "thumbs", settings: { text: `${a.subject}, on {{item}}` } },
        { ref: "settings", type: "list", group: "thumbs", settings: { items: ["white marble", "dark slate", "oiled oak", "raw linen"] } },
        { ref: "look", type: "style", group: "thumbs", settings: { shot: { size: "medium close-up", lens: "85mm", key_light: "soft window light from camera left" } } },
        { ref: "thumbs", type: "generate", group: "thumbs", settings: { quality: "low", size: "1024x1024" } },
        { ref: "anchor", type: "gallery", group: "thumbs" },
        { ref: "changes", type: "list", group: "variations", settings: { items: ["change only the colour to deep blue", "change only the colour to sage green"] } },
        { ref: "variants", type: "edit", group: "variations", settings: { quality: "low" } },
        { ref: "review", type: "gallery", group: "variations" },
        { ref: "hand", type: "handoff", group: "variations", settings: { intent: `Lookbook of ${a.subject}`, target: "web gallery" } },
      ],
      connections: [
        { from: "subject", to: "settings" }, { from: "settings", to: "thumbs" }, { from: "look", to: "thumbs" }, { from: "thumbs", to: "anchor" },
        { from: "anchor", to: "variants", to_handle: "image" }, { from: "changes", to: "variants" }, { from: "variants", to: "review" }, { from: "review", to: "hand" },
      ],
      next: 'Run scope "thumbs" first, pick one in anchor ({op:"pick", node:"anchor", takes:["thumbs/t2"]}), then run the rest. Edit settings.items and changes.items to your case.',
    }),
  },
  "character-sheet": {
    summary: "A character: thumbnails, pick and approve one, then turnaround views as edits of it, ready to save as canon.",
    build: a => ({
      groups: [G("design", "concept"), G("turnaround", "art")],
      nodes: [
        { ref: "character", type: "generate", group: "design", settings: { prompt: `${a.subject}, full body, neutral pose, plain light grey background`, quality: "low", takes: 4, size: "1024x1536" } },
        { ref: "anchor", type: "gallery", group: "design" },
        { ref: "views", type: "list", group: "turnaround", settings: { items: ["show the same character from the front, full body", "the same character in three-quarter view", "the same character in side profile", "the same character from behind", "a close-up portrait of the same character"] } },
        { ref: "turnaround", type: "edit", group: "turnaround", settings: { quality: "low", size: "1024x1536" } },
        { ref: "sheet", type: "gallery", group: "turnaround" },
      ],
      connections: [
        { from: "character", to: "anchor" }, { from: "anchor", to: "turnaround", to_handle: "image" }, { from: "views", to: "turnaround" }, { from: "turnaround", to: "sheet" },
      ],
      next: 'Run scope "character", look, pick one in anchor, run the rest. Approve the best views and save them: {op:"canon_save", name:"...", kind:"character", takes:[...], description:"..."}.',
    }),
  },
  "product-set": {
    summary: "An existing product photo placed in several scenes as edits, so the product stays the product.",
    needs: "path: the product photo",
    build: a => {
      if (!a.path) throw new StudioError("BAD_INPUT", 'recipe "product-set" needs path: the product photo.', cmd("create", { name: "...", recipe: "product-set", subject: "the bottle", path: "images/bottle.png" }));
      return {
        groups: [G("scenes", "art")],
        nodes: [
          { ref: "product", type: "reference", group: "scenes", settings: { path: a.path, role: "subject" } },
          { ref: "scenes", type: "list", group: "scenes", settings: { items: [`place ${a.subject} on a marble kitchen counter in soft morning light`, `place ${a.subject} on a wooden shelf with plants`, `place ${a.subject} on a plain pastel backdrop with a soft shadow`] } },
          { ref: "placed", type: "edit", group: "scenes", settings: { quality: "low" } },
          { ref: "review", type: "gallery", group: "scenes" },
        ],
        connections: [{ from: "product", to: "placed", to_handle: "image" }, { from: "scenes", to: "placed" }, { from: "placed", to: "review" }],
        next: "Edit the scenes list, run, then compare each scene with the product photo for drift (the run result lists deviations).",
      };
    },
  },
  storyboard: {
    summary: "A sequence of beats in one consistent look: one shared style node, one panel per beat.",
    build: a => ({
      groups: [G("board", "concept")],
      nodes: [
        { ref: "story", type: "prompt", group: "board", settings: { text: `${a.subject}: {{item}}` } },
        { ref: "beats", type: "list", group: "board", settings: { items: ["establishing wide shot of the place", "the main character arrives", "close-up of the key moment", "the resolution"] } },
        { ref: "look", type: "style", group: "board", settings: { shot: { medium: "loose pencil storyboard sketch with grey wash", palette: "greyscale" } } },
        { ref: "panels", type: "generate", group: "board", settings: { quality: "low", size: "1536x1024" } },
        { ref: "board", type: "gallery", group: "board" },
      ],
      connections: [{ from: "story", to: "beats" }, { from: "beats", to: "panels" }, { from: "look", to: "panels" }, { from: "panels", to: "board" }],
      next: "Replace the beats with yours, run, read the sheet in order. For a recurring character, save it as canon and connect a canon node to panels' references.",
    }),
  },
  "page-mock": {
    summary: "A web page mock to a build package: a few low-quality mocks, approve one, handoff to the coding agent, then attach the build screenshot.",
    build: a => ({
      groups: [G("mock", "concept"), G("build", "build")],
      nodes: [
        { ref: "page", type: "generate", group: "mock", settings: { prompt: `a website landing page design for ${a.subject}, desktop, full hero section with headline, sub-headline and one call-to-action button, clean modern layout, realistic UI screenshot`, quality: "low", takes: 3, size: "1536x1024" } },
        { ref: "pick", type: "gallery", group: "mock" },
        { ref: "hand", type: "handoff", group: "build", settings: { intent: `Landing page for ${a.subject}`, target: "Next.js landing page, 1440px wide", must_match: ["layout and hierarchy", "colour palette"], flexible: ["exact copy", "imagery"] } },
      ],
      connections: [{ from: "page", to: "pick" }, { from: "pick", to: "hand" }],
      next: 'Run, look at the mocks, approve one (after a recorded look), run "hand". When the page is built, add an implementation node with its screenshot.',
    }),
  },
};

export const RECIPE_NAMES = Object.keys(RECIPES);

export function recipeSpec(name: string, args: RecipeArgs): Spec {
  const r = RECIPES[name];
  if (!r) throw new StudioError("NO_RECIPE", `No recipe "${name}".`, `Recipes: ${RECIPE_NAMES.join(", ")}.`);
  if (!args.subject?.trim()) throw new StudioError("BAD_INPUT", `recipe "${name}" needs subject: what the images are of.`, cmd("create", { name: "...", recipe: name, subject: "a ceramic teapot" }));
  return r.build({ subject: args.subject.trim(), path: args.path });
}

export function recipesGuide(): string {
  return ["# Working order and recipes", "",
    "Work the way illustrators and photographers do, cheapest decisions first:",
    "1. Composition: many low-quality thumbnails (takes 3-4, or a list). Judge only framing and shapes.",
    "2. Lighting and value: sweep shot.key_light or shot.light_ratio on the chosen one.",
    "3. Colour: sweep shot.palette or shot.grade.",
    "4. Final: one image, approved after a recorded look, then handoff or canon.",
    "Variations of a settled image are edits of that anchor, not new generations.", "",
    `Recipes build a ready graph: ${cmd("create", { name: "...", recipe: "lookbook", subject: "..." })} (product-set also needs path). Then edit it like any graph.`,
    ...Object.entries(RECIPES).map(([k, r]) => `- ${k}: ${r.summary}${r.needs ? ` Needs ${r.needs}.` : ""}`)].join("\n");
}
