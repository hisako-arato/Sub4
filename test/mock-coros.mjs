// 本物の COROS に繋げない環境で、OAuth と MCP の流れを確かめるための偽サーバー。
// 実際の COROS の応答形式は取得テストで確認するまで不明なので、ここはあくまで配線の確認用。
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.MOCK_PORT ?? 8788);
const BASE = `http://localhost:${PORT}`;
const codes = new Map(); // code → { challenge, redirect_uri }
const tokens = new Set();
const refreshTokens = new Set();
let clientId = null;
const pushed = [];

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const TOOLS = [
  "queryUserInfo", "queryDevices", "queryFitnessAssessmentOverview", "querySportRecords",
  "getActivityDetail", "queryActivityLapData", "queryDailyHealthData", "querySleepOverview",
  "querySleepHrv", "queryRestingHeartRate", "queryRecoveryStatus", "queryTrainingLoadAssessment",
  "queryTrainingSchedule", "queryTrainingPlanLibrary", "createTrainingPlan", "createScheduledWorkout",
].map((name) => ({ name, description: `mock ${name}`, inputSchema: { type: "object" } }));

function toolResult(name, args) {
  if (name === "querySportRecords") {
    // 本物の COROS と同じ文章形式（2026/11 の取得テストで確認）
    return [
      "Sport Records — 2026-11-01 to 2026-11-05 (1 records)",
      "========================",
      "",
      "1. Outdoor Run — 2026-11-03",
      "   Duration: 4:24:44 | Distance: 42.20 km",
      "   Average Pace: 6:16 /km | Avg HR: 152 bpm | Calories: 3118 kcal",
      "   LabelId: 481490330831585282 | SportType: 100",
    ].join("\n");
  }
  if (name === "queryFitnessAssessmentOverview") {
    return "Fitness Assessment Overview\n========================\n\nVO2max: 54\nThreshold Pace: 4:50 /km\n10 km Prediction: 48:00\nMarathon Prediction: 3:52:00";
  }
  if (name === "queryTrainingLoadAssessment") {
    return "Training Load Assessment\n========================\n\n2026-11-06\nComment: Optimized\nShort-Term Load: 79\nLong-Term Load: 58\nLoad Ratio: 1.36";
  }
  if (name === "queryRecoveryStatus") throw new Error("not supported on this device");
  if (name === "createScheduledWorkout" || name === "updateScheduledWorkout") {
    const c = args.course;
    if (!/^\d{8}$/.test(args.date) || c?.sportType !== 1 || !c.courseName || !c.courseDescription || !c.sections?.length) {
      throw new Error("invalid course");
    }
    if (name === "updateScheduledWorkout" && args.idInPlan !== "777") throw new Error("unknown idInPlan");
    pushed.push({ name, date: args.date, title: c.courseName });
    return `Workout ${name === "createScheduledWorkout" ? "created" : "updated"} on ${args.date}\nidInPlan: 777\nName: ${c.courseName}`;
  }
  return { ok: true, tool: name, args };
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const body = await readBody(req);
  const send = (status, obj, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(obj === undefined ? "" : JSON.stringify(obj));
  };

  if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    return send(200, { resource: `${BASE}/mcp`, authorization_servers: [BASE], scopes_supported: ["read", "write"] });
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return send(200, {
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (url.pathname === "/register" && req.method === "POST") {
    const reg = JSON.parse(body);
    clientId = `client-${crypto.randomUUID()}`;
    return send(201, { client_id: clientId, redirect_uris: reg.redirect_uris, token_endpoint_auth_method: "none" });
  }
  if (url.pathname === "/authorize") {
    const p = url.searchParams;
    if (p.get("client_id") !== clientId || p.get("code_challenge_method") !== "S256" || !p.get("resource")) {
      return send(400, { error: "invalid_request" });
    }
    const code = crypto.randomUUID();
    codes.set(code, { challenge: p.get("code_challenge"), redirect_uri: p.get("redirect_uri") });
    const back = new URL(p.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", p.get("state"));
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  if (url.pathname === "/token" && req.method === "POST") {
    const p = new URLSearchParams(body);
    if (p.get("grant_type") === "authorization_code") {
      const c = codes.get(p.get("code"));
      codes.delete(p.get("code"));
      const challenge = b64url(crypto.createHash("sha256").update(p.get("code_verifier") ?? "").digest());
      if (!c || c.challenge !== challenge || c.redirect_uri !== p.get("redirect_uri")) return send(400, { error: "invalid_grant" });
    } else if (p.get("grant_type") === "refresh_token") {
      if (!refreshTokens.delete(p.get("refresh_token"))) return send(400, { error: "invalid_grant" });
    } else return send(400, { error: "unsupported_grant_type" });
    const at = `at-${crypto.randomUUID()}`;
    const rt = `rt-${crypto.randomUUID()}`;
    tokens.add(at);
    refreshTokens.add(rt);
    return send(200, { access_token: at, refresh_token: rt, token_type: "Bearer", expires_in: 3600 });
  }

  // MCP 本体。/mcp は地域サーバー /us/mcp へ 307 リダイレクトする（本物の地域振り分けを模擬）
  if (url.pathname === "/mcp" || url.pathname === "/us/mcp") {
    const auth = req.headers.authorization ?? "";
    if (!tokens.has(auth.replace(/^Bearer /, ""))) {
      return send(401, { error: "unauthorized" }, {
        "WWW-Authenticate": `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
      });
    }
    if (url.pathname === "/mcp") {
      res.writeHead(307, { Location: `${BASE}/us/mcp` });
      return res.end();
    }
    const msg = JSON.parse(body);
    if (msg.id === undefined) return send(202);
    let result;
    let error;
    if (msg.method === "initialize") {
      result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock-coros", version: "0" } };
    } else if (msg.method === "tools/list") {
      result = { tools: TOOLS };
    } else if (msg.method === "tools/call") {
      try {
        const out = toolResult(msg.params.name, msg.params.arguments);
        result = { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }] };
      } catch (e) {
        result = { content: [{ type: "text", text: String(e.message) }], isError: true };
      }
    } else error = { code: -32601, message: "Method not found" };
    // SSE で返す（JSON 直返しとの両対応を確認するため）
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`);
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...(error ? { error } : { result }) })}\n\n`);
    return;
  }
  send(404, { error: "not_found" });
});

server.listen(PORT, () => console.log(`mock COROS listening on ${BASE}`));
