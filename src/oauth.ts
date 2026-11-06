// COROS MCP への OAuth 2.0 接続。
// COROS の公式ドキュメントには OAuth の詳細（エンドポイント・クライアント登録方法）が載っていないため、
// MCP 仕様の標準手順で自動発見する：
//   1. 保護リソースメタデータ（RFC 9728）→ 認可サーバーを特定
//   2. 認可サーバーメタデータ（RFC 8414 / OIDC Discovery）
//   3. 動的クライアント登録（RFC 7591）。非対応なら COROS_CLIENT_ID を使う
//   4. 認可コード + PKCE(S256)
import type { Env } from "./env.ts";
import { kvDelete, kvGet, kvSet } from "./store.ts";
import { b64url } from "./session.ts";

export interface AuthServerInfo {
  resource: string;
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  discovered_via: string[]; // どの手順で見つけたか（取得テストで表示する）
}

export interface ClientInfo {
  client_id: string;
  client_secret?: string;
  token_endpoint_auth_method?: string;
  redirect_uri: string;
}

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_at?: number; // UNIX秒
  obtained_at: number;
}

const K_AS = "coros:auth_server";
const K_CLIENT = "coros:client";
const K_TOKENS = "coros:tokens";
const pendingKey = (state: string) => `coros:pending:${state}`;

async function fetchJson(url: string, init?: RequestInit): Promise<any | null> {
  try {
    const res = await fetch(url, { ...init, headers: { Accept: "application/json", ...(init?.headers ?? {}) } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** RFC 8414 / 9728 の「パス挿入」形式の well-known URL 候補を作る */
function wellKnownCandidates(base: string, suffix: string): string[] {
  const u = new URL(base);
  const path = u.pathname.replace(/\/$/, "");
  const list = [];
  if (path) list.push(`${u.origin}/.well-known/${suffix}${path}`);
  list.push(`${u.origin}/.well-known/${suffix}`);
  if (path) list.push(`${u.origin}${path}/.well-known/${suffix}`);
  return list;
}

export async function discover(env: Env): Promise<AuthServerInfo> {
  const mcpUrl = env.COROS_MCP_URL;
  const via: string[] = [];

  // 1) トークンなしで MCP を叩き、WWW-Authenticate の resource_metadata を探す
  let prmUrl: string | null = null;
  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
    });
    const wa = res.headers.get("WWW-Authenticate") ?? "";
    const m = wa.match(/resource_metadata="([^"]+)"/i);
    via.push(`POST ${mcpUrl} → ${res.status}${wa ? ` (WWW-Authenticate: ${wa.slice(0, 200)})` : ""}`);
    if (m) prmUrl = new URL(m[1], mcpUrl).toString();
  } catch (e) {
    via.push(`POST ${mcpUrl} → 失敗: ${String(e)}`);
  }

  // 2) 保護リソースメタデータ
  let prm: any = null;
  for (const url of [...(prmUrl ? [prmUrl] : []), ...wellKnownCandidates(mcpUrl, "oauth-protected-resource")]) {
    prm = await fetchJson(url);
    if (prm?.authorization_servers?.length) {
      via.push(`保護リソースメタデータ: ${url}`);
      break;
    }
    prm = null;
  }
  const asBase: string = prm?.authorization_servers?.[0] ?? new URL(mcpUrl).origin;
  if (!prm) via.push(`保護リソースメタデータなし → 認可サーバーを ${asBase} と仮定`);

  // 3) 認可サーバーメタデータ
  let meta: any = null;
  const candidates = [
    ...wellKnownCandidates(asBase, "oauth-authorization-server"),
    ...wellKnownCandidates(asBase, "openid-configuration"),
  ];
  for (const url of candidates) {
    meta = await fetchJson(url);
    if (meta?.authorization_endpoint && meta?.token_endpoint) {
      via.push(`認可サーバーメタデータ: ${url}`);
      break;
    }
    meta = null;
  }
  if (!meta) {
    // MCP 2025-03-26 仕様のフォールバック（既定パス）
    const origin = new URL(asBase).origin;
    meta = { authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` };
    via.push("認可サーバーメタデータなし → 既定パス(/authorize, /token, /register)を仮定");
  }

  const info: AuthServerInfo = {
    resource: prm?.resource ?? mcpUrl,
    issuer: meta.issuer,
    authorization_endpoint: meta.authorization_endpoint,
    token_endpoint: meta.token_endpoint,
    registration_endpoint: meta.registration_endpoint,
    scopes_supported: prm?.scopes_supported ?? meta.scopes_supported,
    token_endpoint_auth_methods_supported: meta.token_endpoint_auth_methods_supported,
    discovered_via: via,
  };
  await kvSet(env, K_AS, info);
  return info;
}

async function ensureClient(env: Env, as: AuthServerInfo, redirectUri: string): Promise<ClientInfo> {
  if (env.COROS_CLIENT_ID) {
    return {
      client_id: env.COROS_CLIENT_ID,
      client_secret: env.COROS_CLIENT_SECRET,
      token_endpoint_auth_method: env.COROS_CLIENT_SECRET ? "client_secret_post" : "none",
      redirect_uri: redirectUri,
    };
  }
  const saved = await kvGet<ClientInfo>(env, K_CLIENT);
  if (saved && saved.redirect_uri === redirectUri) return saved;

  if (!as.registration_endpoint) {
    throw new Error("COROS が動的クライアント登録に対応していません。COROS_CLIENT_ID を設定してください。");
  }
  const res = await fetch(as.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Sub4 Coach (personal)",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`クライアント登録に失敗: ${res.status} ${text.slice(0, 500)}`);
  const reg = JSON.parse(text);
  const client: ClientInfo = {
    client_id: reg.client_id,
    client_secret: reg.client_secret,
    token_endpoint_auth_method: reg.token_endpoint_auth_method ?? (reg.client_secret ? "client_secret_post" : "none"),
    redirect_uri: redirectUri,
  };
  await kvSet(env, K_CLIENT, client);
  return client;
}

async function sha256b64url(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return b64url(new Uint8Array(d));
}

function randomString(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** /oauth/start：COROS のログイン画面へリダイレクト */
export async function startAuth(req: Request, env: Env): Promise<Response> {
  const redirectUri = `${new URL(req.url).origin}/oauth/callback`;
  const as = await discover(env);
  const client = await ensureClient(env, as, redirectUri);

  const state = randomString(16);
  const verifier = randomString(48);
  await kvSet(env, pendingKey(state), { verifier, redirect_uri: redirectUri }, 600);

  const url = new URL(as.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.client_id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await sha256b64url(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", as.resource);
  if (as.scopes_supported?.length) url.searchParams.set("scope", as.scopes_supported.join(" "));
  return Response.redirect(url.toString(), 302);
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<Tokens> {
  const as = (await kvGet<AuthServerInfo>(env, K_AS)) ?? (await discover(env));
  const client = env.COROS_CLIENT_ID
    ? await ensureClient(env, as, params.redirect_uri ?? "")
    : await kvGet<ClientInfo>(env, K_CLIENT);
  if (!client) throw new Error("クライアント情報がありません。もう一度COROSと接続してください。");

  const body = new URLSearchParams({ ...params, client_id: client.client_id, resource: as.resource });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (client.client_secret) {
    if (client.token_endpoint_auth_method === "client_secret_basic") {
      headers.Authorization = `Basic ${btoa(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`)}`;
    } else {
      body.set("client_secret", client.client_secret);
    }
  }
  const res = await fetch(as.token_endpoint, { method: "POST", headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`トークン取得に失敗: ${res.status} ${text.slice(0, 500)}`);
  const t = JSON.parse(text);
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    token_type: t.token_type,
    scope: t.scope,
    expires_at: t.expires_in ? nowSec + Number(t.expires_in) : undefined,
    obtained_at: nowSec,
  };
}

/** /oauth/callback：認可コードをトークンに交換して保存 */
export async function handleCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const err = url.searchParams.get("error");
  if (err) return Response.redirect(`${url.origin}/?oauth_error=${encodeURIComponent(err)}`, 302);

  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const pending = await kvGet<{ verifier: string; redirect_uri: string }>(env, pendingKey(state));
  if (!pending || !code) return Response.redirect(`${url.origin}/?oauth_error=invalid_state`, 302);
  await kvDelete(env, pendingKey(state));

  try {
    const tokens = await tokenRequest(env, {
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirect_uri,
      code_verifier: pending.verifier,
    });
    await kvSet(env, K_TOKENS, tokens);
  } catch (e) {
    return Response.redirect(`${url.origin}/?oauth_error=${encodeURIComponent(String(e).slice(0, 300))}`, 302);
  }
  return Response.redirect(`${url.origin}/?connected=1`, 302);
}

/** 有効なアクセストークンを返す。期限が近ければ更新する。 */
export async function getAccessToken(env: Env, refreshWithinSeconds = 3 * 86400): Promise<string | null> {
  const tokens = await kvGet<Tokens>(env, K_TOKENS);
  if (!tokens) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (tokens.expires_at && tokens.expires_at - nowSec < refreshWithinSeconds && tokens.refresh_token) {
    return (await refreshTokens(env, tokens)).access_token;
  }
  return tokens.access_token;
}

export async function refreshTokens(env: Env, current?: Tokens): Promise<Tokens> {
  const tokens = current ?? (await kvGet<Tokens>(env, K_TOKENS));
  if (!tokens?.refresh_token) throw new Error("リフレッシュトークンがありません");
  const next = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  // 新しいリフレッシュトークンが返らない場合は従来のものを使い続ける
  if (!next.refresh_token) next.refresh_token = tokens.refresh_token;
  await kvSet(env, K_TOKENS, next);
  return next;
}

export async function connectionStatus(env: Env) {
  const tokens = await kvGet<Tokens>(env, K_TOKENS);
  const as = await kvGet<AuthServerInfo>(env, K_AS);
  return {
    connected: !!tokens,
    access_expires_at: tokens?.expires_at ?? null,
    has_refresh_token: !!tokens?.refresh_token,
    obtained_at: tokens?.obtained_at ?? null,
    auth_server: as ? { ...as } : null,
  };
}

export async function disconnect(env: Env): Promise<void> {
  await kvDelete(env, K_TOKENS);
}
