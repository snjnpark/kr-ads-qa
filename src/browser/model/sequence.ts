/*! Choice sequence layout and temperature behavior ported from @receptron/laya 0.2.0.
MIT License

Copyright (c) 2026 Receptron

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import type { ChoiceQuestion, ModelConfig } from "./types";
export function pyJson(value: unknown): string {
  if (value == null) return "null";
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  if (typeof value === "object") return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pyJson(item)}`).join(", ")}}`;
  return JSON.stringify(value);
}
export function softmax(values: number[]) {
  if (!values.length || values.some(v => !Number.isFinite(v))) throw new Error("Invalid model logits");
  const max = Math.max(...values), weights = values.map(v => Math.exp(v - max));
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map(v => v / sum);
}
export function temperatureFor(config: ModelConfig, count: number) {
  const bucket = count <= 2 ? "2" : count <= 5 ? "3-5" : count <= 10 ? "6-10" : "11+";
  const specific = config.temperature_by_options?.[`choice:${bucket}`];
  const value = typeof specific === "number" && Number.isFinite(specific) ? specific : config.temperature[0];
  return Math.min(5, Math.max(0.5, Number.isFinite(value) ? value : 1));
}
export function buildChoiceSequence(encode: (text: string) => number[], state: unknown, question: ChoiceQuestion, config: ModelConfig) {
  const scrub = (text: string) => text.replace(/\[MASK\]|<mask>/g, " ");
  const labels = Array.isArray(question.criteria) ? question.criteria : Object.keys(question.criteria);
  if (!labels.length || labels.length > 256 || new Set(labels).size !== labels.length || labels.some(v => typeof v !== "string" || !v)) throw new Error("Invalid choice labels");
  const criteria = question.criteria;
  const options = labels.map(key => !Array.isArray(criteria) && criteria[key] ? `${key}: ${criteria[key]}` : key);
  const header = encode(`choice question: ${scrub(typeof question.instructions === "string" ? question.instructions : pyJson(question.instructions))}`);
  let optionTokens = options.map(value => [4, ...encode(" " + scrub(value)).slice(0, 48)]);
  let budget = config.head_max_len - optionTokens.reduce((sum, value) => sum + value.length, 0);
  if (budget < 16) {
    const per = Math.max(4, Math.floor((config.head_max_len - 16) / optionTokens.length));
    optionTokens = optionTokens.map(value => value.slice(0, per));
    budget = config.head_max_len - optionTokens.reduce((sum, value) => sum + value.length, 0);
  }
  const stateTokens = encode(scrub(typeof state === "string" ? state : pyJson(state)));
  const total = header.length + optionTokens.reduce((sum, value) => sum + value.length, 0) + 4 + stateTokens.length;
  // Reject truncation before inference rather than silently losing question evidence.
  if (header.length > Math.max(8, budget) || total > config.max_len) throw new Error("입력이 모델 토큰 한도를 초과했습니다.");
  const ids = [2, ...header, 1], markers: number[] = [];
  for (const option of optionTokens) { markers.push(ids.length); ids.push(...option); }
  ids.push(1, ...stateTokens, 1);
  return { ids, markers, labels };
}
