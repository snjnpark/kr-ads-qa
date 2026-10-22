import { useEffect, useState } from "react";
import { TEST_MODE } from "@/lib/runtime";
import { Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  StatusBadge,
  PlatformMark,
  valueText,
  InlineError,
  FIELD_LABELS,
  dateText,
  money,
} from "@/components/shared";
import { api } from "@/lib/api";
import { criterionText, settingValueText } from "@/lib/evidence-display";
import { ChangeValue } from "@/components/secondary/WorkspaceParts";
import {
  evidenceObservations,
  parseStoredValue,
  semanticOutcome,
  validateSelectedEntity,
  type EvidenceObservation,
} from "@/lib/evidence";
import type { DataRow } from "@/contracts/api";

const stateNames: Record<string, string> = {
  PRESENT: "조회됨",
  NOT_SET: "미설정",
  NOT_SUPPORTED: "지원하지 않음",
  NOT_RETURNED: "미조회",
  PERMISSION_DENIED: "권한 없음",
  FETCH_FAILED: "조회 실패",
  NOT_APPLICABLE: "해당 없음",
};
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function getPath(data: Record<string, unknown>, path: string) {
  return path
    .split(".")
    .reduce<unknown>((value, key) => object(value)?.[key], data);
}
function observedValue(item: EvidenceObservation, currency?: string) {
  if (item.state !== "PRESENT") return stateNames[item.state] ?? "확인 불가";
  if (
    ["status", "effective_status"].includes(item.field) &&
    typeof item.value === "string"
  )
    return <StatusBadge status={item.value} />;
  if (
    currency &&
    /^(?:effective_(?:daily|lifetime)_budget|budget\.(?:daily|lifetime)|bid\.amount)$/.test(
      item.field,
    ) &&
    (typeof item.value === "string" || typeof item.value === "number")
  )
    return money(item.value, currency);
  if (/schedule\.|created_at/.test(item.field) && item.value)
    return dateText(item.value);
  return settingValueText(item.value, item.field);
}
function ObservationList({
  rows,
  currency,
}: {
  rows: EvidenceObservation[];
  currency?: string;
}) {
  return (
    <dl className="definition-list">
      {rows.map((item) => (
        <div key={item.field}>
          <dt>{FIELD_LABELS[item.field] ?? item.field}</dt>
          <dd className="min-w-0 break-words">
            {observedValue(item, currency)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
export default function EvidenceSheet({
  row,
  ruleOptions,
  onClose,
}: {
  row: DataRow | null;
  ruleOptions?: Record<string, string>;
  onClose: () => void;
}) {
  const [entity, setEntity] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const currentEntity = Boolean(
    row?.key && /^(meta|naver|kakao|kakao_keyword|google)\//.test(row.key),
  );
  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();
    setEntity(null);
    setError("");
    setLoading(false);
    if (currentEntity && row?.key) {
      setLoading(true);
      api<Record<string, unknown>>(`/entities/${encodeURIComponent(row.key)}`, {
        signal: controller.signal,
      })
        .then((data) => {
          if (!ignore) {
            validateSelectedEntity(data, row.key!);
            setEntity(data);
          }
        })
        .catch((err) => {
          if (!ignore) setError(err.message);
        })
        .finally(() => {
          if (!ignore) setLoading(false);
        });
    }
    return () => {
      ignore = true;
      controller.abort();
    };
  }, [row?.key, currentEntity]);
  const evidence = object(parseStoredValue(row?.evidence));
  const observations = evidenceObservations(evidence);
  const meaning = object(row?.semantic),
    actualConfiguration = object(meaning?.actual_configuration);
  const isChange = Boolean(row && ("before" in row || "after" in row));
  const hasSummary = Boolean(
    meaning || isChange || observations.length || (row && "expected" in row),
  );
  const currency =
    typeof entity?.currency === "string"
      ? entity.currency
      : typeof row?.currency === "string"
        ? row.currency
        : undefined;
  const fields = object(entity?.fields) ?? {};
  const settings = entity
    ? Object.entries(fields)
        .filter(
          ([field, state]) =>
            !Object.keys(fields).some((path) => path.startsWith(`${field}.`)) &&
            !(
              field === "budget.unit" &&
              state === "PRESENT" &&
              getPath(entity, field) === "major"
            ),
        )
        .map(([field, state]) => ({
          field,
          state: String(state),
          value: getPath(entity, field),
          source: object(entity.sources)?.[field] as string | undefined,
        }))
    : observations;
  const title =
    row?.name && row.name !== "이름 미조회"
      ? row.name
      : typeof entity?.name === "string" && entity.name
        ? entity.name
        : "광고 설정 상세";
  return (
    <Sheet
      open={Boolean(row)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="evidence-sheet sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            {row?.platform && <PlatformMark platform={row.platform} />}
            <span className="ml-3">매체 ID {row?.id || "미조회"}</span>
          </SheetDescription>
        </SheetHeader>
        <div className="sheet-body">
          {row && (
            <>
              {hasSummary && <div className="evidence-summary">
                <StatusBadge status={row.result || row.status} />
                <p>
                  {meaning
                    ? `${semanticOutcome(meaning.label)}${TEST_MODE && meaning.source === "deterministic_mock" ? " · 예시 판단" : ""}`
                    : ruleOptions?.[String(row.rule_id)] ||
                      row.reason ||
                      "조회한 광고 설정"}
                </p>
              </div>}
              <Tabs key={row.key} defaultValue={hasSummary ? "summary" : "settings"}>
                {hasSummary && <TabsList className="w-full">
                  <TabsTrigger value="summary" className="flex-1">
                    {isChange ? "변경 내용" : "판단 근거"}
                  </TabsTrigger>
                  <TabsTrigger value="settings" className="flex-1">
                    {isChange ? "원본 기록" : "확인한 설정"}
                  </TabsTrigger>
                </TabsList>}
                <TabsContent value="summary" className="space-y-5 pt-5">
                  {isChange && (
                    <section className="space-y-4">
                      <p className="font-medium">
                        {FIELD_LABELS[String(row.field)] ?? String(row.field ?? "변경 항목")}
                      </p>
                      <ChangeValue
                        before={settingValueText(row.before, String(row.field))}
                        after={settingValueText(row.after, String(row.field))}
                      />
                      <p className="fine-print">
                        비교한 저장 시점 · {dateText(row.observed_from)} → {dateText(row.observed_to)}
                      </p>
                    </section>
                  )}
                  {("actual" in row || "expected" in row) && (
                    <div className="evidence-values">
                      {!observations.length && (
                        <div>
                          <span>확인한 값</span>
                          <strong>
                            {settingValueText(row.actual)}
                          </strong>
                        </div>
                      )}
                      <div
                        className={
                          observations.length ? "col-span-2" : undefined
                        }
                      >
                        <span>검사 기준</span>
                        <strong>{criterionText(row.expected)}</strong>
                      </div>
                    </div>
                  )}
                  {observations.length > 0 && (
                    <ObservationList rows={observations} currency={currency} />
                  )}
                  {typeof evidence?.note === "string" && (
                    <p className="muted">{evidence.note}</p>
                  )}
                  {!isChange && Boolean(evidence?.fetched_at ?? row.fetched_at) && (
                    <p className="fine-print">
                      {evidence?.fetched_at || currentEntity
                        ? "설정 조회 시각"
                        : "검사 시각"}
                      {" · "}
                      {dateText(evidence?.fetched_at ?? row.fetched_at)}
                    </p>
                  )}
                  {meaning && (
                    <section className="meaning-section">
                      <p className="muted">
                        {TEST_MODE && meaning.source === "deterministic_mock"
                          ? "기능 확인용 예시 판단입니다."
                          : meaning.label == null
                            ? "의도를 확인하지 못해 판단을 보류했습니다. 실제 설정을 확인하세요."
                            : "이름과 문구에서 추정한 의도입니다. 실제 설정과 함께 확인하세요."}
                      </p>
                      {actualConfiguration && (
                        <div className="mt-4 rounded-xl border bg-muted/20 p-4 text-sm">
                          <p className="mb-2 font-medium">
                            실제 설정 ·{" "}
                            {actualConfiguration.value === true
                              ? "해당 설정 확인"
                              : actualConfiguration.value === false
                                ? "다른 설정 확인"
                                : "확인 불가"}
                          </p>
                          <p className="muted leading-relaxed">
                            {valueText(actualConfiguration.reason)}
                          </p>
                        </div>
                      )}
                    </section>
                  )}
                </TabsContent>
                <TabsContent value="settings" className="pt-5">
                  {!isChange && <>
                  <InlineError message={error} />
                  {loading ? (
                    <div className="py-8 flex items-center justify-center gap-2 muted">
                      <Loader2 className="animate-spin size-4" />
                      설정을 읽고 있습니다
                    </div>
                  ) : settings.length ? (
                    <>
                      <p className="fine-print mb-4">
                        {entity
                          ? "현재 조회한 설정입니다."
                          : "검사 시점에 확인한 설정입니다."}{" "}
                        ‘미조회’는 설정이 없다는 뜻이 아닙니다.
                      </p>
                      <ObservationList rows={settings} currency={currency} />
                    </>
                  ) : (
                    <p className="muted">
                      {currentEntity
                        ? "설정을 불러오지 못했습니다. 조회 범위와 연결 상태를 확인하고 다시 선택하세요."
                        : "저장된 설정값이 없습니다. ‘판단 근거’를 확인하세요."}
                    </p>
                  )}
                  </>}
                  <details className="mt-5 rounded-xl border">
                    <summary className="cursor-pointer px-4 py-3 text-xs">
                      원본 기록 보기
                    </summary>
                    <pre className="raw-code">
                      {JSON.stringify(
                        {
                          result: row,
                          ...(entity ? { settings: entity } : {}),
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </TabsContent>
              </Tabs>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
