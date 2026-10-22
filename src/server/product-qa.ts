import type { Entity, Json, ResultStatus } from "./models";
import { observe } from "./policies/evaluation";
import { productCode } from "../lib/ad-products";

export const PRODUCT_RULES: Record<string, { label: string; base: string }> = {
  PRODUCT_APP: { label: "앱 캠페인의 앱·스토어 연결", base: "CREATIVE_001" },
  PRODUCT_SHOPPING: { label: "쇼핑 캠페인의 판매자 계정 연결", base: "CREATIVE_001" },
  PRODUCT_SHOPPING_STATUS: { label: "쇼핑 상품의 집행 상태와 문제", base: "CREATIVE_001" },
  PRODUCT_HOTEL: { label: "호텔 캠페인의 Hotel Center 연결", base: "CREATIVE_001" },
  PRODUCT_ASSETS: { label: "PMax 자산 연결의 참조 무결성", base: "CREATIVE_001" },
  PRODUCT_KAKAO_LINK: { label: "프리미엄링크 소재연결의 원본 소재", base: "CREATIVE_001" },
  PRODUCT_CONTRACT: { label: "검색광고 계약의 집행기간", base: "SCHEDULE_001" },
};

export function productRuleResults(entity: Entity, index: Map<string, Entity>): Json[] {
  const results: Json[] = [];
  const check = (id: string, paths: string[], predicate: (...values: any[]) => boolean | null | ResultStatus) => {
    const observed = paths.map(path => observe(entity, path));
    let status: ResultStatus;
    if (observed.some(item => item.state === "NOT_APPLICABLE" || item.state === "NOT_SUPPORTED")) status = "NOT_APPLICABLE";
    else if (observed.some(item => !item.known)) status = "UNKNOWN";
    else {
      try { const valid = predicate(...observed.map(item => item.value)); status = typeof valid === "string" ? valid : valid === null ? "UNKNOWN" : valid ? "PASS" : "FAIL"; }
      catch { status = "UNKNOWN"; }
    }
    const fields = Object.fromEntries(paths.map((path, i) => [path, observed[i]]));
    results.push({ rule_id: id, platform: entity.platform, account_id: entity.account_id, entity_id: entity.entity_id, entity_name: entity.name,
      status, severity: "error", expected: PRODUCT_RULES[id].label, actual: Object.fromEntries(paths.map((path, i) => [path, observed[i].value])),
      evidence: { ...fields, entity_key: entity.key, fetched_at: entity.fetched_at, rule_description: PRODUCT_RULES[id].label }, checked_at: new Date().toISOString(), model_version: null, scores: {} });
  };
  const present = (value: unknown) => (typeof value === "string" || typeof value === "number") && !!String(value).trim();
  if (entity.platform === "google" && entity.entity_type === "campaign") {
    const code = productCode(entity);
    if (code === "MULTI_CHANNEL") check("PRODUCT_APP", ["extensions.product_settings.appCampaignSetting.appId", "extensions.product_settings.appCampaignSetting.appStore"], (id, store) => {
      if (!present(id) || !present(store) || ["UNKNOWN", "UNSPECIFIED"].includes(store)) return false;
      if (store === "APPLE_APP_STORE") return /^\d+$/.test(String(id)) && BigInt(String(id)) > 0n;
      if (store === "GOOGLE_APP_STORE") return typeof id === "string" && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(id);
      return null;
    });
    if (code === "SHOPPING" || (code === "PERFORMANCE_MAX" && entity.extensions.product_settings?.shoppingSetting))
      check("PRODUCT_SHOPPING", ["extensions.product_settings.shoppingSetting.merchantId"], id => present(id) && /^\d+$/.test(String(id)) && BigInt(String(id)) > 0n);
    if (code === "HOTEL") check("PRODUCT_HOTEL", ["extensions.product_settings.hotelSetting.hotelCenterId"], id => present(id) && /^\d+$/.test(String(id)) && BigInt(String(id)) > 0n);
    if (entity.fields["extensions.shopping_products"] || entity.extensions.shopping_products !== undefined)
      check("PRODUCT_SHOPPING_STATUS", ["extensions.shopping_products", "status"], (products, status) => {
        if (["PAUSED", "DISABLED", "OFF", "REMOVED", "DELETED"].includes(status)) return "NOT_APPLICABLE";
        if (!["ACTIVE", "ENABLED", "ON", "ELIGIBLE"].includes(status)) return "UNKNOWN";
        if (!Array.isArray(products) || !products.length) return "UNKNOWN";
        if (products.some(item => item?.status === "NOT_ELIGIBLE")) return "FAIL";
        if (products.some(item => !["ELIGIBLE", "ELIGIBLE_LIMITED"].includes(item?.status))) return "UNKNOWN";
        return products.some(item => item.status === "ELIGIBLE_LIMITED") ? "WARNING" : "PASS";
      });
  }
  if (entity.platform === "google" && entity.entity_type === "asset_group" && entity.extensions.creative_container === true)
    check("PRODUCT_ASSETS", ["extensions.assets"], assets => Array.isArray(assets) && assets.every((item: Json) => !!item?.asset));
  if (entity.platform === "kakao_keyword" && entity.entity_type === "ad")
    check("PRODUCT_KAKAO_LINK", ["extensions.creative_id"], id => index.has(`${entity.platform}/${entity.account_id}/creative/${id}`) ? true : null);
  if (entity.platform === "naver" && ["time_contract", "brand_new_contract"].includes(entity.entity_type))
    check("PRODUCT_CONTRACT", ["schedule.start", "schedule.end"], (start, end) => Number.isFinite(Date.parse(start)) && Number.isFinite(Date.parse(end)) && Date.parse(start) <= Date.parse(end));
  return results;
}
