"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Camera,
  Download,
  History,
  RefreshCw,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { api, exportRows } from "@/lib/api";
import type { Scope } from "@/contracts/api";
import { productLabel } from "@/lib/ad-products";
import { PageHeader } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ChangeValue,
  display,
  Empty,
  entityNames,
  Field,
  fieldNames,
  formatDate,
  LoadingButton,
  Notice,
  Pick,
  platformNames,
  RawDetails,
} from "@/components/secondary/WorkspaceParts";

import { actorLabel, localTime, nativeHistoryRange } from "./history-input";

type Snapshot = {
  snapshot_id: string;
  created_at: string;
  entity_count: number;
  complete: boolean;
  errors: unknown[];
  scope?: Scope;
};
type Row = Record<string, unknown>;
type Report = {
  message: string;
  rows: Row[];
  warnings?: string[];
  errors?: { platform: string; account_id: string; reason: string }[];
  complete?: boolean;
  comparable?: boolean;
};
export default function HistoryPage({
  scope,
  onRefresh,
}: {
  scope: Scope;
  onRefresh?: () => void;
}) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [before, setBefore] = useState("");
  const [after, setAfter] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [native, setNative] = useState<Report | null>(null);
  const [start, setStart] = useState(() =>
    localTime(new Date(Date.now() - 7 * 86400_000)),
  );
  const [end, setEnd] = useState(() => localTime(new Date()));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<Row | null>(null);
  const [tab, setTab] = useState("snapshots");
  const generation = useRef(0),
    mounted = useRef(false),
    working = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [reload, setReload] = useState(0),
    [loading, setLoading] = useState(true);
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    mounted.current = true;
    working.current = false;
    setBusy("");
    const current = ++generation.current,
      request = new AbortController();
    controller.current = request;
    setNative(null);
    setReport(null);
    setDetail(null);
    setError("");
    setLoading(true);
    api<Snapshot[]>("/snapshots", { signal: request.signal })
      .then((items) => {
        if (!mounted.current || generation.current !== current) return;
        setSnapshots(items);
        setBefore((previous) =>
          items.some((item) => item.snapshot_id === previous)
            ? previous
            : (items[1]?.snapshot_id ?? ""),
        );
        setAfter((previous) =>
          items.some((item) => item.snapshot_id === previous)
            ? previous
            : (items[0]?.snapshot_id ?? ""),
        );
      })
      .catch((error) => {
        if (mounted.current && generation.current === current)
          setError(error.message);
      })
      .finally(() => {
        if (mounted.current && generation.current === current)
          setLoading(false);
      });
    return () => {
      mounted.current = false;
      ++generation.current;
      request.abort();
      controller.current?.abort();
    };
  }, [scopeKey, reload]);
  async function action(
    name: string,
    run: (isCurrent: () => boolean, signal: AbortSignal) => Promise<void>,
  ) {
    if (working.current || loading) return;
    working.current = true;
    controller.current?.abort();
    const current = ++generation.current,
      request = new AbortController();
    controller.current = request;
    const isCurrent = () => mounted.current && generation.current === current;
    setBusy(name);
    setError("");
    setDetail(null);
    if (name === "compare" || name === "snapshot") setReport(null);
    if (name === "native") setNative(null);
    try {
      await run(isCurrent, request.signal);
    } catch (error) {
      if (isCurrent()) {
        setError((error as Error).message);
        toast.error((error as Error).message);
      }
    } finally {
      if (isCurrent()) {
        working.current = false;
        setBusy("");
      }
    }
  }
  function clearResult(kind: "snapshot" | "native") {
    setDetail(null);
    setError("");
    if (kind === "snapshot") setReport(null);
    else setNative(null);
  }
  const supportsNative =
    !scope.products?.length && (!scope.platforms?.length ||
    scope.platforms.some((platform) => ["meta", "google"].includes(platform)));
  const snapshotLabels = snapshots.map(
    (item) =>
      `${formatDate(item.created_at)} · ${item.entity_count}개${item.scope?.products?.length ? ` · ${item.scope.products.map(value => { const [platform, code] = value.split(":"); return productLabel(platform, code); }).join("·")}` : ""}${item.complete ? "" : " · 부분 조회"}`,
  );
  const labelCounts = new Map<string, number>(),
    labelPositions = new Map<string, number>();
  snapshotLabels.forEach((label) =>
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1),
  );
  const options = snapshots.map((item, index) => {
    const label = snapshotLabels[index];
    const position = (labelPositions.get(label) ?? 0) + 1;
    labelPositions.set(label, position);
    return {
      value: item.snapshot_id,
      label:
        (labelCounts.get(label) ?? 0) > 1
          ? `${label} · 저장본 ${position}`
          : label,
    };
  });
  const current = tab === "snapshots" ? report : native;

  return (
    <div className="space-y-6">
      <PageHeader
        title="변경 이력"
        description="저장한 설정을 비교하거나 매체의 변경 기록을 조회하세요."
      >
        <LoadingButton
          loading={busy === "snapshot"}
          disabled={!!busy || loading}
          onClick={() =>
            void action("snapshot", async (isCurrent, signal) => {
              const saved = await api<Snapshot>("/snapshots", {
                method: "POST",
                body: { ...scope, force: true },
                signal,
              });
              let items: Snapshot[];
              try {
                items = await api<Snapshot[]>("/snapshots", { signal });
              } catch {
                if (!isCurrent()) return;
                items = [
                  saved,
                  ...snapshots.filter(
                    (item) => item.snapshot_id !== saved.snapshot_id,
                  ),
                ];
                setError(
                  "현재 설정은 저장했습니다. 저장 목록을 새로고침해 주세요.",
                );
              }
              if (!isCurrent()) return;
              setSnapshots(items);
              setAfter(saved.snapshot_id);
              setBefore(
                items.find(
                  (item) =>
                    item.snapshot_id === after &&
                    item.snapshot_id !== saved.snapshot_id,
                )?.snapshot_id ??
                  items.find((item) => item.snapshot_id !== saved.snapshot_id)
                    ?.snapshot_id ??
                  "",
              );
              setReport(null);
              onRefresh?.();
              toast.success(
                `${saved.entity_count}개 설정을 ${saved.complete ? "저장했습니다." : "부분 저장했습니다. 조회 범위를 확인하세요."}`,
              );
            })
          }
        >
          <Camera className="size-4" />
          현재 설정 저장
        </LoadingButton>
      </PageHeader>
      {error && <Notice tone="error">{error}</Notice>}
      <Tabs value={tab} onValueChange={setTab} className="space-y-5">
        <TabsList className="h-auto gap-1 p-1">
          <TabsTrigger value="snapshots" className="gap-2 px-4 py-2">
            <Camera className="size-4" />
            저장 시점 비교
          </TabsTrigger>
          <TabsTrigger value="native" className="gap-2 px-4 py-2">
            <History className="size-4" />
            매체 변경 기록
          </TabsTrigger>
        </TabsList>
        <TabsContent value="snapshots" className="space-y-5">
          <Card>
            <CardContent className="space-y-5">
              <div className="grid items-end gap-4 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto]">
                <Field label="이전 시점">
                  <Pick
                    disabled={!!busy}
                    value={before}
                    onChange={(value) => {
                      setBefore(value);
                      clearResult("snapshot");
                    }}
                    options={options}
                    placeholder="이전 저장 시점 선택"
                    label="이전 저장 시점"
                  />
                </Field>
                <ArrowRight className="mb-2 hidden size-4 text-muted-foreground md:block" />
                <Field label="이후 시점">
                  <Pick
                    disabled={!!busy}
                    value={after}
                    onChange={(value) => {
                      setAfter(value);
                      clearResult("snapshot");
                    }}
                    options={options}
                    placeholder="이후 저장 시점 선택"
                    label="이후 저장 시점"
                  />
                </Field>
                <LoadingButton
                  loading={busy === "compare"}
                  disabled={!!busy || !before || !after || before === after}
                  onClick={() =>
                    void action("compare", async (isCurrent, signal) => {
                      const first = snapshots.find(
                        (item) => item.snapshot_id === before,
                      );
                      const second = snapshots.find(
                        (item) => item.snapshot_id === after,
                      );
                      if (
                        first &&
                        second &&
                        new Date(first.created_at) > new Date(second.created_at)
                      )
                        throw new Error(
                          "이후 시점은 이전 시점보다 늦어야 합니다.",
                        );
                      const result = await api<Report>("/history/compare", {
                        method: "POST",
                        body: { before_id: before, after_id: after, ...scope },
                        signal,
                      });
                      if (isCurrent()) setReport(result);
                    })
                  }
                >
                  <Search className="size-4" />
                  차이 비교
                </LoadingButton>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  변경자와 변경 시각은 매체가 기록한 경우에만 확인할 수
                  있습니다.
                  <br />
                  표시 시간: {Intl.DateTimeFormat().resolvedOptions().timeZone}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!!busy}
                  onClick={() => setReload((value) => value + 1)}
                >
                  <RefreshCw className="size-3.5" />
                  목록 새로고침
                </Button>
              </div>
            </CardContent>
          </Card>
          {!report && (loading || snapshots.length < 2) && (
            <Empty
              title={
                loading
                  ? "저장 시점을 불러오는 중입니다…"
                  : "비교하려면 두 번 이상 저장해야 합니다"
              }
              description={
                !loading
                  ? "현재 설정을 저장하고, 다음에 다시 저장하면 변경 내용을 비교할 수 있습니다."
                  : undefined
              }
            />
          )}
          {report && (
            <>
              {report.warnings?.map((warning, i) => (
                <Notice tone="warning" key={i}>
                  {warning}
                </Notice>
              ))}
              <HistoryResults
                report={report}
                native={false}
                onDetails={setDetail}
              />
            </>
          )}
        </TabsContent>
        <TabsContent value="native" className="space-y-5">
          <Card>
            <CardHeader>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Meta·Google에서 제공하는 변경 기록을 조회합니다.
                {!!scope.products?.length && " 상품을 선택한 범위에서는 저장한 설정 비교를 이용하세요."}
              </p>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid items-end gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <Field label="시작 일시">
                  <Input
                    type="datetime-local"
                    disabled={!!busy}
                    value={start}
                    max={localTime(new Date())}
                    onChange={(e) => {
                      setStart(e.target.value);
                      clearResult("native");
                    }}
                  />
                </Field>
                <Field label="종료 일시">
                  <Input
                    type="datetime-local"
                    disabled={!!busy}
                    value={end}
                    max={localTime(new Date())}
                    onChange={(e) => {
                      setEnd(e.target.value);
                      clearResult("native");
                    }}
                  />
                </Field>
                <LoadingButton
                  loading={busy === "native"}
                  disabled={
                    !!busy || loading || !start || !end || !supportsNative
                  }
                  onClick={() =>
                    void action("native", async (isCurrent, signal) => {
                      const range = nativeHistoryRange(
                        start,
                        end,
                        scope.platforms,
                      );
                      const result = await api<Report>("/history/native", {
                        method: "POST",
                        body: {
                          ...scope,
                          ...range,
                        },
                        signal,
                      });
                      if (isCurrent()) setNative(result);
                    })
                  }
                >
                  <Search className="size-4" />
                  변경 기록 조회
                </LoadingButton>
              </div>
              {!supportsNative && (
                <Notice tone="warning">
                  {scope.products?.length ? "상품을 선택한 범위에서는 저장 시점 비교를 이용하세요." : "변경 기록을 보려면 Meta 또는 Google을 선택하세요."}
                </Notice>
              )}
              <p className="text-xs leading-relaxed text-muted-foreground">
                시간대: {Intl.DateTimeFormat().resolvedOptions().timeZone}. 종료
                시각은 제외됩니다. Google은 최근 30일만 조회할 수 있습니다.
                <br />
                변경자와 변경 시각은 매체가 제공한 경우에만 표시됩니다.
              </p>
            </CardContent>
          </Card>
          {!native ? (
            busy === "native" && (
              <Empty title="변경 기록을 불러오는 중입니다…" />
            )
          ) : (
            <>
              {!!native.errors?.length && (
                <Notice tone="warning">
                  <p>불러오지 못한 기록 {native.errors.length}건</p>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-medium">
                      상세 보기
                    </summary>
                    <ul className="mt-3 space-y-2">
                      {native.errors.map((item, i) => (
                        <li key={i}>
                          {platformNames[item.platform] ??
                            item.platform ??
                            "연결"}
                          {item.account_id ? ` · ${item.account_id}` : ""}:{" "}
                          {item.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                </Notice>
              )}
              <HistoryResults report={native} native onDetails={setDetail} />
            </>
          )}
        </TabsContent>
      </Tabs>
      {current && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            disabled={!!busy || !current.rows.length}
            onClick={() =>
              void action("export", async () => {
                await exportRows(
                  current.rows,
                  tab === "native" ? "매체_변경_기록.csv" : "설정_변경.csv",
                );
              })
            }
          >
            <Download className="size-4" />
            CSV 다운로드
          </Button>
        </div>
      )}
      <Dialog
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {String(detail?.name ?? detail?.entity_id ?? "변경 내역 상세")}
            </DialogTitle>
            <DialogDescription className="sr-only">
              변경 전후 값과 기록 정보를 확인할 수 있습니다.
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-4">
              <dl className="grid grid-cols-[100px_1fr] gap-3 text-sm">
                <dt className="text-muted-foreground">매체</dt>
                <dd>
                  {platformNames[String(detail.platform)] ??
                    display(detail.platform)}
                </dd>
                <dt className="text-muted-foreground">계정</dt>
                <dd className="break-all">
                  {display(detail.account ?? detail.account_id)}
                </dd>
                {!!detail.field && (
                  <>
                    <dt className="text-muted-foreground">변경 항목</dt>
                    <dd>
                      {fieldNames[String(detail.field)] ??
                        display(detail.field)}
                    </dd>
                  </>
                )}
                {!!detail.timestamp && (
                  <>
                    <dt className="text-muted-foreground">변경 시각</dt>
                    <dd>{formatDate(String(detail.timestamp))}</dd>
                  </>
                )}
                {!!detail.actor && (
                  <>
                    <dt className="text-muted-foreground">변경자</dt>
                    <dd>{actorLabel(detail.actor)}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">출처</dt>
                <dd>
                  {detail.source === "platform_change_log"
                    ? "매체 변경 기록"
                    : ["snapshot_diff", "local_snapshot"].includes(
                          String(detail.source),
                        )
                      ? "저장 시점 비교"
                      : "확인 불가"}
                </dd>
              </dl>
              {("before" in detail || "after" in detail) && (
                <div className="rounded-xl border bg-muted/25 p-4">
                  <ChangeValue before={detail.before} after={detail.after} />
                </div>
              )}
              <RawDetails value={detail} title="고급 · 원본 기록" />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function HistoryResults({
  report,
  native,
  onDetails,
}: {
  report: Report;
  native: boolean;
  onDetails: (row: Row) => void;
}) {
  const changeNames: Record<string, string> = {
    CREATED: "추가",
    REMOVED: "삭제",
    MODIFIED: "변경",
    added: "추가",
    removed: "삭제",
    changed: "변경",
    modified: "변경",
    deleted: "삭제",
  };
  const eventNames: Record<string, string> = {
    CREATE: "생성",
    UPDATE: "설정 변경",
    REMOVE: "삭제",
    UNKNOWN: "유형 확인 불가",
    UNSPECIFIED: "유형 미제공",
  };
  return (
    <Card className="overflow-hidden">
      {report.rows.length > 0 && (
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">
              {native ? "변경 기록" : "설정 차이"}{" "}
              <span className="ml-1 text-muted-foreground">
                {report.rows.length}
              </span>
            </CardTitle>
            {native && (
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {report.message}
              </p>
            )}
          </div>
          {report.complete === false && (
            <Badge
              variant="outline"
              className="shrink-0 border-amber-200 bg-amber-50 text-amber-800"
            >
              부분 조회
            </Badge>
          )}
        </CardHeader>
      )}
      <CardContent className="p-0">
        {report.rows.length ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">
                    {native ? "변경 시각" : "대상"}
                  </TableHead>
                  <TableHead>매체 · 계정</TableHead>
                  <TableHead>{native ? "변경 종류" : "변경 항목"}</TableHead>
                  <TableHead>{native ? "변경자" : "이전 → 이후"}</TableHead>
                  <TableHead className="pr-6 text-right">상세</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.rows.map((row, i) => (
                  <TableRow key={String(row.key ?? i)}>
                    <TableCell className="max-w-64 pl-6">
                      <p className="break-words text-sm font-medium">
                        {native
                          ? formatDate(String(row.timestamp ?? ""))
                          : display(row.name ?? row.entity_id)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {native
                          ? `${entityNames[String(row.entity_type)] ?? display(row.entity_type)} · ${display(row.entity_id)}`
                          : (changeNames[String(row.change_type)] ??
                            display(row.change_type))}
                      </p>
                    </TableCell>
                    <TableCell>
                      <p className="text-sm">
                        {platformNames[String(row.platform)] ??
                          display(row.platform)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {display(row.account ?? row.account_id)}
                      </p>
                    </TableCell>
                    <TableCell className="max-w-56 whitespace-normal text-sm">
                      {native
                        ? typeof row.description === "string" && row.description
                          ? row.description
                          : (eventNames[String(row.event_type)] ??
                            display(row.event_type))
                        : (fieldNames[String(row.field)] ?? display(row.field))}
                    </TableCell>
                    <TableCell className="max-w-80 whitespace-normal">
                      {native ? (
                        <span className="text-sm">{actorLabel(row.actor)}</span>
                      ) : (
                        <ChangeValue before={row.before} after={row.after} />
                      )}
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onDetails(row)}
                      >
                        보기
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="p-6">
            {report.complete === false && (
              <Badge
                variant="outline"
                className="border-amber-200 bg-amber-50 text-amber-800"
              >
                부분 조회
              </Badge>
            )}
            <Empty
              title={
                report.comparable === false
                  ? "비교할 공통 설정이 없습니다"
                  : report.complete === false
                    ? "조회된 변경 기록이 없습니다"
                    : "이 기간에 확인된 변경이 없습니다"
              }
              description={
                report.comparable === false
                  ? "선택한 계정이 포함된 두 시점을 선택하세요."
                  : report.complete === false
                    ? "조회하지 못한 계정의 내역은 위 안내를 확인하세요."
                    : undefined
              }
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
