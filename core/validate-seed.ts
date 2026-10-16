// 外部から渡された Seed (JSON) の検証。形が合わなければ InputError を投げる
import type { Seed } from "./types.ts";
import { InputError } from "./explicit.ts";
import { isBaseMode, isFontMood, isRecord, isShadowKind } from "./guards.ts";

const ID_RE = /^[a-z][a-z0-9-]*$/;
const ID_MAX = 20;

const isFiniteNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

const show = (v: unknown): string => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));

function fail(path: string, expect: string, v: unknown): never {
  throw new InputError(`${path} は${expect}で指定してください (${show(v)})`);
}

function obj(x: unknown, path: string): Record<string, unknown> {
  if (!isRecord(x)) return fail(path, "オブジェクト", x);
  return x;
}

function nonEmptyString(x: unknown, path: string): string {
  if (typeof x !== "string" || x.trim() === "") return fail(path, "空でない文字列", x);
  return x;
}

/** lo 以上 hi 以下の数 */
function numIn(x: unknown, path: string, lo: number, hi: number): number {
  if (!isFiniteNum(x) || x < lo || x > hi) return fail(path, `${lo}〜${hi} の数値`, x);
  return x;
}

/** 色相: 0 以上 360 未満の数 */
function hue(x: unknown, path: string): number {
  if (!isFiniteNum(x) || x < 0 || x >= 360) return fail(path, "0 以上 360 未満の数値", x);
  return x;
}

function validateId(x: unknown, path: string): string {
  if (typeof x !== "string" || !ID_RE.test(x) || x.length > ID_MAX) {
    return fail(path, `/^[a-z][a-z0-9-]*$/ に合う ${ID_MAX} 文字以内の文字列`, x);
  }
  return x;
}

function validateColor(x: unknown, path: string): Seed["color"] {
  const c = obj(x, path);
  return {
    brandHue: hue(c.brandHue, `${path}.brandHue`),
    brandChroma: numIn(c.brandChroma, `${path}.brandChroma`, 0, 0.4),
    accentHue: c.accentHue === null ? null : hue(c.accentHue, `${path}.accentHue (null も可)`),
    neutralHue: hue(c.neutralHue, `${path}.neutralHue`),
    neutralChroma: numIn(c.neutralChroma, `${path}.neutralChroma`, 0, 0.4),
    contrast: numIn(c.contrast, `${path}.contrast`, 1, 5),
  };
}

function validateShape(x: unknown, path: string): Seed["shape"] {
  const s = obj(x, path);
  const shadow = s.shadow;
  if (!isShadowKind(shadow)) return fail(`${path}.shadow`, "none / soft / hard のどれか", shadow);
  return {
    radiusPx: numIn(s.radiusPx, `${path}.radiusPx`, 0, 48),
    spacingScale: numIn(s.spacingScale, `${path}.spacingScale`, 0.5, 2),
    shadow,
  };
}

function validateFont(x: unknown, path: string): Seed["font"] {
  const f = obj(x, path);
  const mood = f.mood;
  if (!isFontMood(mood)) return fail(`${path}.mood`, "geometric / humanist / rounded / serif / mincho / tech のどれか", mood);
  const font: Seed["font"] = {
    mood,
    heading: nonEmptyString(f.heading, `${path}.heading`),
    body: nonEmptyString(f.body, `${path}.body`),
    mono: nonEmptyString(f.mono, `${path}.mono`),
  };
  if (f.pairId !== undefined) {
    if (typeof f.pairId !== "string") return fail(`${path}.pairId`, "文字列", f.pairId);
    font.pairId = f.pairId;
  }
  return font;
}

function validateSeedAt(x: unknown, path: string): Seed {
  const s = obj(x, path);
  const baseMode = s.baseMode;
  if (!isBaseMode(baseMode)) return fail(`${path}.baseMode`, "light か dark", baseMode);
  return {
    id: validateId(s.id, `${path}.id`),
    name: nonEmptyString(s.name, `${path}.name`),
    tone: nonEmptyString(s.tone, `${path}.tone`),
    baseMode,
    color: validateColor(s.color, `${path}.color`),
    shape: validateShape(s.shape, `${path}.shape`),
    font: validateFont(s.font, `${path}.font`),
  };
}

/** Seed を 1 つ検証する。不正なら InputError */
export function validateSeed(x: unknown): Seed {
  return validateSeedAt(x, "seed");
}

/** Seed 1 つ、または Seed の配列を検証し、配列で返す。空の配列と id の重複は InputError */
export function validateSeeds(x: unknown): Seed[] {
  if (!Array.isArray(x)) return [validateSeed(x)];
  if (x.length === 0) throw new InputError("seed の配列が空です");
  const seeds = x.map((item, i) => validateSeedAt(item, `seeds[${i}]`));
  const ids = seeds.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) throw new InputError(`seeds に同じ id が複数あります: ${dup}`);
  return seeds;
}
