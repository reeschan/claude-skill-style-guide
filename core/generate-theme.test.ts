import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderThemeFiles, resolveTheme, themeCss } from "./generate-theme.ts";
import type { Seed } from "./types.ts";

const EXAMPLES = fileURLToPath(new URL("../examples", import.meta.url));
const readSeed = (name: string) => JSON.parse(readFileSync(`${EXAMPLES}/seeds/${name}.json`, "utf8")) as Seed;
const expected = JSON.parse(readFileSync(`${EXAMPLES}/theme.json`, "utf8")) as {
  seed: Seed;
  modes: Record<"light" | "dark", { tokens: Record<string, string> }>;
}[];
const expectedFor = (id: string) => {
  const hit = expected.find((t) => t.seed.id === id);
  if (!hit) throw new Error(`theme.json に ${id} がない`);
  return hit;
};

const aizome = readSeed("aizome");
const neon = readSeed("neon");
const ACCENT_TOKENS = new Set(["brand-accent", "brand-accent-foreground"]);

test("aizome / neon: brand-accent 以外のトークンが theme.json と一致する", () => {
  for (const seed of [aizome, neon]) {
    const actual = resolveTheme(seed);
    const exp = expectedFor(seed.id);
    for (const mode of ["light", "dark"] as const) {
      const a = actual.modes[mode].tokens;
      const e = exp.modes[mode].tokens;
      assert.deepEqual(
        Object.keys(a).sort(),
        Object.keys(e).sort(),
        `${seed.id} / ${mode}: トークン名の集合が違う`,
      );
      for (const key of Object.keys(e)) {
        if (ACCENT_TOKENS.has(key)) continue;
        assert.equal(a[key], e[key], `${seed.id} / ${mode} / ${key}`);
      }
    }
  }
});

test("aizome の brand-accent は元の彩度より低い (約 0.096)", () => {
  const css = themeCss(resolveTheme(aizome));
  const m = css.match(/--brand-accent: oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/);
  assert.ok(m, "--brand-accent が css に見つからない");
  const chroma = Number(m[2]);
  const original = Number(expectedFor("aizome").modes.light.tokens["brand-accent"].match(/oklch\([\d.]+ ([\d.]+)/)![1]);
  assert.ok(chroma < original, `彩度 ${chroma} が元の ${original} 以上`);
  assert.ok(Math.abs(chroma - 0.096) < 0.005, `彩度 ${chroma} が 0.096 から離れている`);
});

test("mood が serif のとき見出しと本文の総称が serif になり、それ以外は sans-serif のまま", () => {
  const serifSeed = { ...aizome, font: { ...aizome.font, mood: "serif" as const } };
  const serifCss = themeCss(resolveTheme(serifSeed));
  assert.ok(serifCss.includes(`--theme-font-heading: "Zen Kaku Gothic New", serif;`));

  const originalCss = themeCss(resolveTheme(aizome));
  assert.ok(originalCss.includes("sans-serif"));
  assert.ok(originalCss.includes(`--theme-font-mono: "JetBrains Mono", monospace;`));
});

test("renderThemeFiles([aizome, neon]): failed は 0 で、report の 1 行目は aizome / light: で始まる", () => {
  const { failed, report, css, json } = renderThemeFiles([aizome, neon]);
  assert.equal(failed, 0);
  assert.ok(report[0].startsWith("aizome / light: "), report[0]);
  assert.ok(css.startsWith("@import \"tailwindcss\";"));
  assert.equal(JSON.parse(json).length, 2);
});

test("font.pairId を持つ seed でも例外なく動く", () => {
  const withPair = { ...aizome, font: { ...aizome.font, pairId: "zen-kaku+noto-sans-jp" } } as Seed;
  assert.doesNotThrow(() => {
    const { css, failed } = renderThemeFiles([withPair]);
    assert.ok(css.includes("--theme-font-heading"));
    assert.equal(failed, 0);
  });
});
