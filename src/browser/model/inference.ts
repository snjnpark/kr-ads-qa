import { Tokenizer } from "@huggingface/tokenizers";
import * as ort from "onnxruntime-web/wasm";
import { createConditionAgent, type ConditionInput } from "./condition-agent";
import { CONDITION_LEXICAL_WIDTH, conditionTextFeatures } from "../../server/condition-features";
import { buildChoiceSequence, softmax, temperatureFor } from "./sequence";
import { loadModelFiles, MODEL_RELEASE, MODEL_TOTAL_BYTES, type ModelLoadOptions } from "./cache";
import type { ModelConfig, TypedAgent, ModelResult } from "./types";
const round4 = (value: number) => Math.round(value * 1e4) / 1e4;
const toTensors = (feeds: Record<string, ConditionInput>) => Object.fromEntries(Object.entries(feeds).map(([key, value]) => [key, value.type === "bool" ? new ort.Tensor("bool", value.data, value.dims) : new ort.Tensor("int64", value.data, value.dims)]));

/** Own exactly one encoder session; learned condition and choice heads share it. */
export async function createBrowserAgent(options: ModelLoadOptions = {}): Promise<{ agent: TypedAgent; encode: (text: string) => number[]; config: ModelConfig }> {
  const files = await loadModelFiles(options);
  if (options.signal?.aborted) throw new DOMException("모델 준비를 취소했습니다.", "AbortError");
  options.progress?.({ stage: "initialize", loaded: MODEL_TOTAL_BYTES, total: MODEL_TOTAL_BYTES });
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  // The build copies the two runtime files from the pinned npm release to this origin.
  ort.env.wasm.wasmPaths = new URL("/onnxruntime/", globalThis.location.origin).href;
  const json = (name: Parameters<typeof files.get>[0]) => JSON.parse(new TextDecoder().decode(files.get(name)));
  const config = json("laya_config.json") as ModelConfig;
  if (!Number.isInteger(config.max_len) || config.max_len < 16 || config.max_len > 4096 || !Number.isInteger(config.head_max_len) || config.head_max_len < 16 || config.head_max_len > config.max_len || !Array.isArray(config.temperature) || config.temperature.length !== 3 || config.condition_classifier !== "ads-conditions-v2") throw new Error("고정 배포 모델의 설정 형식을 확인할 수 없습니다.");
  const tokenizer = new Tokenizer(json("tokenizer/tokenizer.json"), json("tokenizer/tokenizer_config.json"));
  for (const [name, id] of Object.entries({ "[CLS]": 2, "[SEP]": 1, "[MASK]": 4, "[PAD]": 0 })) if (tokenizer.token_to_id(name) !== id) throw new Error("모델 특수 토큰이 고정 명세와 다릅니다.");
  const encode = (text: string) => tokenizer.encode(text, { add_special_tokens: false }).ids;
  const session = await ort.InferenceSession.create(files.get("laya.onnx")!, {
    executionProviders: ["wasm"], graphOptimizationLevel: "all",
    externalData: [{ path: "model.onnx.data", data: files.get("model.onnx.data")! }],
  });
  let head: ort.InferenceSession;
  try { head = await ort.InferenceSession.create(files.get("condition-head.onnx")!, { executionProviders: ["wasm"], graphOptimizationLevel: "all" }); }
  catch (error) { await session.release(); throw error; }
  // ONNX owns the model now. Do not retain the 1.31 GB download buffer as a second copy.
  const cacheStatus = { cacheComplete: files.cacheComplete, cacheWarning: files.cacheWarning, cacheFailure: files.cacheFailure };
  files.clear();
  let closed = false;
  const delegate: TypedAgent = {
    async systemOne(state, questions): Promise<ModelResult> {
      if (closed) throw new Error("모델이 닫혔습니다.");
      const qids = Object.keys(questions);
      if (!qids.length || qids.length > 256) throw new Error("모델 질문 수를 확인해 주세요.");
      const items = qids.map(qid => buildChoiceSequence(encode, state, questions[qid], config));
      const count = items.length, length = Math.max(...items.map(it => it.ids.length)), width = Math.max(2, ...items.map(it => it.markers.length));
      const input = new BigInt64Array(count * length), attention = new BigInt64Array(count * length), positions = new BigInt64Array(count * width), mask = new Uint8Array(count * width), qtype = new BigInt64Array(count);
      let tokens = 0;
      items.forEach((item, index) => {
        item.ids.forEach((value, offset) => { input[index * length + offset] = BigInt(value); attention[index * length + offset] = 1n; });
        item.markers.forEach((value, offset) => { positions[index * width + offset] = BigInt(value); mask[index * width + offset] = 1; });
        tokens += item.ids.length;
      });
      const output = await session.run({ input_ids: new ort.Tensor("int64", input, [count, length]), attention_mask: new ort.Tensor("int64", attention, [count, length]), marker_pos: new ort.Tensor("int64", positions, [count, width]), marker_mask: new ort.Tensor("bool", mask, [count, width]), qtype: new ort.Tensor("int64", qtype, [count]) });
      const logits = output.logits?.data;
      if (!(logits instanceof Float32Array) || logits.length !== count * width || logits.some(value => !Number.isFinite(value))) throw new Error("모델 선택지 점수가 유효하지 않습니다.");
      const answers: ModelResult["answers"] = {};
      items.forEach((item, index) => {
        const temperature = temperatureFor(config, item.labels.length);
        const scores = softmax(Array.from(logits.subarray(index * width, index * width + item.labels.length), value => value / temperature));
        answers[qids[index]] = { type: "choice", choice: item.labels[scores.indexOf(Math.max(...scores))], probabilities: Object.fromEntries(item.labels.map((label, offset) => [label, round4(scores[offset])])) };
      });
      return { answers, usage: { input_tokens: tokens } };
    },
    async close() { if (!closed) { closed = true; await session.release(); } },
  };
  const agent = createConditionAgent(delegate, encode, {
    async run(feeds, request) {
      if (typeof request !== "string") throw new Error("조건 분류 요청 문자열이 없습니다.");
      const width = 2304;
      const output = await session.run(toTensors({ ...feeds,
        marker_pos: { type: "int64", data: BigInt64Array.from({ length: width }, (_, index) => BigInt(index)), dims: [1, width] },
        marker_mask: { type: "bool", data: new Uint8Array(width).fill(1), dims: [1, width] },
        qtype: { type: "int64", data: BigInt64Array.from([4n]), dims: [1] },
      }));
      const values = output.logits?.data;
      if (!(values instanceof Float32Array) || values.length !== width || values.some(value => !Number.isFinite(value))) throw new Error("조건 인코더 결과가 유효하지 않습니다.");
      const features = new Float32Array(width + CONDITION_LEXICAL_WIDTH);
      features.set(values); features.set(conditionTextFeatures(request), width);
      return head.run({ features: new ort.Tensor("float32", features, [1, features.length]) });
    },
    async release() { await head.release(); },
  });
  options.progress?.({ stage: "ready", loaded: MODEL_TOTAL_BYTES, total: MODEL_TOTAL_BYTES, ...cacheStatus, message: cacheStatus.cacheWarning ?? `${MODEL_RELEASE.candidate_id} · WASM` });
  return { agent, encode, config };
}
