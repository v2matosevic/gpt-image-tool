// MCP stdio server exposing a single `generate_image` tool. Any MCP client (Claude Code, Codex,
// Cursor, ...) can call it. Returns the saved file path as text (works everywhere); optionally
// attaches an inline image block when GPT_IMAGE_INLINE=1 (off by default to avoid output-token caps).
//
// IMPORTANT: stdout is the JSON-RPC channel — never write to it. All logging goes to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { generateImage } from "./generate.js";
import type { ImageFormat } from "./providers/types.js";

const INLINE = process.env.GPT_IMAGE_INLINE === "1";

function mimeFor(f: ImageFormat): string {
  return f === "jpeg" ? "image/jpeg" : f === "webp" ? "image/webp" : "image/png";
}

const server = new McpServer({ name: "gpt-image", version: "0.1.0" });

server.registerTool(
  "generate_image",
  {
    title: "Generate image (ChatGPT subscription)",
    description:
      "Generate an image from a text prompt using the user's ChatGPT/Codex subscription (no API cost). " +
      "Saves the image to disk and returns its absolute path — open/view that path to see the result. " +
      "Good for icons, illustrations, placeholders, mockups, hero art, textures, etc.",
    inputSchema: {
      prompt: z.string().describe("Detailed description of the image to generate."),
      size: z
        .enum(["auto", "1024x1024", "1536x1024", "1024x1536"])
        .optional()
        .describe("Dimensions. Default 1024x1024. 1536x1024 = landscape, 1024x1536 = portrait."),
      quality: z.enum(["auto", "low", "medium", "high"]).optional().describe("Render quality hint. Default auto."),
      format: z.enum(["png", "jpeg", "webp"]).optional().describe("Output file format. Default png."),
      output_path: z
        .string()
        .optional()
        .describe("Absolute file path (or a directory ending in /) to save to. Defaults to ./generated-images/."),
      backend: z
        .enum(["subscription", "apikey"])
        .optional()
        .describe("'subscription' (default, free, uses ChatGPT/Codex login) or 'apikey' (paid, uses OPENAI_API_KEY)."),
    },
  },
  async (args) => {
    try {
      const out = await generateImage({
        prompt: args.prompt,
        size: args.size,
        quality: args.quality,
        format: args.format,
        outputPath: args.output_path,
        backend: args.backend,
      });
      const text =
        `Image generated via the ${out.backend} backend and saved to:\n${out.path}\n\n` +
        `Open/view that path to see the image (${out.bytes} bytes, ${out.format}).` +
        (out.revisedPrompt ? `\n\nRevised prompt: ${out.revisedPrompt}` : "");

      const content: Array<Record<string, unknown>> = [{ type: "text", text }];
      if (INLINE) content.push({ type: "image", data: out.base64, mimeType: mimeFor(out.format) });
      return { content } as any;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text", text: `Image generation failed: ${msg}` }] } as any;
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[gpt-image] MCP server ready on stdio");
