import { BrowserApplication } from "./application";
import { BrowserLayaEngine, type BrowserEngineOptions } from "./model/engine";
import type { BrowserStorage } from "./storage";
import type { Settings } from "../contracts/domain";

export const runtimeInfo = { mode: "production", label: "프로덕션 · 이 브라우저에서 처리" };
export async function createBrowserApplication(storage: BrowserStorage, settings: Settings, modelOptions: BrowserEngineOptions = {}) {
  return new BrowserApplication(settings, { storage, ai: new BrowserLayaEngine({ threshold: settings.semantic_threshold, batchSize: settings.batch_size, ...modelOptions }) });
}
