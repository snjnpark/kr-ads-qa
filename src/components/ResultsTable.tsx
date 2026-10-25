import { useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  EmptyState,
  PlatformMark,
  StatusBadge,
  money,
} from "@/components/shared";
import { exportRows } from "@/lib/api";
import { criterionText, settingValueText } from "@/lib/evidence-display";
import { resultHierarchy, resultSearchText } from "@/lib/result-hierarchy";
import { entityNames } from "@/components/secondary/WorkspaceParts";
import type { DataRow } from "@/contracts/api";

const statusLabels: Record<string, string> = {
  FAIL: "오류",
  WARNING: "주의",
  REVIEW: "검토 필요",
  UNKNOWN: "확인 불가",
  PASS: "정상",
  NOT_APPLICABLE: "해당 없음",
  MATCH: "조건 일치",
};
const order = [
  "FAIL",
  "WARNING",
  "REVIEW",
  "UNKNOWN",
  "MATCH",
  "PASS",
  "NOT_APPLICABLE",
];

function Identity({
  name,
  id,
  inapplicable,
  onSelect,
}: {
  name: string;
  id: string;
  inapplicable?: boolean;
  onSelect?: () => void;
}) {
  if (inapplicable)
    return <span className="text-muted-foreground">해당 없음</span>;
  return (
    <>
      {onSelect ? (
        <button
          className="entity-name"
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
        >
          {name || "미조회"}
        </button>
      ) : (
        <span className="entity-name">{name || "미조회"}</span>
      )}
      <span className="entity-meta" title={id || undefined}>
        {id || "ID 미조회"}
      </span>
    </>
  );
}

export default function ResultsTable({
  rows,
  kind = "entities",
  onSelect,
  ruleOptions = {},
  title = "조회 결과",
  emptyTitle = "표시할 결과가 없습니다",
  emptyDescription = "검색 조건이나 조회 범위를 바꿔 다시 확인해 주세요.",
  totalCount,
}: {
  rows: DataRow[];
  kind?: "entities" | "audit" | "meaning";
  onSelect: (row: DataRow) => void;
  ruleOptions?: Record<string, string>;
  title?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  totalCount?: number;
}) {
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("priority");
  const [exporting, setExporting] = useState(false);
  const statuses = [
    ...new Set(
      rows
        .map((row) => String(row.result))
        .filter((status) => statusLabels[status]),
    ),
  ].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const activeStatus = statuses.includes(status) ? status : "all";
  const showResult = statuses.some((status) => status !== "MATCH");
  const term = filter.trim().toLocaleLowerCase();
  const priority = (value: unknown) => {
    const index = order.indexOf(String(value));
    return index < 0 ? order.length : index;
  };
  const filtered = useMemo(
    () =>
      rows
        .filter(
          (row) =>
            (activeStatus === "all" || row.result === activeStatus) &&
            resultSearchText(row, ruleOptions[String(row.rule_id)]).includes(term),
        )
        .sort((a, b) =>
          sort === "name"
            ? String(a.name).localeCompare(String(b.name), "ko")
            : kind === "audit"
              ? priority(a.result) - priority(b.result)
              : 0,
        ),
    [rows, activeStatus, term, sort, kind, ruleOptions],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 15));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * 15, current * 15);
  return (
    <section className="result-surface" aria-label={title}>
      <div className="result-toolbar">
        <div className="result-heading">
          <h2>{title}</h2>
          <span className="count-pill">
            {filtered.length.toLocaleString()}
            {(term || activeStatus !== "all") &&
              ` / ${rows.length.toLocaleString()}`}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!filtered.length || exporting}
          onClick={async () => {
            setExporting(true);
            try {
              await exportRows(filtered);
            } catch (error) {
              toast.error((error as Error).message);
            } finally {
              setExporting(false);
            }
          }}
        >
          {exporting ? (
            <Loader2 className="animate-spin" />
          ) : (
            <ArrowDownToLine />
          )}
          {exporting ? "내보내는 중" : "CSV 다운로드"}
        </Button>
      </div>
      {totalCount !== undefined && totalCount > rows.length && (
        <p className="fine-print px-4 pb-3" role="status">
          전체 {totalCount.toLocaleString()}개 중 처음 {rows.length.toLocaleString()}개를 표시합니다.
          결과 내 검색·판정 필터·CSV 다운로드는 표시된 {rows.length.toLocaleString()}개를 대상으로 합니다.
        </p>
      )}
      {rows.length > 0 && (
        <div className="table-controls">
          <div className="search-field">
            <Search size={15} />
            <Input
              aria-label="결과 내 검색"
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setPage(1);
              }}
              placeholder={
                kind === "audit"
                  ? "캠페인, 그룹, 대상 이름·ID, 검사 항목 검색"
                  : "캠페인, 그룹, 대상 이름·ID 검색"
              }
            />
          </div>
          <div className="table-control-right">
            {statuses.length > 1 && (
              <Select
                value={activeStatus}
                onValueChange={(value) => {
                  setStatus(value);
                  setPage(1);
                }}
              >
                <SelectTrigger aria-label="판정 필터" className="w-36">
                  <SlidersHorizontal size={13} />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">모든 판정</SelectItem>
                  {statuses.map((value) => (
                    <SelectItem value={value} key={value}>
                      {statusLabels[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger aria-label="결과 정렬" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="priority">
                  {kind === "audit" ? "검토 우선순" : "기본 순서"}
                </SelectItem>
                <SelectItem value="name">이름순</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
      {!visible.length ? (
        <EmptyState
          title={rows.length ? "검색된 항목이 없습니다" : emptyTitle}
          description={
            rows.length
              ? "다른 이름이나 판정으로 검색해 보세요."
              : emptyDescription
          }
          action={
            rows.length > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setFilter("");
                  setStatus("all");
                  setPage(1);
                }}
              >
                필터 초기화
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ul className="mobile-result-list">
            {visible.map((row, index) => { const hierarchy = resultHierarchy(row); return <li key={row.key ?? index}>
              <button type="button" className="mobile-result-open" onClick={() => onSelect(row)}>
                <strong>{String(row.name || row.id || "이름 미조회")}</strong>
                <span>{hierarchy.type === "adgroup" && row.platform === "meta" ? "광고 세트" : entityNames[hierarchy.type] || hierarchy.type || "미조회"}</span>
              </button>
              <div className="mobile-result-status"><PlatformMark platform={row.platform || ""} />
                <StatusBadge status={kind === "entities" ? row.status : row.result} />
              </div>
              {typeof row.product === "string" && row.product && <p className="mobile-result-account">{row.product}</p>}
              {kind === "audit" ? <div className="mobile-result-values"><strong>{ruleOptions[String(row.rule_id)] || String(row.reason || row.rule_id || "검사")}</strong><span>{settingValueText(row.actual)} · 기준 {criterionText(row.expected)}</span></div>
                : kind === "meaning" ? <p className="mobile-result-values">{row.reason || "판단 보류"}</p>
                : <p className="mobile-result-values">일예산 {money(row.daily_budget, String(row.currency || "통화 미조회"))}{showResult && <StatusBadge status={row.result} />}</p>}
              <p className="mobile-result-account">{String(row.account_name || (hierarchy.type === "account" ? row.name : "") || row.account_id || row.account || "계정명 미조회")}</p>
              <details className="mobile-result-identity"><summary>소속·원본 ID</summary><dl>
                <div><dt>대상 ID</dt><dd>{String(row.id || "ID 미조회")}</dd></div>
                <div><dt>계정 ID</dt><dd>{String(row.account_id || row.account || (hierarchy.type === "account" ? row.id : "") || "ID 미조회")}</dd></div>
                <div><dt>캠페인</dt><dd><Identity {...hierarchy.campaign} /></dd></div>
                <div><dt>광고그룹·광고 세트</dt><dd><Identity {...hierarchy.group} /></dd></div>
              </dl></details>
            </li>; })}
          </ul>
        <div className="data-table-scroll desktop-result-table">
          <Table style={{ minWidth: 1280 }}>
            <TableHeader>
              <TableRow>
                {kind === "audit" && <TableHead>판정</TableHead>}
                <TableHead>매체·계정</TableHead>
                <TableHead>대상 종류</TableHead>
                <TableHead className="min-w-48 max-w-72">캠페인</TableHead>
                <TableHead className="min-w-48 max-w-72">
                  광고그룹·광고 세트
                </TableHead>
                <TableHead className="min-w-48 max-w-72">검사 대상</TableHead>
                {kind === "audit" ? (
                  <>
                    <TableHead>검사 항목</TableHead>
                    <TableHead>확인값·기준</TableHead>
                  </>
                ) : kind === "meaning" ? (
                  <>
                    <TableHead>의미 판단</TableHead>
                    <TableHead>확인 상태</TableHead>
                  </>
                ) : (
                  <>
                    <TableHead>운영 상태</TableHead>
                    <TableHead className="text-right">일예산</TableHead>
                    {showResult && <TableHead>판정</TableHead>}
                  </>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row, index) => {
                const hierarchy = resultHierarchy(row);
                const select = () => onSelect(row);
                return (
                  <TableRow
                    key={row.key ?? index}
                    className="clickable-row"
                    onClick={() => onSelect(row)}
                  >
                    {kind === "audit" && (
                      <TableCell><StatusBadge status={row.result} /></TableCell>
                    )}
                    <TableCell>
                      <PlatformMark platform={row.platform || ""} />
                      {typeof row.product === "string" && <span className="entity-meta">{row.product}</span>}
                      <div className="mt-2">
                        <Identity
                          name={String(row.account_name || (hierarchy.type === "account" ? row.name : "") || "계정명 미조회")}
                          id={String(row.account_id || row.account || (hierarchy.type === "account" ? row.id : "") || "")}
                          onSelect={hierarchy.type === "account" ? select : undefined}
                        />
                      </div>
                    </TableCell>
                    <TableCell>{hierarchy.type === "adgroup" && row.platform === "meta" ? "광고 세트" : entityNames[hierarchy.type] || hierarchy.type || "미조회"}</TableCell>
                    <TableCell className="min-w-48 max-w-72">
                      <Identity {...hierarchy.campaign} onSelect={hierarchy.type === "campaign" ? select : undefined} />
                    </TableCell>
                    <TableCell className="min-w-48 max-w-72">
                      <Identity {...hierarchy.group} onSelect={hierarchy.target.inapplicable && !hierarchy.group.inapplicable ? select : undefined} />
                    </TableCell>
                    <TableCell className="min-w-48 max-w-72">
                      <Identity {...hierarchy.target} onSelect={select} />
                    </TableCell>
                    {kind === "audit" ? (
                      <>
                        <TableCell>
                          <span className="rule-name">
                            {ruleOptions[String(row.rule_id)] ||
                              String(row.reason || row.rule_id || "검사")}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="value-comparison">
                            <span>{settingValueText(row.actual)}</span>
                            <small>기준 {criterionText(row.expected)}</small>
                          </div>
                        </TableCell>
                      </>
                    ) : kind === "meaning" ? (
                      <>
                        <TableCell>
                          <span className="rule-name">
                            {row.reason || "판단 보류"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={row.result} />
                        </TableCell>
                      </>
                    ) : (
                      <>
                        <TableCell>
                          <StatusBadge status={row.status} />
                        </TableCell>
                        <TableCell className="numeric">
                          {money(row.daily_budget, String(row.currency || "통화 미조회"))}
                        </TableCell>
                        {showResult && (
                          <TableCell>
                            <StatusBadge status={row.result} />
                          </TableCell>
                        )}
                      </>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        </>
      )}
      {pages > 1 && (
        <div className="table-footer">
          <span>
            {filtered.length.toLocaleString()}개 중{" "}
            {((current - 1) * 15 + 1).toLocaleString()}–
            {Math.min(current * 15, filtered.length).toLocaleString()}개 표시
          </span>
          <div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="이전 페이지"
              disabled={current === 1}
              onClick={() => setPage(current - 1)}
            >
              <ChevronLeft />
            </Button>
            <span>
              {current} / {pages}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="다음 페이지"
              disabled={current === pages}
              onClick={() => setPage(current + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
