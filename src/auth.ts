// Reads, validates, and refreshes the ChatGPT-subscription OAuth credentials that
// Codex CLI writes to ~/.codex/auth.json. We deliberately reuse Codex's own token file
// (last-writer-wins) so we never run a second OAuth flow and Codex keeps the tokens fresh.

import { readFile, writeFile, rename, chmod, unlink, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { sleep } from "./retry.js";

const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // Codex CLI's published public client id
const REFRESH_SCOPE = "openid profile email";
const VERSION_FLOOR = "0.143.0"; // never claim an older Codex version (gpt-5.6 tiers gate on newer builds)

export function codexHome(): string {
  const env = process.env.CODEX_HOME?.trim();
  return env ? env : join(homedir(), ".codex");
}

function authPath(): string {
  // Dedicated override lets the image tool ride a different account than the user's main
  // `codex` login (~/.codex). Falls back to CODEX_HOME, then ~/.codex.
  const override = process.env.GPT_IMAGE_AUTH_FILE?.trim();
  if (override) return override;
  return join(codexHome(), "auth.json");
}

/** A clear, actionable message for when the image account's Codex session is dead/invalid. */
export function reloginHint(reason: string): string {
  const dir = dirname(authPath());
  return (
    `${reason}. The image account's Codex session is invalid — re-authenticate it:\n` +
    `  PowerShell:  $env:CODEX_HOME="${dir}"; codex login\n` +
    `then sign in as the account you want images billed to. If it keeps getting invalidated, ` +
    `that account is being signed into Codex somewhere else (another device or your main \`codex\`) — ` +
    `dedicate an account to images that you don't log into Codex elsewhere.`
  );
}

interface AuthFile {
  OPENAI_API_KEY?: string | null;
  auth_mode?: string | null;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
    id_token?: string;
  };
  last_refresh?: string;
  [k: string]: unknown;
}

export interface SubscriptionCreds {
  accessToken: string;
  accountId: string | null;
  refreshToken: string | null;
}

async function readAuth(): Promise<AuthFile> {
  let raw: string;
  try {
    raw = await readFile(authPath(), "utf8");
  } catch {
    throw new Error(
      `No Codex credentials found at ${authPath()}. Sign in first with \`codex login\` (Sign in with ChatGPT). ` +
        `An OPENAI_API_KEY is NOT a substitute for the subscription path — use --backend apikey for that.`,
    );
  }
  try {
    return JSON.parse(raw) as AuthFile;
  } catch {
    throw new Error(`Codex auth file at ${authPath()} is not valid JSON.`);
  }
}

/** Load current creds without refreshing. */
export async function loadCreds(): Promise<SubscriptionCreds> {
  const auth = await readAuth();
  const t = auth.tokens;
  const accessToken = typeof t?.access_token === "string" ? t.access_token : null;
  if (!accessToken) {
    throw new Error(`Codex auth at ${authPath()} has no access_token. Run \`codex login\` again.`);
  }
  return {
    accessToken,
    accountId: typeof t?.account_id === "string" ? t.account_id : null,
    refreshToken: typeof t?.refresh_token === "string" ? t.refresh_token : null,
  };
}

/** Decode a JWT's `exp` (ms since epoch), or null if it can't be read. No signature check. */
export function jwtExpiryMs(jwt: string): number | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (typeof payload?.exp === "number") return payload.exp * 1000;
  } catch {
    /* ignore */
  }
  return null;
}

/** True if the token is expired or within `skewMs` of expiry. Unknown exp => false (defer to a reactive 401 refresh). */
export function isExpired(jwt: string, skewMs = 60_000): boolean {
  const exp = jwtExpiryMs(jwt);
  if (exp == null) return false;
  return Date.now() + skewMs >= exp;
}

function userAgent(version: string): string {
  return `codex_cli_rs/${version} (Windows NT 10.0; x64) gpt-image-tool`;
}

/** Build the `version` header value: max(version.json latest_version, floor). Tries the auth
 *  file's own directory first, then the real ~/.codex, then the floor. (Version is account-
 *  independent, so reading the main Codex install's version.json is fine.) */
export async function codexVersionHeader(): Promise<string> {
  let latest = VERSION_FLOOR;
  const candidates = [
    join(dirname(authPath()), "version.json"),
    join(homedir(), ".codex", "version.json"),
  ];
  for (const file of candidates) {
    try {
      const j = JSON.parse(await readFile(file, "utf8"));
      if (typeof j?.latest_version === "string") {
        latest = maxVersion(j.latest_version, VERSION_FLOOR);
        break;
      }
    } catch {
      /* try next candidate */
    }
  }
  return latest;
}

export { userAgent };

function maxVersion(a: string, b: string): string {
  return cmpVersion(a, b) >= 0 ? a : b;
}

export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function atomicWriteAuth(auth: AuthFile): Promise<void> {
  const tmp = join(dirname(authPath()), `auth.json.tmp-${randomBytes(6).toString("hex")}`);
  const data = JSON.stringify(auth, null, 2);
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    try {
      await chmod(tmp, 0o600);
    } catch {
      /* Windows: file mode is a no-op */
    }
    await rename(tmp, authPath());
  } catch (e) {
    try {
      await unlink(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/**
 * Exchange the refresh_token for a fresh access_token, write the rotated tokens back into
 * auth.json atomically, and return the merged creds. Throws a clear error on invalid_grant.
 */
export async function refreshCreds(refreshToken: string): Promise<SubscriptionCreds> {
  const version = await codexVersionHeader();
  const body = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: REFRESH_SCOPE,
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent(version),
    },
    body,
  });
  if (!res.ok) {
    let code = `HTTP ${res.status}`;
    let detail = "";
    try {
      const j: any = await res.json();
      if (typeof j?.error === "string") code = j.error;
      else if (j?.error && typeof j.error === "object") {
        code = j.error.code || j.error.type || code;
        if (typeof j.error.message === "string") detail = j.error.message;
      }
    } catch {
      /* ignore body */
    }
    if (code === "invalid_grant" || /invalidat/i.test(`${code} ${detail}`)) {
      throw new Error(reloginHint(`Token refresh rejected (${code}${detail ? `: ${detail}` : ""})`));
    }
    throw new Error(`Token refresh failed (${code}${detail ? `: ${detail}` : ""}).`);
  }
  const refreshed: any = await res.json();

  const auth = await readAuth();
  const tokens = (auth.tokens ??= {});
  if (typeof refreshed.access_token === "string") tokens.access_token = refreshed.access_token;
  if (typeof refreshed.refresh_token === "string") tokens.refresh_token = refreshed.refresh_token;
  if (typeof refreshed.id_token === "string") tokens.id_token = refreshed.id_token;
  auth.last_refresh = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  try {
    await atomicWriteAuth(auth);
  } catch {
    /* persistence failure is non-fatal: we still hold valid in-memory tokens for this call */
  }

  if (typeof tokens.access_token !== "string") {
    throw new Error("Token refresh returned no access_token.");
  }
  return {
    accessToken: tokens.access_token,
    accountId: typeof tokens.account_id === "string" ? tokens.account_id : null,
    refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : refreshToken,
  };
}

/** Decode the signed-in account's email from the auth file's id_token, if present. */
export async function accountEmail(): Promise<string | null> {
  try {
    const auth = await readAuth();
    const idt = auth.tokens?.id_token;
    if (typeof idt !== "string") return null;
    const parts = idt.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    const email = payload?.email ?? payload?.["https://api.openai.com/profile"]?.email;
    return typeof email === "string" ? email : null;
  } catch {
    return null;
  }
}

export interface SessionStatus {
  ok: boolean;
  authFile: string;
  email: string | null;
  accessExpiry: string | null;
  /** Present when ok === false: the actionable reason the session can't be used. */
  reason?: string;
}

/**
 * Validate the subscription session WITHOUT spending image quota. Forces an OAuth token
 * refresh (the same call every real generation may make) so it catches a server-invalidated
 * session even when the cached access token hasn't expired by its own clock — exactly the
 * "Your session has ended" failure. Never throws; folds errors into `{ ok:false, reason }`.
 */
export async function checkSession(): Promise<SessionStatus> {
  const authFile = authPath();
  const email = await accountEmail();
  let creds: SubscriptionCreds;
  try {
    creds = await loadCreds();
  } catch (e) {
    return { ok: false, authFile, email, accessExpiry: null, reason: e instanceof Error ? e.message : String(e) };
  }
  const exp = jwtExpiryMs(creds.accessToken);
  const accessExpiry = exp != null ? new Date(exp).toISOString() : null;
  if (!creds.refreshToken) {
    return { ok: false, authFile, email, accessExpiry, reason: "No refresh_token in the auth file — run `codex login`." };
  }
  try {
    await refreshCreds(creds.refreshToken);
    return { ok: true, authFile, email, accessExpiry };
  } catch (e) {
    return { ok: false, authFile, email, accessExpiry, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Cross-process single-flight lock around token refresh. The OAuth refresh token ROTATES on every
 * use, and OpenAI invalidates the whole session if a rotated token is reused — so two processes
 * refreshing at once (e.g. parallel image jobs) would kill the session. This serializes refresh:
 * only one process refreshes; the others wait and pick up the freshly-written token. Best-effort —
 * if the lock can't be taken within the budget, we proceed (a stale lock never blocks forever).
 */
export async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = join(dirname(authPath()), ".gpt-image-refresh.lock");
  const deadlineMs = Date.now() + 30_000;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx"); // O_CREAT|O_EXCL: fails if another holder exists
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      // Steal a stale lock (holder crashed) or give up waiting and proceed un-locked.
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > 60_000) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock vanished between catch and stat — retry the create
      }
      if (Date.now() > deadlineMs) return fn();
      await sleep(200);
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => {});
  }
}

/**
 * Refresh after a 401, single-flight. Under the lock we re-read the token file first: if a peer
 * already refreshed (the stored access token changed), we use theirs instead of refreshing again —
 * which is what prevents the rotated-token reuse that kills the session.
 */
export async function refreshAfter401(staleAccessToken: string): Promise<SubscriptionCreds> {
  return withRefreshLock(async () => {
    const fresh = await loadCreds();
    if (fresh.accessToken !== staleAccessToken) return fresh; // a peer already refreshed
    if (!fresh.refreshToken) throw new Error(reloginHint("subscription auth rejected and no refresh token"));
    return refreshCreds(fresh.refreshToken);
  });
}

/** Load creds, proactively refreshing (single-flight) if the access token is expired/near-expiry. */
export async function getValidCreds(): Promise<SubscriptionCreds> {
  const creds = await loadCreds();
  if (isExpired(creds.accessToken) && creds.refreshToken) {
    try {
      return await withRefreshLock(async () => {
        const fresh = await loadCreds();
        if (!isExpired(fresh.accessToken)) return fresh; // a peer refreshed while we waited
        return refreshCreds(fresh.refreshToken ?? creds.refreshToken!);
      });
    } catch (e) {
      // If the refresh token itself is dead, surface it. Otherwise fall back to the (possibly
      // stale) token and let the request's reactive 401 handler try once more.
      if (e instanceof Error && /codex login/.test(e.message)) throw e;
    }
  }
  return creds;
}
