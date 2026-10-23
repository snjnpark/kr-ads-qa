import { BrowserStorage } from "./storage";
import { configureSettings, readSettings } from "./settings";
import { configureCredentials } from "./credentials";
import { createBrowserApplication, runtimeInfo } from "@browser-runtime";
import { createApi } from "./api";
import { exportBrowserBackup, parseBrowserBackup } from "./backup";
import { loadPolicy } from "../server/policies/schema";
import defaultPolicy from "./default-policy.json";

const scope = globalThis as unknown as { onmessage: (event: MessageEvent<Call>) => void; postMessage(value: unknown): void };
type Call = { id: number; path: string; method?: string; body?: unknown };
const cancellations = new Map<number, AbortController>();
let cookie = "", csrf = "";
let bootstrap: Promise<unknown> | undefined;
const storagePromise = BrowserStorage.open({ databaseName: `laya-browser-${runtimeInfo.mode}-v1` });
const appPromise = storagePromise.then(async storage => {
  configureSettings(storage);
  const app = await createBrowserApplication(storage, readSettings());
  configureCredentials(app);
  await storage.atomic(async () => {
    if (!app.policies.list().length) app.policies.create(loadPolicy(defaultPolicy));
    await app.initialize();
  });
  app.startScheduler();
  if (app.settings.preload_model) void app.ai.load().catch(() => undefined);
  return app;
});
const api = createApi(() => appPromise);

async function localCall(call: Call): Promise<unknown> {
  const app = await appPromise;
  const pathname = new URL(call.path, "https://browser.invalid").pathname;
  if (pathname === "/model/status") return app.ai.modelStatus;
  if (pathname === "/runtime") return runtimeInfo;
  if (pathname === "/model/load") {
    void app.ai.load().catch(() => undefined);
    return { message: "모델 준비를 시작했습니다.", ...app.ai.modelStatus };
  }
  if (pathname === "/model/cancel") { app.ai.cancel(); return { message: "모델 준비를 중단했습니다." }; }
  if (pathname === "/model/retry") { void app.ai.retry().catch(() => undefined); return { message: "모델 준비를 다시 시작했습니다." }; }
  if (pathname === "/model/import") {
    const files = (call.body as { files?: File[] })?.files;
    if (!Array.isArray(files) || !files.length || files.length > 20 || files.some(file => !(file instanceof File))) throw new Error("모델 파일을 선택해 주세요.");
    void app.ai.importModelFiles(files).catch(() => undefined);
    return { message: "모델 파일의 무결성을 확인하고 있습니다." };
  }
  if (pathname === "/backup/export") return app.mutex.run(async () => { await app.storage.reload(); return { content: await exportBrowserBackup(app.storage) }; });
  if (pathname === "/backup/import") {
    const text = (call.body as { content?: unknown })?.content;
    if (typeof text !== "string") throw new Error("백업 파일을 확인해 주세요.");
    const snapshot = await parseBrowserBackup(text);
    await app.mutex.run(async () => { await app.storage.atomic(() => app.storage.replace(snapshot), { signal: cancellations.get(call.id)?.signal }); for (const adapter of Object.values(app.adapters)) await adapter.close(); app.adapters = {}; await app.initialize(); });
    return { message: "이 브라우저에 백업을 복원했습니다. 인증 정보는 다시 연결해 주세요." };
  }
  const method = call.method ?? "GET";
  if (call.id !== -1 && (!cookie || !csrf)) {
    // The first concurrent screen reads share one local session initialization.
    bootstrap ??= localCall({ id: -1, path: "/state" }).finally(() => { bootstrap = undefined; });
    await bootstrap;
  }
  const request = new Request(new URL(`/api${call.path}`, "https://browser.invalid"), {
    method, signal: cancellations.get(call.id)?.signal, headers: { "Content-Type": "application/json", "X-Laya-Tab": "current-tab", ...(cookie ? { "X-Laya-Worker-Session": cookie } : {}), ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
    ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
  });
  const response = await api(request);
  const returnedCookie = response.headers.get("x-laya-worker-session");
  if (returnedCookie) cookie = returnedCookie;
  const data = await response.json();
  if (!response.ok) {
    if (data.code === "SESSION_EXPIRED") { cookie = ""; csrf = ""; }
    throw new Error(data.message ?? "작업을 완료하지 못했습니다.");
  }
  if (data && typeof data.csrf_token === "string") csrf = data.csrf_token;
  return data;
}

scope.onmessage = async event => {
  const call = event.data;
  if (!call || !Number.isSafeInteger(call.id)) return;
  if (call.path === "/__cancel") { cancellations.get(call.id)?.abort(); return; }
  if (typeof call.path !== "string") return;
  cancellations.set(call.id, new AbortController());
  try { scope.postMessage({ id: call.id, result: await localCall(call) }); }
  catch (error) {
    // Reload the committed generation after failed persistence, without sending data to a server.
    try { const app = await appPromise; await app.mutex.run(async () => { await app.storage.reload(); await app.initialize(); }); } catch { /* Preserve the original failure. */ }
    scope.postMessage({ id: call.id, error: error instanceof Error && error.message.length < 1200 ? error.message : "브라우저 작업을 완료하지 못했습니다." });
  } finally { cancellations.delete(call.id); }
};
