import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppServer } from "./server.ts";
import { resetLlmCache } from "./llm.ts";

const MOCK_LLM = join(dirname(fileURLToPath(import.meta.url)), "mock-llm.mjs");
const ENV_KEYS = [
  "STYLE_GUIDE_HOME", "STYLE_GUIDE_LLM_CMD", "STYLE_GUIDE_LLM_MODEL", "MOCK_LLM_MODE",
  "JEV_ENDPOINT", "TYPESAFE_API_KEY", "TYPESAFE_CREDENTIALS_FILE",
];

// モック Jev。mode "ok" は質問に合わせた答え、"401" は 401
let jevMode: "ok" | "401" = "ok";
let jevCalls: { auth: string; body: any }[] = [];
const jevServer = http.createServer((req, res) => {
  let s = "";
  req.setEncoding("utf8");
  req.on("data", (d) => (s += d));
  req.on("end", () => {
    const body = JSON.parse(s);
    jevCalls.push({ auth: String(req.headers.authorization), body });
    if (jevMode === "401") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const answers: Record<string, unknown> = {};
    for (const [k, q] of Object.entries<any>(body.questions)) {
      if (q.type === "choice") {
        const c = k === "font_mood" ? "humanist" : Object.keys(q.criteria)[0];
        answers[k] = { type: "choice", choice: c, confidence: 0.9, probabilities: { [c]: 0.9 } };
      } else if (q.type === "noul") {
        answers[k] = { type: "noul", noul: 0.7 };
      } else {
        answers[k] = { type: "score", score: 2, confidence: 0.8, probabilities: { "2": 0.8 } };
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});

const app = createAppServer();
let base = "";
let port = 0;
let saved: Record<string, string | undefined> = {};
let home = "";

before(async () => {
  await new Promise<void>((r) => jevServer.listen(0, "127.0.0.1", () => r()));
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  port = (app.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  await new Promise((r) => app.close(r));
  await new Promise((r) => jevServer.close(r));
});

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), "sg-server-test-"));
  process.env.STYLE_GUIDE_HOME = home;
  process.env.STYLE_GUIDE_LLM_CMD = JSON.stringify([process.execPath, MOCK_LLM]);
  delete process.env.STYLE_GUIDE_LLM_MODEL;
  process.env.MOCK_LLM_MODE = "brief";
  process.env.JEV_ENDPOINT = `http://127.0.0.1:${(jevServer.address() as AddressInfo).port}/v1/systemone`;
  process.env.TYPESAFE_API_KEY = "dummy";
  process.env.TYPESAFE_CREDENTIALS_FILE = join(home, "nonexistent", "credentials.json");
  jevMode = "ok";
  jevCalls = [];
  resetLlmCache();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
  resetLlmCache();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: raw });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: r.status, json, text };
}

// 本文を送り切る前にサーバーが応答して接続を閉じることがあるので、応答の状態コードだけを取る
function rawPostStatus(path: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });
}

const request = { prompt: "落ち着いた請求書アプリ" };
const brief = {
  id: "calm-blue", name: "テスト", tone: "落ち着いた雰囲気。", needsJapanese: true,
  state: { product: "Invoicing app", audience: "Small businesses", mood: ["calm", "trustworthy"], references: "", avoid: "" },
  explicit: { brandColor: null, baseMode: null },
};

test("1. GET / が 200 で HTML", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(String(r.headers.get("content-type")), /^text\/html; charset=utf-8/);
  assert.match(await r.text(), /<html/i);
});

test("2. GET /api/meta に catalog と jev:true、キーを含まない", async () => {
  const r = await fetch(base + "/api/meta");
  assert.equal(r.status, 200);
  const text = await r.text();
  const j = JSON.parse(text);
  assert.ok(Array.isArray(j.catalog) && j.catalog.length >= 40);
  assert.equal(j.jev, true);
  assert.equal(j.llm, true);
  assert.equal(Object.keys(j.questions).length, 12);
  assert.equal(j.storeHome, home);
  assert.ok(!text.includes("dummy"));
});

test("3. POST /api/brief が brief を返し、LLM が無ければ 503", async () => {
  const r = await post("/api/brief", { request });
  assert.equal(r.status, 200);
  assert.equal(r.json.brief.id, "calm-blue");
  process.env.STYLE_GUIDE_LLM_CMD = JSON.stringify(["definitely-not-a-command-xyz"]);
  resetLlmCache();
  const r2 = await post("/api/brief", { request });
  assert.equal(r2.status, 503);
  assert.equal(r2.json.error, "llm-unavailable");
});

test("4. POST /api/estimate (Jev) が font_pair 付きで jev", async () => {
  const r = await post("/api/estimate", { request, brief });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.estimateSource, "jev");
  assert.equal(r.json.fallbackReason, null);
  assert.deepStrictEqual(r.json.skip, []);
  assert.equal(Object.keys(r.json.estimate).length, 13);
  assert.ok(r.json.estimate.font_pair);
  assert.equal(jevCalls.length, 2);
  assert.equal(jevCalls[0].auth, "Bearer dummy");
  assert.deepStrictEqual(jevCalls[0].body.state, brief.state);
  assert.deepStrictEqual(Object.keys(jevCalls[1].body.questions), ["font_pair"]);
  assert.ok(!r.text.includes("dummy"));
});

test("5. Jev が 401 なら LLM にフォールバック", async () => {
  jevMode = "401";
  process.env.MOCK_LLM_MODE = "estimate";
  const r = await post("/api/estimate", { request, brief });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.estimateSource, "llm-fallback");
  assert.match(r.json.fallbackReason, /^jev-failed/);
  assert.equal(r.json.fallbackReason, "jev-failed: http 401");
  assert.ok(r.json.estimate.brand_hue);
  assert.ok(r.json.estimate.font_pair);
});

test("5b. キーが無く LLM も無ければ 503 estimator-unavailable、キー無しで LLM なら no-key", async () => {
  delete process.env.TYPESAFE_API_KEY;
  process.env.MOCK_LLM_MODE = "estimate";
  const r = await post("/api/estimate", { request, brief });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.fallbackReason, "no-key");
  assert.equal(jevCalls.length, 0);
  process.env.STYLE_GUIDE_LLM_CMD = JSON.stringify(["definitely-not-a-command-xyz"]);
  resetLlmCache();
  const r2 = await post("/api/estimate", { request, brief });
  assert.equal(r2.status, 503);
  assert.equal(r2.json.error, "estimator-unavailable");
  assert.equal(Object.keys(r2.json.questions).length, 12);
});

async function jevEstimate() {
  const r = await post("/api/estimate", { request, brief });
  assert.equal(r.status, 200, r.text);
  return r.json;
}

test("6. POST /api/render が previewCss と overrides を反映", async () => {
  const est = await jevEstimate();
  const body = { request, brief, estimate: est.estimate, estimateSource: est.estimateSource };
  const r = await post("/api/render", body);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.previewCss.includes(`[data-theme="calm-blue"]`));
  for (const k of ["seedResult", "theme", "previewCss", "fontsUrl", "candidates", "styleGuideMd"]) assert.ok(k in r.json, k);
  const r2 = await post("/api/render", { ...body, overrides: { radius: 4 } });
  assert.equal(r2.status, 200, r2.text);
  assert.equal(r2.json.seedResult.seed.shape.radiusPx, 20);
});

test("7. POST /api/save が 201、一覧と詳細に出る", async () => {
  const est = await jevEstimate();
  const r = await post("/api/save", { request, brief, estimate: est.estimate, estimateSource: "jev" });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.dir, join(home, "themes", "calm-blue"));
  const list = await (await fetch(base + "/api/themes")).json();
  assert.ok(list.some((t: any) => t.id === "calm-blue"));
  const one = await fetch(base + "/api/themes/calm-blue");
  assert.equal(one.status, 200);
  assert.equal((await one.json()).brief.id, "calm-blue");
  const none = await fetch(base + "/api/themes/nope");
  assert.equal(none.status, 404);
});

test("8. Origin / Content-Type / 壊れた JSON / 不正な brief / 大きすぎる本文", async () => {
  const evil = await post("/api/brief", { request }, { Origin: "http://evil.example" });
  assert.equal(evil.status, 403);
  const plain = await post("/api/brief", { request }, { "Content-Type": "text/plain" });
  assert.equal(plain.status, 415);
  const broken = await post("/api/brief", "{not json");
  assert.equal(broken.status, 400);
  const bad = await post("/api/estimate", { request, brief: { ...brief, id: "Bad Id" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, "input");
  const okOrigin = await post("/api/brief", { request }, { Origin: `http://localhost:${port}` });
  assert.equal(okOrigin.status, 200);
  assert.equal(await rawPostStatus("/api/brief", JSON.stringify({ request: { prompt: "x".repeat(1024 * 1024 + 10) } })), 413);
});
