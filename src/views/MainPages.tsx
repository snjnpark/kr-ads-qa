import { policyConditionCount } from "@/lib/policy-conditions";
import { TEST_MODE } from "@/lib/runtime";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  CheckCheck,
  CircleHelp,
  ClipboardCheck,
  FileSearch,
  Loader2,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PageHeader,
  EmptyState,
  InlineError,
  dateText,
  platforms,
} from "@/components/shared";
import PolicyPicker from "@/components/PolicyPicker";
import ResultsTable from "@/components/ResultsTable";
import EvidenceSheet from "@/components/EvidenceSheet";
import ComparisonTable from "@/components/ComparisonTable";
import { HistoryResults } from "@/views/HistoryPage";
import { Notice } from "@/components/secondary/WorkspaceParts";
import { api } from "@/lib/api";
import { semanticOutcome, unknownResultTitle } from "@/lib/evidence";
import type { AppState, DataRow, Result, Scope } from "@/contracts/api";

export const questionExamples = [
  "예산이 설정되지 않은 캠페인 찾아줘",
  "현재 활성화된 광고그룹 보여줘",
  "종료일이 없는 캠페인 찾아줘",
  "메타에서 구매 최적화가 아닌 광고 세트 찾아줘",
];
function examplesFor(state: AppState) {
  return TEST_MODE && state.settings.mode === "mock" && state.settings.mock_dataset === "api"
    ? [
        "현재 활성화된 광고그룹 보여줘",
        "예산이 설정되지 않은 광고그룹 찾아줘",
        "종료일이 없는 광고그룹 찾아줘",
        questionExamples[3],
      ]
    : questionExamples;
}
function scopeDescription(scope: Scope, state: AppState) {
  const media = scope.platforms?.length
    ? scope.platforms
        .map((platform) => platforms[platform] ?? platform)
        .join(" · ")
    : "전체 매체";
  const accounts = scope.accounts?.map(
    (value) =>
      state.accounts.find(
        (account) =>
          value === `${account.platform}/${account.account_id}` ||
          value === account.account_id,
      )?.name ?? value,
  );
  return `${media} · ${accounts?.length ? accounts.join(" · ") : "전체 계정"}`;
}
function Loading({ text }: { text: string }) {
  return (
    <div className="working-state" role="status">
      <Loader2 className="animate-spin size-4" />
      <div>
        <strong>{text}</strong>
      </div>
      <span className="working-dots" />
    </div>
  );
}

export { default as OverviewPage } from "./OverviewPage";

export function AskPage({
  state,
  scope,
  preset,
  presetVersion = 0,
  onRefresh,
  active = true,
}: {
  state: AppState;
  scope: Scope;
  preset: string;
  presetVersion?: number;
  onRefresh: () => void;
  active?: boolean;
}) {
  const [text, setText] = useState(preset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [row, setRow] = useState<DataRow | null>(null);
  const [showMeaning, setShowMeaning] = useState(false);
  const [submitted, setSubmitted] = useState("");
  const [resultKey, setResultKey] = useState(0);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    sequence.current++;
    controller.current?.abort();
    setText(preset);
    setResult(null);
    setRow(null);
    setShowMeaning(false);
    setSubmitted("");
    setError("");
    setBusy(false);
  }, [preset, presetVersion]);
  useEffect(() => {
    if (!active) {
      setRow(null);
      setShowMeaning(false);
    }
  }, [active]);
  useEffect(() => {
    sequence.current++;
    controller.current?.abort();
    setResult(null);
    setRow(null);
    setShowMeaning(false);
    setSubmitted("");
    setError("");
    setBusy(false);
    return () => {
      sequence.current++;
      controller.current?.abort();
    };
  }, [scopeKey]);
  function resetSearch() {
    sequence.current++;
    controller.current?.abort();
    setText("");
    setSubmitted("");
    setResult(null);
    setRow(null);
    setShowMeaning(false);
    setError("");
    setBusy(false);
    input.current?.focus();
  }
  function useQuestion(question: string) {
    setText(question);
    input.current?.focus();
  }
  async function search() {
    if (!text.trim() || busy) return;
    const request = ++sequence.current;
    controller.current?.abort();
    const pending = new AbortController();
    controller.current = pending;
    setBusy(true);
    setError("");
    setResult(null);
    setRow(null);
    setShowMeaning(false);
    setSubmitted(text.trim());
    try {
      const data = await api<Result>("/ask", {
        method: "POST",
        body: { text: text.trim(), ...scope },
        signal: pending.signal,
      });
      if (sequence.current === request) {
        setResult(data);
        setResultKey(request);
        onRefresh();
      }
    } catch (error) {
      if (sequence.current === request) setError((error as Error).message);
    } finally {
      if (sequence.current === request) setBusy(false);
    }
  }
  const meaningRows = Object.entries(result?.semantic_decisions ?? {}).map(
    ([key, meaning]) => {
      const [platform, account, type, id] = key.split("/");
      const entity =
        result?.rows.find((entity) => entity.key === key) ??
        state.entities.find((entity) => entity.key === key);
      return {
        platform,
        account,
        type,
        id,
        name: "이름 미조회",
        ...entity,
        key,
        result:
          meaning.status === "UNKNOWN" ||
          !["true", "false"].includes(String(meaning.label))
            ? "UNKNOWN"
            : "REVIEW",
        reason: semanticOutcome(meaning.label),
        semantic: meaning,
      };
    },
  );
  if (!TEST_MODE && !state.accounts.length) return (
    <section className="search-page" aria-label="설정 검색">
      <EmptyState title="광고 API를 연결해 주세요" description="계정의 광고 설정을 불러온 뒤 자연어로 질문하고 QA 결과를 확인할 수 있습니다." icon={FileSearch}
        action={<Button asChild><a href="/settings">광고 API 연결하기<ArrowRight /></a></Button>} />
    </section>
  );
  return (
    <section
      className={`search-page ${submitted ? "search-page-results" : "search-page-home"}`}
      aria-label="설정 검색"
    >
      <div className="search-entry">
        {!submitted && (
          <header className="search-intro">
            <span className="search-kicker">광고 설정을 한눈에</span>
            <h1>
              kr-ads-qa
            </h1>
            <p>광고 설정, 무엇이 궁금하세요?</p>
          </header>
        )}
        {submitted && (
          <div className="search-entry-heading">
            <span>설정 검색</span>
            <Button variant="ghost" size="sm" onClick={resetSearch}>
              새 검색
              <ArrowUpRight />
            </Button>
          </div>
        )}
        <form
          className="search-form"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <Search className="search-form-icon" size={20} aria-hidden="true" />
          <Textarea
            ref={input}
            aria-label="광고 설정 질문"
            aria-describedby="search-keyboard-hint"
            rows={1}
            maxLength={2000}
            placeholder="광고 설정에 대해 질문하세요"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                event.keyCode !== 229
              ) {
                event.preventDefault();
                void search();
              }
            }}
          />
          {text.length > 0 && !busy && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="search-clear"
              aria-label="질문 지우기"
              onClick={() => useQuestion("")}
            >
              <X />
            </Button>
          )}
          <Button
            type="submit"
            size="icon"
            className="search-submit"
            aria-label="설정 검색"
            disabled={busy || !text.trim()}
          >
            {busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </Button>
        </form>
        <div className="search-hint" id="search-keyboard-hint">
          <span>
            {submitted
              ? "질문을 바꿔 다시 검색할 수 있어요"
              : "선택한 매체와 계정에서 찾아드려요"}
          </span>
          <span className="keyboard-hint">
            Enter로 검색 · Shift + Enter로 줄바꿈
          </span>
        </div>
        {!submitted && (
          <section
            className={`search-examples ${text.length > 0 ? "search-examples-hidden" : ""}`}
            aria-label="질문 예시"
            aria-hidden={text.length > 0}
          >
            <p>이런 질문으로 시작해 보세요</p>
            {examplesFor(state).slice(0, 3).map((question) => (
              <Button
                type="button"
                variant="ghost"
                onClick={() => useQuestion(question)}
                key={question}
                tabIndex={text.length > 0 ? -1 : undefined}
              >
                <Search size={14} aria-hidden="true" />
                <span>{question}</span>
                <ArrowUpRight size={14} aria-hidden="true" />
              </Button>
            ))}
          </section>
        )}
      </div>
      <div className="search-results">
        <InlineError message={error} />
        {busy && <Loading text="광고 설정을 검색하고 있습니다" />}
        {result && (
          <>
            <div className="query-summary">
              <div>
                <span className="eyebrow">검색 결과</span>
                <h2>{submitted}</h2>
                <p>{result.message}</p>
              </div>
              {meaningRows.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowMeaning(true)}
                >
                  <CircleHelp />
                  의미 판단 전체 내역
                </Button>
              )}
            </div>
            {result.warnings?.map((warning, index) => (
              <Notice tone="warning" key={index}>{warning}</Notice>
            ))}
            {result.coverage?.complete === false && (
              <Notice tone="warning">
                일부 설정을 조회하지 못했습니다. 조회 범위와 계정 연결을 확인하세요.
              </Notice>
            )}
            {result.result_type === "history" ? (
              result.rows.length > 0 && (
                <HistoryResults report={result} native={false} onDetails={setRow} />
              )
            ) : (
              <>
                {!!result.comparison?.length && (
                  <ComparisonTable
                    comparison={result.comparison}
                    entities={state.entities}
                    onSelect={setRow}
                  />
                )}
                <ResultsTable
                  key={resultKey}
                  kind={result.result_type === "audit" ? "audit" : "entities"}
                  ruleOptions={state.rule_options}
                  rows={result.rows ?? []}
                  totalCount={result.count}
                  onSelect={setRow}
                  emptyTitle={result.result_type === "audit"
                    ? "검사할 광고 설정이 없습니다"
                    : unknownResultTitle(result)}
                  emptyDescription={result.message}
                />
              </>
            )}
            {result.result_type === "entities" && result.rows.length > 0 && (
              <div className="follow-up-note">
                <span className="follow-up-line" />
                <button onClick={() => useQuestion("그중 활성화된 것만 보여줘")}>
                  그중 활성화된 것만 보여줘
                  <ArrowUpRight size={12} />
                </button>
              </div>
            )}
          </>
        )}
        {meaningRows.length > 0 && (
          <div className="meaning-disclaimer">
            <CircleHelp size={16} />
            <p>이름과 문구에서 추정한 의도입니다. 실제 설정을 함께 확인하세요.</p>
          </div>
        )}
      </div>
      <Dialog open={showMeaning} onOpenChange={setShowMeaning}>
        <DialogContent className="sm:max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>의미 판단 전체 내역</DialogTitle>
            <DialogDescription>
              {TEST_MODE && state.settings.ai_mode === "mock"
                ? "기능 확인용 예시 판단입니다."
                : "이름과 문구에서 추정한 의도입니다."}{" "}
              판단을 보류한 항목도 함께 표시합니다.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {["해당 의도", "다른 의도", "판단 보류"]
              .map(
                (label) =>
                  `${label} ${meaningRows.filter((row) => semanticOutcome(row.semantic.label) === label).length}개`,
              )
              .join(" · ")}
          </p>
          <ResultsTable
            key={`meaning-${resultKey}`}
            kind="meaning"
            rows={meaningRows}
            title={
              TEST_MODE && state.settings.ai_mode === "mock" ? "예시 판단" : "광고별 판단"
            }
            onSelect={setRow}
          />
        </DialogContent>
      </Dialog>
      <EvidenceSheet
        row={row}
        ruleOptions={state.rule_options}
        onClose={() => setRow(null)}
      />
    </section>
  );
}

export function AuditPage({
  state,
  scope,
  onRefresh,
  onNavigate, policyId, onPolicyChange, auditRequest, onAuditStarted, requestedRun = "", onRunOpened,
}: {
  state: AppState;
  scope: Scope;
  onRefresh: () => void;
  onNavigate: (page: string) => void;
  policyId: string; onPolicyChange: (id: string) => void;
  auditRequest: number; onAuditStarted: () => void;
  requestedRun?: string; onRunOpened?: () => void;
}) {
  const selectedPolicy = state.policies.find(item => item.policy_id === policyId);
  const ruleCount = policyConditionCount(selectedPolicy, scope.platforms ?? scope.accounts?.map(account => account.split("/")[0]));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [row, setRow] = useState<DataRow | null>(null);
  const [run, setRun] = useState("");
  const [resultKey, setResultKey] = useState(0);
  const [resultKind, setResultKind] = useState<
    "audit" | "anomalies" | "history"
  >("audit");
  const [resultScope, setResultScope] = useState<Scope>({});
  const seq = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    seq.current++;
    controller.current?.abort();
    setResult(null);
    setRow(null);
    setError("");
    setBusy("");
    setRun("");
    return () => {
      seq.current++;
      controller.current?.abort();
    };
  }, [scopeKey, policyId, selectedPolicy?.version]);
  function resetResult() {
    seq.current++;
    controller.current?.abort();
    setResult(null);
    setRow(null);
    setRun("");
    setError("");
    setBusy("");
  }
  useEffect(() => {
    if (!auditRequest) return;
    const timer = setTimeout(() => { onAuditStarted(); void execute("audit"); }, 0);
    return () => clearTimeout(timer);
  }, [auditRequest]);
  useEffect(() => {
    if (!requestedRun) return;
    const timer = setTimeout(() => { onRunOpened?.(); void loadRun(requestedRun); }, 0);
    return () => clearTimeout(timer);
  }, [requestedRun]);
  async function execute(action: "audit" | "anomalies") {
    if (busy || (action === "audit" && !selectedPolicy)) return;
    const request = ++seq.current;
    controller.current?.abort();
    const pending = new AbortController();
    controller.current = pending;
    setBusy(action);
    setError("");
    setResult(null);
    setRow(null);
    setRun("");
    try {
      const data = await api<Result>(`/${action}`, {
        method: "POST",
        body: {
          ...scope,
          ...(action === "audit"
            ? {
                policy_id: policyId,
              }
            : {}),
        },
        signal: pending.signal,
      });
      if (request === seq.current) {
        setResult(data);
        setRun(data.run_id ?? "");
        setResultKey(request);
        setResultKind(action);
        setResultScope(scope);
        onRefresh();
      }
    } catch (error) {
      if (request === seq.current) setError((error as Error).message);
    } finally {
      if (request === seq.current) setBusy("");
    }
  }
  async function loadRun(id: string) {
    if (busy) return;
    if (!id) {
      resetResult();
      return;
    }
    setRun(id);
    const request = ++seq.current;
    controller.current?.abort();
    const pending = new AbortController();
    controller.current = pending;
    setBusy("history");
    setError("");
    setResult(null);
    setRow(null);
    try {
      const data = await api<Result & { scope?: Scope }>(`/audits/${id}`, {
        signal: pending.signal,
      });
      if (request === seq.current) {
        setResult(data);
        setResultKind("history");
        setResultKey(request);
        setResultScope(data.scope ?? {});
      }
    } catch (error) {
      if (request === seq.current) setError((error as Error).message);
    } finally {
      if (request === seq.current) setBusy("");
    }
  }
  return (
    <>
      <PageHeader title="전체 QA">
        <Button
          disabled={Boolean(busy) || !selectedPolicy || (selectedPolicy.evaluation_mode === "conditions" && !ruleCount)}
          onClick={() => execute("audit")}
        >
          {busy === "audit" ? (
            <Loader2 className="animate-spin" />
          ) : (
            <ClipboardCheck />
          )}
          {busy === "audit"
            ? "광고 설정 검사 중"
            : "전체 QA 실행"}
        </Button>
      </PageHeader>
      <Card className="audit-configuration">
        <CardContent>
          <div className="audit-config-row">
            <div className="audit-config-label">
              <span className="config-icon">
                <CheckCheck size={19} />
              </span>
              <div>
                <h2>검사 범위</h2>
                <p>
                  {selectedPolicy ? `${selectedPolicy.name} · 버전 ${selectedPolicy.version} · 활성 조건 ${ruleCount}개${selectedPolicy.evaluation_mode ? "" : " + 기본 검사"}` : "운영 정책을 선택하세요"}
                </p>
              </div>
            </div>
            <div className="audit-config-actions">
              <PolicyPicker state={state} value={policyId} disabled={Boolean(busy)} onChange={(value) => { onPolicyChange(value); resetResult(); }} />
              <Button
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() => onNavigate("policies")}
              >
                운영 정책 편집
              </Button>
            </div>
          </div>
          <p className="fine-print mt-4">선택한 정책의 적용 매체·계정 범위와 현재 조회 범위가 겹치는 광고를 검사합니다. 저장 전 편집 내용은 적용되지 않습니다.</p>
        </CardContent>
      </Card>
      <div className="audit-secondary-actions">
        <Button
          variant="ghost"
          disabled={Boolean(busy)}
          onClick={() => execute("anomalies")}
        >
          <Sparkles size={15} />
          이상 설정 후보 찾기
          <ArrowUpRight size={13} />
        </Button>
        <div>
          <span>이전 검사</span>
          <Select
            value={run || "none"}
            disabled={Boolean(busy) || !state.recent_audits.length}
            onValueChange={(value) => {
              void loadRun(value === "none" ? "" : value);
            }}
          >
            <SelectTrigger className="w-60" aria-label="이전 검사 불러오기">
              <SelectValue placeholder="검사 이력 선택" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">검사 이력 선택</SelectItem>
              {state.recent_audits.map((item) => (
                <SelectItem key={item.run_id} value={item.run_id}>
                  {dateText(item.at)} · 오류 {item.counts.FAIL ?? 0}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <InlineError message={error} />
      {busy && (
        <Loading
          text={
            busy === "history"
              ? "검사 결과를 불러오고 있습니다"
              : "선택한 항목을 검사하고 있습니다"
          }
        />
      )}
      {result ? (
        <>
          <div className="audit-result-heading">
            <div>
              <h2>
                {resultKind === "history" ? "이전 검사 · " : ""}
                {result.rows.length
                  ? `${result.rows.length.toLocaleString()}${resultKind === "anomalies" ? "개 검토 후보" : "건의 검사 결과"}`
                  : resultKind === "anomalies"
                    ? "설정 차이 후보가 없습니다"
                    : "검사할 광고 설정이 없습니다"}
              </h2>
              {resultKind === "anomalies" && <p>{result.message}</p>}
              <p className="fine-print mt-2">
                {result.selected_policy && <span>적용 정책 · {result.selected_policy.name} v{result.selected_policy.version}<br /></span>}
                검사 당시 범위 · {scopeDescription(resultScope, state)}
                {resultKind === "history"
                  ? " · 현재 선택 범위와 다를 수 있습니다."
                  : ""}
              </p>
            </div>
          </div>
          {result.coverage?.complete === false && (
            <div
              className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
              role="status"
            >
              일부 설정을 조회하지 못했습니다. 확인 불가 항목과 계정 연결 상태를
              확인하세요.
            </div>
          )}
          {result.rows.length > 0 && <div className="audit-counters results-counts">
            {[
              ["FAIL", "오류"],
              ["WARNING", "주의"],
              ["REVIEW", "검토 필요"],
              ["UNKNOWN", "확인 불가"],
            ].map(([status, label]) => (
              <div
                key={status}
                className={`audit-counter counter-${status.toLowerCase()}`}
              >
                <span>{label}</span>
                <strong>
                  {result.counts?.[status] ??
                    result.rows.filter((row) => row.result === status).length}
                </strong>
              </div>
            ))}
          </div>}
          <ResultsTable
            key={`${resultKind}-${run || resultKey}`}
            rows={result.rows}
            kind="audit"
            ruleOptions={state.rule_options}
            title={
              resultKind === "anomalies" ? "설정 이상 후보" : "상세 검사 결과"
            }
            emptyTitle={resultKind === "anomalies"
              ? "설정 차이 후보가 없습니다"
              : "검사할 광고 설정이 없습니다"}
            emptyDescription={result.message}
            onSelect={setRow}
          />
        </>
      ) : (
        !busy && (
          <div className="audit-empty">
            <EmptyState
              title="검사 결과가 없습니다"
              description="검사할 항목을 선택하고 실행하세요."
              icon={FileSearch}
            />
          </div>
        )
      )}
      <EvidenceSheet
        row={row}
        ruleOptions={state.rule_options}
        onClose={() => setRow(null)}
      />
    </>
  );
}
