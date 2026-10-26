import * as ort from "onnxruntime-web/wasm";
import { createConditionAgent, type ConditionInput } from "./condition-agent";
import { CONDITION_LEXICAL_WIDTH, conditionTextFeatures } from "../../domain/query/condition-features";
import { buildChoiceSequence, softmax, temperatureFor } from "./sequence";
import { loadModelFiles, MODEL_RELEASE, MODEL_TOTAL_BYTES, type ModelLoadOptions } from "./cache";
import type { ModelConfig, TypedAgent, ModelResult } from "./types";
import { createUpstreamTokenizer } from "./tokenizer";
const round4 = (value: number) => Math.round(value * 1e4) / 1e4;
const toTensors = (feeds: Record<string, ConditionInput>) => Object.fromEntries(Object.entries(feeds).map(([key, value]) => [key, value.type === "bool" ? new ort.Tensor("bool", value.data, value.dims) : new ort.Tensor("int64", value.data, value.dims)]));
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException("모델 준비를 취소했습니다.", "AbortError"); };
const strength = () => new ort.Tensor("float32", Float32Array.of(1), [1]);

/** Own exactly one encoder session; learned condition and choice heads share it. */
export async function createBrowserAgent(options: ModelLoadOptions = {}): Promise<{ agent: TypedAgent; encode: (text: string) => number[]; config: ModelConfig }> {
  const files = await loadModelFiles(options);
  const json = (name: Parameters<typeof files.get>[0]) => JSON.parse(new TextDecoder().decode(files.get(name)));
  const cacheStatus = { cacheComplete: files.cacheComplete, cacheWarning: files.cacheWarning, cacheFailure: files.cacheFailure };
  let session: ort.InferenceSession | undefined, head: ort.InferenceSession | undefined, config: ModelConfig, encode: (text: string) => number[];
  try {
    abort(options.signal);
    options.progress?.({ stage: "initialize", loaded: MODEL_TOTAL_BYTES, total: MODEL_TOTAL_BYTES });
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    // The build copies the two runtime files from the pinned npm release to this origin.
    ort.env.wasm.wasmPaths = new URL("/onnxruntime/", globalThis.location.origin).href;
    config = json("laya_config.json") as ModelConfig;
    if (!config || typeof config !== "object" || !Number.isInteger(config.max_len) || config.max_len < 16 || config.max_len > 4096 || !Number.isInteger(config.head_max_len) || config.head_max_len < 16 || config.head_max_len > config.max_len || !Array.isArray(config.temperature) || config.temperature.length !== 3 || config.temperature.some(value => !Number.isFinite(value) || value <= 0) || (config.temperature_by_options !== undefined && (!config.temperature_by_options || typeof config.temperature_by_options !== "object" || Array.isArray(config.temperature_by_options) || Object.values(config.temperature_by_options).some(value => !Number.isFinite(value) || value <= 0))) || config.condition_classifier !== "ads-conditions-v2") throw new Error("고정 배포 모델의 설정 형식을 확인할 수 없습니다.");
    const tokenizer = createUpstreamTokenizer(json("tokenizer/tokenizer.json"), json("tokenizer/tokenizer_config.json"));
    encode = (text: string) => tokenizer.encode(text, { add_special_tokens: false }).ids;
    session = await ort.InferenceSession.create(files.get("lora.onnx")!, {
      executionProviders: ["wasm"], graphOptimizationLevel: "all",
      externalData: [{ path: "upstream.safetensors", data: files.get("upstream.safetensors")! }, { path: "adapter-heads.bin", data: files.get("adapter-heads.bin")! }],
    });
    abort(options.signal);
    head = await ort.InferenceSession.create(files.get("condition-head.onnx")!, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    abort(options.signal);
  } catch (error) {
    await Promise.allSettled([head?.release(), session?.release()]);
    throw error;
  } finally {
    // ORT has copied the external data; drop download buffers on success and failure.
    files.clear();
  }
  const encoderSession = session, conditionHead = head;
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
      const output = await encoderSession.run({ input_ids: new ort.Tensor("int64", input, [count, length]), attention_mask: new ort.Tensor("int64", attention, [count, length]), marker_pos: new ort.Tensor("int64", positions, [count, width]), marker_mask: new ort.Tensor("bool", mask, [count, width]), qtype: new ort.Tensor("int64", qtype, [count]), lora_strength: strength() });
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
    async close() { if (!closed) { closed = true; await encoderSession.release(); } },
  };
  const agent = createConditionAgent(delegate, encode, {
    async run(feeds, request) {
      if (typeof request !== "string") throw new Error("조건 분류 요청 문자열이 없습니다.");
      const width = 2304;
      const output = await encoderSession.run({ ...toTensors({ ...feeds,
        marker_pos: { type: "int64", data: BigInt64Array.from({ length: width }, (_, index) => BigInt(index)), dims: [1, width] },
        marker_mask: { type: "bool", data: new Uint8Array(width).fill(1), dims: [1, width] },
        qtype: { type: "int64", data: BigInt64Array.from([4n]), dims: [1] },
      }), lora_strength: strength() });
      const values = output.logits?.data;
      if (!(values instanceof Float32Array) || values.length !== width || values.some(value => !Number.isFinite(value))) throw new Error("조건 인코더 결과가 유효하지 않습니다.");
      const features = new Float32Array(width + CONDITION_LEXICAL_WIDTH);
      features.set(values); features.set(conditionTextFeatures(request), width);
      return conditionHead.run({ features: new ort.Tensor("float32", features, [1, features.length]) });
    },
    async release() { await conditionHead.release(); },
  });
  options.progress?.({ stage: "ready", loaded: MODEL_TOTAL_BYTES, total: MODEL_TOTAL_BYTES, ...cacheStatus, message: cacheStatus.cacheWarning ?? `${MODEL_RELEASE.candidate_id} · WASM` });
  return { agent, encode, config };
}
