import type { Policy, Rule } from "../contracts/policy";
import { POLICY_PLATFORMS, type PolicyPlatform } from "./policy-conditions";

export type RulePreset = {
  id: string;
  label: string;
  description: string;
  field: string;
  operator: NonNullable<Rule["check"]["operator"]>;
  value?: unknown;
  entity: string;
  kind: "money" | "number" | "text" | "status" | "required";
};
export const RUNNING_STATUSES = ["ACTIVE", "ENABLED", "ON", "ELIGIBLE", "NORMAL"];
export const PAUSED_STATUSES = ["PAUSED", "DISABLED", "OFF", "STOPPED"];
export const COMMON_PRESETS: RulePreset[] = [
  { id: "daily_max", label: "일예산 상한", description: "설정한 금액 이하로 운영합니다. 상위 예산 상속을 포함합니다.", field: "effective_daily_budget", operator: "lte", value: "50000", entity: "adgroup", kind: "money" },
  { id: "daily_min", label: "일예산 하한", description: "설정한 금액 이상으로 운영합니다.", field: "effective_daily_budget", operator: "gte", value: "1", entity: "adgroup", kind: "money" },
  { id: "status", label: "운영 상태", description: "정책에 맞는 운영 상태인지 확인합니다.", field: "status", operator: "in", value: RUNNING_STATUSES, entity: "campaign", kind: "status" },
  { id: "end", label: "종료일 필수", description: "종료일이 설정되어 있어야 합니다.", field: "schedule.end", operator: "is_not_empty", entity: "campaign", kind: "required" },
  { id: "url", label: "도착 URL 필수", description: "광고에 도착 페이지 주소가 있어야 합니다.", field: "tracking.url", operator: "is_not_empty", entity: "ad", kind: "required" },
  { id: "tracking", label: "필수 추적 태그", description: "지정한 추적 매개변수를 포함해야 합니다. 한 조건에 태그 하나를 지정합니다.", field: "tracking.parameters", operator: "contains", value: "utm_source", entity: "ad", kind: "text" },
];
const bid: RulePreset = { id: "bid", label: "최대 입찰가", description: "설정한 금액을 넘는 입찰가를 찾습니다.", field: "bid.amount", operator: "lte", value: "1000", entity: "keyword", kind: "money" };
const lifetime: RulePreset = { id: "lifetime", label: "총예산 상한", description: "설정한 총예산 한도를 넘지 않아야 합니다.", field: "effective_lifetime_budget", operator: "lte", value: "1000000", entity: "adgroup", kind: "money" };
const audience: RulePreset[] = [
  { id: "audience", label: "오디언스 필수", description: "맞춤 오디언스가 하나 이상 설정되어 있어야 합니다.", field: "targeting.custom_audiences", operator: "is_not_empty", entity: "adgroup", kind: "required" },
  { id: "approved", label: "승인 오디언스 포함", description: "아래에 등록한 승인 오디언스 중 하나 이상을 포함해야 합니다.", field: "targeting.approved_retarg_audience_present", operator: "eq", value: true, entity: "adgroup", kind: "required" },
  { id: "age_min", label: "최소 연령", description: "타겟의 최소 연령이 이 값 이상이어야 합니다.", field: "targeting.age_min", operator: "gte", value: "18", entity: "adgroup", kind: "number" },
  { id: "age_max", label: "최대 연령", description: "타겟의 최대 연령이 이 값 이하여야 합니다.", field: "targeting.age_max", operator: "lte", value: "65", entity: "adgroup", kind: "number" },
  { id: "country", label: "필수 포함 국가", description: "지정한 국가를 타겟에 포함해야 합니다. 예: KR", field: "targeting.countries", operator: "contains", value: "KR", entity: "adgroup", kind: "text" },
  { id: "event", label: "전환 이벤트", description: "설정된 전환 이벤트가 기준값과 일치해야 합니다.", field: "optimization.event", operator: "eq", value: "PURCHASE", entity: "adgroup", kind: "text" },
];
export const MEDIA_PRESETS: Record<PolicyPlatform, RulePreset[]> = {
  meta: [lifetime, ...audience],
  naver: [bid],
  google: [lifetime, bid, { id: "strategy", label: "입찰 전략", description: "설정된 입찰 전략이 기준값과 일치해야 합니다.", field: "bid.strategy", operator: "eq", value: "MAXIMIZE_CONVERSIONS", entity: "campaign", kind: "text" }],
  kakao: [lifetime, ...audience],
  kakao_keyword: [bid],
};

export function emptyPolicy(id: string): Policy {
  return { policy_id: id, name: "", version: 1, platforms: [...POLICY_PLATFORMS], account_ids: [], evaluation_mode: "conditions", settings: { allowed_countries: [], required_utm: [], approved_audiences: [], require_promotion_end: false }, rules: [] };
}
export function ruleFromPreset(preset: RulePreset, section: "common" | PolicyPlatform, id: string): Rule {
  return { rule_id: id, name: preset.label, entity: preset.entity, platforms: section === "common" ? [] : [section], account_ids: [], enabled: true, severity: "error", check: { field: preset.field, operator: preset.operator, ...(preset.value !== undefined ? { value: structuredClone(preset.value) } : {}) } };
}
export function matchesPreset(rule: Rule, preset: RulePreset): boolean {
  return rule.platforms.length <= 1 && !rule.when && !rule.exclude && !rule.account_ids.length && rule.check.field === preset.field && rule.check.operator === preset.operator &&
    (preset.kind !== "required" || rule.check.value === preset.value);
}
export function policyDocument(policy: Policy): string {
  const { yaml: _yaml, ...document } = policy as Policy & { yaml?: string };
  return JSON.stringify(document);
}
