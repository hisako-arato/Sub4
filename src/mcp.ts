// COROS MCP を LLM なしで直接呼ぶための最小 MCP クライアント（Streamable HTTP / JSON-RPC 2.0）。
import type { Env } from "./env.ts";
import { getAccessToken } from "./oauth.ts";

export class AuthRequiredError extends Error {}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [k: string]: unknown };
}

const PROTOCOL_VERSION = "2025-06-18";

export class McpClient {
  private url: string;
  private sessionId: string | null = null;
  private negotiatedVersion: string | null = null;
  private nextId = 1;

  private constructor(url: string, private token: string) {
    this.url = url;
  }

  static async connect(env: Env): Promise<McpClient> {
    const token = await getAccessToken(env);
    if (!token) throw new AuthRequiredError("COROSと未接続です");
    const c = new McpClient(env.COROS_MCP_URL, token);
    const init = await c.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "sub4-coach", version: "0.1.0" },
    });
    c.negotiatedVersion = init?.protocolVersion ?? PROTOCOL_VERSION;
    await c.notify("notifications/initialized");
    return c;
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.request("tools/list", cursor ? { cursor } : {});
      tools.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
    } while (cursor);
    return tools;
  }

  /** ツールを呼び、content 中のテキストを JSON として解釈できればパースして返す */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: unknown; raw: unknown }> {
    const r = await this.request("tools/call", { name, arguments: args });
    const content: any[] = r?.content ?? [];
    let data: unknown = r?.structuredContent;
    if (data === undefined) {
      const texts = content.filter((c) => c.type === "text").map((c) => c.text as string);
      const parsed = texts.map((t) => {
        try {
          return JSON.parse(t);
        } catch {
          return t;
        }
      });
      data = parsed.length === 1 ? parsed[0] : parsed;
    }
    return { isError: !!r?.isError, data, raw: r };
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.token}`,
    };
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    if (this.negotiatedVersion) h["MCP-Protocol-Version"] = this.negotiatedVersion;
    return h;
  }

  /** POST する。地域別サーバーへのリダイレクトは POST のまま追従する */
  private async post(body: unknown): Promise<Response> {
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify(body), redirect: "manual" });
      const loc = res.headers.get("Location");
      if (res.status >= 300 && res.status < 400 && loc) {
        this.url = new URL(loc, this.url).toString();
        continue;
      }
      if (res.status === 401) throw new AuthRequiredError("COROSの認証が切れています。再接続してください。");
      const sid = res.headers.get("Mcp-Session-Id");
      if (sid) this.sessionId = sid;
      return res;
    }
    throw new Error("リダイレクトが多すぎます");
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  async request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const ct = res.headers.get("Content-Type") ?? "";
    const msg = ct.includes("text/event-stream") ? findInSse(await res.text(), id) : await res.json<any>();
    if (!msg) throw new Error(`${method}: 応答が見つかりません`);
    if (msg.error) throw new Error(`${method}: ${msg.error.code} ${msg.error.message}`);
    return msg.result;
  }
}

/** SSE 本文から指定 id の JSON-RPC 応答を探す */
export function findInSse(text: string, id: number): any | null {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      const msg = JSON.parse(data);
      const msgs = Array.isArray(msg) ? msg : [msg];
      const hit = msgs.find((m) => m.id === id);
      if (hit) return hit;
    } catch {
      /* 途中のイベントは無視 */
    }
  }
  return null;
}
