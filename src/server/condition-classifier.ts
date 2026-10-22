import path from "node:path";
import type { TypedAgent } from "./ai";
import conditionCatalog from "./condition-catalog.json";
import { conditionTextFeatures, CONDITION_LEXICAL_WIDTH } from "./condition-features";

type ModelResult = Awaited<ReturnType<TypedAgent["systemOne"]>>;
export type ConditionInput =
  | { type: "int64"; data: BigInt64Array; dims: number[] }
  | { type: "bool"; data: Uint8Array; dims: number[] };
export interface ConditionSession {
  run(feeds: Record<string, ConditionInput>, request?: string): Promise<{ logits?: { data: ArrayLike<unknown> } }>;
  release(): Promise<void>;
}
const { names, offsets, total_classes: total } = conditionCatalog;
const catalog: Record<string, string[]> = conditionCatalog.catalog;
const int64 = (values: number[], dims: number[]): ConditionInput => ({
  type: "int64", data: BigInt64Array.from(values, BigInt), dims,
});

export function createConditionAgent(
  delegate: TypedAgent, encode: (request: string) => number[], session: ConditionSession,
): TypedAgent {
  let cached: { request: string; logits: number[] } | undefined;
  let queue = Promise.resolve();
  let closing: Promise<void> | undefined;
  const answer: TypedAgent["systemOne"] = async (state, questions) => {
    const input = state as { request?: unknown; previous_results?: unknown } | null;
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        typeof input.request !== "string" ||
        (input.previous_results !== undefined && typeof input.previous_results !== "boolean")) {
      cached = undefined;
      return delegate.systemOne(state, questions);
    }
    const entries = Object.entries(questions);
    // Prior-result navigation is delegated below; raw-request condition heads remain valid for follow-up queries.
    const fixed = entries.filter(([key, question]) => names.includes(key) &&
      question.type === "choice" && !Array.isArray(question.criteria) &&
      JSON.stringify(Object.keys(question.criteria)) === JSON.stringify(catalog[key]));
    if (!fixed.length) return delegate.systemOne(state, questions);
    let tokens = 0;
    if (cached?.request !== input.request) {
      cached = undefined;
      const ids = [2, ...encode(input.request), 1];
      tokens = ids.length;
      const output = await session.run({
        input_ids: int64(ids, [1, tokens]),
        attention_mask: int64(ids.map(() => 1), [1, tokens]),
        marker_pos: int64(Array.from({ length: total }, (_, i) => i), [1, total]),
        marker_mask: { type: "bool", data: new Uint8Array(total).fill(1), dims: [1, total] },
        qtype: int64([3], [1]),
      }, input.request);
      const values = output.logits?.data;
      if (!values || values.length !== total ||
          Array.from(values).some(value => typeof value !== "number" || !Number.isFinite(value)))
        throw new Error("Invalid condition logits: expected 88 finite numbers");
      cached = { request: input.request, logits: Array.from(values) as number[] };
    }
    const answers: ModelResult["answers"] = {};
    for (const [key] of fixed) {
      const labels = catalog[key], offset = offsets[names.indexOf(key)];
      const logits = cached.logits.slice(offset, offset + labels.length);
      const max = Math.max(...logits), weights = logits.map(value => Math.exp(value - max));
      const sum = weights.reduce((a, b) => a + b, 0);
      answers[key] = { type: "choice", choice: labels[logits.indexOf(max)],
        probabilities: Object.fromEntries(labels.map((label, i) => [label, weights[i] / sum])) };
    }
    const remaining = entries.filter(([key]) => !Object.hasOwn(answers, key));
    const result: ModelResult = remaining.length
      ? await delegate.systemOne(state, Object.fromEntries(remaining)) : { answers: {} };
    return { ...result, answers: { ...result.answers, ...answers },
      usage: { ...result.usage, input_tokens: (result.usage?.input_tokens ?? 0) + tokens } };
  };
  return {
    systemOne(state, questions) {
      if (closing) return Promise.reject(new Error("Condition agent is closed"));
      const result = queue.then(() => answer(state, questions));
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    close() {
      return closing ??= (async () => {
        await queue;
        cached = undefined;
        try { await session.release(); }
        finally { await delegate.close?.(); }
      })();
    },
  };
}

export async function loadConditionAgent(
  directory: string, delegate: TypedAgent, encode: (request: string) => number[], cpuThreads = 8,
  kind: "ads-conditions-v1" | "ads-conditions-v2" = "ads-conditions-v1",
): Promise<TypedAgent> {
  const { InferenceSession, Tensor } = await import("onnxruntime-node");
  const session = await InferenceSession.create(/* turbopackIgnore: true */ path.join(directory, "laya.onnx"), {
    executionProviders: ["cpu"], intraOpNumThreads: cpuThreads, interOpNumThreads: 1,
  });
  let lexical: typeof session | undefined;
  try {
    if (kind === "ads-conditions-v2") lexical = await InferenceSession.create(
      /* turbopackIgnore: true */ path.join(directory, "condition-head.onnx"),
      { executionProviders: ["cpu"], intraOpNumThreads: cpuThreads, interOpNumThreads: 1 },
    );
  } catch (error) { await session.release(); throw error; }
  const toTensors = (feeds: Record<string, ConditionInput>) => Object.fromEntries(
    Object.entries(feeds).map(([key, value]) => [key, value.type === "bool"
      ? new Tensor("bool", value.data, value.dims) : new Tensor("int64", value.data, value.dims)]),
  );
  return createConditionAgent(delegate, encode, {
    async run(feeds, request) {
      if (!lexical) return session.run(toTensors(feeds));
      if (typeof request !== "string") throw new Error("Condition text is missing");
      const width = 2304;
      const raw = await session.run(toTensors({ ...feeds,
        marker_pos: int64(Array.from({ length: width }, (_, i) => i), [1, width]),
        marker_mask: { type: "bool", data: new Uint8Array(width).fill(1), dims: [1, width] },
        qtype: int64([4], [1]),
      }));
      const values = raw.logits.data;
      if (!(values instanceof Float32Array) || values.length !== width || values.some(v => !Number.isFinite(v)))
        throw new Error("Invalid condition encoder features");
      const features = new Float32Array(width + CONDITION_LEXICAL_WIDTH);
      features.set(values); features.set(conditionTextFeatures(request), width);
      return lexical.run({ features: new Tensor("float32", features, [1, features.length]) });
    },
    async release() {
      try { await lexical?.release(); } finally { await session.release(); }
    },
  });
}
