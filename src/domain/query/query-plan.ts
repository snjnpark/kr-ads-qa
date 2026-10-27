import { verifySlotBinding } from "./query-clarification";
import { Clarification, type Query, type QueryContext } from "./query";
import { fieldPaths, queryPlanSchema, type QueryPlan } from "./query-contract";
import type { ExecutionPlan, RequestSpec, RequestEvidence } from "./query-request";
import { assertEntityCapabilities, descendantType } from "./query-scope";

const evidenceRoles = ["filter", "logic", "target_declaration", "operation", "entity", "scope", "reference", "relation", "semantic", "workflow", "slot"];
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function fail(message = "질문에 명시한 조건과 실행 계획이 일치하지 않습니다. 요청한 조건을 확인해 주세요."): never { throw new Clarification(message); }

/** Check source facts and the finite, source-authorized choices without interpreting the question again. */
export function validateRequestPlan(raw: unknown, request: RequestSpec, context?: QueryContext): QueryPlan {
  const parsed = queryPlanSchema.safeParse(raw);
  if (!parsed.success) fail("조회 조건 형식을 확인하지 못했습니다. 질문을 구체적으로 입력해 주세요.");
  const plan = parsed.data!;
  if (request.state === "unsupported" || request.issues?.length) fail(request.issues?.[0]?.message);
  const selection = request.selection;
  if (!selection) fail("요청 조건의 검증 정보가 없습니다. 질문을 다시 입력해 주세요.");
  if (plan.children && context?.has_results && !descendantType(context.entity, plan.entity)) fail("이전 결과 아래에서 조회할 수 있는 하위 대상을 지정해 주세요.");
  if (!["find", "count"].includes(plan.operation) && request.operation !== plan.operation) fail("조회 방식과 질문의 요청이 일치하지 않습니다. 원하는 작업을 확인해 주세요.");
  if (request.entity && request.entity !== plan.entity) fail("질문에 명시한 조회 대상과 계획이 일치하지 않습니다.");
  if (request.operation && request.operation !== plan.operation) fail("질문에 명시한 작업과 계획이 일치하지 않습니다. 요청한 작업을 생략할 수 없습니다.");
  if (new Set(plan.platforms).size !== plan.platforms.length) fail("조회 범위와 이전 검색 결과를 확인해 주세요.");
  if (plan.previous !== (request.reference !== "all") || plan.children !== (request.reference === "children"))
    fail("이전 결과 참조가 질문과 일치하지 않습니다. 하위 대상 참조를 생략하거나 바꿀 수 없습니다.");
  if (plan.previous && (!context?.has_results || !request.input.previous.has_results || context.platforms.length && plan.platforms.some(platform => !context.platforms.includes(platform))))
    fail("이전 결과의 매체와 다릅니다. 이전 검색 결과와 조회 범위를 확인해 주세요.");
  if (!same([...request.platforms].sort(), [...plan.platforms].sort()))
    fail("질문에 명시한 매체의 조회 범위와 계획이 일치하지 않습니다.");
  if (plan.previous && (request.input.previous.entity !== context!.entity || request.input.previous.scope !== (context!.scope ?? null) || !same(request.input.previous.platforms, context!.platforms)))
    fail("이전 결과의 대상이나 조회 범위가 변경되었습니다. 새로 검색해 주세요.");
  if (["audit", "policy", "history"].includes(plan.operation) && (plan.filters.length || plan.semantic || plan.previous))
    fail("조건으로 좁힌 대상의 검수·정책·이력은 해당 화면에서 조회 범위를 선택해 주세요.");
  if (plan.filters.length > 1 && selection.logic && selection.logic !== plan.logical_operator) fail("질문에 명시한 조건의 AND/OR 연결과 계획이 일치하지 않습니다.");
  const seen = new Set<string>();
  for (const filter of plan.filters) {
    if (seen.has(filter.field)) fail("같은 항목의 여러 조건을 묶는 방법을 확인해 주세요.");
    seen.add(filter.field);
    if ((filter.operator === "is_empty" || filter.operator === "is_not_empty") !== (filter.value === undefined)) fail("질문에 명시한 조건과 일치하지 않습니다. 조회 조건의 비교 값을 확인해 주세요.");
    const bound = request.conditions.find(condition => condition.filter.field === filter.field);
    if (bound ? !same(bound.filter, filter) : !selection.filters.some(option => option.field === filter.field && option.alternatives.some(candidate => same(candidate, filter))))
      fail(filter.field.startsWith("budget.") ? "질문에 명시한 조건과 실행 계획이 일치하지 않습니다. 예산의 비교 방향과 설정 유무·비교 값을 확인해 주세요." : "질문에 명시한 조건과 실행 계획이 일치하지 않습니다. 근거 없는 비교 방향·값을 추가하거나 변경할 수 없습니다.");
  }
  for (const condition of request.conditions) if (!plan.filters.some(filter => same(filter, condition.filter))) fail("질문에 명시한 조건과 실행 계획이 일치하지 않습니다. 지정한 조건을 생략할 수 없습니다.");
  for (const ambiguity of request.ambiguities.filter(item => item.endsWith(":ambiguous_predicate")))
    if (!seen.has(fieldPaths[ambiguity.split(":")[0]])) fail("부정 표현이 포함된 조건을 생략할 수 없습니다. 원하는 조건을 긍정 표현으로 다시 알려주세요.");
  for (const requirement of selection.required_fields)
    if (!(requirement.unless_semantic && plan.semantic) && !requirement.fields.some(field => seen.has(field))) fail("질문에 명시한 조건과 실행 계획이 일치하지 않습니다. 지정한 항목의 조건을 생략할 수 없습니다.");
  if (plan.filters.some(filter => filter.field.startsWith("budget.") && !["is_empty", "is_not_empty"].includes(filter.operator)) && plan.currency !== selection.currency)
    fail("질문에 명시한 예산 통화와 계획이 일치하지 않습니다.");
  if (!selection.shapes.some(shape => shape.operation === plan.operation && shape.semantic === plan.semantic))
    fail(plan.semantic && !request.semantic && selection.source_complete ? "질문에 명시한 목적과 조회 계획이 일치하지 않습니다. 근거 없는 의미 조건을 추가할 수 없습니다." : "질문에 명시한 조건과 조회 방식이 일치하지 않습니다. 해석하지 못한 추가 조건을 확인해 주세요.");
  assertEntityCapabilities(plan.entity, plan.platforms, request.products);
  const extraSources = request.sources ?? [];
  if (extraSources.some(source => source.id === "question") || new Set(extraSources.map(source => source.id)).size !== extraSources.length) fail("원문 근거의 출처 식별자가 중복되었습니다.");
  if (request.continuation) {
    const {slot} = request.continuation, binding = verifySlotBinding(request.input, request.continuation);
    const slotFacts = request.evidence.filter(fact => fact.role === "slot");
    const answerFacts = request.evidence.filter(fact => fact.source_id === "answer");
    if (extraSources.length !== 1 || extraSources[0].id !== "answer" || extraSources[0].text !== binding.text ||
        slotFacts.length !== 1 || slotFacts[0].source_id !== "question" || slotFacts[0].owner !== slot.owner || !same(slotFacts[0].span, slot.span) || slotFacts[0].text !== slot.text || !same(slotFacts[0].value, slot) ||
        answerFacts.length !== 1 || answerFacts[0].role !== "filter" || answerFacts[0].owner !== slot.owner || !same(answerFacts[0].span, binding.span) || answerFacts[0].text !== binding.text || !same(answerFacts[0].value, binding.filter) ||
        !request.conditions.some(condition => condition.evidence_id === answerFacts[0].id && same(condition.filter, binding.filter)) ||
        request.date_expression !== binding.date_expression || slot.kind === "budget_criterion" && selection.currency !== binding.currency)
      fail("보충 답변과 원래 요청 조건의 근거가 일치하지 않습니다.");
  } else if (extraSources.length || request.date_expression || request.evidence.some(fact => fact.role === "slot")) fail("확인하지 않은 보충 조건을 추가할 수 없습니다.");
  const sources = new Map([["question", request.input.text], ...extraSources.map(source => [source.id, source.text] as [string, string])]);
  const ids = new Set<string>();
  for (const fact of request.evidence) {
    if (!evidenceRoles.includes(fact.role)) fail("지원하지 않는 요청 근거 역할입니다.");
    const source = sources.get(fact.source_id);
    if (ids.has(fact.id) || source === undefined || !Number.isInteger(fact.span[0]) || !Number.isInteger(fact.span[1]) || fact.span[0] < 0 || fact.span[1] > source.length || fact.span[0] >= fact.span[1] || source.slice(...fact.span) !== fact.text) fail("요청 조건의 원문 근거를 확인하지 못했습니다.");
    ids.add(fact.id);
  }
  for (const condition of request.conditions) {
    const fact = request.evidence.find(item => item.id === condition.evidence_id);
    if (condition.owner !== plan.entity && !(request.entity === null && condition.owner === null) || !fact || fact.role !== "filter" || fact.owner !== condition.owner || !same(fact.value, condition.filter)) fail("조건과 소유 대상의 원문 근거가 일치하지 않습니다.");
  }
  for (const fact of request.evidence) {
    if (fact.role === "entity" && fact.owner !== request.entity || fact.role === "relation" && request.reference === "all") continue;
    if (request.obligations.filter(obligation => obligation.kind === fact.role && obligation.evidence_ids.includes(fact.id)).length !== 1) fail("원문 근거에 대응하는 요청 의무가 누락되었습니다.");
  }
  const obligations = new Set<string>();
  for (const obligation of request.obligations) {
    if (!evidenceRoles.includes(obligation.kind)) fail("지원하지 않는 요청 의무입니다.");
    if (obligation.basis === "default") {
      const registered = !obligation.evidence_ids.length && (obligation.kind === "operation" && plan.operation === "find" && obligation.owner === null || obligation.kind === "logic" && plan.filters.length <= 1 && plan.logical_operator === "AND" && obligation.owner === plan.entity) && request.obligations.filter(item => item.kind === obligation.kind).length === 1;
      if (!registered) fail("등록되지 않은 기본 처리 의무를 추가할 수 없습니다.");
    } else if (!obligation.evidence_ids.length) fail("요청 의무의 근거가 누락되었습니다.");
    if (obligations.has(obligation.id) || obligation.evidence_ids.some(id => !ids.has(id))) fail("요청 의무와 원문 근거가 일치하지 않습니다.");
    obligations.add(obligation.id);
    for (const id of obligation.evidence_ids) {
      const fact = request.evidence.find(item => item.id === id)!;
      if (fact.role !== obligation.kind || fact.owner !== obligation.owner) fail("조건의 소유 대상이 일치하지 않습니다.");
      if (["filter", "logic", "target_declaration", "entity", "semantic", "slot"].includes(fact.role) && fact.owner !== null && fact.owner !== plan.entity) fail("다른 대상의 조건을 조회 대상에 적용할 수 없습니다.");
      if (fact.role === "filter" && !plan.filters.some(filter => same(filter, fact.value))) fail();
      if (fact.role === "workflow" && (!same(fact.value, request.workflow) || !["audit", "policy", "history", "create_rule"].includes(plan.operation))) fail("업무 옵션의 원문 근거가 일치하지 않습니다.");
      if (fact.role === "scope" && !same(fact.value, request.platforms)) fail("매체 범위의 원문 근거가 일치하지 않습니다.");
      if (fact.role === "operation" && fact.value !== plan.operation || fact.role === "semantic" && fact.value !== plan.semantic || fact.role === "entity" && fact.value !== plan.entity || fact.role === "reference" && fact.value !== request.reference || fact.role === "relation" && fact.value !== "children") fail();
      if (fact.role === "logic" && plan.filters.length > 1 && fact.value !== plan.logical_operator) fail();
    }
  }
  return plan;
}

/** Commit only choices authorized by the original request; literal facts remain immutable. */
export function completeRequest(request: RequestSpec, raw: unknown, context?: QueryContext): RequestSpec {
  const plan = validateRequestPlan(raw, request, context), completed = structuredClone(request);
  const add = (role: RequestEvidence["role"], value: unknown, basis: "model" | "default", owner: RequestEvidence["owner"] = null) => {
    const id = `resolved:${role}:${completed.obligations.length}`;
    const evidence_ids: string[] = [];
    if (basis === "model") {
      completed.evidence.push({ id, source_id: "question", role, owner, span: [0, request.input.text.length], text: request.input.text, value: structuredClone(value) });
      evidence_ids.push(id);
    }
    completed.obligations.push({ id, kind: role, owner, evidence_ids, basis });
    return id;
  };
  if (!completed.entity) {
    for (const fact of completed.evidence) if (fact.owner === null && ["filter", "logic", "target_declaration", "semantic"].includes(fact.role)) fact.owner = plan.entity;
    for (const condition of completed.conditions) if (condition.owner === null) condition.owner = plan.entity;
    for (const obligation of completed.obligations) if (obligation.owner === null && ["filter", "logic", "target_declaration", "semantic"].includes(obligation.kind)) obligation.owner = plan.entity;
    add("entity", plan.entity, "model", plan.entity);
  }
  if (!completed.operation && !completed.obligations.some(obligation => obligation.kind === "operation")) add("operation", plan.operation, "default");
  if (!completed.semantic && plan.semantic) add("semantic", plan.semantic, "model", plan.entity);
  for (const filter of plan.filters) if (!completed.conditions.some(condition => condition.filter.field === filter.field)) {
    const id = add("filter", filter, "model", plan.entity);
    completed.conditions.push({ id: `condition:${id}`, owner: plan.entity, filter: structuredClone(filter), evidence_id: id });
  }
  if (!completed.logic) add("logic", plan.logical_operator, plan.filters.length > 1 ? "model" : "default", plan.entity);
  completed.entity = plan.entity; completed.operation = plan.operation; completed.logic = plan.logical_operator;
  completed.semantic = plan.semantic; completed.state = "ready"; completed.unresolved = [];
  return completed;
}

const stepKind = (kind: RequestEvidence["role"]): ExecutionPlan["steps"][number]["kind"] =>
  kind === "workflow" ? "workflow" : kind === "filter" || kind === "logic" || kind === "slot" ? "filter" : kind === "reference" ? "previous" : kind === "relation" ? "children" : kind === "semantic" ? "semantic" : kind === "operation" ? "result" : "scope";
export function compileExecutionPlan(request: RequestSpec, raw: unknown, context?: QueryContext): ExecutionPlan {
  const query = validateRequestPlan(raw, request, context);
  if (request.state !== "ready" || request.unresolved.length || request.ambiguities.length) fail("아직 해결하지 못한 요청 조건이 있습니다.");
  if (!request.workflow) fail("업무 옵션의 검증 정보가 없습니다.");
  const kinds: ExecutionPlan["steps"][number]["kind"][] = ["scope"];
  if (query.previous) kinds.push("previous");
  if (query.children) kinds.push("children");
  if (query.filters.length) kinds.push("filter");
  if (query.semantic) kinds.push("semantic");
  if (["audit", "policy", "history", "create_rule"].includes(query.operation)) kinds.push("workflow");
  kinds.push("result");
  const execution: ExecutionPlan = {
    workflow: structuredClone(request.workflow),
    query: { ...query, products: [...request.products] },
    steps: kinds.map(kind => ({ kind, obligation_ids: request.obligations.filter(obligation => {
      const target = stepKind(obligation.kind);
      return (target === "result" && kinds.includes("workflow") && obligation.kind === "operation" ? "workflow" : target === "filter" && !query.filters.length ? "result" : target) === kind;
    }).map(obligation => obligation.id) })),
    data_requirements: [...request.data_requirements],
  };
  const assigned = execution.steps.flatMap(step => step.obligation_ids);
  if (!same([...assigned].sort(), request.obligations.map(obligation => obligation.id).sort())) fail("실행 단계에 배정되지 않은 요청 의무가 있습니다.");
  return execution;
}

export function validateExecutionPlan(plan: ExecutionPlan, request: RequestSpec, context?: QueryContext): ExecutionPlan {
  const { products, ...raw } = plan.query;
  const expected = compileExecutionPlan(request, raw, context);
  if (!same(plan.workflow, expected.workflow) || !same(products, expected.query.products) || !same(plan.steps, expected.steps) || !same(plan.data_requirements, expected.data_requirements)) fail("요청 의무와 실행 단계의 대응이 일치하지 않습니다.");
  return expected;
}
export function projectQuery(plan: ExecutionPlan, request: RequestSpec): Query {
  return { ...structuredClone(plan.query), text: request.input.text, reference_time: new Date(request.input.reference_time), ...(request.date_expression ? { date_expression: request.date_expression } : {}) };
}
