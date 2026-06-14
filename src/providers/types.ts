export type ImageSize = "auto" | "1024x1024" | "1536x1024" | "1024x1536";
export type ImageFormat = "png" | "jpeg" | "webp";
export type ImageQuality = "auto" | "low" | "medium" | "high";

export interface GenerateInput {
  prompt: string;
  size: ImageSize;
  format: ImageFormat;
  quality: ImageQuality;
}

export interface GenerateResult {
  bytes: Buffer;
  format: ImageFormat;
  revisedPrompt?: string;
}

export interface ImageProvider {
  readonly name: string;
  generate(input: GenerateInput): Promise<GenerateResult>;
}
