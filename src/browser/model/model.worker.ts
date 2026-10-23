import { QueryModelError } from "../../server/query-model";
import { BrowserModelCore } from "./engine-core";
import type { WorkerRequest, WorkerResponse } from "./protocol";
const worker = globalThis as unknown as { postMessage(value: WorkerResponse): void; onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null };
let core: BrowserModelCore | undefined;
let queue = Promise.resolve();
worker.onmessage = event => {
  const request = event.data;
  queue = queue.catch(() => undefined).then(async () => {
    if (!request || !Number.isSafeInteger(request.id) || request.id < 1) return;
    try {
      core ??= new BrowserModelCore({ ...request.settings, ...(request.method === "load" ? { files: request.files } : {}), progress: value => worker.postMessage({ type: "progress", value }) });
      let result: unknown;
      if (request.method === "load") { await core.load(); result = { model_version: core.modelVersion }; }
      else if (request.method === "parseQuery") result = await core.parseQuery(...request.args);
      else if (request.method === "classify") result = await core.classify(...request.args);
      else if (request.method === "judgeBatch") result = await core.judgeBatch(...request.args);
      else throw new Error("지원하지 않는 모델 작업입니다.");
      worker.postMessage({ type: "result", id: request.id, result });
    } catch (error) {
      worker.postMessage({ type: "error", id: request.id, error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : "브라우저 모델을 실행하지 못했습니다.", ...(error instanceof QueryModelError ? { trace: error.trace } : {}) } });
    }
  });
};
