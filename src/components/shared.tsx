import type { ReactNode, ElementType } from "react";
import {
  CircleHelp,
  Check,
  AlertTriangle,
  CircleAlert,
  Minus,
  Inbox,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}
const statuses: Record<
  string,
  { label: string; tone: string; icon: ElementType }
> = {
  FAIL: { label: "오류", tone: "danger", icon: CircleAlert },
  WARNING: { label: "주의", tone: "warning", icon: AlertTriangle },
  REVIEW: { label: "검토 필요", tone: "review", icon: CircleHelp },
  UNKNOWN: { label: "확인 불가", tone: "muted", icon: CircleHelp },
  PASS: { label: "정상", tone: "success", icon: Check },
  MATCH: { label: "조건 일치", tone: "success", icon: Check },
  NOT_APPLICABLE: { label: "해당 없음", tone: "muted", icon: Minus },
  ACTIVE: { label: "운영 중", tone: "success", icon: Check },
  ENABLED: { label: "운영 중", tone: "success", icon: Check },
  PAUSED: { label: "중지", tone: "muted", icon: Minus },
};
export function StatusBadge({ status }: { status?: string | null }) {
  const value = statuses[status ?? ""] ?? {
    label: status || "미조회",
    tone: "muted",
    icon: Minus,
  };
  const Icon = value.icon;
  return (
    <Badge
      variant="outline"
      className={cn("status-badge", `status-${value.tone}`)}
    >
      <Icon size={12} strokeWidth={2} />
      {value.label}
    </Badge>
  );
}
export const platforms: Record<string, string> = {
  meta: "Meta",
  naver: "NAVER",
  kakao: "카카오모먼트",
  kakao_keyword: "카카오 키워드광고",
  google: "Google",
};
export function PlatformMark({
  platform,
  withLabel = true,
}: {
  platform: string;
  withLabel?: boolean;
}) {
  return (
    <span className="platform-label">
      <span className={cn("platform-mark", "platform-brand", `platform-${platform}`)} aria-hidden={withLabel || undefined}>
        {Object.hasOwn(platforms, platform) && <img
          src={`/brands/${platform === "kakao_keyword" ? "kakao" : platform}.${platform === "meta" ? "svg" : "png"}`}
          alt={withLabel ? "" : platforms[platform]}
          width={52}
          height={24}
        />}
      </span>
      {withLabel && <span>{platforms[platform] ?? platform}</span>}
    </span>
  );
}
export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
}: {
  title: string;
  description?: string;
  icon?: ElementType;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon size={25} strokeWidth={1.5} />
      </span>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
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
export function InlineError({ message }: { message?: string }) {
  return message ? (
    <div className="inline-error" role="alert">
      <CircleAlert size={17} />
      <span>{message}</span>
    </div>
  ) : null;
}
