#!/usr/bin/env node
// CLI wrapper over the same core. Prints the saved file path to stdout (scriptable);
// status/errors go to stderr.
//
//   gpt-image "a red fox in snow, watercolor" -o fox.png
//   gpt-image --subject "a ceramic coffee mug" --preset product-studio --modifier warm-grade
//   gpt-image --upscale photo.png -o photo-hi.png
//   gpt-image --edit photo.png --instruction "replace the background with a sunlit beach"
//   gpt-image --presets [category]        # list the catalog
//   gpt-image --check                     # validate the session

import { editImage, generateImage, previewImageRequest, modelAssistedCutout, upscaleImage } from "./generate.js";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { exportLogoKit } from "./logo.js";
import { createBrandBoard } from "./brandboard.js";
import { resolveBrandPaths } from "./branding.js";
import { creativeBriefSchema, referenceSchema, type ImageReference } from "./brief.js";
import { checkSession } from "./auth.js";
import { configuredModels } from "./models.js";
import { catalog } from "./presets/index.js";
import { exportWebAssets, type WebAssetKind } from "./webassets.js";
import { cutoutPath, removeBackgroundFile } from "./imageops.js";
import type { PromptOverrides } from "./presets/index.js";
import type { ImageFormat, ImageQuality, ImageSize } from "./providers/types.js";

interface CliArgs {
  preview?: boolean;
  logoKit?: string;
  brandBoard?: string;
  briefFile?: string;
  contactSheet?: boolean;
  preserveUnmasked?: boolean;
  references?: ImageReference[];
  prompt: string;
  subject?: string;
  preset?: string;
  modifiers: string[];
  style: PromptOverrides;
  upscale?: string;
  edit?: string;
  web?: string;
  image?: string;
  removeBg?: string;
  stripMeta?: string;
  useModel?: boolean;
  instruction?: string;
  guidance?: string;
  mask?: string;
  transparent?: boolean;
  count?: number;
  series?: number;
  from?: string;
  styleRef: string[];
  platform?: string;
  proof?: boolean;
  size?: ImageSize;
  quality?: ImageQuality;
  format?: ImageFormat;
  output?: string;
  backend?: string;
  imageModel?: string;
  check?: boolean;
  presets?: boolean;
  presetsCategory?: string;
}

const STYLE_KEYS = ["medium", "composition", "subjectDetail", "setting", "lighting", "camera", "color", "mood", "detail"];

function printHelp(): void {
  console.error(
    [
      "gpt-image — generate / edit / upscale images via your ChatGPT/Codex subscription",
      "",
      'Usage: gpt-image "<prompt>" [options]',
      "       gpt-image --subject \"<thing>\" --preset <id> [--modifier <id>]...",
      "       gpt-image --upscale <path> [options]",
      "       gpt-image --edit <path> --instruction \"<change>\" [options]",
      "       gpt-image --presets [category]",
      "       gpt-image --logo-kit <spec.json> [-o directory]",
      "       gpt-image --brand-board <spec.json> [-o directory]",
      "",
      "Modes:",
      "  --preview              Show the compiled generation request, without credentials or quota",
      "  --brief <json>         Structured creative brief (paths in the JSON are relative to that file)",
      "  --reference role:path  Subject/style/photography/texture/composition/palette/logo reference (repeatable)",
      "  --contact-sheet        Label all concepts in one local review sheet",
      "  --logo-kit <json>      Export approved logo artwork and outlined wordmarks locally",
      "  --brand-board <json>   Compose a board, exact type/palette and tokens; generation is opt-in",
      "  --no-preserve-unmasked Return raw model output from a masked edit (default preserves originals)",
      "  --subject <text>       What to depict (use with --preset for compiled prompts)",
      "  --preset <id>          Curated style preset (see --presets)",
      "  --modifier <id>        Layer a modifier (repeatable)",
      "  --style.<dim> <text>   Override a dimension, e.g. --style.lighting \"neon glow\"",
      "  --transparent          Transparent background (icons/logos/stickers; forces png)",
      "  -n, --count <N>        Produce N independent variations (1-10)",
      "  --series <N>           Produce N CONSISTENT images (first reused as style ref for the rest)",
      "  --from <image>         Reproduce/tweak a prior image from its sidecar (then override with args)",
      "  --mask <path>          Mask PNG for --edit inpainting (transparent = regenerate here)",
      "  --style-ref <path>     Style/brand reference image (repeatable; aesthetics only)",
      "  --platform <id>        Target platform (instagram-feed|instagram-story|tiktok|x-post|linkedin-post|og-card|youtube-thumbnail|pinterest-pin): native size + safe-area composition",
      "  --proof / --no-proof   Vision proof-loop: model proofreads its render + auto-retries (default: on when --style.text is set)",
      "  --upscale <path>       Enhance/upscale an existing image",
      "  --edit <path>          Edit an existing image (with --instruction)",
      "  --web <kind>           Export web assets: favicon | og | hero | appicon",
      "                           source = --image <path>, or generate from --subject/--preset",
      "  --image <path>         Source image for --web (instead of generating)",
      "  --remove-bg <path>     Cut out background → transparent PNG (clean backgrounds only)",
      "  --strip-metadata <p>   Scrub EXIF/XMP/C2PA provenance from an image, lossless (default: in place)",
      "  --use-model            With --remove-bg: model re-renders the subject on chroma for busy backgrounds",
      "  --instruction <text>   What to change (for --edit)",
      "  --guidance <text>      Extra guidance (for --upscale)",
      "  --presets [category]   Print the preset + modifier catalog (JSON)",
      "",
      "Options:",
      "  -o, --out <path>       Output file or directory (default ./generated-images/)",
      "  --size <size>          auto | 1024x1024 | 1536x1024 | 1024x1536 | 1024x1280 (4:5) | 1280x1024 (5:4) | 2048x2048 | 2048x1152 | 1152x2048",
      "  -q, --quality <q>      auto | low | medium | high | xhigh | max",
      "  -f, --format <fmt>     png | jpeg | webp",
      "  --image-model <name>   flare (fast) | sunburst (precise) | auto | full ID; requires --backend apikey",
      "  -b, --backend <name>   subscription | apikey",
      "      --check            Validate the subscription session (no image quota spent) and exit",
      "  -h, --help             Show this help",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { prompt: "", modifiers: [], style: {}, styleRef: [] };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--style.")) {
      const dim = a.slice("--style.".length);
      const val = argv[++i];
      if (dim === "avoid") args.style.avoid = (val ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      else if (dim === "text") args.style.text = val;
      else if (STYLE_KEYS.includes(dim)) (args.style as Record<string, unknown>)[dim] = val;
      continue;
    }
    switch (a) {
      case "--preview":
      case "--dry-run": args.preview = true; break;
      case "--logo-kit": args.logoKit = argv[++i]; if (!args.logoKit) throw new Error("--logo-kit requires a JSON file"); break;
      case "--brand-board": args.brandBoard = argv[++i]; if (!args.brandBoard) throw new Error("--brand-board requires a JSON file"); break;
      case "--brief": args.briefFile = argv[++i]; if (!args.briefFile) throw new Error("--brief requires a JSON file"); break;
      case "--contact-sheet": args.contactSheet = true; break;
      case "--preserve-unmasked": args.preserveUnmasked = true; break;
      case "--no-preserve-unmasked": args.preserveUnmasked = false; break;
      case "--reference": {
        const ref = argv[++i] ?? "", colon = ref.indexOf(":");
        const value = referenceSchema.parse({ role: ref.slice(0, colon), path: ref.slice(colon + 1) });
        (args.references ??= []).push(value); break;
      }
      case "-o":
      case "--out":
      case "--output":
        args.output = argv[++i];
        break;
      case "--subject":
        args.subject = argv[++i];
        break;
      case "--preset":
        args.preset = argv[++i];
        break;
      case "--modifier":
      case "--mod":
        { const v = argv[++i]; if (v) args.modifiers.push(v); }
        break;
      case "--upscale":
        args.upscale = argv[++i];
        break;
      case "--edit":
        args.edit = argv[++i];
        break;
      case "--web":
        args.web = argv[++i];
        break;
      case "--image":
        args.image = argv[++i];
        break;
      case "--remove-bg":
        args.removeBg = argv[++i];
        break;
      case "--strip-metadata":
        args.stripMeta = argv[++i];
        break;
      case "--use-model":
        args.useModel = true;
        break;
      case "--instruction":
        args.instruction = argv[++i];
        break;
      case "--guidance":
        args.guidance = argv[++i];
        break;
      case "--mask":
        args.mask = argv[++i];
        break;
      case "--transparent":
        args.transparent = true;
        break;
      case "--count":
      case "-n":
        args.count = Number(argv[++i]) || 1;
        break;
      case "--series":
        args.series = Number(argv[++i]) || 1;
        break;
      case "--from":
        args.from = argv[++i];
        break;
      case "--style-ref":
        { const v = argv[++i]; if (v) args.styleRef.push(v); }
        break;
      case "--platform":
        args.platform = argv[++i];
        break;
      case "--proof":
        args.proof = true;
        break;
      case "--no-proof":
        args.proof = false;
        break;
      case "--presets":
        args.presets = true;
        // optional non-flag category follows
        if (argv[i + 1] && !argv[i + 1]!.startsWith("-")) args.presetsCategory = argv[++i];
        break;
      case "--size":
        args.size = argv[++i] as ImageSize;
        break;
      case "-q":
      case "--quality":
        args.quality = argv[++i] as ImageQuality;
        break;
      case "-f":
      case "--format":
        args.format = argv[++i] as ImageFormat;
        break;
      case "-b":
      case "--backend":
        args.backend = argv[++i];
        break;
      case "--image-model":
        args.imageModel = argv[++i];
        if (!args.imageModel || args.imageModel.startsWith("--")) throw new Error("--image-model requires flare, sunburst, auto, or a full model ID.");
        break;
      case "--check":
        args.check = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        rest.push(a);
    }
  }
  args.prompt = rest.join(" ").trim();
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.preview && (args.edit || args.upscale || args.web || args.logoKit || args.brandBoard || args.removeBg || args.stripMeta || args.check)) {
  throw new Error("--preview applies to generation only; do not combine it with another operation. No operation was performed.");
}

if (args.check) {
  const models = configuredModels();
  console.error(`routing   : ${models.routing} (subscription; renderer selected by OpenAI)`);
  console.error(`proof     : ${models.proof}`);
  console.error(`API image : ${models.image} (only when apikey backend is selected)`);
  console.error("API choices: flare (fast) | sunburst (editing precision); --image-model selects per call");
  const s = await checkSession();
  console.error(`auth file : ${s.authFile}`);
  console.error(`account   : ${s.email ?? "(unknown)"}`);
  if (s.accessExpiry) console.error(`token exp : ${s.accessExpiry}`);
  if (s.ok) {
    console.error("session   : valid (image access and quota are not tested)");
    process.exit(0);
  }
  console.error(`session   : ✗ invalid\n${s.reason}`);
  process.exit(1);
}

if (args.presets) {
  console.log(JSON.stringify(catalog(args.presetsCategory as any), null, 2));
  process.exit(0);
}

const hasStyle = Object.keys(args.style).length > 0;
const brief = args.briefFile ? creativeBriefSchema.parse(JSON.parse(await readFile(args.briefFile, "utf8"))) : undefined;

if (args.logoKit || args.brandBoard) {
  try {
    const file = resolve((args.logoKit ?? args.brandBoard)!);
    const spec = JSON.parse(await readFile(file, "utf8"));
    const base = dirname(file);
    if (spec.brand) spec.brand = resolveBrandPaths(spec.brand, base);
    spec.outDir = args.output ? resolve(args.output) : resolve(base, spec.outDir ?? "brand-output");
    if (args.logoKit) {
      for (const key of ["markPath", "wordmarkPath", "fontPath"]) if (spec[key]) spec[key] = resolve(base, spec[key]);
      const result = await exportLogoKit(spec);
      console.log(result.manifest); console.log(result.sheet);
      console.error(`${result.files.length} logo/website assets saved to ${result.outDir}`);
    } else {
      if (spec.assets) spec.assets = spec.assets.map((a: any) => ({ ...a, path: resolve(base, a.path) }));
      if (args.backend) spec.backend = args.backend;
      if (args.imageModel) spec.imageModel = args.imageModel;
      if (args.quality) spec.quality = args.quality;
      const result = await createBrandBoard(spec);
      console.log(result.path); console.log(result.svgPath); console.log(result.manifest);
    }
    process.exit(0);
  } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
}

// Local-only operations (no generation) handled up front.
if (args.stripMeta) {
  const { stripImageMetadata } = await import("./metastrip.js");
  const { readFile, writeFile } = await import("node:fs/promises");
  const buf = await readFile(args.stripMeta);
  const clean = stripImageMetadata(buf);
  const outPath = args.output ?? args.stripMeta;
  await writeFile(outPath, clean);
  console.log(outPath);
  console.error(`✓ metadata stripped → ${outPath} (${buf.length - clean.length} bytes removed)`);
  process.exit(0);
}

if (args.removeBg) {
  const outPath = args.output ?? cutoutPath(args.removeBg);
  if (args.useModel) {
    await modelAssistedCutout(args.removeBg, outPath, args.backend, args.imageModel);
    console.error("⚠ model-assisted cutout regenerates the subject — verify fine detail against the original.");
  } else {
    await removeBackgroundFile(args.removeBg, outPath);
  }
  console.log(outPath);
  console.error(`✓ background removed → ${outPath}`);
  process.exit(0);
}

if (args.web) {
  let source = args.image;
  if (!source) {
    if (!args.subject) {
      console.error("✗ --web needs --image <path> or --subject to generate a source");
      process.exit(1);
    }
    const kind = args.web as WebAssetKind;
    const g = await generateImage({
      subject: args.subject,
      preset: args.preset,
      backend: args.backend,
      imageModel: args.imageModel,
      quality: args.quality,
      transparent: args.transparent ?? (kind === "favicon" || kind === "appicon"),
      size: kind === "og" ? "1536x1024" : kind === "hero" ? "2048x1152" : "1024x1024",
    });
    source = g.path;
    console.error(`  generated source: ${g.path}`);
  }
  const res = await exportWebAssets({ sourcePath: source, kind: args.web as WebAssetKind, outDir: args.output, format: args.format });
  for (const f of res.files) console.log(f.path);
  console.error(`✓ ${res.files.length} ${res.kind} asset(s) → ${res.outDir}${res.notes.length ? `\n  ${res.notes.join(" ")}` : ""}`);
  process.exit(0);
}

try {
  let out;
  if (args.upscale) {
    out = await upscaleImage({
      imagePath: args.upscale,
      guidance: args.guidance,
      size: args.size,
      quality: args.quality,
      format: args.format,
      outputPath: args.output,
      backend: args.backend,
      imageModel: args.imageModel,
    });
  } else if (args.edit) {
    out = await editImage({
      imagePaths: [args.edit],
      instruction: args.instruction ?? (args.prompt || undefined),
      maskPath: args.mask,
      preserveUnmasked: args.preserveUnmasked,
      brief,
      references: args.references,
      count: args.count,
      subject: args.subject,
      preset: args.preset,
      modifiers: args.modifiers,
      style: hasStyle ? args.style : undefined,
      proof: args.proof,
      platform: args.platform,
      size: args.size,
      quality: args.quality,
      format: args.format,
      outputPath: args.output,
      backend: args.backend,
      imageModel: args.imageModel,
    });
  } else {
    if (!args.prompt && !args.subject && !args.from) {
      printHelp();
      process.exit(1);
    }
    const generationOptions = {
      brief,
      references: args.references,
      contactSheet: args.contactSheet,
      prompt: args.prompt || undefined,
      subject: args.subject,
      preset: args.preset,
      modifiers: args.modifiers,
      style: hasStyle ? args.style : undefined,
      transparent: args.transparent,
      count: args.count,
      series: args.series,
      fromImage: args.from,
      styleReference: args.styleRef.length ? args.styleRef : undefined,
      platform: args.platform,
      proof: args.proof,
      size: args.size,
      quality: args.quality,
      format: args.format,
      outputPath: args.output,
      backend: args.backend,
      imageModel: args.imageModel,
    };
    if (args.preview) { console.log(JSON.stringify(await previewImageRequest(generationOptions), null, 2)); process.exit(0); }
    out = await generateImage(generationOptions);
  }
  for (const p of [out.path, ...(out.variants ?? [])]) console.log(p);
  if (out.contactSheet) console.log(out.contactSheet);
  console.error(
    `✓ ${out.backend} · ${out.bytes} bytes · ${out.format}${out.background === "transparent" ? " · transparent" : ""}` +
      (out.variants?.length ? ` · ${out.variants.length + 1} variants` : "") +
      (out.preset ? ` · preset ${out.preset}${out.modifiers.length ? ` +[${out.modifiers.join(",")}]` : ""}` : "") +
      (out.palette?.length ? `\n  palette: ${out.palette.join(", ")}` : "") +
      (out.proof
        ? out.proof.unverified
          ? "\n  proof: ⚠ could not run — image unverified"
          : out.proof.pass
            ? `\n  proof: ✓ passed (${out.proof.attempts ?? 1} attempt(s))`
            : `\n  proof: ✗ FAILED — ${out.proof.issues.join("; ")}`
        : "") +
      (out.revisedPrompt ? `\n  revised: ${out.revisedPrompt}` : ""),
  );
} catch (e) {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
