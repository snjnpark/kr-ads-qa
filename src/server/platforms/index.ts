import { PLATFORMS, type Platform, type Settings } from "../models";
import type { Credentials } from "../credentials";
import { BaseAdapter, PlatformError, type AdsPlatformAdapter } from "./base";
import type { FetchLike } from "./http";
import { MetaAdapter } from "./meta";
import { NaverAdapter } from "./naver";
import { KakaoAdapter } from "./kakao";
import { KakaoKeywordAdapter } from "./kakao-keyword";
import { GoogleAdapter } from "./google";
export * from "./base";
export { MetaAdapter, NaverAdapter, KakaoAdapter, KakaoKeywordAdapter, GoogleAdapter };
class FailedAdapter extends BaseAdapter {
  readonly capabilities = { connection: "REQUIRES_PERMISSION" };
  constructor(readonly platform: Platform) {
    super();
  }
  private fail(): never {
    throw new PlatformError(
      "CONFIGURATION",
      "광고 API 인증 설정을 확인해 주세요.",
    );
  }
  async listAccounts() {
    return this.fail();
  }
  async listCampaigns(_id: string) {
    return this.fail();
  }
  async listAdgroups(_id: string) {
    return this.fail();
  }
  async listAds(_id: string) {
    return this.fail();
  }
  async getEntity(_kind: string, _id: string, _accountId = "") {
    return this.fail();
  }
}
export function getAdapters(
  settings: Settings,
  credentials: Credentials = {},
  options: { fetch?: FetchLike } = {},
): Record<string, AdsPlatformAdapter> {
  if (settings.mode !== "live") throw new Error("실제 광고 계정만 사용할 수 있습니다.");
  const adapters: Record<string, AdsPlatformAdapter> = {};
  for (const platform of PLATFORMS) {
    const values = credentials[platform];
    if (!values) continue;
    try {
      adapters[platform] =
        platform === "meta"
          ? new MetaAdapter(values.access_token, options)
          : platform === "naver"
            ? new NaverAdapter(
                values.api_key,
                values.secret_key,
                values.customer_id,
                options,
              )
            : platform === "kakao"
              ? new KakaoAdapter(values.business_token, options)
              : platform === "kakao_keyword"
                ? new KakaoKeywordAdapter(values.business_token, options)
              : new GoogleAdapter(values, options);
    } catch {
      adapters[platform] = new FailedAdapter(platform);
    }
  }
  return adapters;
}
