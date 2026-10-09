// スキル style-guide から使う CLI。ブリーフ (と推定) からテーマ一式を作る
//   node scripts/pipeline.ts questions --request R.json --brief B.json
//   node scripts/pipeline.ts fonts --request R.json --brief B.json --estimate E.json
//   node scripts/pipeline.ts run --request R.json --brief B.json [--estimate E.json] [--estimate-source jev|llm-fallback] [--out DIR] [--dry-run]
//   node scripts/pipeline.ts list
// 標準出力には JSON を 1 つだけ出す。エラーは標準エラーに {"error": ...}
// 終了コード: 0 成功、1 入力エラー、2 推定が必要 (Jev キー無し)、3 Jev の失敗
import { readFileSync } from "node:fs";
import { loadJev as loadJevShared } from "../lib/load-jev.ts";
import { parseArgs } from "node:util";
import type { Brief, ChoiceAnswer, Estimate, FontPair, Question, Resolved, ThemeRequest } from "../core/types.ts";
import { InputError, resolveExplicit, validateBrief, validateRequest } from "../core/explicit.ts";
import { JEV_MODEL, estimateQuestions } from "../core/questions.ts";
import { requiredKeys, validateEstimate } from "../core/seed.ts";
import { fontQuestion, loadCatalog, selectCandidates, validateFixedFonts } from "../core/fonts.ts";
import { buildBundle, listThemes, writeBundle } from "../core/bundle.ts";

const EXIT_OK = 0;
const EXIT_INPUT = 1;
const EXIT_NEED_ESTIMATE = 2;
const EXIT_JEV = 3;

// 終了コード付きで CLI を止めるための例外
class CliExit extends Error {
  code: number;
  payload: Record<string, unknown>;
  constructor(code: number, payload: Record<string, unknown>) {
    super(String(payload.error));
    this.code = code;
    this.payload = payload;
  }
}

const usage = (message: string): CliExit => new CliExit(EXIT_INPUT, { error: "usage", message });

type JevModule = {
  callJev: (args: { state: unknown; questions: Record<string, Question>; model: string; endpoint?: string }) => Promise<{ answers: Record<string, unknown> }>;
  getApiKey: (env?: NodeJS.ProcessEnv) => string | null;
  JevError: new (...args: never[]) => Error & { code: string; status: number };
  DEFAULT_ENDPOINT: string;
};

async function loadJev(): Promise<JevModule> {
  return (await loadJevShared()) as JevModule;
}

function readJson(path: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new CliExit(EXIT_INPUT, { error: "file", file: label, path, message: (e as Error).message });
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CliExit(EXIT_INPUT, { error: "file", file: label, path, message: `JSON として読めません: ${(e as Error).message}` });
  }
}

function need(values: Record<string, unknown>, name: string): string {
  const v = values[name];
  if (typeof v !== "string" || v === "") throw usage(`--${name} が必要です`);
  return v;
}

function loadInputs(values: Record<string, unknown>): { request: ThemeRequest; brief: Brief; resolved: Resolved } {
  const request = validateRequest(readJson(need(values, "request"), "request"));
  const brief = validateBrief(readJson(need(values, "brief"), "brief"));
  return { request, brief, resolved: resolveExplicit(request, brief) };
}

function candidatesFor(catalog: FontPair[], brief: Brief, resolved: Resolved, estimate: Estimate): FontPair[] {
  const problems = validateFixedFonts(resolved.fixed.fonts, catalog);
  if (problems.length > 0) throw new InputError(problems.join(" / "));
  const mood = estimate.font_mood;
  const formality = estimate.formality;
  if (!mood || mood.type !== "choice") throw new InputError("font_mood が必要です");
  if (!formality || formality.type !== "score") throw new InputError("formality が必要です");
  return selectCandidates({
    catalog,
    fontMood: mood as ChoiceAnswer,
    needsJapanese: brief.needsJapanese,
    fixed: resolved.fixed.fonts,
    formality: formality.score,
  });
}

const candidateView = (p: FontPair) => ({ id: p.id, heading: p.heading, body: p.body, mono: p.mono, mood: p.mood, description: p.description });

function endpointOf(jev: JevModule): string {
  return process.env.JEV_ENDPOINT || jev.DEFAULT_ENDPOINT;
}

function jevFailure(jev: JevModule, e: unknown, stage: string, extra: Record<string, unknown>): never {
  if (e instanceof jev.JevError) {
    throw new CliExit(EXIT_JEV, { error: "jev-failed", stage, code: e.code, status: e.status, message: e.message, ...extra });
  }
  throw e;
}

// ---------------------------------------------------------------------------
// サブコマンド
// ---------------------------------------------------------------------------
function cmdQuestions(values: Record<string, unknown>): unknown {
  const { resolved } = loadInputs(values);
  return { skip: resolved.skip, questions: estimateQuestions(resolved.skip) };
}

function cmdFonts(values: Record<string, unknown>): unknown {
  const { brief, resolved } = loadInputs(values);
  const raw = readJson(need(values, "estimate"), "estimate");
  if (resolved.skip.includes("font_pair")) return { candidates: [], question: null };
  const estimate = validateEstimate(raw, ["font_mood", "formality"]);
  const candidates = candidatesFor(loadCatalog(), brief, resolved, estimate);
  return {
    candidates: candidates.map(candidateView),
    question: candidates.length > 1 ? fontQuestion(candidates) : null,
  };
}

async function cmdRun(values: Record<string, unknown>): Promise<unknown> {
  const { request, brief, resolved } = loadInputs(values);
  const skip = resolved.skip;

  const sourceArg = values["estimate-source"];
  if (sourceArg !== undefined && sourceArg !== "jev" && sourceArg !== "llm-fallback") {
    throw usage("--estimate-source は jev か llm-fallback です");
  }

  // 推定
  const jev = await loadJev();
  const hasKey = jev.getApiKey(process.env) !== null;
  let raw: unknown;
  let estimateSource: "jev" | "llm-fallback";
  if (typeof values.estimate === "string") {
    raw = readJson(values.estimate, "estimate");
    estimateSource = (sourceArg as "jev" | "llm-fallback" | undefined) ?? "llm-fallback";
  } else {
    const questions = estimateQuestions(skip);
    if (!hasKey) throw new CliExit(EXIT_NEED_ESTIMATE, { error: "estimate-required", questions });
    try {
      const res = await jev.callJev({ state: brief.state, questions, model: JEV_MODEL, endpoint: endpointOf(jev) });
      raw = res.answers;
    } catch (e) {
      jevFailure(jev, e, "estimate", { questions });
    }
    estimateSource = "jev";
  }
  let estimate = validateEstimate(raw, requiredKeys(skip));

  // フォントの組
  const catalog = loadCatalog();
  if (!skip.includes("font_pair") && estimate.font_pair === undefined) {
    const candidates = candidatesFor(catalog, brief, resolved, estimate);
    if (candidates.length >= 2) {
      const question = fontQuestion(candidates);
      if (!hasKey) {
        throw new CliExit(EXIT_NEED_ESTIMATE, { error: "font-pair-required", candidates: candidates.map(candidateView), question });
      }
      let answer: unknown;
      try {
        const res = await jev.callJev({ state: brief.state, questions: question, model: JEV_MODEL, endpoint: endpointOf(jev) });
        answer = res.answers.font_pair;
      } catch (e) {
        jevFailure(jev, e, "fonts", { question });
      }
      if (answer === undefined) {
        throw new CliExit(EXIT_JEV, { error: "jev-failed", stage: "fonts", code: "bad-response", status: 0, message: "応答に font_pair がありません", question });
      }
      estimate = validateEstimate({ ...estimate, font_pair: answer }, requiredKeys(skip));
    }
  }

  // 組み立てと保存
  const bundle = buildBundle({ request, brief, estimate, estimateSource, catalog });
  const dir = values["dry-run"] ? null : writeBundle(bundle, typeof values.out === "string" ? values.out : undefined);
  const checks: Record<string, { pass: number; total: number; adjusted: number }> = {};
  for (const mode of ["light", "dark"] as const) {
    const cs = bundle.theme.modes[mode].checks;
    checks[mode] = { pass: cs.filter((c) => c.pass).length, total: cs.length, adjusted: cs.filter((c) => c.adjusted).length };
  }
  const sr = bundle.seedResult;
  return {
    dir,
    seed: sr.seed,
    alternatives: sr.alternatives,
    sources: sr.sources,
    lowConfidence: sr.lowConfidence,
    checks,
    fontsUrl: bundle.fontsUrl,
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
async function main(argv: string[]): Promise<number> {
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
          request: { type: "string" },
          brief: { type: "string" },
          estimate: { type: "string" },
          "estimate-source": { type: "string" },
          out: { type: "string" },
          "dry-run": { type: "boolean" },
        },
      });
    } catch (e) {
      throw usage((e as Error).message);
    }
    const { values, positionals } = parsed;
    if (positionals.length !== 1) throw usage("サブコマンドを 1 つ指定してください (questions / fonts / run / list)");
    let result: unknown;
    switch (positionals[0]) {
      case "questions":
        result = cmdQuestions(values);
        break;
      case "fonts":
        result = cmdFonts(values);
        break;
      case "run":
        result = await cmdRun(values);
        break;
      case "list":
        result = listThemes();
        break;
      default:
        throw usage(`不明なサブコマンド: ${positionals[0]}`);
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return EXIT_OK;
  } catch (e) {
    if (e instanceof CliExit) {
      process.stderr.write(JSON.stringify(e.payload) + "\n");
      return e.code;
    }
    if (e instanceof InputError) {
      process.stderr.write(JSON.stringify({ error: "input", message: e.message }) + "\n");
      return EXIT_INPUT;
    }
    process.stderr.write(JSON.stringify({ error: "internal", message: (e as Error)?.message ?? String(e) }) + "\n");
    return EXIT_INPUT;
  }
}

process.exitCode = await main(process.argv.slice(2));
