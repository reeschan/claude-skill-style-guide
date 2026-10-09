import type { Alternative, Answer, Brief, Estimate, FontPair, Resolved, Seed, SeedResult, Source } from "./types.ts";
import { ESTIMATE_KEYS, ESTIMATE_QUESTIONS, HUES, THRESHOLDS } from "./questions.ts";
import { InputError } from "./explicit.ts";

export const LEVELS = {
  brandChroma: [0.04, 0.08, 0.12, 0.16, 0.2],
  radiusPx: [0, 4, 8, 12, 20],
  spacingScale: [0.85, 0.92, 1.0, 1.1, 1.2],
};
export const ACCENT_OFFSET = { analogous: 30, complementary: 180, triadic: 120 };

// 質問のキー → その答えで決まるシードの項目 (sources のキー)
export const FIELDS_BY_KEY: Record<string, string[]> = {
  brand_hue: ["color.brandHue"],
  chroma: ["color.brandChroma"],
  neutral_tint: ["color.neutralHue", "color.neutralChroma"],
  accent_scheme: ["color.accentHue"],
  use_accent: ["color.accentHue"],
  contrast: ["color.contrast"],
  radius: ["shape.radiusPx"],
  density: ["shape.spacingScale"],
  shadow: ["shape.shadow"],
  base_mode: ["baseMode"],
  font_mood: ["font.mood"],
  font_pair: ["font.heading", "font.body", "font.mono"],
};

const round3 = (x: number): number => Math.round(x * 1000) / 1000;
const round2 = (x: number): number => Math.round(x * 100) / 100;

export function lerpLevel(table: number[], score: number): number {
  const s = Math.min(4, Math.max(0, score));
  const i = Math.min(3, Math.floor(s));
  const t = s - i;
  return table[i] + (table[i + 1] - table[i]) * t;
}

export function requiredKeys(skip: string[]): string[] {
  return ESTIMATE_KEYS.filter((k) => !skip.includes(k));
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown, lo: number, hi: number): boolean => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;

function checkAnswer(key: string, a: unknown): string | null {
  const q = key === "font_pair" ? null : ESTIMATE_QUESTIONS[key];
  const type = q ? q.type : "choice";
  if (!isObj(a)) return `${key}: オブジェクトではありません`;
  if (a.type !== undefined && a.type !== type) return `${key}: type は ${type} である必要があります (${String(a.type)})`;
  if (type === "choice") {
    if (typeof a.choice !== "string" || a.choice === "") return `${key}: choice が文字列ではありません`;
    if (q && q.type === "choice" && !Object.prototype.hasOwnProperty.call(q.criteria, a.choice)) {
      return `${key}: choice "${a.choice}" は選択肢 (${Object.keys(q.criteria).join(", ")}) にありません`;
    }
    if (!isNum(a.confidence, 0, 1)) return `${key}: confidence は 0〜1 の数値である必要があります`;
    if (!isObj(a.probabilities)) return `${key}: probabilities がオブジェクトではありません`;
  } else if (type === "noul") {
    if (!isNum(a.noul, 0, 1)) return `${key}: noul は 0〜1 の数値である必要があります`;
  } else {
    if (!isNum(a.score, 0, 4)) return `${key}: score は 0〜4 の数値である必要があります`;
    if (!isNum(a.confidence, 0, 1)) return `${key}: confidence は 0〜1 の数値である必要があります`;
  }
  return null;
}

export function validateEstimate(x: unknown, required: string[]): Estimate {
  if (!isObj(x)) throw new InputError("推定結果がオブジェクトではありません");
  const problems: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) out[k] = v;
  const keys = [...required];
  if (x.font_pair !== undefined && !keys.includes("font_pair")) keys.push("font_pair");
  for (const key of keys) {
    if (!(key in x) || x[key] === undefined) {
      problems.push(`${key}: 答えがありません`);
      continue;
    }
    const msg = checkAnswer(key, x[key]);
    if (msg) {
      problems.push(msg);
      continue;
    }
    const q = key === "font_pair" ? null : ESTIMATE_QUESTIONS[key];
    out[key] = { type: q ? q.type : "choice", ...(x[key] as object) };
  }
  if (problems.length) throw new InputError(`推定結果が不正です: ${problems.join(" / ")}`);
  return out as Estimate;
}

export function applyOverrides(est: Estimate, overrides: Record<string, string | number>): Estimate {
  const out: Estimate = structuredClone(est);
  for (const [key, v] of Object.entries(overrides)) {
    const q = key === "font_pair" ? null : ESTIMATE_QUESTIONS[key];
    if (key !== "font_pair" && !q) throw new InputError(`未知の質問キーです: ${key}`);
    const type = q ? q.type : "choice";
    let a: Answer;
    if (type === "choice") a = { type: "choice", choice: String(v), confidence: 1, probabilities: { [String(v)]: 1 } };
    else if (type === "noul") a = { type: "noul", noul: Number(v) };
    else a = { type: "score", score: Number(v), confidence: 1 };
    out[key] = a;
  }
  return out;
}

const NEUTRAL: Record<string, [number | null, number]> = { pure: [null, 0], brand: [null, 0.01], warm: [70, 0.01], cool: [250, 0.01] };

function need(est: Estimate, key: string): Answer {
  const a = est[key];
  if (!a) throw new InputError(`推定結果に ${key} がありません`);
  return a;
}
const choiceOf = (est: Estimate, key: string): string => {
  const a = need(est, key);
  if (a.type !== "choice") throw new InputError(`${key} は choice である必要があります`);
  return a.choice;
};
const scoreOf = (est: Estimate, key: string): number => {
  const a = need(est, key);
  if (a.type !== "score") throw new InputError(`${key} は score である必要があります`);
  return a.score;
};
const noulOf = (est: Estimate, key: string): number => {
  const a = need(est, key);
  if (a.type !== "noul") throw new InputError(`${key} は noul である必要があります`);
  return a.noul;
};

export function toSeedResult(args: {
  brief: Brief;
  resolved: Resolved;
  estimate: Estimate;
  fontPair: FontPair | null;
  estimateSource: "jev" | "llm-fallback";
}): SeedResult {
  const { brief, resolved, estimate, fontPair, estimateSource } = args;
  const fixed = resolved.fixed;

  const brandHue = fixed.brandHue ?? (HUES as Record<string, number>)[choiceOf(estimate, "brand_hue")];
  if (brandHue === undefined) throw new InputError("brand_hue の色相を決められません");
  const brandChroma = fixed.brandChroma ?? round3(lerpLevel(LEVELS.brandChroma, scoreOf(estimate, "chroma")));
  const baseMode = fixed.baseMode ?? (choiceOf(estimate, "base_mode") as Seed["baseMode"]);

  const useAccent = noulOf(estimate, "use_accent");
  let accentHue: number | null = null;
  if (useAccent >= 0.5) {
    const scheme = choiceOf(estimate, "accent_scheme");
    const off = (ACCENT_OFFSET as Record<string, number>)[scheme];
    if (off === undefined) throw new InputError(`accent_scheme が不正です: ${scheme}`);
    accentHue = (brandHue + off) % 360;
  }

  const tint = NEUTRAL[choiceOf(estimate, "neutral_tint")];
  if (!tint) throw new InputError("neutral_tint が不正です");
  const neutralHue = tint[0] ?? brandHue;
  const neutralChroma = tint[1];

  const heading = fixed.fonts.heading ?? fontPair?.heading;
  const body = fixed.fonts.body ?? fontPair?.body;
  const mono = fixed.fonts.mono ?? fontPair?.mono;
  if (!heading || !body || !mono) throw new InputError("フォントの組が決まっていません");
  const font: Seed["font"] = { mood: choiceOf(estimate, "font_mood") as Seed["font"]["mood"], heading, body, mono };
  if (fontPair) font.pairId = fontPair.id;

  const seed: Seed = {
    id: brief.id,
    name: brief.name,
    tone: brief.tone,
    baseMode,
    color: { brandHue, brandChroma, accentHue, neutralHue, neutralChroma, contrast: round2(scoreOf(estimate, "contrast") + 1) },
    shape: {
      radiusPx: Math.round(lerpLevel(LEVELS.radiusPx, scoreOf(estimate, "radius"))),
      spacingScale: round3(lerpLevel(LEVELS.spacingScale, scoreOf(estimate, "density"))),
      shadow: choiceOf(estimate, "shadow") as Seed["shape"]["shadow"],
    },
    font,
  };

  const paths = ["baseMode", "color.brandHue", "color.brandChroma", "color.accentHue", "color.neutralHue", "color.neutralChroma", "color.contrast", "shape.radiusPx", "shape.spacingScale", "shape.shadow", "font.mood", "font.heading", "font.body", "font.mono"];
  const sources: Record<string, Source> = {};
  for (const p of paths) sources[p] = resolved.sources[p] ?? estimateSource;

  const alternatives: Alternative[] = [];
  const choiceKeys = ["brand_hue", "neutral_tint", "accent_scheme", "base_mode", "font_mood", "shadow", "use_accent", "font_pair"];
  for (const key of choiceKeys) {
    const a = estimate[key];
    if (!a) continue;
    if (key === "use_accent") {
      if (a.type !== "noul") continue;
      const [lo, hi] = THRESHOLDS.noulUncertain.use_accent;
      if (a.noul >= lo && a.noul <= hi) {
        alternatives.push({ field: key, value: a.noul < 0.5 ? "true" : "false", probability: a.noul < 0.5 ? a.noul : 1 - a.noul });
      }
      continue;
    }
    if (a.type !== "choice" || resolved.skip.includes(key)) continue;
    const th = (THRESHOLDS.choice as Record<string, number>)[key];
    if (th === undefined || !(a.confidence < th)) continue;
    const ranked = Object.entries(a.probabilities)
      .filter(([v]) => v !== a.choice)
      .sort((p, q) => q[1] - p[1])
      .slice(0, 2);
    for (const [value, probability] of ranked) {
      if (probability >= 0.1) alternatives.push({ field: key, value, probability });
    }
  }

  const lowConfidence: string[] = [];
  for (const key of ["chroma", "contrast", "radius", "density", "formality"]) {
    const a = estimate[key];
    if (a && a.type === "score" && a.confidence < (THRESHOLDS.scoreLow as Record<string, number>)[key]) lowConfidence.push(key);
  }

  return { seed, alternatives, sources, lowConfidence };
}
