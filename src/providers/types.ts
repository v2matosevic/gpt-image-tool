export type ImageSize =
  | "auto"
  | "1024x1024"
  | "1536x1024"
  | "1024x1536"
  | "1024x1280" // 4:5 portrait — Instagram/Facebook feed (backend renders native 4:5, ~1122x1402)
  | "1280x1024" // 5:4 landscape
  | "2048x2048" // 2K square (verified on the subscription endpoint)
  | "2048x1152" // 2K landscape (~16:9)
  | "1152x2048" // 2K portrait
  | `${number}x${number}`; // custom WIDTHxHEIGHT: apikey backend with GPT Image 2.5/2.6 only (validateSize)
export type ImageFormat = "png" | "jpeg" | "webp";
export type ImageQuality = "auto" | "low" | "medium" | "high" | "xhigh" | "max";
export type ImageBackground = "auto" | "transparent" | "opaque";

export interface GenerateInput {
  /** Image renderer, separate from the mainline routing model. */
  imageModel?: string;
  prompt: string;
  size: ImageSize;
  format: ImageFormat;
  quality: ImageQuality;
  /** Alpha handling. "transparent" requires a png/webp output. "auto" lets the model decide. */
  background?: ImageBackground;
  /** Reference images for image-to-image (edit / upscale / variation). Empty/undefined = text-to-image. */
  inputImages?: InputImage[];
  /** Optional alpha mask for inpainting: transparent areas of the mask are the regions to regenerate. */
  maskImage?: InputImage;
  /** GPT-Image-2.6 planning effort (low | medium | high). API only; refused elsewhere. */
  complexity?: string;
  /** Project folder whose git-ignored .secrets may hold OPENAI_API_KEY (apikey backend only). */
  keyProject?: string;
}

export interface InputImage {
  bytes: Buffer;
  /** MIME, e.g. "image/png". Used to build the data URI / multipart part. */
  mime: string;
}

export interface GenerateResult {
  /** Only populated when the provider explicitly reports a renderer. */
  reportedImageModel?: string;
  bytes: Buffer;
  format: ImageFormat;
  revisedPrompt?: string;
  /** Token usage the API reported for this request (apikey backend), numeric fields only. */
  usage?: import("../pricing.js").ImageUsage;
  /** Which source supplied the API key (never the key). */
  keySource?: string;
}

export interface ImageProvider {
  readonly name: string;
  generate(input: GenerateInput): Promise<GenerateResult>;
}
