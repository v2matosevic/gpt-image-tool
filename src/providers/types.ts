export type ImageSize = "auto" | "1024x1024" | "1536x1024" | "1024x1536";
export type ImageFormat = "png" | "jpeg" | "webp";
export type ImageQuality = "auto" | "low" | "medium" | "high";
export type ImageBackground = "auto" | "transparent" | "opaque";

export interface GenerateInput {
  prompt: string;
  size: ImageSize;
  format: ImageFormat;
  quality: ImageQuality;
  /** Alpha handling. "transparent" requires a png/webp output. "auto" lets the model decide. */
  background?: ImageBackground;
  /** Reference images for image-to-image (edit / upscale / variation). Empty/undefined = text-to-image. */
  inputImages?: InputImage[];
}

export interface InputImage {
  bytes: Buffer;
  /** MIME, e.g. "image/png". Used to build the data URI / multipart part. */
  mime: string;
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
