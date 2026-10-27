const randomUUID = () => crypto.randomUUID();
import type { BrowserApplication as Application } from "./application";
import type { Entity, Json } from "../domain/entities";
import type { Scope } from "../contracts/domain";
import { semanticIdentity } from "./model/identity";
import type { SemanticInput } from "./model/protocol";
import { observe } from "../domain/policies/evaluation";
import { decimal } from "../domain/policies/values";
import { execute, emptyContext, Clarification, type QueryContext } from "../domain/query/query";
import { QueryModelError, type QueryTrace } from "../domain/query/query-model";
import { resolveQueryScope } from "../domain/query/query-scope";
import type { EvidenceResult, ExecutionPlan, RequestSpec } from "../domain/query/query-request";
import { projectQuery, validateExecutionPlan } from "../domain/query/query-plan";
import { assertQueryInput } from "../domain/query/query-preparation";
import { selected, scopeKey } from "../domain/scope";

export type QueryResponse = Json & {
  rows: Json[];
  status: string;
  message: string;
  count?: number;
  unknown_count?: number;
  semantic_decisions?: Json;
  comparison?: Json[];
};
export type QueryExecutionOptions = {
  onClarification?: (request: RequestSpec) => void;
};
type QueryApplication = Pick<Application,
  "accounts" | "settings" | "ai" | "ensureScope" | "policies" | "audit" |
  "saveSnapshot" | "snapshots" | "compareHistory" | "entities" | "rows" |
  "coverage" | "source" | "storage" | "lastSync" | "collectionGeneration" | "adapters">;

export async function executeApplicationQuery(
  application: QueryApplication,
  text: string,
  context: QueryContext = emptyContext(),
  scope: Scope = {},
  options: QueryExecutionOptions = {},
): Promise<QueryResponse> {
  if (!application.accounts.length && !Object.keys(application.adapters).length)
    return { rows: [], status: "REVIEW", query_state: "needs_clarification", message: "설정에서 광고 API를 연결하고 계정 데이터를 불러온 뒤 질문해 주세요." };
  let query;
  let interpretation: QueryTrace;
  let request: RequestSpec;
  let executionPlan: ExecutionPlan;
  let effectiveScope: Scope;
  try {
    assertQueryInput(text);
    const result = await application.ai.parseQuery(text, context, new Date(), application.settings.timezone);
    interpretation = result.trace;
    request = structuredClone(result.request);
    request.input.scope = structuredClone(scope);
    executionPlan = result.execution_plan;
    if (request.state !== "ready" || !request.workflow || !executionPlan || !Array.isArray(executionPlan.steps))
      throw new Clarification("검증된 조회 계획을 확인하지 못했습니다. 다시 질문해 주세요.");
    executionPlan = validateExecutionPlan(executionPlan, request, context);
    query = projectQuery(executionPlan, request);
    if (query.previous && context.scope !== scopeKey(scope))
      throw new Clarification("조회 범위가 변경되었습니다. 현재 범위에서 먼저 검색해 주세요.");
    effectiveScope = resolveQueryScope(query, scope);
    query.platforms = (effectiveScope.platforms ?? []) as typeof query.platforms;
  } catch (error) {
    if (error instanceof QueryModelError && error.request && error.trace.outcome !== "inference")
      options.onClarification?.(error.request);
    return {
      rows: [],
      status: "REVIEW",
      message:
        error instanceof Error ? error.message : "질문을 확인해 주세요.",
      query_state: error instanceof QueryModelError ?
        (error.trace.outcome === "unsupported" ? "unsupported" : error.trace.outcome === "inference" ? "error" : "needs_clarification") :
        error instanceof Clarification ? "needs_clarification" : "error",
      ...(error instanceof QueryModelError ? { query_interpretation: error.trace } : {}),
    };
  }
  if (query.previous && context.data_generation !== application.collectionGeneration)
    return { rows: [], status: "REVIEW", query_state: "needs_clarification", message: "광고 자료가 변경되었습니다. 현재 자료에서 먼저 새로 검색해 주세요." };
  if (["audit", "policy", "history", "create_rule"].includes(query.operation) && query.previous)
    return { rows: [], status: "REVIEW", query_state: "needs_clarification", message: "전체 QA 또는 변경 이력 화면에서 조회 범위를 선택해 실행해 주세요." };
  const workflow = executionPlan.workflow;
  const named = ["audit", "policy"].includes(query.operation) ? application.policies.list()
    .filter(policy => workflow.policy_terms.some(term => term.includes(policy.name) || term.includes(policy.policy_id))) : [];
  const missingPolicy = () => !named.length && (workflow.requires_policy || (query.operation === "policy" &&
    application.accounts.filter(account => selected(account, effectiveScope) &&
      (!effectiveScope.products?.length || application.entities.some(entity =>
        entity.platform === account.platform && entity.account_id === account.account_id && selected(entity, effectiveScope))))
      .some(account => !application.policies.forAccount(account.platform, account.account_id))));
  if (named.length > 1)
    return { rows: [], status: "REVIEW", query_state: "needs_clarification", message: "적용할 운영 정책을 하나만 지정해 주세요." };
  if (["audit", "policy"].includes(query.operation) && missingPolicy())
    return { rows: [], status: "REVIEW", query_state: "needs_clarification", message: "운영 정책을 먼저 등록하고 선택한 계정에 연결해 주세요." };
  if (query.operation !== "create_rule") {
    await application.ensureScope(scope);
    if (query.previous && context.data_generation !== application.collectionGeneration)
      return { rows: [], status: "REVIEW", query_state: "needs_clarification", message: "광고 자료가 갱신되었습니다. 현재 자료에서 먼저 새로 검색해 주세요." };
    if (!application.accounts.length)
      return { rows: [], status: "REVIEW", query_state: "needs_clarification", message: "조회할 광고 계정 자료를 확인하지 못했습니다. 연결과 조회 범위를 확인해 주세요.", coverage: application.coverage, source: application.source };
  }
  const summarize = (response: QueryResponse, evidence?: EvidenceResult): QueryResponse => ({
    ...response,
    query_state: "completed",
    evidence_result: {
      operation: query.operation, entity: query.entity, scope: structuredClone(effectiveScope),
      data_generation: application.collectionGeneration, collected_at: application.lastSync,
      complete: application.coverage.complete,
      count: evidence?.count ?? response.rows.length, unknown_count: evidence?.unknown_count ?? response.unknown_count ?? response.coverage?.unknown_count ?? 0,
      displayed_count: response.rows.length, steps: executionPlan.steps.map(step => step.kind),
    },
  });
  const intent = application.ai.mock ? await application.ai.classify(text) : {
    label: query.operation === "find" || query.operation === "count" ? "search" : query.operation,
    source: "laya", model_version: interpretation.model_version, reason: "검증을 통과한 모델 조회 조건입니다.",
  };
  if (query.operation === "audit" || query.operation === "policy") {
    if (missingPolicy())
      return { rows: [], status: "REVIEW", query_state: "needs_clarification", message: "운영 정책을 먼저 등록하고 선택한 계정에 연결해 주세요." };
    Object.assign(context, emptyContext(), { scope: scopeKey(scope) });
    delete context.data_generation;
    const result = application.audit(effectiveScope, named[0]?.policy_id);
    if (query.operation === "policy" && workflow.violations_only)
      result.rows = result.rows.filter((r) =>
        ["FAIL", "WARNING", "REVIEW"].includes(r.result),
      );
    return summarize({ ...result, result_type: "audit" });
  }
  if (query.operation === "create_rule")
    return {
      rows: [],
      status: "REVIEW",
      message: "규칙 만들기 화면에서 검사 조건을 미리 보고 승인해 주세요.",
      query_state: "needs_clarification",
      rule_request: text,
      intent,
    };
  if (query.operation === "history") {
    Object.assign(context, emptyContext(), { scope: scopeKey(scope) });
    delete context.data_generation;
    const saved = application.saveSnapshot();
    let prior = application.snapshots
      .list()
      .filter(
        (s) =>
          s.snapshot_id !== saved.snapshot_id &&
          s.created_at < saved.created_at,
      );
    const period = workflow.history?.period;
    if (period)
      prior = prior.filter(
        (s) =>
          Date.parse(s.created_at) >= period[0] &&
          Date.parse(s.created_at) < period[1],
      );
    if (!prior.length)
      return summarize({
        result_type: "history",
        rows: [],
        status: "REVIEW",
        message:
          "현재 설정을 저장했습니다. 비교할 이전 저장 기록이 없습니다.",
      });
    const response = await application.compareHistory(
      prior[0].snapshot_id,
      saved.snapshot_id,
      effectiveScope,
    );
    let rows = response.rows;
    if (workflow.history?.fields.includes("budget"))
      rows = rows.filter((row) => row.field.startsWith("budget."));
    if (workflow.history?.fields.includes("targeting"))
      rows = rows.filter((row) => row.field.startsWith("targeting."));
    if (workflow.history?.entity)
      rows = rows.filter((row) => row.entity_type === workflow.history!.entity);
    if (workflow.history?.increased_only)
      rows = rows.filter((row) => {
        const before = decimal(row.before),
          after = decimal(row.after);
        return !!before && !!after && after.gt(before);
      });
    return summarize({
      ...response,
      result_type: "history",
      rows,
      message: `요청 조건에 해당하는 설정 차이 ${rows.length}개를 찾았습니다.`,
    });
  }
  let [matched, unknown] = execute(
    query,
    application.entities.filter((e) => selected(e, effectiveScope)),
    context,
  );
  const decisions: Json = {},
    reasons: Record<string, string> = {};
  if (query.semantic) {
    const question = {
      retarget:
        "Does the advertising entity name or purpose indicate retargeting of existing visitors or customers?",
      purchase_mismatch:
        "Does the advertising entity name or purpose indicate optimizing for purchases?",
      branding:
        "Does the advertising entity name or purpose indicate brand awareness?",
    }[query.semantic]!;
    const items: SemanticInput[] = matched.map((e) => ({
        platform: e.platform,
        account_id: e.account_id,
        entity_type: e.entity_type,
        entity_id: e.entity_id,
        name: e.name,
        purpose: e.extensions.declared_purpose,
        text: e.text,
      })),
      judged = await application.ai.judgeBatch(items, question),
      byId = new Map(judged.map((r) => [r.entity_id, r])),
      keep: Entity[] = [];
    for (let i = 0; i < matched.length; i++) {
      const e = matched[i],
        decision = byId.get(semanticIdentity(items[i]));
      if (!decision) {
        unknown.push(e);
        continue;
      }
      decisions[e.key] = { ...decision };
      const actual =
        query.semantic !== "branding"
          ? actualConfiguration(e, query.semantic === "retarget" ? "retarget" : "purchase")
          : undefined;
      if (actual) decisions[e.key].actual_configuration = actual;
      if (decision.status === "UNKNOWN" || decision.label === null) {
        unknown.push(e);
        continue;
      }
      if (!["true", "yes"].includes(decision.label)) continue;
      if (actual) {
        if (actual.value === null) {
          unknown.push(e);
          continue;
        }
        if (actual.value) continue;
      }
      keep.push(e);
      reasons[e.key] = application.ai.mock
        ? "예시 분류 결과"
        : "이름·문구와 실제 설정을 확인해 주세요.";
    }
    matched = keep;
  }
  const comparison: Json[] = [];
  if (query.operation === "compare")
    for (const path of [
      "status",
      "budget.daily",
      "budget.lifetime",
      "schedule.start",
      "schedule.end",
      "targeting.countries",
      "optimization.goal",
      "tracking.url",
    ]) {
      const values = Object.fromEntries(
        matched.map((e) => [
          e.key,
          {
            ...observe(e, path),
            currency: path.startsWith("budget.") ? e.currency : null,
          },
        ]),
      );
      if (
        new Set(
          Object.values(values).map((v) =>
            JSON.stringify({
              value: v.value,
              state: v.state,
              currency: v.currency,
            }),
          ),
        ).size > 1
      )
        comparison.push({ field: path, values });
    }
  const rows = application.rows(matched.slice(0, 100)).map((row) => ({
    ...row,
    result:
      query.semantic || query.operation === "compare" ? "REVIEW" : "MATCH",
    reason:
      reasons[row.key] ??
      (query.operation === "compare"
        ? "설정 차이 비교"
        : "질의 조건과 조회한 설정값 일치"),
    ...(decisions[row.key]
      ? {
          semantic: decisions[row.key],
          model: decisions[row.key].model_version,
        }
      : {}),
    ...(comparison.length ? { comparison } : {}),
  }));
  Object.assign(context, {
    result_keys: matched.map((e) => e.key),
    platforms: query.platforms,
    account_ids: scope.accounts ?? [],
    entity: query.entity,
    has_results: true,
    scope: scopeKey(scope),
    data_generation: application.collectionGeneration,
  });
  const evidenceReasons = Object.fromEntries([
    ...matched.map(entity => [entity.key, reasons[entity.key] ?? (query.operation === "compare" ? "설정 차이 비교" : "질의 조건과 조회한 설정값 일치")]),
    ...unknown.map(entity => [entity.key, "조건에 필요한 설정 또는 의미 판단의 근거를 확인하지 못했습니다."]),
  ]);
  const evidenceResult: EvidenceResult = {
    plan: executionPlan, scope: structuredClone(effectiveScope),
    matched_keys: matched.map(entity => entity.key), unknown_keys: unknown.map(entity => entity.key),
    rows, count: matched.length, unknown_count: unknown.length, complete: application.coverage.complete,
    collected_at: application.lastSync, reasons: evidenceReasons,
  };
  const response = summarize({
    result_type: "entities" as const,
    message:
      query.operation === "compare"
        ? `${matched.length}개 광고 항목을 비교했습니다. ${comparison.length}개 설정이 다릅니다.`
        : query.semantic
          ? `검토할 광고 ${matched.length}개를 찾았습니다.${unknown.length ? ` ${unknown.length}개는 판단을 보류했습니다.` : ""}`
          : `${matched.length}개가 조건에 해당합니다.${unknown.length ? ` ${unknown.length}개는 필요한 설정을 확인하지 못했습니다.` : ""}`,
    rows,
    status:
      query.semantic || unknown.length || !application.coverage.complete
        ? "REVIEW"
        : "PASS",
    count: matched.length,
    unknown_count: unknown.length,
    intent,
    query_interpretation: interpretation,
    semantic_decisions: decisions,
    comparison,
    query,
    source: application.source,
    coverage: application.coverage,
  }, evidenceResult);
  application.storage.put("query_history", randomUUID(), {
    question: text,
    response: JSON.parse(JSON.stringify(response)),
    at: new Date().toISOString(),
  });
  return response;
}

export function actualConfiguration(entity: Entity, domain: string): Json {
  const path =
      domain === "retarget"
        ? "targeting.custom_audiences"
        : "optimization.goal",
    item = observe(entity, path);
  let value: boolean | null = null,
    reason = "필요한 설정을 조회하지 못했습니다.";
  const fields: Json = { [path]: item };
  if (item.known && item.state === "PRESENT" && domain === "retarget") {
    if (Array.isArray(item.value) && !item.value.length) {
      value = false;
      reason = "조회한 포함 맞춤 오디언스 목록이 비어 있습니다.";
    } else if (Array.isArray(item.value))
      reason =
        "오디언스 ID만으로 기존 방문자·고객 대상인지 확인할 수 없습니다.";
  }
  if (item.known && domain === "purchase") {
    const goal = String(item.value).toUpperCase();
    if (
      ["PURCHASE", "PURCHASES", "OFFSITE_CONVERSIONS_PURCHASE"].includes(goal)
    ) {
      value = true;
      reason = "조회한 최적화 목표가 구매입니다.";
    } else if (["OFFSITE_CONVERSIONS", "CONVERSIONS", "VALUE"].includes(goal)) {
      const event = observe(entity, "optimization.event");
      fields["optimization.event"] = event;
      if (event.known && event.value) {
        value = String(event.value).toUpperCase() === "PURCHASE";
        reason = "조회한 전환 목표와 실제 이벤트를 함께 비교했습니다.";
      }
    } else if (
      [
        "LINK_CLICKS",
        "LANDING_PAGE_VIEWS",
        "REACH",
        "AD_RECALL_LIFT",
        "IMPRESSIONS",
        "VIDEO_VIEWS",
        "THRUPLAY",
        "CLICKS",
      ].includes(goal)
    ) {
      value = false;
      reason = "조회한 목표가 구매 이벤트 최적화가 아닙니다.";
    }
  }
  return {
    value,
    state: item.state,
    fields,
    sources: Object.keys(fields).map((field) => entity.sources[field] || field),
    reason,
  };
}
