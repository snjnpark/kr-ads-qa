import { FIELD_LABELS, valueText, conditionText, entityNames, platformNames } from "@/lib/display";
import { parseStoredValue } from "@/lib/evidence";

const operationNames: Record<string, string> = {
  ACTIVE: "운영 중",
  ENABLED: "운영 중",
  ON: "운영 중",
  ELIGIBLE: "운영 가능",
  NORMAL: "정상",
  PAUSED: "중지",
  DISABLED: "사용 중지",
  OFF: "중지",
  STOPPED: "중지",
  DELETED: "삭제됨",
  REMOVED: "삭제됨",
  ARCHIVED: "보관됨",
  DISAPPROVED: "심사 거절",
  REJECTED: "심사 거절",
  APPROVED: "심사 승인",
  PENDING: "심사 대기",
  SUSPENDED: "정지됨",
  WITH_ISSUES: "문제 있음",
  LIMITED: "제한됨",
  SYSTEM_STOPPED: "시스템에서 중지",
};
const goalNames: Record<string, string> = {
  OFFSITE_CONVERSIONS: "외부 사이트 전환",
  LINK_CLICKS: "링크 클릭",
  LANDING_PAGE_VIEWS: "랜딩 페이지 조회",
  REACH: "도달",
  IMPRESSIONS: "노출",
  AD_RECALL_LIFT: "광고 회상 증가",
};
const bidNames: Record<string, string> = {
  LOWEST_COST_WITHOUT_CAP: "입찰가 상한 없는 최저 비용",
  LOWEST_COST_WITH_BID_CAP: "입찰가 상한을 적용한 최저 비용",
  BID_CAP: "입찰가 상한",
  COST_CAP: "비용 상한",
  MANUAL_CPC: "수동 클릭당 입찰",
};

/** Display known settings without changing the stored value or exported record. */
export function settingValueText(value: unknown, field?: string): string {
  const parsed = parseStoredValue(value);
  if (Array.isArray(parsed))
    return parsed.length
      ? parsed.map((item) => settingValueText(item, field)).join(", ")
      : valueText(parsed);
  if (parsed && typeof parsed === "object")
    return Object.entries(parsed)
      .map(
        ([key, item]) =>
          `${FIELD_LABELS[key] ?? key}: ${settingValueText(item, key)}`,
      )
      .join(", ");
  if (typeof parsed !== "string") return valueText(parsed);
  if (field === "platform") return platformNames[parsed] ?? parsed;
  if (field === "entity_type" || field === "budget.level")
    return entityNames[parsed] ?? (parsed === "entity" ? "이 항목" : parsed);
  if (field === "optimization.goal") return goalNames[parsed] ?? parsed;
  if (field === "bid.strategy") return bidNames[parsed] ?? parsed;
  if (field && /(?:^|\.|_)status$/.test(field))
    return operationNames[parsed] ?? parsed;
  if (field === "budget.unit" && parsed === "major") return "통화 기본 단위";
  return valueText(parsed);
}

const criterionNames: Record<string, string> = {
  "start <= end": "시작일이 종료일보다 늦지 않음",
  "age_min <= age_max": "최소 연령이 최대 연령을 넘지 않음",
  "활성 객체의 상위 객체 활성": "운영 중인 항목의 상위 항목도 운영 중",
  "활성 객체 집행 제한 없음": "운영 중인 항목에 집행 제한 없음",
  "종료일 이후 활성 상태 확인": "종료일이 지난 항목이 운영 중인지 확인",
  "시작일 이전 활성 상태 확인": "시작일 전 항목이 운영 중인지 확인",
  "조회 가능한 IANA 시간대": "유효한 계정 시간대",
  "major (통화 기본 단위)": "통화 기본 단위로 입력된 금액",
  "빈 문자열이 아닌 소재 문구": "소재 문구가 입력되어 있음",
  "http(s)://host": "http:// 또는 https://로 시작하는 유효한 주소",
  "중복 query key 없음": "URL 매개변수 중복 없음",
};

export function criterionText(value: unknown): string {
  const parsed = parseStoredValue(value);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (
      "field" in parsed ||
      "all" in parsed ||
      "any" in parsed ||
      "not" in parsed
    )
      return conditionText(parsed);
    return settingValueText(parsed);
  }
  if (typeof parsed !== "string") return valueText(parsed);
  const text = parsed.trim();
  if (criterionNames[text]) return criterionNames[text];
  if (operationNames[text]) return operationNames[text];
  const comparison = /^(<=|>=|<|>)\s+(.+)$/.exec(text);
  if (comparison) {
    const suffix: Record<string, string> = {
      "<=": "이하",
      ">=": "이상",
      "<": "미만",
      ">": "초과",
    };
    return `${comparison[2]} ${suffix[comparison[1]]}`;
  }
  return parsed;
}
