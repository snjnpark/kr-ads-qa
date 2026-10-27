import { queryScopeText, unquotedAdText } from "../../lib/ad-products";
import { Clarification, dateRange } from "./query";
import { analyzeQueryAnswerability } from "./query-answerability";
import type { QueryPlan } from "./query-contract";
import { budgetCurrency, queryLiterals } from "./query-preparation";
import type { QueryInput, RequestSpec } from "./query-request";
import { childEntity, queryScopeEvidence } from "./query-scope";

type Filter = QueryPlan["filters"][number];
export type MissingSlot = {
  id: string;
  kind: "budget_criterion" | "name_value" | "creation_period";
  field: Filter["field"];
  owner: QueryPlan["entity"];
  span: [number, number];
  text: string;
  operator?: Filter["operator"];
  currency: QueryPlan["currency"];
  prompt: string;
  declarations?: {span: [number, number]; text: string}[];
};
export type SlotBinding = {
  slot_id: string;
  source_id: "answer";
  text: string;
  span: [number, number];
  filter: Filter;
  currency: QueryPlan["currency"];
  date_expression?: string;
};
export type RequestSlotProof = { slot: MissingSlot; binding: SlotBinding };
export type RequestContinuation = { request: RequestSpec; slot: MissingSlot; answer: string };
type Hole = Pick<MissingSlot, "kind" | "field" | "span" | "operator">;
const budgetHole = /(일\s*예\s*산|하루\s*예\s*산|일일\s*예\s*산|총\s*예\s*산|전체\s*예\s*산)(?:이|가|은|는)?\s*(?:(?:원화|달러|KRW|USD)\s*(?:기준(?:으로)?\s*)?)?(?:(기준(?:\s*금액)?(?:보다)?|얼마)\s*)?(이상(?:인)?|이하(?:인)?|초과(?:인|하는)?|미만(?:인)?|높은|낮은|큰|작은|적은|많은|적당한|충분한|애매한|적정한|대략적인)(?:지\s*(?:기준\s*)?금액(?:을|은)?\s*(?:아직\s*)?정하지\s*않았(?:어|습니다))?(?=$|[\s,.;?!])/giu;
const nameHole = /(?:이름|명칭)(?:에|에서|이|가|은|는)?\s*(?:(?:특정|어떤)\s*(?:단어|문구|문자열)(?:가|이|와|과)?\s*)?((?:정확히\s*)?(?:같은|일치하는|동일한)|포함(?:된|한|하는)|들어\s*(?:있는|간)|포함(?:되지|하지)\s*않(?:은|는)|제외(?:된|한))(?=$|[\s,.;?!])/gu;
const creationHoles = [
  /(?:얼마\s*전|최근|근래|요즘|조금\s*전|며칠\s*전)(?:에|의)?\s*(?:새로\s*)?(?:생성(?:된|한|됐|되었)|등록(?:된|한|했)|만든|만들어진)(?=$|[\s,.;?!])/gu,
  /(?:생성(?:일|\s*날짜)|등록일)(?:이|가|은|는)?\s*(?:얼마\s*전|최근|근래|요즘|며칠\s*전)(?:인)?(?=$|[\s,.;?!])/gu,
];
const budgetOperators: Record<string, Filter["operator"]> = { 이상: "gte", 이하: "lte", 초과: "gt", 미만: "lt" };
const answerOperators: Record<string, Filter["operator"]> = { ...budgetOperators, 같음: "eq", 같은: "eq", 같다: "eq", 동일: "eq" };
const allowedMissingReasons = new Set(["missing_budget_criterion", "missing_name_operand", "missing_creation_period"]);

function slotDeclarations(text: string, hole: Hole): NonNullable<MissingSlot["declarations"]> {
  const subject = hole.kind === "budget_criterion" ? "(?:기준\\s*)?금액|예산\\s*기준" : hole.kind === "name_value" ? "(?:이름\\s*값|문구|문자열|단어)" : "(?:생성|등록)\\s*(?:기간|날짜)|기간";
  const value = `(?:(?:어떤\\s*)?(?:${subject})|(?:필요한\\s*값|값|조건|확인할\\s*기준))`;
  const time = "(?:이어서|다음에|나중에|추가로)";
  const act = "(?:알려\\s*(?:줄게|드릴게|주겠습니다)|보충(?:할게|하겠습니다)|확정(?:할게|하겠습니다))";
  const clause = `(?:(?:${time}\\s*)?${value}(?:인지는|은|는|을|를|이|가)?\\s*(?:${time}\\s*)?${act}|${value}(?:은|는)\\s*다음\\s*답에\\s*있어|아직\\s*${value}(?:이|가)\\s*완성되지\\s*않았어|(?:먼저\\s*)?확인\\s*질문(?:을)?\\s*(?:해\\s*줘|해주세요))`;
  // A declaration must occupy an entire clause; unknown words and other predicates are never hidden.
  const pattern = new RegExp(`(?<![^.;?!\\n])\\s*${clause}(?=$|[.;?!\\n])`, "gu");
  const clean = unquotedAdText(text);
  return [...clean.matchAll(pattern)].filter(match => text.slice(match.index, match.index + match[0].length) === match[0])
    .map(match => ({span: [match.index, match.index + match[0].length] as [number, number], text: text.slice(match.index, match.index + match[0].length)}));
}

export function readSlotSource(input: QueryInput): MissingSlot | null {
  const text = input.text;
  if (!text.trim() || text.length > 2000) return null;
  const previous = input.previous;
  const context = { ...previous, entity: previous.entity ?? "campaign", result_keys: [], account_ids: [], scope: previous.scope ?? undefined };
  const disposition = analyzeQueryAnswerability(text, undefined, context);
  if (disposition.reasons.some(reason => !allowedMissingReasons.has(reason.code))) return null;
  if (disposition.operation && ["audit", "policy", "history"].includes(disposition.operation)) return null;
  const clean = queryScopeText(text), hole = readHole(text);
  if (!hole) return null;
  let scope: ReturnType<typeof queryScopeEvidence>;
  let currency: QueryPlan["currency"];
  try {
    scope = queryScopeEvidence(text, previous.has_results ? context.entity : undefined);
    currency = hole.kind === "budget_criterion" ? budgetCurrency(clean) : null;
    if (hole.kind === "creation_period" && queryLiterals(text, new Date(input.reference_time), input.timezone).dates.length) return null;
  } catch (error) {
    if (error instanceof Clarification) return null;
    throw error;
  }
  const previousEntity = ["campaign", "adgroup", "ad", "creative", "keyword", "asset_group"].includes(context.entity) ? context.entity as QueryPlan["entity"] : undefined;
  const owner = scope.scope.entity ?? (scope.scope.reference && previous.has_results ? scope.scope.reference === "children" ? childEntity(context.entity) : previousEntity : undefined);
  if (!owner) return null;
  const declarations = slotDeclarations(text, hole);
  return { ...hole, id: `missing:${hole.field}:${hole.span.join(":")}`, owner, text: text.slice(...hole.span), currency, ...(declarations.length ? {declarations} : {}),
    prompt: hole.kind === "budget_criterion" ? hole.operator ? "비교할 예산 금액을 알려주세요." : "예산의 기준 금액과 비교 방향을 알려주세요. 예: 3만 원 이상."
      : hole.kind === "name_value" ? "이름에 적용할 문자열을 알려주세요. 공백이나 업무 단어가 있으면 따옴표로 감싸 주세요." : "생성 기간을 알려주세요. 예: 오늘, 지난주, 2026-10-20." };
}

function readHole(text: string): Hole | null {
  const clean = queryScopeText(text), holes: Hole[] = [];
  for (const match of clean.matchAll(budgetHole)) {
    if (text.slice(match.index,match.index + match[0].length) !== match[0]) continue;
    const explicit = Object.entries(budgetOperators).find(([prefix]) => match[3].startsWith(prefix))?.[1];
    const compared = match[2]?.endsWith("보다") ? /^(?:높은|큰|많은)$/u.test(match[3]) ? "gt" : /^(?:낮은|작은|적은)$/u.test(match[3]) ? "lt" : undefined : undefined;
    holes.push({ kind: "budget_criterion", field: /총|전체/u.test(match[1]) ? "budget.lifetime" : "budget.daily", span: [match.index, match.index + match[0].length], operator: explicit ?? compared });
  }
  for (const match of unquotedAdText(text).matchAll(nameHole)) if (text.slice(match.index,match.index + match[0].length) === match[0])
    holes.push({ kind: "name_value", field: "name", span: [match.index, match.index + match[0].length], operator: /않|제외/u.test(match[1]) ? "not_contains" : /같은|일치|동일/u.test(match[1]) ? "eq" : "contains" });
  for (const pattern of creationHoles) for (const match of clean.matchAll(pattern)) if (text.slice(match.index,match.index + match[0].length) === match[0])
    holes.push({ kind: "creation_period", field: "created_at", span: [match.index, match.index + match[0].length], operator: "between" });
  if (holes.length !== 1) return null;
  const hole = holes[0];
  if (/^\s*(?:(?:것(?:이|은)|게|건)\s*)?(?:아닌|아니|않|말고|제외)/u.test(clean.slice(hole.span[1]))) return null;
  return hole;
}

/** Lexical ownership only; preparation keeps the canonical workflow and scope readers. */
export function readSlotDeclarations(text: string): NonNullable<MissingSlot["declarations"]> {
  const hole = readHole(text);
  return hole ? slotDeclarations(text, hole) : [];
}

/** A hole owns one closed source phrase. It never consumes another condition or operation. */
export function proposeSlot(request: RequestSpec): MissingSlot | null {
  if (request.state !== "needs_clarification" || request.issues?.some(issue => issue.kind === "unsupported") ||
    request.ambiguities.some(item => /multiple_|mixed_logic|nested_logic|ambiguous_scope|ambiguous_field_attachment|ambiguous_predicate/u.test(item))) return null;
  const slot = readSlotSource(request.input);
  return slot && !request.conditions.some(condition => condition.filter.field === slot.field) ? slot : null;
}

function readSlotAnswer(input: QueryInput, slot: MissingSlot, text: string): SlotBinding {
  const valueText = text.trim();
  if (!valueText || text.length > 2000) throw new Clarification("확인할 조건의 값만 2,000자 이내로 알려주세요.");
  let filter: Filter;
  let currency = slot.currency;
  let dateExpression: string | undefined;
  if (slot.kind === "budget_criterion") {
    const amount = /^([+]?\s*\d[\d,]*(?:\.\d+)?(?:\s*[억만천백십]\s*(?:\d[\d,]*(?:\.\d+)?)?)*|[영일이삼사오육칠팔구십백천만억열]+)\s*(원|달러|KRW|USD)?\s*(이상|이하|초과|미만|같음|같은|같다|동일)?\s*(?:입니다|이요|요)?[.!]?$/iu.exec(valueText);
    if (!amount) throw new Clarification("예산의 금액과 비교 방향만 알려주세요. 예: 3만 원 이상.");
    const literals = queryLiterals(amount[1] + (amount[2] ?? ""), new Date(input.reference_time), input.timezone);
    if (literals.amounts.length !== 1) throw new Clarification("예산은 0 이상 1,000조 이하의 기준 금액 하나로 알려주세요.");
    const operator = amount[3] ? answerOperators[amount[3]] : slot.operator;
    if (!operator || (slot.operator && operator !== slot.operator)) throw new Clarification("원래 비교 방향을 유지하면서 기준 금액을 알려주세요.");
    const answeredCurrency = amount[2] ? /^(?:원|KRW)$/iu.test(amount[2]) ? "KRW" : "USD" : null;
    if (slot.currency && answeredCurrency && slot.currency !== answeredCurrency) throw new Clarification("원래 질문에 지정한 예산 통화를 유지해 주세요.");
    currency = answeredCurrency ?? slot.currency;
    filter = { field: slot.field, operator, value: literals.amounts[0] };
  } else if (slot.kind === "name_value") {
    const quoted = /^(?:'([^']{1,64})'|"([^"]{1,64})"|“([^”]{1,64})”|‘([^’]{1,64})’|`([^`]{1,64})`)$/u.exec(valueText);
    const bare = /^[\p{L}\p{N}_./()-]{1,64}$/u.test(valueText) && !/검수|검사|점검|비교|조회|보여|찾아|삭제|수정|변경|예산|생성|종료|정책|이력|규칙|캠페인|광고|해줘|해주세요|하세요|하라/u.test(valueText);
    const value = quoted ? quoted.slice(1).find(item => item !== undefined)! : bare ? valueText : undefined;
    if (!value || value.length > 64) throw new Clarification("적용할 이름 문자열 하나만 알려주세요. 공백이나 업무 단어가 있으면 따옴표로 감싸 주세요.");
    filter = { field: "name", operator: slot.operator!, value };
  } else {
    const date = /^(그제|어제|오늘|금일|지난\s?주|이번\s?주|지난\s?달|이번\s?달|\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일)(?:\s*(?:에\s*)?(?:생성된|등록된|만든)|\s*(?:입니다|이요|요))?[.!]?$/u.exec(valueText);
    if (!date) throw new Clarification("생성 날짜 또는 기간 하나만 알려주세요. 예: 오늘, 지난주, 2026-10-20.");
    dateExpression = date[1] === "금일" ? "오늘" : date[1];
    const range = dateRange(dateExpression, new Date(input.reference_time), input.timezone)!;
    filter = { field: "created_at", operator: "between", value: range };
  }
  return { slot_id: slot.id, source_id: "answer", text, span: [0, text.length], filter, currency, ...(dateExpression ? { date_expression: dateExpression } : {}) };
}

/** Answers are separate sources. An answer can fill its slot but cannot replace its predicate. */
export function bindSlotAnswer(request: RequestSpec, slot: MissingSlot, text: string): SlotBinding {
  const expected = proposeSlot(request);
  if (!expected || JSON.stringify(expected) !== JSON.stringify(slot)) throw new Clarification("확인할 조건이 변경되었습니다. 원래 질문부터 다시 검색해 주세요.");
  return readSlotAnswer(request.input, slot, text);
}

/** Plan validation checks the original hole and the whole answer again, without a nested request or a synthetic question. */
export function verifySlotBinding(input: QueryInput, proof: RequestSlotProof): SlotBinding {
  if (!proof || !proof.slot || !proof.binding || typeof proof.binding.text !== "string") throw new Clarification("확인 답변의 근거 형식을 확인하지 못했습니다.");
  const expected = readSlotSource(input);
  if (!expected || JSON.stringify(expected) !== JSON.stringify(proof.slot)) throw new Clarification("원래 질문의 확인 항목과 답변이 일치하지 않습니다.");
  const binding = readSlotAnswer(input, proof.slot, proof.binding.text);
  if (JSON.stringify(binding) !== JSON.stringify(proof.binding)) throw new Clarification("확인 답변의 값·비교 방향·통화 근거가 일치하지 않습니다.");
  return binding;
}
