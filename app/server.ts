// テーマ生成ツールの Web アプリ用ローカルサーバー。127.0.0.1 だけで待ち受け、Jev のキーと LLM はサーバー側だけで使う
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Brief, Estimate, FontPair, Question, ThemeRequest } from "../core/types.ts";
import { ESTIMATE_QUESTIONS, HUES, JEV_MODEL, estimateQuestions } from "../core/questions.ts";
import { InputError, resolveExplicit, validateBrief, validateRequest } from "../core/explicit.ts";
import { familyNames, fontQuestion, loadCatalog, selectCandidates } from "../core/fonts.ts";
import { buildBundle, listThemes, readTheme, storeHome, writeBundle } from "../core/bundle.ts";
import type { Bundle } from "../core/bundle.ts";
import { loadJev as loadJevShared } from "../lib/load-jev.ts";
import { LlmError, estimateWithLlm, generateBrief, llmAvailable } from "./llm.ts";

const MAX_BODY = 1024 * 1024;
const INDEX_PATH = fileURLToPath(new URL("./index.html", import.meta.url));

// 共通 Jev クライアント (SHARED/jev.mjs) を動的 import する
type JevModule = {
  DEFAULT_ENDPOINT: string;
  JevError: new (...args: any[]) => Error & { code: string; status: number };
  getApiKey: (env?: NodeJS.ProcessEnv) => string | null;
  callJev: (args: { state: unknown; questions: Record<string, Question>; model: string; endpoint?: string }) => Promise<{ answers: Estimate }>;
};
async function loadJev(): Promise<JevModule> {
  return (await loadJevShared()) as JevModule;
}

let catalogCache: FontPair[] | null = null;
function catalog(): FontPair[] {
  if (!catalogCache) catalogCache = loadCatalog();
  return catalogCache;
}

class HttpError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error));
    this.status = status;
    this.body = body;
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const onData = (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > MAX_BODY) {
        done = true;
        req.removeListener("data", onData);
        req.pause();
        reject(new HttpError(413, { error: "too-large" }));
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

function checkPost(req: http.IncomingMessage): void {
  const port = req.socket.localPort;
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(String(req.headers.host ?? ""))) throw new HttpError(403, { error: "forbidden" });
  const origin = req.headers.origin;
  if (origin !== undefined && !hosts.map((h) => `http://${h}`).includes(String(origin))) {
    throw new HttpError(403, { error: "forbidden" });
  }
  const ct = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!ct.startsWith("application/json")) throw new HttpError(415, { error: "unsupported-media-type" });
  const len = Number(req.headers["content-length"]);
  if (Number.isFinite(len) && len > MAX_BODY) throw new HttpError(413, { error: "too-large" });
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readBody(req);
  let x: unknown;
  try {
    x = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new HttpError(400, { error: "bad-json" });
  }
  if (typeof x !== "object" || x === null || Array.isArray(x)) throw new HttpError(400, { error: "bad-json" });
  return x as Record<string, unknown>;
}

function jevEndpoint(jev: JevModule): string {
  return process.env.JEV_ENDPOINT || jev.DEFAULT_ENDPOINT;
}

// 推定に font_pair を足すための候補。skip に font_pair があるか、必要な答えが無ければ空
function fontCandidates(brief: Brief, est: Estimate, skip: string[], fixed: { heading?: string; body?: string; mono?: string }): FontPair[] {
  if (skip.includes("font_pair")) return [];
  const mood = est.font_mood;
  const formality = est.formality;
  if (!mood || mood.type !== "choice" || !formality || formality.type !== "score") return [];
  return selectCandidates({ catalog: catalog(), fontMood: mood, needsJapanese: brief.needsJapanese, fixed, formality: formality.score });
}

async function handleEstimate(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const request: ThemeRequest = validateRequest(body.request);
  const brief = validateBrief(body.brief);
  const resolved = resolveExplicit(request, brief);
  const skip = resolved.skip;
  const questions = estimateQuestions(skip);

  const jev = await loadJev();
  let fallbackReason: string;
  if (jev.getApiKey() !== null) {
    const endpoint = jevEndpoint(jev);
    try {
      const r1 = await jev.callJev({ state: brief.state, questions, model: JEV_MODEL, endpoint });
      const estimate: Estimate = { ...r1.answers };
      const candidates = fontCandidates(brief, estimate, skip, resolved.fixed.fonts);
      if (candidates.length >= 2) {
        const r2 = await jev.callJev({ state: brief.state, questions: fontQuestion(candidates), model: JEV_MODEL, endpoint });
        if (r2.answers.font_pair) estimate.font_pair = r2.answers.font_pair;
      }
      return { estimate, estimateSource: "jev", skip, fallbackReason: null };
    } catch (e) {
      if (!(e instanceof jev.JevError)) throw e;
      fallbackReason = `jev-failed: ${e.code} ${e.status}`;
    }
  } else {
    fallbackReason = "no-key";
  }

  if (!llmAvailable()) throw new HttpError(503, { error: "estimator-unavailable", questions });
  try {
    const estimate = await estimateWithLlm(brief, questions);
    const candidates = fontCandidates(brief, estimate, skip, resolved.fixed.fonts);
    if (candidates.length >= 2) {
      const fp = await estimateWithLlm(brief, fontQuestion(candidates));
      if (fp.font_pair) estimate.font_pair = fp.font_pair;
    }
    return { estimate, estimateSource: "llm-fallback", skip, fallbackReason };
  } catch (e) {
    if (e instanceof LlmError) throw new HttpError(502, { error: "llm-failed", message: e.message });
    throw e;
  }
}

function bundleFrom(body: Record<string, unknown>): Bundle {
  const src = body.estimateSource;
  if (src !== "jev" && src !== "llm-fallback") throw new InputError("estimateSource は jev か llm-fallback で指定してください");
  const ov = body.overrides;
  if (ov !== undefined && ov !== null && (typeof ov !== "object" || Array.isArray(ov))) {
    throw new InputError("overrides はオブジェクトで指定してください");
  }
  return buildBundle({
    request: body.request,
    brief: body.brief,
    estimate: body.estimate,
    estimateSource: src,
    catalog: catalog(),
    overrides: (ov ?? undefined) as Record<string, string | number> | undefined,
  });
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

  if (method === "GET") {
    if (path === "/" || path === "/index.html") {
      let html: Buffer;
      try {
        html = readFileSync(INDEX_PATH);
      } catch {
        sendJson(res, 404, { error: "not-found" });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": html.length, "Cache-Control": "no-store" });
      res.end(html);
      return;
    }
    if (path === "/api/meta") {
      const jev = await loadJev();
      const cat = catalog();
      sendJson(res, 200, {
        llm: llmAvailable(),
        jev: jev.getApiKey() !== null,
        hues: HUES,
        questions: ESTIMATE_QUESTIONS,
        catalog: cat,
        families: familyNames(cat),
        storeHome: storeHome(),
      });
      return;
    }
    if (path === "/api/themes") {
      sendJson(res, 200, listThemes());
      return;
    }
    if (path.startsWith("/api/themes/")) {
      let id: string;
      try {
        id = decodeURIComponent(path.slice("/api/themes/".length));
      } catch {
        id = "";
      }
      const t = readTheme(id);
      if (!t) sendJson(res, 404, { error: "not-found" });
      else sendJson(res, 200, t);
      return;
    }
    sendJson(res, 404, { error: "not-found" });
    return;
  }

  if (method === "POST" && ["/api/brief", "/api/estimate", "/api/render", "/api/save"].includes(path)) {
    checkPost(req);
    const body = await readJson(req);
    if (path === "/api/brief") {
      const request = validateRequest(body.request);
      if (!llmAvailable()) throw new HttpError(503, { error: "llm-unavailable" });
      try {
        sendJson(res, 200, { brief: await generateBrief(request) });
      } catch (e) {
        if (e instanceof LlmError) throw new HttpError(502, { error: "llm-failed", message: e.message });
        throw e;
      }
      return;
    }
    if (path === "/api/estimate") {
      sendJson(res, 200, await handleEstimate(body));
      return;
    }
    const bundle = bundleFrom(body);
    if (path === "/api/render") {
      sendJson(res, 200, {
        seedResult: bundle.seedResult,
        theme: bundle.theme,
        previewCss: bundle.previewCss,
        fontsUrl: bundle.fontsUrl,
        candidates: bundle.candidates,
        styleGuideMd: bundle.files["style-guide.md"],
      });
      return;
    }
    sendJson(res, 201, { dir: writeBundle(bundle) });
    return;
  }

  sendJson(res, 404, { error: "not-found" });
}

export function createAppServer(): http.Server {
  return http.createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof HttpError) {
        if (e.status === 413) res.setHeader("Connection", "close");
        sendJson(res, e.status, e.body);
        return;
      }
      if (e instanceof InputError) {
        sendJson(res, 400, { error: "input", message: e.message });
        return;
      }
      console.error(e instanceof Error ? e.stack ?? e.message : e);
      sendJson(res, 500, { error: "internal" });
    });
  });
}

function openBrowser(url: string): void {
  try {
    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true, windowsHide: true })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ブラウザが開けなくてもサーバーは動かし続ける
  }
}

function main(argv: string[]): void {
  let port = 0;
  let browser = true;
  let openId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        console.error("--port は 0〜65535 の整数で指定してください");
        process.exit(1);
      }
      port = n;
    } else if (a === "--no-browser") {
      browser = false;
    } else if (a === "--open") {
      openId = argv[++i] ?? null;
    } else {
      console.error(`未知の引数です: ${a}`);
      process.exit(1);
    }
  }
  const server = createAppServer();
  server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    const actual = typeof addr === "object" && addr ? addr.port : port;
    const url = `http://127.0.0.1:${actual}/`;
    console.log(`style-guide app: ${url}`);
    if (browser) openBrowser(openId ? `${url}#theme=${encodeURIComponent(openId)}` : url);
  });
}

if (process.argv[1] && process.argv[1].endsWith("server.ts")) main(process.argv.slice(2));
