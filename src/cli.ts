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

import { editImage, generateImage, modelAssistedCutout, upscaleImage } from "./generate.js";
import { checkSession } from "./auth.js";
import { catalog } from "./presets/index.js";
import { exportWebAssets, type WebAssetKind } from "./webassets.js";
import { cutoutPath, removeBackgroundFile } from "./imageops.js";
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
  web?: string;
  image?: string;
  removeBg?: string;
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
      "  --use-model            With --remove-bg: model re-renders the subject on chroma for busy backgrounds",
      "  --instruction <text>   What to change (for --edit)",
      "  --guidance <text>      Extra guidance (for --upscale)",
      "  --presets [category]   Print the preset + modifier catalog (JSON)",
      "",
      "Options:",
      "  -o, --out <path>       Output file or directory (default ./generated-images/)",
      "  --size <size>          auto | 1024x1024 | 1536x1024 | 1024x1536 | 1024x1280 (4:5) | 1280x1024 (5:4) | 2048x2048 | 2048x1152 | 1152x2048",
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
      case "--web":
        args.web = argv[++i];
        break;
      case "--image":
        args.image = argv[++i];
        break;
      case "--remove-bg":
        args.removeBg = argv[++i];
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

// Local-only operations (no generation) handled up front.
if (args.removeBg) {
  const outPath = args.output ?? cutoutPath(args.removeBg);
  if (args.useModel) {
    await modelAssistedCutout(args.removeBg, outPath, args.backend);
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
      proof: args.proof,
      platform: args.platform,
      size: args.size,
      quality: args.quality,
      format: args.format,
      outputPath: args.output,
      backend: args.backend,
    });
  } else {
    if (!args.prompt && !args.subject && !args.from) {
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
    });
  }
  for (const p of [out.path, ...(out.variants ?? [])]) console.log(p);
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
