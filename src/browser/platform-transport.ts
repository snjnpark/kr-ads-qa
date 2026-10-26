import type { Platform } from "../contracts/domain";
import type { AdsPlatformAdapter } from "../platforms/base";
import { PlatformError } from "../platforms/base";
import { MetaAdapter } from "../platforms/meta";
import { NaverAdapter } from "../platforms/naver";
import { KakaoAdapter } from "../platforms/kakao";
import { KakaoKeywordAdapter } from "../platforms/kakao-keyword";
import { GoogleAdapter } from "../platforms/google";
import type { OperationSignal } from "../platforms/http";
import { buildRelayRequest, relayOperation, type RelayPlatform, type RelayRequest } from "../relay/contract";

export const BROWSER_CREDENTIAL_FIELDS: Record<Platform, readonly string[]> = {
  meta: ["access_token"],
  naver: ["api_key", "secret_key", "customer_id"],
  kakao: ["business_token"],
  kakao_keyword: ["business_token"],
  google: ["access_token", "login_customer_id"],
};
export type BrowserTransportOptions = { signal?: AbortSignal; getSignal?: OperationSignal; fetch?: typeof fetch };
const relayOrigins = { naver: "https://api.searchad.naver.com", kakao_keyword: "https://api.keywordad.kakao.com" } as const;
function blocked(): never { throw new PlatformError("WRITE_BLOCKED", "허용된 광고 조회만 실행할 수 있습니다."); }
function params(url: URL) {
  const output: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(output, key)) return blocked();
    output[key] = value;
  }
  return output;
}
/** The only app-server request is a bounded POST to the current origin's relay. */
export function createBrowserTransport(platform: Platform, options: BrowserTransportOptions = {}): typeof fetch {
  const transport = options.fetch || fetch;
  return async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method || "GET").toUpperCase();
    const signals = [init?.signal, options.signal, options.getSignal?.()].filter((value): value is AbortSignal => !!value);
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    signal?.throwIfAborted();
    if (url.username || url.password || url.port || url.hash || url.protocol !== "https:") return blocked();
    if ((platform === "naver" || platform === "kakao_keyword") && url.origin === relayOrigins[platform]) {
      if (method !== "GET" || init?.body != null) return blocked();
      const headers = new Headers(init?.headers);
      const body: RelayRequest = {
        platform: platform as RelayPlatform, ...relayOperation(platform, url.pathname), params: params(url),
        auth: platform === "naver" ? {
          api_key: headers.get("x-api-key") || "", customer_id: headers.get("x-customer") || "",
          timestamp: headers.get("x-timestamp") || "", signature: headers.get("x-signature") || "",
        } : {
          business_token: (headers.get("authorization") || "").replace(/^Bearer /, ""),
          ...(headers.has("adaccountid") ? { account_id: headers.get("adaccountid")! } : {}),
        },
      };
      buildRelayRequest(body); // Apply the same operation/parameter contract before sending.
      return transport("/api/relay", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Laya-Relay": "1" },
        body: JSON.stringify(body), signal, cache: "no-store", credentials: "omit",
        redirect: "error", referrerPolicy: "no-referrer",
      });
    }
    const allowed = platform === "meta" ? url.origin === "https://graph.facebook.com" && method === "GET" && /^\/v26\.0\/[A-Za-z0-9_-]+(?:\/(?:adaccounts|campaigns|adsets|ads|adcreatives|activities))?$/.test(url.pathname)
      : platform === "google" ? url.origin === "https://googleads.googleapis.com" && ((method === "GET" && url.pathname === "/v26/customers:listAccessibleCustomers") || (method === "POST" && /^\/v26\/customers\/[0-9]+\/googleAds:search$/.test(url.pathname)))
      : (platform === "kakao" && url.origin === "https://apis.moment.kakao.com" && method === "GET" && /^\/openapi\/v4\/(?:adAccounts\/pages|(?:adAccounts|campaigns|adGroups|creatives)(?:\/[A-Za-z0-9_-]+)?)$/.test(url.pathname))
        || ((platform === "kakao" || platform === "kakao_keyword") && url.origin === "https://kapi.kakao.com" && url.pathname === "/v1/business/tokeninfo" && method === "GET");
    if (!allowed) return blocked();
    if (method === "GET" && init?.body != null) return blocked();
    if (platform === "google" && method === "POST") {
      let body: unknown;
      try { body = JSON.parse(String(init?.body)); } catch { return blocked(); }
      const query = (body as { query?: unknown } | null)?.query;
      if (typeof query !== "string" || !/^\s*SELECT\s/i.test(query) || query.includes(";")) return blocked();
    }
    for (const key of url.searchParams.keys())
      if (["access_token", "appsecret_proof", "method"].includes(key.toLowerCase())) return blocked();
    return transport(url, { ...init, signal, cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
  };
}
/** Credentials live only in this adapter and the calling tab's memory. No refresh/client secret exchange. */
export function createPlatformAdapter(platform: Platform, credentials: Record<string, string>, options: BrowserTransportOptions = {}): AdsPlatformAdapter {
  if (!Object.hasOwn(BROWSER_CREDENTIAL_FIELDS, platform) || !credentials || Object.entries(credentials).some(([key, value]) => !BROWSER_CREDENTIAL_FIELDS[platform].includes(key) || typeof value !== "string" || !value.trim() || value.length > 8192 || /[\r\n\0]/.test(value)))
    throw new PlatformError("AUTHENTICATION", "브라우저 연결 정보를 확인해 주세요.");
  const required = platform === "google" ? ["access_token"] : platform === "meta" ? ["access_token"] : platform === "naver" ? ["api_key", "secret_key", "customer_id"] : ["business_token"];
  if (required.some((key) => !credentials[key])) throw new PlatformError("AUTHENTICATION", "브라우저 연결 정보를 모두 입력해 주세요.");
  const fetch = createBrowserTransport(platform, options);
  const getSignal = () => {
    const signals = [options.signal, options.getSignal?.()].filter((value): value is AbortSignal => !!value);
    return signals.length ? AbortSignal.any(signals) : undefined;
  };
  if (platform === "meta") return new MetaAdapter(credentials.access_token, { fetch, getSignal });
  if (platform === "naver") return new NaverAdapter(credentials.api_key, credentials.secret_key, credentials.customer_id, { fetch, getSignal });
  if (platform === "kakao") return new KakaoAdapter(credentials.business_token, { fetch, getSignal });
  if (platform === "kakao_keyword") return new KakaoKeywordAdapter(credentials.business_token, { fetch, getSignal });
  return new GoogleAdapter({ ...credentials }, { fetch, getSignal });
}
