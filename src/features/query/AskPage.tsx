import { TEST_MODE } from "@/lib/runtime";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUp, ArrowUpRight, CircleHelp, FileSearch, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, InlineError } from "@/components/shared";
import ResultsTable from "@/components/ResultsTable";
import EvidenceSheet from "@/components/EvidenceSheet";
import ComparisonTable from "@/components/ComparisonTable";
import { HistoryResults } from "@/features/history/HistoryResults";
import { Notice } from "@/components/secondary/WorkspaceParts";
import { api } from "@/lib/api";
import { semanticOutcome, unknownResultTitle } from "@/lib/evidence";
import type { AppState, AskRequest, DataRow, QueryClarification, Result, Scope } from "@/contracts/api";

import { WorkingState } from "@/components/WorkingState";

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
  const [answerText, setAnswerText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [row, setRow] = useState<DataRow | null>(null);
  const [showMeaning, setShowMeaning] = useState(false);
  const [submitted, setSubmitted] = useState("");
  const [clarification, setClarification] = useState<QueryClarification | null>(null);
  const inputText = clarification ? answerText : text;
  const [resultKey, setResultKey] = useState(0);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const clarificationRef = useRef<QueryClarification | null>(null);
  const clearing = useRef<Promise<unknown> | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const scopeKey = JSON.stringify(scope);
  function updateClarification(value: QueryClarification | null) {
    clarificationRef.current = value;
    setClarification(value);
  }
  function releaseClarification() {
    const requestId = clarificationRef.current?.request_id;
    if (!requestId && !controller.current) return;
    clarificationRef.current = null;
    clearing.current = (clearing.current ?? Promise.resolve()).then(() => api<Result>("/ask", {
      method: "DELETE", body: requestId ? { request_id: requestId } : {},
    })).catch(() => undefined);
  }
  useEffect(() => {
    sequence.current++;
    controller.current?.abort();
    releaseClarification();
    controller.current = null;
    setText(preset);
    setAnswerText("");
    setResult(null);
    setRow(null);
    setShowMeaning(false);
    setSubmitted("");
    updateClarification(null);
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
    if (clarification && active) input.current?.focus();
  }, [clarification, active]);
  useEffect(() => {
    sequence.current++;
    controller.current?.abort();
    releaseClarification();
    controller.current = null;
    setResult(null);
    setRow(null);
    setShowMeaning(false);
    setSubmitted("");
    setAnswerText("");
    updateClarification(null);
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
    releaseClarification();
    setText("");
    setAnswerText("");
    setSubmitted("");
    updateClarification(null);
    setResult(null);
    setRow(null);
    setShowMeaning(false);
    setError("");
    setBusy(false);
    input.current?.focus();
  }
  function useQuestion(question: string) {
    releaseClarification();
    updateClarification(null);
    setAnswerText("");
    setText(question);
    input.current?.focus();
  }
  async function search() {
    // The controller ref locks immediately, before React publishes the busy state.
    if (!inputText.trim() || busy || (controller.current && !controller.current.signal.aborted)) return;
    const request = ++sequence.current;
    controller.current?.abort();
    const pending = new AbortController();
    controller.current = pending;
    setBusy(true);
    setError("");
    setResult(null);
    setRow(null);
    setShowMeaning(false);
    if (!clarification) setSubmitted(text.trim());
    const body: AskRequest = { text: inputText.trim(), ...scope,
      ...(clarification ? { clarification: { request_id: clarification.request_id, slot_id: clarification.slot_id } } : {}) };
    try {
      await clearing.current;
      if (sequence.current !== request || pending.signal.aborted) return;
      const data = await api<Result>("/ask", {
        method: "POST",
        body,
        signal: pending.signal,
      });
      if (sequence.current === request) {
        setResult(data);
        setResultKey(request);
        if (data.query_state === "error") setError(data.message);
        else updateClarification(data.clarification ?? null);
        if (data.clarification && !clarification) setAnswerText("");
        if (data.clarification && clarification) setError(data.message);
        if (data.query_state === "completed") {
          if (clarification) { setText(""); setAnswerText(""); }
          onRefresh();
        }
      }
    } catch (error) {
      if (sequence.current === request) setError((error as Error).message);
    } finally {
      if (sequence.current === request) { controller.current = null; setBusy(false); }
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
            <h1>광고 설정 검색</h1>
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
            aria-label={clarification ? "조건 확인 답변" : "광고 설정 질문"}
            aria-describedby={clarification ? "search-clarification-prompt search-keyboard-hint" : "search-keyboard-hint"}
            rows={1}
            maxLength={2000}
            placeholder={clarification ? clarification.kind === "budget_criterion" ? "예: 3만 원 이상" : clarification.kind === "name_value" ? "예: '봄'" : "예: 오늘, 지난주, 2026-10-20" : "광고 설정에 대해 질문하세요"}
            value={inputText}
            onChange={(event) => clarification ? setAnswerText(event.target.value) : setText(event.target.value)}
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
          {inputText.length > 0 && !busy && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="search-clear"
              aria-label={clarification ? "답변 지우기" : "질문 지우기"}
              onClick={() => { if (clarification) setAnswerText(""); else setText(""); input.current?.focus(); }}
            >
              <X />
            </Button>
          )}
          <Button
            type="submit"
            size="icon"
            className="search-submit"
            aria-label={clarification ? "조건 확인" : "설정 검색"}
            disabled={busy || !inputText.trim()}
          >
            {busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </Button>
        </form>
        <div className="search-hint" id="search-keyboard-hint">
          <span className="keyboard-hint">
            {clarification ? "Enter로 답변 · Shift + Enter로 줄바꿈" : "Enter로 검색 · Shift + Enter로 줄바꿈"}
          </span>
        </div>
        {!submitted && (
          <section
            className={`search-examples ${text.length > 0 ? "search-examples-hidden" : ""}`}
            aria-label="질문 예시"
            aria-hidden={text.length > 0}
          >
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
        {clarification && (
          <div className="query-summary">
            <div>
              <h2>{submitted}</h2>
              <p id="search-clarification-prompt" role="status">{clarification.prompt}</p>
            </div>
          </div>
        )}
        {busy && <WorkingState text={clarification ? "조건을 확인하고 있습니다" : "광고 설정을 검색하고 있습니다"} />}
        {result && !clarification && (
          <>
            <div className="query-summary">
              <div>
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
            {result.query_state && result.query_state !== "completed" ? null : result.result_type === "history" ? (
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
