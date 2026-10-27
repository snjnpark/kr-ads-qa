import type { QueryContext } from "../../domain/query/query";
import { QueryModelError, type interpretQuery } from "../../domain/query/query-model";
import { MODEL_RELEASE, MODEL_TOTAL_BYTES } from "./cache";
import { MODEL_VERSION } from "./model-version";
import type { Decision, SemanticInput, ModelProgress, EngineSettings, WorkerRequest, WorkerResponse } from "./protocol";
export { semanticIdentity, semanticState, SEMANTIC_POLICY_VERSION, QUESTION_SCHEMA_VERSION } from "./identity";
export type { Decision, SemanticInput, ModelProgress } from "./protocol";
type WorkerOperation = WorkerRequest extends infer T ? T extends WorkerRequest ? Omit<T, "id" | "settings"> : never : never;
export type BrowserEngineOptions = EngineSettings & { onProgress?: (value: ModelProgress) => void; workerFactory?: () => Worker };
/** Application-compatible facade. All model and question computation stays in the Worker. */
export class BrowserLayaEngine {
  readonly mock = false;
  readonly threshold: number;
  readonly margin: number;
  readonly batchSize: number;
  readonly cpuThreads = 1;
  readonly modelKind = "candidate";
  readonly candidateId = MODEL_RELEASE.candidate_id;
  readonly modelDirectory = "browser-public-model-cache";
  private worker?: Worker;
  private sequence = 0;
  private pending = new Map<number, { method: WorkerRequest["method"]; resolve(value: unknown): void; reject(error: Error): void }>();
  private listeners = new Set<(value: ModelProgress) => void>();
  private ready = false;
  private progress: ModelProgress = { stage: "download", loaded: 0, total: MODEL_TOTAL_BYTES };
  constructor(private options: BrowserEngineOptions = {}) {
    this.threshold = options.threshold ?? 0.8;
    this.margin = options.margin ?? 0.1;
    this.batchSize = options.batchSize ?? 8;
    if (!Number.isFinite(this.threshold) || this.threshold < 0 || this.threshold > 1 || !Number.isFinite(this.margin) || this.margin < 0 || this.margin > 1 || !Number.isInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 256) throw new Error("의미 판단 설정값이 올바르지 않습니다.");
    if (options.onProgress) this.listeners.add(options.onProgress);
  }
  get source() { return "laya"; }
  get modelVersion() { return MODEL_VERSION; }
  get modelStatus() { return { ...this.progress, ready: this.ready, loading: [...this.pending.values()].some(request => request.method === "load"), model_version: this.modelVersion }; }
  subscribe(listener: (value: ModelProgress) => void) { this.listeners.add(listener); listener(this.progress); return () => { this.listeners.delete(listener); }; }
  private emit(progress: ModelProgress) { this.progress = progress; if (progress.stage === "ready") this.ready = true; for (const listener of this.listeners) { try { listener(progress); } catch { /* A view listener must not interrupt inference. */ } } }
  private ensureWorker() {
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined" && !this.options.workerFactory) throw new Error("이 브라우저는 모델 Worker를 지원하지 않습니다.");
    const worker = this.options.workerFactory?.() ?? new Worker(new URL("./model.worker.ts", import.meta.url), { type: "module", name: "laya-local-model" });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response.type === "progress") { this.emit(response.value); return; }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.type === "result") pending.resolve(response.result);
      else {
        const error = response.error.trace ? new QueryModelError(response.error.message, response.error.trace, response.error.request) : new Error(response.error.message); error.name = response.error.name;
        if (pending.method === "load" || !this.ready) this.emit({ stage: "error", loaded: this.progress.loaded, total: MODEL_TOTAL_BYTES, message: error.message }); pending.reject(error);
      }
    };
    worker.onerror = event => { event.preventDefault(); this.stop(new Error("브라우저 모델 Worker 실행이 중단되었습니다. 모델을 다시 준비해 주세요.")); };
    this.worker = worker; return worker;
  }
  private request<T>(operation: WorkerOperation): Promise<T> {
    const settings: EngineSettings = { threshold: this.threshold, margin: this.margin, batchSize: this.batchSize, baseUrl: this.options.baseUrl ?? process.env.NEXT_PUBLIC_LAYA_MODEL_BASE_URL };
    return new Promise((resolve, reject) => {
      let id: number | undefined;
      try {
        const worker = this.ensureWorker(); id = ++this.sequence;
        this.pending.set(id, { method: operation.method, resolve: value => resolve(value as T), reject });
        worker.postMessage({ ...operation, id, settings } as WorkerRequest);
      } catch (error) { if (id !== undefined) this.pending.delete(id); reject(error); }
    });
  }
  private stop(error: Error) {
    this.worker?.terminate(); this.worker = undefined; this.ready = false;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear(); this.emit({ stage: "error", loaded: this.progress.loaded, total: MODEL_TOTAL_BYTES, message: error.message });
  }
  cancel() { this.stop(new DOMException("모델 준비 또는 추론을 취소했습니다.", "AbortError")); }
  async close() { this.stop(new DOMException("모델을 닫았습니다.", "AbortError")); }
  async load(): Promise<{ model_version: string }> { return this.request({ method: "load" }); }
  async retry() { this.cancel(); return this.load(); }
  async importModelFiles(files: File[]) {
    if (!files.length) throw new Error("검증할 모델 폴더를 선택해 주세요.");
    this.cancel(); return this.request<{ model_version: string }>({ method: "load", files });
  }
  parseQuery(text: string, context?: QueryContext, now = new Date(), timezone = "Asia/Seoul") { return this.request<Awaited<ReturnType<typeof interpretQuery>>>({ method: "parseQuery", args: [text, context, now, timezone] }); }
  classify(text: string) { return this.request<Decision>({ method: "classify", args: [text] }); }
  judgeBatch(items: SemanticInput[], question: string) { return this.request<Decision[]>({ method: "judgeBatch", args: [items, question] }); }
}
