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

import { editImage, generateImage, upscaleImage } from "./generate.js";
import { checkSession } from "./auth.js";
import { catalog } from "./presets/index.js";
import type { PromptOverrides } from "./presets/index.js";
import type { ImageFormat, ImageQuality, ImageSize } from "./providers/types.js";

interface CliArgs {
  prompt: string;
  subject?: string;
  preset?: string;
  modifiers: string[];
  style: PromptOverrides;
  upscale?: string;
  edit?: string;
  instruction?: string;
  guidance?: string;
  mask?: string;
  transparent?: boolean;
  count?: number;
  styleRef: string[];
  size?: ImageSize;
  quality?: ImageQuality;
  format?: ImageFormat;
  output?: string;
  backend?: string;
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
      "",
      "Modes:",
      "  --subject <text>       What to depict (use with --preset for compiled prompts)",
      "  --preset <id>          Curated style preset (see --presets)",
      "  --modifier <id>        Layer a modifier (repeatable)",
      "  --style.<dim> <text>   Override a dimension, e.g. --style.lighting \"neon glow\"",
      "  --transparent          Transparent background (icons/logos/stickers; forces png)",
      "  -n, --count <N>        Produce N variations (1-10)",
      "  --mask <path>          Mask PNG for --edit inpainting (transparent = regenerate here)",
      "  --style-ref <path>     Style/brand reference image (repeatable; aesthetics only)",
      "  --upscale <path>       Enhance/upscale an existing image",
      "  --edit <path>          Edit an existing image (with --instruction)",
      "  --instruction <text>   What to change (for --edit)",
      "  --guidance <text>      Extra guidance (for --upscale)",
      "  --presets [category]   Print the preset + modifier catalog (JSON)",
      "",
      "Options:",
      "  -o, --out <path>       Output file or directory (default ./generated-images/)",
      "  --size <size>          auto | 1024x1024 | 1536x1024 | 1024x1536",
      "  -q, --quality <q>      auto | low | medium | high",
      "  -f, --format <fmt>     png | jpeg | webp",
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
      case "--style-ref":
        { const v = argv[++i]; if (v) args.styleRef.push(v); }
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

if (args.check) {
  const s = await checkSession();
  console.error(`auth file : ${s.authFile}`);
  console.error(`account   : ${s.email ?? "(unknown)"}`);
  if (s.accessExpiry) console.error(`token exp : ${s.accessExpiry}`);
  if (s.ok) {
    console.error("session   : ✓ valid — subscription backend is ready");
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
    });
  } else if (args.edit) {
    out = await editImage({
      imagePaths: [args.edit],
      instruction: args.instruction ?? (args.prompt || undefined),
      maskPath: args.mask,
      count: args.count,
      subject: args.subject,
      preset: args.preset,
      modifiers: args.modifiers,
      style: hasStyle ? args.style : undefined,
      size: args.size,
      quality: args.quality,
      format: args.format,
      outputPath: args.output,
      backend: args.backend,
    });
  } else {
    if (!args.prompt && !args.subject) {
      printHelp();
      process.exit(1);
    }
    out = await generateImage({
      prompt: args.prompt || undefined,
      subject: args.subject,
      preset: args.preset,
      modifiers: args.modifiers,
      style: hasStyle ? args.style : undefined,
      transparent: args.transparent,
      count: args.count,
      styleReference: args.styleRef.length ? args.styleRef : undefined,
      size: args.size,
      quality: args.quality,
      format: args.format,
      outputPath: args.output,
      backend: args.backend,
    });
  }
  for (const p of [out.path, ...(out.variants ?? [])]) console.log(p);
  console.error(
    `✓ ${out.backend} · ${out.bytes} bytes · ${out.format}${out.background === "transparent" ? " · transparent" : ""}` +
      (out.variants?.length ? ` · ${out.variants.length + 1} variants` : "") +
      (out.preset ? ` · preset ${out.preset}${out.modifiers.length ? ` +[${out.modifiers.join(",")}]` : ""}` : "") +
      (out.revisedPrompt ? `\n  revised: ${out.revisedPrompt}` : ""),
  );
} catch (e) {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
