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
import { platforms, platformLabel } from "@/lib/display";
export { platforms, platformLabel, FIELD_LABELS, valueText, dateText, money } from "@/lib/display";

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
      {withLabel && <span>{platformLabel(platform)}</span>}
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
export function InlineError({ message }: { message?: string }) {
  return message ? (
    <div className="inline-error" role="alert">
      <CircleAlert size={17} />
      <span>{message}</span>
    </div>
  ) : null;
}
