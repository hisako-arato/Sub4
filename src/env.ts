export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  COROS_MCP_URL: string;
  APP_PASSWORD: string;
  SESSION_SECRET?: string;
  COROS_CLIENT_ID?: string;
  COROS_CLIENT_SECRET?: string;
}
