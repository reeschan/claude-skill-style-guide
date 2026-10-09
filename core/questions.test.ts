import test from "node:test";
import assert from "node:assert/strict";
import { ESTIMATE_QUESTIONS, ESTIMATE_KEYS, HUES, estimateQuestions } from "./questions.ts";

const ORDER = ["brand_hue", "neutral_tint", "accent_scheme", "base_mode", "font_mood", "shadow", "use_accent", "chroma", "contrast", "radius", "density", "formality"];

test("質問のキーと順", () => {
  assert.deepEqual(Object.keys(ESTIMATE_QUESTIONS), ORDER);
  assert.deepEqual(ESTIMATE_KEYS, ORDER);
});

test("brand_hue の criteria は HUES と一致", () => {
  const q = ESTIMATE_QUESTIONS.brand_hue;
  assert.equal(q.type, "choice");
  assert.deepEqual(Object.keys(q.criteria), Object.keys(HUES));
});

test("score の criteria は 5 要素", () => {
  for (const k of ["chroma", "contrast", "radius", "density", "formality"]) {
    const q = ESTIMATE_QUESTIONS[k];
    assert.equal(q.type, "score");
    assert.equal((q.criteria as string[]).length, 5);
  }
});

test("estimateQuestions は skip を除く", () => {
  const r = estimateQuestions(["chroma", "brand_hue"]);
  assert.equal(Object.keys(r).length, 10);
  assert.ok(!("chroma" in r) && !("brand_hue" in r));
  assert.equal(Object.keys(ESTIMATE_QUESTIONS).length, 12);
});
