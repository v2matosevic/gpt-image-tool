// Where the paid API key comes from, and the scrubber that keeps it out of everything we write.
// Order: OPENAI_API_KEY in the environment, then a git-ignored `.secrets` file in the project
// folder, then a user-level file (~/.gptimage/secrets). Callers learn which source was used,
// never the value. Nothing here logs.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const KEY_NAME = "OPENAI_API_KEY";
export const SECRETS_FILE = ".secrets";
export const userSecretsPath = (env: NodeJS.ProcessEnv = process.env) => join(env.GPT_IMAGE_SECRETS_HOME || homedir(), ".gptimage", "secrets");

export interface KeySource { key: string; source: string }

/** Read NAME from a secrets file. Accepts `NAME=value` and `NAME: value`, optional quotes,
 *  optional `export `, comments with #. Returns undefined when absent or unreadable. */
export function readSecret(file: string, name = KEY_NAME): string | undefined {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return undefined; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|:)\s*(.*)$/.exec(line);
    if (!m || m[1] !== name) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v.trim() || undefined;
  }
  return undefined;
}

/** Project folders to look in: only the explicit project when one is given (a Studio run), else
 *  GPT_IMAGE_PROJECT_DIR, CLAUDE_PROJECT_DIR, then cwd (a direct tool call in a terminal). */
export function projectDirs(project?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (project?.trim()) return [resolve(project.trim())];
  const dirs = [env.GPT_IMAGE_PROJECT_DIR, env.CLAUDE_PROJECT_DIR, process.cwd()].map(d => d?.trim()).filter((d): d is string => Boolean(d)).map(d => resolve(d));
  return [...new Set(dirs)];
}

export function findApiKey(project?: string, env: NodeJS.ProcessEnv = process.env): KeySource | undefined {
  const fromEnv = env[KEY_NAME]?.trim();
  if (fromEnv) return { key: fromEnv, source: `${KEY_NAME} in the environment` };
  for (const dir of projectDirs(project, env)) {
    const file = join(dir, SECRETS_FILE);
    if (!existsSync(file)) continue;
    const key = readSecret(file);
    if (key) return { key, source: `${KEY_NAME} in ${file}` };
  }
  const user = userSecretsPath(env);
  const key = existsSync(user) ? readSecret(user) : undefined;
  return key ? { key, source: `${KEY_NAME} in ${user}` } : undefined;
}

/** The refusal when no key is found: names every place looked and how to fix it. */
export function missingKeyMessage(project?: string, env: NodeJS.ProcessEnv = process.env): string {
  const looked = [`${KEY_NAME} in the environment`, ...projectDirs(project, env).map(d => join(d, SECRETS_FILE)), userSecretsPath(env)];
  return `The paid API needs ${KEY_NAME} and none was found (looked in: ${looked.join("; ")}). ` +
    `Fix: put a line ${KEY_NAME}=sk-... in the project's git-ignored ${SECRETS_FILE} file, or in ${userSecretsPath(env)}, or set ${KEY_NAME} in the environment of the process that runs the tool. ` +
    `No request was sent, and nothing was switched to the subscription.`;
}

/** Remove the key, and anything shaped like an OpenAI key or a masked echo of one, from text
 *  before it can reach an error, a log, a sidecar, a run record or an event. */
export function redact(text: string, key?: string): string {
  let out = text;
  if (key && key.length >= 8) {
    out = out.split(key).join("[redacted key]");
    // Masked echoes such as "sk-proj-abc1****wxyz" carry the key's ends.
    const head = key.slice(0, Math.min(12, Math.floor(key.length / 3)));
    const tail = key.slice(-4);
    if (head.length >= 6) out = out.split(head).join("[redacted]");
    if (tail.length === 4) out = out.replace(new RegExp(`\\*{2,}${tail.replace(/[^A-Za-z0-9]/g, "\\$&")}`, "g"), "***[redacted]");
  }
  return out.replace(/\bsk-[A-Za-z0-9_\-*]{6,}/g, "sk-[redacted]");
}
