// 利用者は1人なので、パスワード1つ＋署名付きCookieの簡易セッションで守る。
import type { Env } from "./env.ts";

const COOKIE = "sub4_session";
const MAX_AGE = 60 * 60 * 24 * 90; // 90日

const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64url(new Uint8Array(sig));
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export async function isLoggedIn(req: Request, env: Env): Promise<boolean> {
  const raw = readCookie(req, COOKIE);
  if (!raw || !env.SESSION_SECRET) return false;
  const [exp, sig] = raw.split(".");
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return timingSafeEqual(sig, await hmac(env.SESSION_SECRET, exp));
}

export async function login(req: Request, env: Env): Promise<Response> {
  if (!env.APP_PASSWORD || !env.SESSION_SECRET) {
    return Response.json({ error: "APP_PASSWORD / SESSION_SECRET が未設定です" }, { status: 500 });
  }
  const body = (await req.json().catch(() => ({}))) as { password?: string };
  if (!timingSafeEqual(body.password ?? "", env.APP_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 800)); // 総当たり対策の小さな遅延
    return Response.json({ error: "パスワードが違います" }, { status: 401 });
  }
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE);
  const value = `${exp}.${await hmac(env.SESSION_SECRET, exp)}`;
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": `${COOKIE}=${value}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax` } },
  );
}

export function logout(): Response {
  return Response.json({ ok: true }, { headers: { "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
}
