export const platforms: Record<string, string> = {
  meta: "Meta",
  naver: "NAVER",
  kakao: "카카오모먼트",
  kakao_keyword: "카카오 키워드광고",
  google: "Google",
};
export function platformLabel(platform: string): string {
  return platforms[platform] ?? platform;
}
export const FIELD_LABELS: Record<string, string> = {
  __entity__: "광고 항목",
  platform: "매체",
  "extensions.product_type": "광고상품 코드",
  parent_id: "상위 항목 ID",
  entity_id: "매체 ID",
  entity_type: "항목 유형",
  account_id: "광고 계정 ID",
  "budget.level": "예산 적용 위치",
  "budget.inherited_from": "예산을 가져온 항목 ID",
  "extensions.declared_purpose": "광고 목적 설명",
  "extensions.creative_audit_status": "소재 심사 상태",
  "targeting.approved_retarg_audience_present": "승인된 맞춤 타겟 사용 여부",
  effective_daily_budget: "유효 일예산",
  effective_lifetime_budget: "유효 총예산",
  "budget.daily": "일예산",
  "budget.lifetime": "총예산",
  "budget.unit": "금액 단위",
  "bid.strategy": "입찰 전략",
  "bid.amount": "입찰가",
  "schedule.start": "시작일",
  "schedule.end": "종료일",
  "targeting.age_min": "최소 연령",
  "targeting.age_max": "최대 연령",
  "targeting.countries": "타겟 국가",
  "targeting.custom_audiences": "포함 맞춤 타겟",
  "targeting.excluded_audiences": "제외 타겟",
  "optimization.objective": "캠페인 목적",
  "optimization.goal": "최적화 목표",
  "optimization.event": "전환 이벤트",
  "tracking.url": "연결 URL",
  "tracking.parameters": "추적 파라미터",
  "extensions.review_status": "심사 상태",
  "parent.status": "상위 운영 상태",
  name: "이름",
  status: "운영 상태",
  effective_status: "실제 운영 상태",
  currency: "통화",
  timezone: "시간대",
  text: "광고 문구",
  created_at: "생성일",
  daily_budget: "일예산",
  peer_median: "비교 그룹 중간값",
};
export function valueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "예" : "아니요";
  if (typeof value === "object")
    return Array.isArray(value)
      ? value.map(valueText).join(", ") || "빈 목록"
      : Object.entries(value)
          .map(
            ([key, item]) => `${FIELD_LABELS[key] ?? key}: ${valueText(item)}`,
          )
          .join(" · ") || "빈 값";
  return String(value);
}
export function dateText(value: unknown, short = false) {
  if (!value) return "조회 전";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat("ko-KR", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        ...(short ? {} : { year: "numeric" }),
      }).format(date);
}
export function money(value: unknown, currency = "KRW") {
  if (value === "—" || value === null || value === undefined || value === "")
    return "—";
  const text = String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return text;
  const [whole, fraction] = text.split(".");
  const grouped =
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (fraction ? `.${fraction}` : "");
  const symbol = (
    { KRW: "₩", USD: "US$", JPY: "JP¥", EUR: "€", GBP: "£" } as Record<
      string,
      string
    >
  )[currency];
  return symbol ? `${symbol}${grouped}` : `${grouped} ${currency}`;
}
export const platformNames: Record<string, string> = {
  ...platforms,
  naver: "네이버",
};
export const severityNames: Record<string, string> = {
  critical: "긴급",
  error: "오류",
  warning: "주의",
  review: "검토",
  info: "안내",
};
export const entityNames: Record<string, string> = {
  ad_extension: "확장소재", business_channel: "비즈채널", product_group: "상품그룹", time_contract: "브랜드검색 계약", brand_new_contract: "신제품검색 계약",
  "*": "모든 항목",
  account: "계정",
  campaign: "캠페인",
  adgroup: "광고 그룹",
  adset: "광고 세트",
  ad: "광고",
  creative: "소재",
  keyword: "키워드",
  asset_group: "애셋 그룹",
  asset: "애셋",
};
export const fieldNames: Record<string, string> = {
  "extensions.product_settings": "상품별 설정",
  "extensions.product_subtype": "광고상품 세부 유형",
  "extensions.product_settings.appCampaignSetting.appId": "광고 앱 ID",
  "extensions.product_settings.appCampaignSetting.appStore": "앱 스토어",
  "extensions.product_settings.shoppingSetting.merchantId": "Merchant Center 계정",
  "extensions.product_settings.shoppingSetting.feedLabel": "상품 피드 라벨",
  "extensions.product_settings.hotelSetting.hotelCenterId": "Hotel Center 계정",
  "extensions.assets": "연결 자산",
  "extensions.shopping_products": "쇼핑 상품 상태·문제",
  "extensions.listing_group_filters": "상품그룹 필터",
  "extensions.targeting_criteria": "상품별 타겟 설정",
  "extensions.conversion_configuration": "전환 목표 설정",
  "extensions.creative_id": "원본 소재 ID",
  "extensions.biz_channel_id": "비즈채널 ID",
  "extensions.landing_urls": "기기별 연결 주소",
  ...FIELD_LABELS,
  platform: "플랫폼",
  account_id: "계정 ID",
  entity_type: "항목 종류",
  entity_id: "항목 ID",
  effective_daily_budget: "적용 일예산",
  "budget.level": "예산 설정 단위",
  "bid.amount": "입찰 금액",
  "targeting.custom_audiences": "맞춤 타겟",
  "targeting.approved_retarg_audience_present": "승인된 맞춤 타겟 포함",
  "optimization.objective": "광고 목표",
};

export function display(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (value === "") return "비어 있음";
  if (value === true) return "예";
  if (value === false) return "아니요";
  if (Array.isArray(value))
    return value.length ? value.map(display).join(", ") : "없음";
  if (typeof value === "object") return valueText(value);
  if (typeof value === "string" && /^(?:\[|\{)/.test(value.trim())) {
    try {
      const parsed = JSON.parse(value);
      return display(parsed);
    } catch {
      /* Plain text is already displayable. */
    }
  }
  return String(value);
}

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("ko-KR", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(date);
}

export function conditionText(value: unknown): string {
  if (!value || typeof value !== "object") return "모든 항목";
  const item = value as Record<string, unknown>;
  const nested = (part: unknown) => {
    const result = conditionText(part);
    return part &&
      typeof part === "object" &&
      ("all" in part || "any" in part || "not" in part)
      ? `(${result})`
      : result;
  };
  if (Array.isArray(item.all)) return item.all.map(nested).join(" 그리고 ");
  if (Array.isArray(item.any)) return item.any.map(nested).join(" 또는 ");
  if (item.not) return `다음 조건 제외: (${conditionText(item.not)})`;
  const field = fieldNames[String(item.field)] ?? String(item.field ?? "조건");
  const operators: Record<string, string> = {
    eq: "일치",
    ne: "일치하지 않음",
    gt: "초과",
    gte: "이상",
    lt: "미만",
    lte: "이하",
    contains: "포함",
    not_contains: "포함하지 않음",
    in: "중 하나",
    not_in: "중 어느 것도 아님",
    regex: "패턴 일치",
    is_empty: "미설정",
    is_not_empty: "설정됨",
    exists: "값 존재",
  };
  const operator = String(item.operator ?? "");
  function conditionValue(value: unknown): string {
    if (Array.isArray(value)) return value.map(conditionValue).join(", ");
    if (
      typeof value === "string" &&
      ["eq", "ne", "in", "not_in"].includes(operator)
    ) {
      if (["status", "effective_status"].includes(String(item.field)))
        return (
          (
            {
              ACTIVE: "운영 중",
              ENABLED: "운영 중",
              PAUSED: "중지",
              DELETED: "삭제됨",
              REMOVED: "삭제됨",
              ARCHIVED: "보관됨",
            } as Record<string, string>
          )[value] ?? value
        );
      if (item.field === "platform") return platformNames[value] ?? value;
      if (item.field === "entity_type" || item.field === "budget.level")
        return entityNames[value] ?? value;
    }
    return display(value);
  }
  return [
    field,
    item.value !== undefined && item.value !== null
      ? conditionValue(item.value)
      : "",
    operators[operator] ?? operator,
  ]
    .filter(Boolean)
    .join(" · ");
}

