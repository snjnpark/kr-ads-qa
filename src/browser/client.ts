let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
function applicationWorker() {
  if (worker) return worker;
  if (typeof window === "undefined" || !window.isSecureContext || typeof Worker === "undefined" || !globalThis.indexedDB) throw new Error("HTTPS 또는 localhost의 최신 브라우저에서 열어 주세요.");
  worker = new Worker(new URL("./application.worker.ts", import.meta.url), { type: "module", name: "laya-browser-workspace" });
  worker.onmessage = event => {
    const message = event.data, call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (typeof message.error === "string") call.reject(new Error(message.error)); else call.resolve(message.result);
  };
  worker.onerror = () => {
    for (const call of pending.values()) call.reject(new Error("브라우저 실행기를 시작하지 못했습니다. 새로고침해 주세요."));
    pending.clear(); worker?.terminate(); worker = undefined;
  };
  return worker;
}
export function browserCall<T = unknown>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new DOMException("중단했습니다.", "AbortError")); return; }
    const id = ++sequence;
    const stop = () => { worker?.postMessage({ id, path: "/__cancel" }); pending.delete(id); reject(new DOMException("중단했습니다.", "AbortError")); };
    options.signal?.addEventListener("abort", stop, { once: true });
    const finish = () => options.signal?.removeEventListener("abort", stop);
    pending.set(id, { resolve(value) { finish(); resolve(value as T); }, reject(error) { finish(); reject(error); } });
    try { applicationWorker().postMessage({ id, path, method: options.method, body: options.body }); }
    catch (error) { pending.delete(id); finish(); reject(error); }
  });
}
