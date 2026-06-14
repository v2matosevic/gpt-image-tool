#!/usr/bin/env node
// CLI wrapper over the same core. Prints the saved file path to stdout (scriptable);
// status/errors go to stderr.
//
//   gpt-image "a red fox in snow, watercolor" -o fox.png
//   gpt-image "logo, flat, minimal" --size 1024x1024 --format webp --backend subscription

import { generateImage } from "./generate.js";
import { checkSession } from "./auth.js";
import type { ImageFormat, ImageQuality, ImageSize } from "./providers/types.js";

interface CliArgs {
  prompt: string;
  size?: ImageSize;
  quality?: ImageQuality;
  format?: ImageFormat;
  output?: string;
  backend?: string;
  check?: boolean;
}

function printHelp(): void {
  console.error(
    [
      "gpt-image — generate images via your ChatGPT/Codex subscription",
      "",
      'Usage: gpt-image "<prompt>" [options]',
      "",
      "Options:",
      "  -o, --out <path>       Output file or directory (default ./generated-images/)",
      "  --size <size>          auto | 1024x1024 | 1536x1024 | 1024x1536  (default 1024x1024)",
      "  -q, --quality <q>      auto | low | medium | high                (default auto)",
      "  -f, --format <fmt>     png | jpeg | webp                          (default png)",
      "  -b, --backend <name>   subscription | apikey                      (default subscription)",
      "      --check            Validate the subscription session (no image quota spent) and exit",
      "  -h, --help             Show this help",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { prompt: "" };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "-o":
      case "--out":
      case "--output":
        args.output = argv[++i];
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

if (!args.prompt) {
  printHelp();
  process.exit(1);
}

try {
  const out = await generateImage({
    prompt: args.prompt,
    size: args.size,
    quality: args.quality,
    format: args.format,
    outputPath: args.output,
    backend: args.backend,
  });
  console.log(out.path);
  console.error(
    `✓ ${out.backend} · ${out.bytes} bytes · ${out.format}` +
      (out.revisedPrompt ? `\n  revised: ${out.revisedPrompt}` : ""),
  );
} catch (e) {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
