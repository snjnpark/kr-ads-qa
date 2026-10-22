import type { ComponentProps, ReactNode } from "react";
import { AlertCircle, ArrowRight, Loader2 } from "lucide-react";
import { FIELD_LABELS, StatusBadge, valueText } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const platformNames: Record<string, string> = {
  meta: "Meta",
  naver: "네이버",
  kakao: "카카오모먼트",
  kakao_keyword: "카카오 키워드광고",
  google: "Google",
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
  "extensions.product_type": "광고상품 코드",
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
  parent_id: "상위 항목 ID",
  name: "이름",
  status: "운영 상태",
  "budget.daily": "일예산",
  effective_daily_budget: "적용 일예산",
  "budget.lifetime": "총예산",
  "budget.level": "예산 설정 단위",
  "bid.amount": "입찰 금액",
  "bid.strategy": "입찰 전략",
  "schedule.start": "시작일",
  "schedule.end": "종료일",
  "targeting.countries": "타겟 국가",
  "targeting.age_min": "최소 연령",
  "targeting.age_max": "최대 연령",
  "targeting.custom_audiences": "맞춤 타겟",
  "targeting.excluded_audiences": "제외 타겟",
  "targeting.approved_retarg_audience_present": "승인된 맞춤 타겟 포함",
  "optimization.objective": "광고 목표",
  "optimization.goal": "최적화 목표",
  "optimization.event": "전환 이벤트",
  "tracking.url": "연결 URL",
  text: "광고 문구",
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

export function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`grid gap-2 text-sm ${className}`}>
      <Label asChild>
        <span>{label}</span>
      </Label>
      {children}
      {hint && (
        <span className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </span>
      )}
    </label>
  );
}

export function Pick({
  value,
  onChange,
  options,
  placeholder = "선택하세요",
  disabled,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <Select
      value={value || undefined}
      onValueChange={onChange}
      disabled={disabled}
    >
      <SelectTrigger className="w-full" aria-label={label ?? placeholder}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "warning" | "error";
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex gap-3 rounded-xl border px-4 py-3 text-sm leading-relaxed ${tone === "warning" ? "border-amber-200 bg-amber-50 text-amber-900" : tone === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-border bg-muted/40 text-muted-foreground"}`}
    >
      {tone !== "info" && <AlertCircle className="mt-0.5 size-4 shrink-0" />}
      <div>{children}</div>
    </div>
  );
}

export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="px-6 py-8 text-center">
      <p className="font-semibold">{title}</p>
      {description && (
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function LoadingButton({
  loading,
  children,
  ...props
}: ComponentProps<typeof Button> & { loading?: boolean }) {
  return (
    <Button {...props} disabled={loading || props.disabled}>
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </Button>
  );
}

export function RawDetails({
  value,
  title = "고급 · 원본 보기",
}: {
  value: unknown;
  title?: string;
}) {
  return (
    <details className="rounded-xl border bg-muted/20">
      <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-muted-foreground">
        {title}
      </summary>
      <pre className="max-h-80 overflow-auto border-t px-4 py-3 text-xs leading-relaxed">
        {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

export function ChangeValue({
  before,
  after,
}: {
  before: unknown;
  after: unknown;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">{display(before)}</span>
      <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
      <span className="font-medium">{display(after)}</span>
    </div>
  );
}

export function ResultBadge({ status }: { status: unknown }) {
  return <StatusBadge status={String(status ?? "UNKNOWN")} />;
}
