import { useEffect, useState } from "react";
import { ArrowRight, ArrowUpRight, ClipboardCheck, Layers3, ShieldCheck, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, PlatformMark, StatusBadge, EmptyState, InlineError, dateText, platforms } from "@/components/shared";
import PolicyPicker from "@/components/PolicyPicker";
import EvidenceSheet from "@/components/EvidenceSheet";
import { api } from "@/lib/api";
import { scopeDescription, matchingOverviewAudit, overviewScopeData } from "@/lib/overview-summary";
import { policyConditionCount } from "@/lib/policy-conditions";
import type { AppState, DataRow, Result, Scope } from "@/contracts/api";

export default function OverviewPage({
  state,
  scope,
  onNavigate,
  policyId, onPolicyChange, onAudit, onOpenAudit,
}: {
  policyId: string; onPolicyChange: (id: string) => void; onAudit: () => void; onOpenAudit?: (id: string) => void;
  state: AppState;
  onNavigate: (page: string) => void;
  scope: Scope;
}) {
  const latestAudit = matchingOverviewAudit(state, scope);
  const scopedData = overviewScopeData(state, scope);
  const [row, setRow] = useState<DataRow | null>(null);
  const [recent, setRecent] = useState<DataRow[]>([]);
  const [recentError, setRecentError] = useState("");
  useEffect(() => {
    setRow(null);
  }, [state.last_sync]);
  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();
    setRecent([]);
    setRecentError("");
    const id = latestAudit?.run_id;
    if (id)
      api<Result>(`/audits/${id}`, { signal: controller.signal })
        .then((data) => {
          if (!ignore)
            setRecent(
              data.rows
                .filter((row) =>
                  ["FAIL", "WARNING", "REVIEW", "UNKNOWN"].includes(
                    String(row.result),
                  ),
                )
                .sort(
                  (first, second) =>
                    ["FAIL", "WARNING", "REVIEW", "UNKNOWN"].indexOf(
                      String(first.result),
                    ) -
                    ["FAIL", "WARNING", "REVIEW", "UNKNOWN"].indexOf(
                      String(second.result),
                    ),
                )
                .slice(0, 6),
            );
        })
        .catch(() => {
          if (!ignore)
            setRecentError(
              "최근 검사를 불러오지 못했습니다. 검사 이력에서 다시 확인하세요.",
            );
        });
    return () => {
      ignore = true;
      controller.abort();
    };
  }, [latestAudit?.run_id]);
  const counts = latestAudit?.counts ?? {};
  const selectedPolicy = state.policies.find(policy => policy.policy_id === policyId);
  return (
    <>
      <PageHeader title="현황">
        <Button disabled={!selectedPolicy || (selectedPolicy.evaluation_mode === "conditions" && !policyConditionCount(selectedPolicy, scope.platforms))} onClick={onAudit}>
          <ClipboardCheck />
          검사 실행
          <ArrowUpRight className="ml-2" />
        </Button>
      </PageHeader>
      <Card className="mb-5"><CardContent className="flex flex-wrap items-center gap-3 pt-5">
        <span className="text-sm font-medium">적용 정책</span>
        <PolicyPicker state={state} value={policyId} onChange={onPolicyChange} />
        <Button variant="outline" onClick={() => onNavigate("policies")}>정책 편집</Button>
        {!selectedPolicy && <p className="text-sm text-muted-foreground">운영 정책을 먼저 만들고 저장하세요.</p>}
      </CardContent></Card>
      <div className="overview-stats">
        <div>
          <span className="stat-label">
            <Layers3 size={15} />
            조회한 광고 설정
          </span>
          <strong>
            {scopedData.entities.length.toLocaleString()}
            <small>개</small>
          </strong>

        </div>
        <div>
          <span className="stat-label">
            <ShieldCheck size={15} />
            연결된 광고 계정
          </span>
          <strong>
            {scopedData.accounts.length}
            <small>개</small>
          </strong>
          <p>
            {new Set(scopedData.accounts.map((account) => account.platform)).size}개
            매체
          </p>
        </div>
        <div>
          <span className="stat-label">
            <CheckCheck size={15} />
            선택한 정책의 활성 조건
          </span>
          <strong>
            {policyConditionCount(selectedPolicy, scope.platforms ?? scope.accounts?.map(account => account.split("/")[0]))}
            <small>개</small>
          </strong>
          <p>{selectedPolicy ? `${selectedPolicy.name} · v${selectedPolicy.version}${selectedPolicy.evaluation_mode ? "" : " · 기본 검사 포함"}` : "저장된 정책을 선택하세요"}</p>
        </div>
      </div>
      <div className="overview-grid">
        <Card className="overview-audit">
          <CardHeader>
            <div className="section-heading">
              <CardTitle>마지막 검사 결과</CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => latestAudit && onOpenAudit ? onOpenAudit(latestAudit.run_id) : onNavigate("audit")}
              >
                검사 이력
                <ArrowRight />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {latestAudit ? (
              <>
                <p className="muted text-xs mb-5">
                  {dateText(latestAudit.at)}에 저장한 검사 ·{" "}
                  {scopeDescription(latestAudit.scope, state.accounts, platforms)}
                </p>
                <div className="audit-counters">
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
                      <strong>{counts[status] ?? 0}</strong>
                    </div>
                  ))}
                </div>
                <div className="quality-track" aria-label="최근 검사 판정 분포">
                  {Object.entries(counts)
                    .filter(([, value]) => value > 0)
                    .map(([status, count]) => (
                      <span
                        key={status}
                        className={`track-${status.toLowerCase()}`}
                        style={{ flex: count }}
                        title={`${({ FAIL: "오류", WARNING: "주의", REVIEW: "검토 필요", UNKNOWN: "확인 불가", PASS: "정상", NOT_APPLICABLE: "해당 없음" } as Record<string, string>)[status] ?? status} ${count}건`}
                      />
                    ))}
                </div>
                <p className="fine-print">
                  정상 {(counts.PASS ?? 0).toLocaleString()}건 · 해당 없음{" "}
                  {(counts.NOT_APPLICABLE ?? 0).toLocaleString()}건 포함
                </p>
              </>
            ) : (
              <EmptyState
                title="저장된 검사 결과가 없습니다"
                description={scopedData.accounts.length ? "검사를 실행하면 확인이 필요한 항목을 볼 수 있습니다." : "광고 API를 연결하면 계정의 설정을 불러와 점검할 수 있습니다."}
                icon={ClipboardCheck}
                action={
                  <Button variant="outline" onClick={() => onNavigate(scopedData.accounts.length ? "audit" : "settings")}>
                    {scopedData.accounts.length ? "검사 항목 확인하기" : "광고 API 연결하기"}
                    <ArrowRight />
                  </Button>
                }
              />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>매체별 조회 현황</CardTitle>
          </CardHeader>
          <CardContent className="channel-list">
            {Object.entries(platforms).map(([platform]) => {
              const entities = scopedData.entities.filter(
                (row) => row.platform === platform,
              );
              const accounts = scopedData.accounts.filter(
                (account) => account.platform === platform,
              );
              return (
                <div className="channel-row" key={platform}>
                  <PlatformMark platform={platform} />
                  <div>
                    <strong>
                      {entities.length.toLocaleString()}
                      <span>개 설정</span>
                    </strong>
                    <small>
                      {accounts.length
                        ? `${accounts.length}개 연결 계정`
                        : "계정 정보 없음"}
                    </small>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
      <InlineError message={recentError} />
      <Card className="overview-preview">
        <CardHeader><div className="section-heading">
          <CardTitle>{recent.length ? "먼저 확인할 항목" : "광고 설정 미리보기"}</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => recent.length && latestAudit && onOpenAudit ? onOpenAudit(latestAudit.run_id) : onNavigate(recent.length ? "audit" : "ask")}>
            {recent.length ? "검사 결과 보기" : "광고 설정 검색"}<ArrowRight />
          </Button>
        </div></CardHeader>
        <CardContent>
          <p className="fine-print mb-3">{recent.length ? `${recent.length}개 우선 표시` : `조회된 ${scopedData.entities.length.toLocaleString()}개 중 ${Math.min(scopedData.entities.length, 8)}개 미리보기`}</p>
          <ul className="overview-preview-list">
            {(recent.length ? recent : scopedData.entities.slice(0, 8)).map((item, index) => <li key={item.key ?? index}>
              <button type="button" onClick={() => setRow(item)}>
                <span><strong>{String(item.name || item.id || "이름 미조회")}</strong><small>{platforms[String(item.platform)] ?? item.platform} · {String(item.account_name || item.account_id || item.account || "계정명 미조회")}</small></span>
                <StatusBadge status={recent.length ? item.result : item.status} />
              </button>
            </li>)}
          </ul>
          {!scopedData.entities.length && !recent.length && <p className="text-sm text-muted-foreground">조회된 광고 설정이 없습니다.</p>}
        </CardContent>
      </Card>
      <EvidenceSheet
        row={row}
        ruleOptions={state.rule_options}
        onClose={() => setRow(null)}
      />
    </>
  );
}
