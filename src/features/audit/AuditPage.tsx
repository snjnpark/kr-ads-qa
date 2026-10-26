import { policyConditionCount } from "@/lib/policy-conditions";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CheckCheck, ClipboardCheck, FileSearch, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, EmptyState, InlineError, dateText, platforms, platformLabel } from "@/components/shared";
import PolicyPicker from "@/components/PolicyPicker";
import ResultsTable from "@/components/ResultsTable";
import EvidenceSheet from "@/components/EvidenceSheet";
import { api } from "@/lib/api";
import { scopeDescription, overviewScopeData } from "@/lib/overview-summary";
import type { AppState, DataRow, Result, Scope } from "@/contracts/api";

import { WorkingState } from "@/components/WorkingState";

type AuditCommand = { kind: "audit" | "anomalies" } | { kind: "history"; id: string };
type AuditResult = Result & { scope?: Scope };

// The command owns admission and request identity; React owns the displayed state.
export async function runAuditCommand(command: AuditCommand, context: {
  busy: string;
  hasPolicy: boolean;
  policyId: string;
  scope: Scope;
  seq: { current: number };
  controller: { current: AbortController | null };
  request: (path: string, options: { method?: string; body?: unknown; signal: AbortSignal }) => Promise<AuditResult>;
  reset: () => void;
  start: (kind: AuditCommand["kind"], id: string) => void;
  complete: (data: AuditResult, request: number, kind: AuditCommand["kind"]) => void;
  fail: (message: string) => void;
  finish: () => void;
}) {
  if (context.busy || (command.kind === "audit" && !context.hasPolicy)) return;
  if (command.kind === "history" && !command.id) {
    context.reset();
    return;
  }
  const request = ++context.seq.current;
  context.controller.current?.abort();
  const pending = new AbortController();
  context.controller.current = pending;
  context.start(command.kind, command.kind === "history" ? command.id : "");
  try {
    const data = await (command.kind === "history"
      ? context.request(`/audits/${command.id}`, { signal: pending.signal })
      : context.request(`/${command.kind}`, {
          method: "POST",
          body: { ...context.scope, ...(command.kind === "audit" ? { policy_id: context.policyId } : {}) },
          signal: pending.signal,
        }));
    if (request === context.seq.current) context.complete(data, request, command.kind);
  } catch (error) {
    if (request === context.seq.current) context.fail((error as Error).message);
  } finally {
    if (request === context.seq.current) context.finish();
  }
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
  function dispatch(command: AuditCommand) {
    return runAuditCommand(command, {
      busy, hasPolicy: Boolean(selectedPolicy), policyId, scope, seq, controller,
      request: api<Result & { scope?: Scope }>,
      reset: resetResult,
      start: (kind, id) => {
        setRun(id);
        setBusy(kind);
        setError("");
        setResult(null);
        setRow(null);
      },
      complete: (data, request, kind) => {
        setResult(data);
        setResultKey(request);
        setResultKind(kind);
        if (kind === "history") {
          setResultScope(data.scope ?? {});
        } else {
          setRun(data.run_id ?? "");
          setResultScope(scope);
          onRefresh();
        }
      },
      fail: setError,
      finish: () => setBusy(""),
    });
  }
  function execute(action: "audit" | "anomalies") {
    return dispatch({ kind: action });
  }
  function loadRun(id: string) {
    return dispatch({ kind: "history", id });
  }
  return (
    <>
      <PageHeader title="검사">
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
            : "검사 실행"}
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
                <h2>적용 정책</h2>
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
          <dl className="audit-scope-summary">
            <div><dt>조회 범위</dt><dd>{scopeDescription(scope, state.accounts, platforms)}</dd></div>
            <div><dt>정책과 겹치는 조회 계정</dt><dd>{selectedPolicy ? (() => {
              const accounts = overviewScopeData(state, scope).accounts.filter(account => selectedPolicy.platforms.includes(account.platform as typeof selectedPolicy.platforms[number]) && (!selectedPolicy.account_ids.length || selectedPolicy.account_ids.includes(account.account_id)));
              return accounts.length ? accounts.map(account => `${platformLabel(account.platform)} · ${account.name}`).join(" / ") : "조회된 계정 없음";
            })() : "정책을 선택하세요"}</dd></div>
          </dl>
          <p className="fine-print mt-3">저장된 정책과 겹치는 범위만 검사합니다. 미저장 편집은 적용되지 않습니다.</p>
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
        <WorkingState
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
                검사 당시 범위 · {scopeDescription(resultScope, state.accounts, platforms)}
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
