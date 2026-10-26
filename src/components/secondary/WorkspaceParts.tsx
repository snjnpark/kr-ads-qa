import type { ComponentProps, ReactNode } from "react";
import { AlertCircle, ArrowRight, Loader2 } from "lucide-react";
import { StatusBadge } from "@/components/shared";
import { display } from "@/lib/display";
export { platformNames, severityNames, entityNames, fieldNames, display, formatDate, conditionText } from "@/lib/display";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
      <SelectTrigger className="w-full min-w-0" aria-label={label ?? placeholder}>
        <SelectValue className="min-w-0 truncate" placeholder={placeholder} />
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
