// Studio file contract. These shapes are a public interface: ADE and other programs read
// graph.json, state.json, events.jsonl and runs/*.json directly. Change them only with a new
// schema version and a migration. docs/STUDIO.md documents every field.

export const GRAPH_SCHEMA = "gpt-image-studio/graph@1";
export const STATE_SCHEMA = "gpt-image-studio/state@1";
export const RUN_SCHEMA = "gpt-image-studio/run@1";
/** Bumped when node execution changes in a way that should invalidate cached takes. */
export const ENGINE_VERSION = 1;

export type HandleType = "text" | "style" | "image" | "package";
export type NodeType =
  | "prompt" | "style" | "list" | "reference" | "generate" | "edit" | "process"
  | "gallery" | "handoff" | "implementation" | "note" | "canon" | "finish";

/** Which renderer made a take. Subscription: OpenAI picks the model (gpt-image-2 as of 2026-11-28)
 *  and ignores quality and size. API: the paid Images API with the named model, which honours them. */
export interface RenderInfo {
  renderer: "subscription" | "api";
  /** Resolved model id for the API; "gpt-image-2 (server-chosen)" for the subscription. */
  model: string;
  quality?: string;
  size?: string;
  complexity?: string;
}

/** Token usage the API reported, numeric fields only (see src/pricing.ts). */
export interface TakeUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number; cached_tokens?: number };
  output_tokens_details?: { text_tokens?: number; image_tokens?: number };
}

export interface Position { x: number; y: number; /** Set when a person or agent placed the node; auto layout leaves it alone. */ pinned?: boolean }

export interface GraphNode {
  id: string;
  type: NodeType;
  label?: string;
  group?: string;
  position?: Position;
  settings: Record<string, unknown>;
}

export interface GraphEdge { from: string; fromHandle: string; to: string; toHandle: string }
export interface GraphGroup { id: string; label?: string; stage: string }

export interface GraphFile {
  schema: typeof GRAPH_SCHEMA;
  name: string;
  slug: string;
  /** Incremented on every definition change. Edits may pass expect_revision to refuse stale writes. */
  revision: number;
  created: string;
  updated: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups: GraphGroup[];
}

export interface TakeInput {
  handle: string;
  node: string;
  take?: string;
  sha256?: string;
  /** Text that flowed along the edge (prompt, list item, instruction). */
  text?: string;
  role?: string;
}

/** A human or agent decision on a take. Approve and reject are exclusive; the latest wins. */
export interface Verdict {
  decision: "approved" | "rejected"; by: string; at: string; note?: string;
  /** True when a person decided (ADE, CLI --human); counts for taste and calibration. */
  human?: boolean;
}

/** An agent's verdict recorded before the human decides, for calibration (agreement over time). */
export interface Prediction { by: string; at: string; decision: "approved" | "rejected" | "picked"; reason: string }

/** A structured opinion on a take, judged against the stated intent. Recorded as an opinion. */
export interface Critique {
  id: string;
  /** Who judged: an agent name, "vision" for the subscription vision model, or a person. */
  judge: string;
  at: string;
  /** Pairwise form: the other take compared against, and which one the judge preferred. */
  against?: string;
  preferred?: string;
  /** True when judged from a blind A/B pair that hid which take was newer. */
  blind?: boolean;
  /** Per-criterion remarks: composition, lighting, depth, colour, fidelity, consistency, artefacts. */
  criteria?: Record<string, string>;
  summary: string;
}

/** Measurements of a take's pixels. Measurements only; never a quality score. `source` names what
 *  produced them ("local" arithmetic, or an optional model with its version). */
export type Reading = Record<string, unknown> & { version: number; source: string };

/** Yes/no questions derived from the request, answered by looking. The main match-to-brief check. */
export interface ChecklistItem { id: string; question: string; from: string; answer?: "yes" | "no" | "unsure"; by?: string; at?: string; note?: string }

export interface Take {
  id: string;
  kind: "image" | "package";
  /** Fan-out position (list item or input image) and take number within it, at creation time. */
  slot: number;
  variant: number;
  /** Hash of everything that determines the output. Equal fingerprint = reusable result. */
  fingerprint: string;
  /** Relative to the graph folder, forward slashes. For a package: the handoff.md path. */
  asset: string;
  sha256: string;
  bytes: number;
  width?: number;
  height?: number;
  created: string;
  job?: string;
  graphRevision: number;
  inputs: TakeInput[];
  text?: { prompt?: string; item?: string; compiledPrompt?: string; revisedPrompt?: string };
  settings: Record<string, unknown>;
  /** Extra files written with the take (web-export set, comparison sheet, package files). */
  files?: string[];
  /** Provider generations this take cost (proof-loop regenerations included). 0 for local work. */
  generations: number;
  warnings?: string[];
  /** For reference/implementation takes: the project-relative file it was imported from. */
  source?: string;
  verdict?: Verdict;
  predictions?: Prediction[];
  critiques?: Critique[];
  reading?: Reading;
  /** Optional-model readings (phase 1c), keyed by capability, each with its own source/version. */
  perception?: Record<string, Reading>;
  checklist?: ChecklistItem[];
  /** Measured departures from the anchor image or from what the request asked for. */
  deviations?: Array<{ source: "anchor" | "request"; measure: string; expected: string; measured: string; note: string }>;
  /** Provider takes (phase 1d): the renderer and model that made it. */
  render?: RenderInfo;
  /** API takes: usage as reported, and dollars from it at the dated rates in src/pricing.ts.
   *  estimate is what the spend check reserved before the request. */
  usage?: TakeUsage;
  /** keySource names where the API key came from (an env variable or a file path), never the key. */
  cost?: { dollars: number; estimate: number; rates: string; funding: string; keySource?: string };
}

export interface NodeError { message: string; fix?: string; at: string; job?: string }

export interface NodeState {
  takes: Take[];
  /** Take ids chosen as the output of their slot. Newest matching take is used when none is chosen. */
  selected: string[];
  /** Gallery only: "node/take" refs picked from the collected images. */
  picks?: string[];
  error?: NodeError;
  /** Present while a run is working on this node. Valid only while that run is live (see runs/). */
  activity?: { job: string; status: "queued" | "running"; at: string };
}

export interface StateFile {
  schema: typeof STATE_SCHEMA;
  /** Incremented on every state write (takes, selections, approvals, run activity). */
  revision: number;
  /** Sequence number of the last event appended. Event seqs strictly increase; gaps are allowed. */
  eventSeq: number;
  nextTake: number;
  nodes: Record<string, NodeState>;
}

export interface StudioEvent {
  seq: number;
  ts: string;
  type: string;
  actor: string;
  [key: string]: unknown;
}

export type RunStatus = "starting" | "running" | "done" | "done_with_errors" | "stopped" | "failed" | "interrupted";

export interface RunScope { kind: "all" | "node" | "downstream" | "selection"; nodes: string[] }

export interface RunRecord {
  schema: typeof RUN_SCHEMA;
  id: string;
  graph: string;
  status: RunStatus;
  scope: RunScope;
  newTake: boolean;
  concurrency: number;
  actor: string;
  /** The ADE terminal and workspace the run was started from, when the starting process knew them
   *  (HEPHAESTUS_TERMINAL_ID / HEPHAESTUS_WORKSPACE). ADE delivers a person's comments to it. */
  origin?: { terminal?: string; workspace?: string };
  pid?: number;
  host?: string;
  created: string;
  started?: string;
  finished?: string;
  heartbeat?: string;
  graphRevision: number;
  resumeOf?: string;
  planned: { generations: number; slots: number; estimate: boolean };
  progress: { slotsDone: number; slotsCached: number; slotsFailed: number; generations: number; current?: { node: string; slot: number; variant: number } };
  /** "node|slot|variant|fingerprint" keys finished by this run (resume skips them). */
  completed: string[];
  takes: Array<{ node: string; take: string; asset: string }>;
  skipped: Array<{ node: string; reason: string }>;
  errors: Array<{ node: string; message: string; fix?: string }>;
  stopReason?: string;
  stopFix?: string;
  /** Machine-readable stop cause: spend stops ("budget-run" | "budget-day" | "budget-ceiling" |
   *  "budget-user-day" | "budget-user-ceiling") and "subscription-cap" (the image cap was reached). */
  stopCode?: string;
  /** Set with stopCode "subscription-cap": when the cap resets (ISO time, from the provider's
   *  resets_at). Resuming before then fails the same way. */
  resetAt?: string;
  /** Graph-relative path of the labelled review sheet of this run's new images. */
  sheet?: string;
  /** Paid API spend (phase 1d). chain is the first run of a resume chain; a resumed run keeps
   *  counting against the same run limit. Amounts in dollars. */
  budget?: {
    chain: string;
    limits: { run: number; day: number; ceiling: number };
    /** Estimated cost of the API work planned at start (before any spend). */
    estimate: number;
    /** Actual dollars this run spent (settled requests), and the chain's total. */
    spent: number;
    chainSpent?: number;
    /** When a limit stopped the run: the estimated dollars the remaining work still needs. */
    needed?: number;
  };
}

/**
 * Reserved folders next to graph folders. Graph slugs cannot start with "_", so these never collide.
 *   _canon/<name>/canon.json   named character, place, product or look shared across graphs
 *   _lessons/lessons.jsonl     project lessons (append-only; superseded, never edited away)
 * Per graph, feedback.jsonl is the append-only log of human and agent verdicts, picks and notes.
 */
export const CANON_DIR = "_canon";
export const LESSONS_DIR = "_lessons";
/** _budget/ledger.jsonl: the project's paid-API spend ledger and grants (append-only). */
export const BUDGET_DIR = "_budget";
export const BUDGET_SCHEMA = "gpt-image-studio/budget@1";

export interface Issue { path?: string; message: string; fix?: string }
