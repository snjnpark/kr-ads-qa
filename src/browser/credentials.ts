import { operationFetch } from "./operation-context";
import type { Platform } from "../contracts/domain";
import { BROWSER_CREDENTIAL_FIELDS, createPlatformAdapter } from "./platform-transport";
import type { BrowserApplication } from "./application";
export const NAMES = BROWSER_CREDENTIAL_FIELDS;
let application: BrowserApplication;
export function configureCredentials(value: BrowserApplication) { application = value; }
export async function saveCredentials(platform: Platform, values: unknown) {
  if (!(platform in NAMES) || !values || typeof values !== "object" || Array.isArray(values)) throw new Error("매체 인증 정보를 확인해 주세요.");
  const entries = Object.entries(values);
  if (!entries.length || entries.some(([k,v]) => !NAMES[platform].includes(k) || typeof v !== "string" || !v.trim() || v.length > 65536 || /[\r\n\0]/.test(v))) throw new Error("매체 인증 항목을 확인해 주세요.");
  const adapter = createPlatformAdapter(platform, values as Record<string,string>, { fetch: operationFetch });
  await application.adapters[platform]?.close();
  application.adapters[platform] = adapter;
  application.lastSync = null;
}
