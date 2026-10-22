import type { Rule, Policy } from "../contracts/policy";

export const POLICY_PLATFORMS = ["meta", "naver", "google", "kakao", "kakao_keyword"] as const;
export type PolicyPlatform = typeof POLICY_PLATFORMS[number];
export const CONDITION_FIELDS = [
  { field: "effective_daily_budget", label: "일예산", kind: "money", media: [] },
  { field: "currency", label: "통화", kind: "text", media: [] },
  { field: "status", label: "운영 상태", kind: "text", media: [] },
  { field: "schedule.end", label: "종료일", kind: "date", media: [] },
  { field: "schedule.start", label: "시작일", kind: "date", media: [] },
  { field: "tracking.url", label: "도착 URL", kind: "text", media: [] },
  { field: "tracking.parameters", label: "추적 매개변수", kind: "text", media: [] },
  { field: "name", label: "이름", kind: "text", media: [] },
  { field: "extensions.product_type", label: "광고상품 코드", kind: "text", media: [] },
  { field: "extensions.product_settings.appCampaignSetting.appId", label: "광고 앱 ID", kind: "text", media: ["google"] },
  { field: "extensions.product_settings.shoppingSetting.merchantId", label: "Merchant Center 계정", kind: "text", media: ["google"] },
  { field: "extensions.product_settings.hotelSetting.hotelCenterId", label: "Hotel Center 계정", kind: "text", media: ["google"] },
  { field: "extensions.creative_id", label: "연결 원본 소재 ID", kind: "text", media: ["kakao_keyword"] },
  { field: "bid.amount", label: "입찰가", kind: "money", media: [] },
  { field: "effective_lifetime_budget", label: "총예산", kind: "money", media: ["meta", "google", "kakao"] },
  { field: "targeting.age_min", label: "최소 연령", kind: "number", media: ["meta", "kakao"] },
  { field: "targeting.age_max", label: "최대 연령", kind: "number", media: ["meta", "kakao"] },
  { field: "targeting.countries", label: "국가", kind: "list", media: ["meta", "kakao"] },
  { field: "targeting.custom_audiences", label: "포함 오디언스", kind: "list", media: ["meta", "kakao"] },
  { field: "targeting.approved_retarg_audience_present", label: "승인 오디언스 존재", kind: "boolean", media: ["meta", "kakao"] },
  { field: "targeting.excluded_audiences", label: "제외 오디언스", kind: "list", media: ["meta", "kakao"] },
  { field: "optimization.objective", label: "캠페인 목적", kind: "text", media: ["meta", "kakao"] },
  { field: "optimization.goal", label: "최적화 목표", kind: "text", media: ["meta", "kakao"] },
  { field: "optimization.event", label: "전환 이벤트", kind: "text", media: ["meta", "kakao"] },
] as const;

export const CONDITION_OPERATORS = {
  eq: "같음", ne: "다름", gte: "이상", lte: "이하", gt: "초과", lt: "미만",
  contains: "포함", not_contains: "미포함", in: "목록 중 하나", not_in: "목록에 없음",
  is_not_empty: "필수 설정", is_empty: "미설정", exists: "값 존재", regex: "패턴 일치",
};

export function activePolicyRules(rules: Rule[], platform: string, accountId?: string): Rule[] {
  const applicable = rules.filter(rule => rule.enabled && (!rule.platforms.length || rule.platforms.includes(platform as PolicyPlatform)) &&
    (accountId === undefined || !rule.account_ids.length || rule.account_ids.includes(accountId)));
  return applicable.filter(rule => rule.platforms.length || !rule.check.field || rule.when || rule.exclude ||
    !applicable.some(other => other.platforms.length && other.entity === rule.entity && !other.when && !other.exclude &&
      other.check.field === rule.check.field && other.check.operator === rule.check.operator &&
      JSON.stringify(other.account_ids) === JSON.stringify(rule.account_ids)));
}

export function policyConditionCount(policy: Policy | undefined, platforms?: string[]): number {
  if (!policy) return 0;
  return new Set(policy.platforms.filter(platform => !platforms?.length || platforms.includes(platform))
    .flatMap(platform => activePolicyRules(policy.rules, platform).map(rule => rule.rule_id))).size;
}
