import Decimal from "decimal.js";
import { z } from "../lib/validation";
import type { ChoiceQuestion } from "../browser/model/types";
import { PLATFORMS } from "./models";
import { literalProducts, unquotedAdText, queryScopeText } from "../lib/ad-products";
import { ACTIVE, INACTIVE, Clarification, dateRange, type Query, type QueryContext } from "./query";

import { queryLiteralScope, literalListOperation, queryRequestRemainder, childEntity, descendantType, assertEntityCapabilities } from "./query-scope";
import { analyzeQueryEvidence, type GroundedQueryFilter } from "./query-evidence";
import { analyzeQueryAnswerability, requestPlanMismatch, type QueryAnswerability } from "./query-answerability";
export { queryLiteralScope } from "./query-scope";

export const QUERY_PLAN_VERSION = "model-conditions-v14";
const fields = ["budget.daily", "budget.lifetime", "status", "schedule.end", "name", "created_at", "entity_id"] as const;
const fieldPaths: Record<string, typeof fields[number]> = { daily: "budget.daily", lifetime: "budget.lifetime", status: "status", end: "schedule.end", name: "name", created: "created_at", id: "entity_id" };
const filterSchema = z.strictObject({
  field: z.enum(fields),
  operator: z.enum(["is_empty", "is_not_empty", "eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "not_contains", "between"]),
  value: z.union([z.string().min(1).max(256), z.array(z.string().max(64)).max(16), z.tuple([z.number().finite(), z.number().finite()])]).optional(),
});
export const queryPlanSchema = z.strictObject({
  platforms: z.array(z.enum(PLATFORMS)).max(PLATFORMS.length),
  entity: z.enum(["campaign", "adgroup", "ad", "creative", "keyword", "asset_group"]),
  operation: z.enum(["find", "count", "compare", "audit", "policy", "history", "create_rule"]),
  filters: z.array(filterSchema).max(7), logical_operator: z.enum(["AND", "OR"]),
  previous: z.boolean(), children: z.boolean(),
  semantic: z.enum(["retarget", "purchase_mismatch", "branding"]).nullable(),
  currency: z.enum(["KRW", "USD"]).nullable(),
});
export type QueryPlan = z.infer<typeof queryPlanSchema>;
export type QueryTrace = {
  source: "laya" | "deterministic_mock" | "deterministic_literal"; version: string; model_version: string;
  outcome: "query" | "clarification" | "unsupported" | "uncertain" | "validation" | "inference";
  decisions: Record<string, { label: string | null; scores: Record<string, number> }>;
  literal_scope?: { entity?: QueryPlan["entity"]; platforms: QueryPlan["platforms"]; reference?: "previous" | "children" };
  preflight?: "literal_list" | "literal_count" | "literal_budget" | "typed_evidence";
  capability_guard?: "read_only" | "performance_metrics" | "excluded_product" | "unsupported_condition" | "unsupported_platform";
  stage?: "input" | "request" | "metadata" | "filters" | "values" | "validation" | "complete";
  failed_decision?: string;
  request_route?: "specialist" | "general" | "evidence";
  evidence?: ReturnType<typeof analyzeQueryEvidence>;
  answerability?: QueryAnswerability;
  grounded?: Record<string, unknown>;
  plan?: unknown;
};
export class QueryModelError extends Clarification {
  constructor(message: string, readonly trace: QueryTrace) { super(message); }
}
type Choice = { label: string | null; scores: Record<string, number> };
export type Choose = (state: unknown, questions: Record<string, ChoiceQuestion>) => Promise<Record<string, Choice>>;
const choice = (instructions: string, criteria: Record<string, string>): ChoiceQuestion => ({ type: "choice", instructions, criteria });
const unknown = { unknown: "질문만으로 판단할 수 없음" };
const numericOps = (label: string) => ({ none: "이 항목을 조건으로 언급하지 않음", is_empty: `${label} 미입력 또는 미설정`, is_not_empty: `${label} 설정되어 있음`, eq: `${label} 금액이 기준과 같음`, ne: `${label} 금액이 기준과 같지 않음`, gt: `${label} 금액이 기준 초과`, gte: `${label} 금액이 기준 이상`, lt: `${label} 금액이 기준 미만`, lte: `${label} 금액이 기준 이하`, ...unknown });
const MONEY_UNITS: Record<string, number> = { 억: 100000000, 만: 10000, 천: 1000, 백: 100, 십: 10 };
const DATE_LITERAL = /\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일|그제|어제|오늘|금일|지난\s?주|이번\s?주|이번\s?달|지난\s?달/gu;

export function requestKindQuestions(entity?: string, general = false) {
  const dispositionId = general || (entity && entity !== "campaign") ? "request_kind" : "disposition";
  return { [dispositionId]: choice(dispositionId === "request_kind"
      ? "Can this request be answered using advertising configuration, not performance metrics or making advertising changes?"
      : "광고 설정을 조회할 수 있는 명확한 질문인가요? 조건이 빠졌는지, 설정 조회 외 요청인지 구분하세요.", dispositionId === "request_kind" ? {
      query: "View or count advertising settings", clarification: "Configuration condition is ambiguous", unsupported: "Change advertisements or request advertising performance", unknown: "Cannot determine",
    } : {
      query: "명확한 조건의 광고 설정 조회, 개수 확인 또는 설정 검수", clarification: "기준 금액, 일예산과 총예산 구분, 검색할 이름 등 필요한 조건이 빠졌거나 모호하여 재질문 필요", unsupported: "광고 삭제나 수정 요청, 클릭률·매출·ROAS 같은 실적 조회, 지원하지 않는 조건", ...unknown,
    }) };
}
export const queryRequestState = (text: string, context?: QueryContext) => ({ request: text, previous_results: context?.has_results ?? false, ...(context?.has_results ? { previous_context: { entity: context.entity, platforms: context.platforms } } : {}) });

function assertMoneyUnitOrder(raw: string) {
  if (/[억만][억만]|[영일이삼사오육칠팔구]{2}/u.test(raw))
    throw new Clarification("금액 단위와 숫자 표기를 확인해 주세요. 예: 1억 2천만 원.");
  let major = Infinity, minor = Infinity;
  for (const [unit] of raw.matchAll(/[억만천백십]/gu)) {
    const value = MONEY_UNITS[unit];
    if (value >= 10000) {
      if (value >= major) throw new Clarification("금액 단위의 순서와 중복을 확인해 주세요. 예: 1억 2천만 원.");
      major = value; minor = Infinity;
    } else {
      if (value >= minor) throw new Clarification("금액 단위의 순서와 중복을 확인해 주세요. 예: 1천 2백 원.");
      minor = value;
    }
  }
}

// Ground model choices and the exact single-condition literal preflight in user-supplied values.
export function queryLiterals(text: string, now = new Date(), timezone = "Asia/Seoul") {
  const amounts = new Set<string>();
  const numericText = queryScopeText(text).replace(/[−﹣－]/gu, "-").replace(DATE_LITERAL, " ");
  for (const match of numericText.matchAll(/[+-]?\s*\d[\d,]*(?:\.\d+)?(?:\s*[억만천백십]\s*(?:\d[\d,]*(?:\.\d+)?)?)*/g)) {
    const raw = match[0].replace(/\s/gu, "");
    // A signed value is consumed as one token; negative amounts never become positive candidates.
    if (raw.startsWith("-")) continue;
    assertMoneyUnitOrder(raw);
    let total = new Decimal(0), section = new Decimal(0), value: Decimal | null = null;
    for (const part of raw.replace(/^\+/u, "").matchAll(/([\d,.]+)|([억만천백십])/gu)) {
      if (part[1]) {
        if (part[1].includes(",") && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(part[1]))
          throw new Clarification("금액의 쉼표 구분을 확인해 주세요.");
        value = new Decimal(part[1].replaceAll(",", ""));
      } else {
        const unit = MONEY_UNITS[part[2]];
        if (unit >= 10000) { total = total.add(section.add(value ?? 0).mul(unit)); section = new Decimal(0); }
        else { section = section.add((value ?? new Decimal(1)).mul(unit)); }
        value = null;
      }
    }
    const amount = total.add(section).add(value ?? 0);
    if (amount.lte("1000000000000000")) amounts.add(amount.toFixed());
  }
  const digits: Record<string, number> = { 영: 0, 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
  for (const match of numericText.matchAll(/(?<![\d.,가-힣])(?:[일이삼사오육칠팔구십백천만억]+|열만)\s*원/g)) {
    const raw = match[0].replace(/\s|원/g, "").replace("열", "십");
    assertMoneyUnitOrder(raw);
    let total = 0, section = 0, digit = 0;
    for (const char of raw) {
      if (Object.hasOwn(digits, char)) digit = digits[char];
      else if (char === "만" || char === "억") { total += (section + digit || 1) * MONEY_UNITS[char]; section = 0; digit = 0; }
      else { section += (digit || 1) * MONEY_UNITS[char]; digit = 0; }
    }
    amounts.add(String(total + section + digit));
  }
  const strings = new Set<string>();
  const quotedStrings = new Set<string>();
  for (const match of text.matchAll(/(?:'([^']{1,64})'|"([^"]{1,64})"|“([^”]{1,64})”|‘([^’]{1,64})’|`([^`]{1,64})`)/g)) { const literal = match.slice(1).find(value => value !== undefined)!; strings.add(literal); quotedStrings.add(literal); }
  for (const match of text.matchAll(/[\w가-힣-]{1,64}/g)) {
    strings.add(match[0]);
    if (/[이가을를]$/.test(match[0]) && match[0].length > 1) strings.add(match[0].slice(0, -1));
  }
  const dates = new Map<string, [number, number]>();
  for (const match of queryScopeText(text).matchAll(DATE_LITERAL)) {
    const range = dateRange(match[0] === "금일" ? "오늘" : match[0], now, timezone);
    if (range) dates.set(match[0], range);
  }
  return { amounts: [...amounts], strings: [...strings], quotedStrings: [...quotedStrings], dates: [...dates] };
}
const namePredicateText = (text: string) => unquotedAdText(text).match(/(?:이름|명칭)[^,;]{0,120}/u)?.[0]
  .split(/일\s*예산|하루\s*예산|총\s*예산|전체\s*예산|예산|종료일|상태|생성|원본\s*ID|\bID\b/iu)[0];
// Only a value owned by the name predicate may be selected; another word
// occurring elsewhere in the question is not an alternative name operand.
function boundNameOperand(text: string) {
  if (/(?:이름|명칭)(?:에서|에|이|가)\s*(?:(?:정확히|정확하게|완전히|딱)\s*)?['"“‘`]/u.test(text)) return;
  const clause = namePredicateText(text);
  return clause?.match(/^(?:이름|명칭)(?:에서|에|이|가)\s*([\p{L}\p{N}_./()-]{1,64}?)(?:이|가|을|를|와|과|하고)?\s*(?:(?:정확히|정확하게|완전히)\s*)?(?:같은|동일한|일치하는|포함|들어|제외|없는|있는|인(?=\s|$))/u)?.[1];
}
const exactNameRequested = (text: string) => /정확히\s*같|(?:와|과)\s*같/u.test(namePredicateText(text) ?? "") ||
  [...unquotedAdText(text).matchAll(/(?:이름|명칭)이/gu)].some(match =>
    /^(?:이름|명칭)이\s*(?:'[^']+'|"[^"]+"|“[^”]+”|‘[^’]+’|`[^`]+`|[\w가-힣-]+)\s*인/u.test(text.slice(match.index)));

function budgetCurrency(text: string): QueryPlan["currency"] {
  const krw = /(?:[\d영일이삼사오육칠팔구억만천백십열]\s*원|원화|\bKRW\b)/iu.test(text);
  const usd = /달러|\bUSD\b/iu.test(text);
  if (krw && usd) throw new Clarification("예산 비교에 사용할 통화를 하나만 지정해 주세요.");
  return krw ? "KRW" : usd ? "USD" : null;
}

function idFacts(text: string) {
  return [...queryScopeText(text).matchAll(/(?:원본\s*(?:(?:캠페인|광고\s*(?:그룹|세트)?|(?:애셋|에셋)\s*그룹|소재|키워드)\s*)?)?(?:\bID\b|아이디)/giu)].flatMap(match => {
    const tail = text.slice(match.index + match[0].length);
    const quoted = /^(?:(?:가|는|:)?\s*|를\s*(?:대조하면|확인하면)\s*)(?:'([^']+)'|"([^"]+)"|“([^”]+)”|‘([^’]+)’|`([^`]+)`)/u.exec(tail);
    const bare = tail.match(/^(?:가|는|:)?\s*([A-Za-z0-9][A-Za-z0-9_-]{0,63})/u);
    const operand = quoted ?? bare;
    if (!operand) return [];
    const value = quoted ? quoted.slice(1).find(part => part !== undefined)! : bare![1];
    const rest = tail.slice(operand[0].length);
    const suffix = /^\s*(?:에\s*해당하는|으로\s*표시된|(?:를|을)\s*가진|(?:와|과)\s*(?:(?:정확히|완전히)\s*)?(?:같은|동일한|일치하는)|하나(?:를|만)|인(?=\s|$)|이고|이며|이야(?=[\s.!?]|$))?/u.exec(rest)![0];
    const positive = !!suffix.trim() || /^\s*(?:(?:를|을)\s*)?(?:찾|보여|조회|확인|캠페인|광고|항목|$)/u.test(rest);
    const span: [number, number] = [match.index, match.index + match[0].length + operand[0].length + suffix.length];
    return [{ value, positive, span, text: text.slice(...span) }];
  });
}
const idOperands = (text: string) => idFacts(text).map(fact => fact.value);
const positiveCreation = (text: string) => /생성(?=$|\s|한|된|됐|되었|됨|했|일)|생성\s*날짜|만든|만들어진|만들어졌|등록(?=$|\s|한|된|했|일)|만들어\s*둔/u.test(queryScopeText(text));

// Literal facts carry their own source spans into the same completeness check as other slots.
function queryEvidence(text: string, numeric: ReturnType<typeof queryLiterals>, now: Date, timezone: string) {
  const literalFacts: GroundedQueryFilter[] = [];
  const clean = queryScopeText(text);
  const ids = idFacts(text);
  if (ids.length === 1) {
    const { value, span, text: literalText } = ids[0];
    literalFacts.push({ field_id: "id", filter: { field: "entity_id", operator: "eq", value }, span, text: literalText });
  }
  if (numeric.dates.length === 1) {
    const [label, range] = numeric.dates[0];
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const verb = "(?:생성(?:한|된|됐|되었|됨|했고|(?=$|\\s))|만든|만들어진|만들어졌|만들어\\s*둔|등록(?:한|된|했|(?=$|\\s)))";
    const before = new RegExp(`${escaped}(?:에|의|\\s*하루\\s*동안)?\\s*(?:새로\\s*)?${verb}`, "u").exec(clean);
    const after = new RegExp(`(?:생성(?:일|\\s*날짜)|등록일)(?:이|가|은|는)?\\s*${escaped}(?:인)?`, "u").exec(clean);
    const found = before ?? after;
    if (found) {
      const span: [number, number] = [found.index, found.index + found[0].length];
      literalFacts.push({ field_id: "created", filter: { field: "created_at", operator: "between", value: range }, span, text: text.slice(...span) });
    }
  }
  return analyzeQueryEvidence(text, numeric, {
    literalsFor: clause => queryLiterals(clause, now, timezone), requestRemainder: queryRequestRemainder, literalFacts,
    semantic: analyzeQueryAnswerability(text).semantic,
  });
}
function evidenceClarification(evidence: ReturnType<typeof queryEvidence>): string | undefined {
  if (evidence.ambiguities.includes("unrepresented_condition")) return "해석하지 못한 추가 조건이 있습니다. 적용할 조건을 나누어 구체적으로 알려주세요.";
  if (evidence.ambiguities.includes("ambiguous_scope")) return "부정 표현의 범위가 분명하지 않습니다. 값이 있는지 없는지를 구체적으로 알려주세요.";
  if (evidence.ambiguities.includes("ambiguous_field_attachment")) return "각 항목에 적용할 조건을 구분해 주세요. 일예산과 총예산 중 어느 조건인지 알려주세요.";
  if (evidence.ambiguities.some(item => /multiple_predicates|multiple_operands|mixed_logic|nested_logic/u.test(item)))
    return "같은 항목의 여러 조건이나 중첩된 연결은 나누어 질문해 주세요.";
}
function literalPredicate(text: string, field: "id" | "created") {
  const clean = queryScopeText(text);
  const marker = field === "id" ? /\bID\b|아이디/iu : /생성(?:일|\s*날짜)?|만든|만들어진|만들어[진졌]/u;
  const match = marker.exec(clean);
  if (!match) return "";
  const boundary = /일\s*예산|하루\s*예산|총\s*예산|전체\s*예산|예산|종료일|이름|명칭|상태|원본\s*ID|\bID\b|아이디|생성|만든|만들어진/iu;
  const after = clean.slice(match.index + match[0].length).split(boundary)[0];
  const prefix = clean.slice(0, match.index);
  const date = [...prefix.matchAll(DATE_LITERAL)].at(-1);
  const before = field === "created" && date ? prefix.slice(date.index) : "";
  return `${before}${match[0]}${after}`;
}
function assertLiteralPredicates(text: string) {
  const id = literalPredicate(text, "id"), created = literalPredicate(text, "created");
  if ((id && /아닌|않|같지|다른|제외|빼고|이상|이하|초과|미만|또는|혹은|이거나|아니면/iu.test(id)) || idOperands(text).length > 1)
    throw new Clarification("원본 ID는 하나의 값과 정확히 일치하는 조건으로 지정해 주세요.");
  if (idFacts(text).some(fact => !fact.positive))
    throw new Clarification("원본 ID는 하나의 값과 정확히 일치하는 조건으로 지정해 주세요.");
  if (created && /(?:생성|만들)[가-힣]*\s*(?:않|안)|아닌|제외|빼고|이전|이후|보다|부터|까지/u.test(created))
    throw new Clarification("생성 날짜는 하나의 날짜 또는 지원하는 기간으로 지정해 주세요. 날짜 부정·전후 비교는 지원하지 않습니다.");

}
// Reject explicit contradictions and dropped operands; never replace a model's answer with another plan.
function assertExplicitConditions(plan: QueryPlan, text: string, prepared: PreparedQuery) {
  if (!["find", "count", "compare"].includes(plan.operation)) return;
  const { unquoted: clean, typed: evidence } = prepared;
  const fail = () => { throw new Clarification("질문에 명시한 조건과 모델의 해석이 일치하지 않습니다. 조건을 나누어 다시 질문해 주세요."); };
  const filter = (field: string) => plan.filters.find(item => item.field === field);
  const grounded = new Set(evidence.filters.map(item => item.filter.field));
  if (plan.filters.length > 1 && (evidence.complete
    ? evidence.logical_operator !== plan.logical_operator
    : /또는|혹은|거나|아니면|\bOR\b/iu.test(clean) && plan.logical_operator !== "OR")) fail();
  const exactName = exactNameRequested(text);
  const nameOperand = grounded.has("name") ? undefined : boundNameOperand(text);
  if (nameOperand && filter("name")?.value !== nameOperand) fail();
  const name = namePredicateText(text)?.match(/(?:이름|명칭)[^,;]{0,100}?(?:포함(?:(?:되지|하지)\s*않[가-힣]*|\s*안\s*[가-힣]+|[가-힣]*)|(?:안\s*)?들어(?:\s*있[가-힣]*|[가-힣]*)(?:\s*않[가-힣]*)?|제외[가-힣]*|빠진|없(?:는|고|거나|든)|있(?:는|고|거나|든))/u)?.[0];
  if (name && !filter("name")) fail();
  if (filter("name") && !grounded.has("name") && !name && !exactName) fail();
  if (!grounded.has("name") && exactName && filter("name")?.operator !== "eq") fail();
  if (name && !grounded.has("name") && !exactName && !/말고|나머지/u.test(unquotedAdText(text))) {
    const expected = /포함\s*(?:되지|하지|안)|안\s*(?:포함|들어)|들어(?:\s*있)?[가-힣]*\s*않|제외|빠진|없(?:는|고|거나|든)/u.test(name) ? "not_contains" : "contains";
    if (filter("name")?.operator !== expected) fail();
  }
}

// Both inference and direct-plan validation consume the same checked source facts.
function preprocessQuery(text: string, context: QueryContext | undefined, now: Date, timezone: string, trace: Partial<QueryTrace> = {}) {
  trace.outcome = "clarification";
  if (!text.trim() || text.length > 2000) throw new Clarification("2,000자 이내의 광고 설정 질문을 입력해 주세요.");
  // Enforce the existing read-only configuration boundary before model interpretation; quoted names stay literal.
  const unquoted = queryScopeText(text);
  const initialRequest = analyzeQueryAnswerability(text, undefined, context);
  trace.answerability = initialRequest;
  if (initialRequest.status === "unsupported" || initialRequest.status === "clarification") {
    const reason = initialRequest.reasons.find(item => item.kind === initialRequest.status)!;
    trace.outcome = initialRequest.status;
    trace.capability_guard = reason.capability;
    throw new Clarification(reason.message);
  }
  const numeric = queryLiterals(text, now, timezone);
  assertLiteralPredicates(text);
  if (numeric.dates.length && /등록(?:하지|되지)\s*않|등록\s*안/u.test(unquoted))
    throw new Clarification("등록 날짜는 긍정 표현의 날짜 또는 기간으로 지정해 주세요.");
  const typed = queryEvidence(text, numeric, now, timezone);
  trace.evidence = typed;
  const request = analyzeQueryAnswerability(text, typed, context);
  trace.answerability = request;
  if (request.status === "unsupported" || request.status === "clarification") {
    const reason = request.reasons.find(item => item.kind === request.status)!;
    trace.outcome = request.status;
    trace.capability_guard = reason.capability;
    throw new Clarification(reason.message);
  }
  const evidenceIssue = evidenceClarification(typed);
  if (evidenceIssue) throw new Clarification(evidenceIssue);
  if (typed.unresolved.includes("status:unrecognized"))
    throw new Clarification("활성 또는 중지 등 지원하는 운영 상태를 지정해 주세요.");
  if (numeric.dates.length && typed.relevant_fields.includes("end") &&
      !typed.filters.some(fact => fact.field_id === "end" || fact.field_id === "created"))
    throw new Clarification("종료일은 설정 유무만 조회할 수 있습니다. 생성 날짜와 구분해 질문해 주세요.");
  const evidence = new Set<string>(typed.relevant_fields);
  if (/포함|들어|빠진/u.test(unquoted)) evidence.add("name");
  trace.grounded = { ...trace.grounded, fields: [...evidence] };
  const amountText = unquoted.replace(/\d{4}[-./]\d{1,2}[-./]\d{1,2}/gu, " ");
  if ((evidence.has("daily") || evidence.has("lifetime")) && /(?:^|[\s이가은는])[-−﹣－]\s*\d/u.test(amountText))
    throw new Clarification("예산은 0 이상의 금액으로 알려주세요.");
  if (evidence.has("created") && numeric.dates.length !== 1 && !/생성일.*종료일|종료일.*생성일/u.test(unquoted))
    throw new Clarification("생성 날짜 또는 기간을 하나만 지정해 주세요. 예: 오늘, 지난주, 2026-10-20.");
  if (evidence.has("created") && numeric.dates.length === 1 && !positiveCreation(text))
    throw new Clarification("해당 날짜에 생성된 항목인지 확인해 주세요. 생성 날짜의 조건을 긍정 표현으로 지정해 주세요.");
  if (typed.relevant_fields.includes("id") && !idOperands(text).length)
    throw new Clarification("조회할 원본 ID 값을 지정해 주세요.");
  if (/이름|명칭/u.test(unquotedAdText(text)) && !numeric.quotedStrings.length &&
      /(?:이름|명칭)(?:이|가|은|는)?\s*(?:(?:정확히|정확하게|완전히|딱)\s*)?(?:같은|일치하는|동일한)/u.test(unquotedAdText(text)))
    throw new Clarification("비교할 이름 값을 지정해 주세요.");
  for (const marker of unquoted.matchAll(/일\s*예산|하루\s*예산|총\s*예산|전체\s*예산|예산/gu)) {
    const clause = unquoted.slice(marker.index + marker[0].length).split(/일\s*예산|하루\s*예산|총\s*예산|전체\s*예산|종료일|이름|명칭|상태|생성|원본\s*ID|\bID\b|아이디/iu)[0];
    const before = unquoted.slice(0, marker.index);
    const precedingOperand = /보다\s*$/u.test(before) && queryLiterals(before, now, timezone).amounts.length === 1;
    if (!precedingOperand && !queryLiterals(clause, now, timezone).amounts.length && /이상|이하|초과|미만|(?:높|낮|크|작|적|많)은|넘는|보다/u.test(clause))
      throw new Clarification("예산을 비교할 기준 금액을 지정해 주세요.");
  }
  if ((/예산/u.test(unquoted) && !numeric.amounts.length && /큰|높은|낮|적은|적게|과다|조금|저렴|지나친|적정|넉넉|많이|평균적인|기준보다|기준\s*금액|얼마\s*미만/u.test(unquoted)) ||
      (/이름|명칭/u.test(unquotedAdText(text)) && /아직|나중에|다음에|미정|비워|모르겠|무엇이|그\s*(?:단어|문구)|해당\s*문구|지정할\s*문구/u.test(unquotedAdText(text)) && !numeric.quotedStrings.length) ||
      /(?:이름|명칭).*(?:특정\s*(?:단어|문구)|검색어|어떤\s*(?:단어|문구))/u.test(unquotedAdText(text)) && !numeric.quotedStrings.length ||
      /일예산인지.*(?:전체|총)\s*예산인지|금액\s*단위는\s*빠졌/u.test(unquoted))
    throw new Clarification("비교할 값과 항목을 구체적으로 알려주세요.");
  const literalScope = queryLiteralScope(text);
  trace.literal_scope = literalScope;
  const scopeEntity = literalScope.entity ?? (literalScope.reference && context?.has_results ? literalScope.reference === "children" ? childEntity(context.entity) : context.entity as QueryPlan["entity"] : undefined);
  const scopedPlatforms = literalScope.platforms.length ? literalScope.platforms : literalScope.reference && context?.has_results ? context.platforms : [];
  const products = literalProducts(text, scopedPlatforms);
  if (scopeEntity) assertEntityCapabilities(scopeEntity, scopedPlatforms, products);
  if (literalScope.reference === "children" && !scopeEntity) throw new Clarification("조회할 하위 대상 종류를 지정해 주세요.");
  if (literalScope.reference === "children" && context && scopeEntity && !descendantType(context.entity, scopeEntity))
    throw new Clarification("이전 결과 아래에서 조회할 수 있는 하위 대상을 지정해 주세요.");
  if (literalScope.reference && context?.platforms.length && literalScope.platforms.some(platform => !context.platforms.includes(platform)))
    throw new Clarification("이전 결과의 매체와 다릅니다. 새로 검색할지 이전 결과를 좁힐지 알려주세요.");
  return { unquoted, numeric, typed, request, evidence, literalScope, scopeEntity, products };
}
type PreparedQuery = ReturnType<typeof preprocessQuery>;

export function validateQueryPlan(raw: unknown, text: string, context?: QueryContext, now = new Date(), timezone = "Asia/Seoul"): Query {
  return validatePreparedQuery(raw, text, context, now, timezone);
}
function validatePreparedQuery(raw: unknown, text: string, context: QueryContext | undefined, now: Date, timezone: string, prepared?: PreparedQuery): Query {
  const parsed = queryPlanSchema.safeParse(raw);
  if (!parsed.success) throw new Clarification("조회 조건 형식을 확인하지 못했습니다. 질문을 구체적으로 입력해 주세요.");
  const plan = parsed.data;
  const checked = prepared ?? preprocessQuery(text, context, now, timezone);
  const { typed: evidence, numeric: literals, literalScope, request } = checked;
  const mismatch = requestPlanMismatch(request, plan);
  if (mismatch) throw new Clarification(mismatch);
  if (evidence.complete && !request.semantic && plan.semantic)
    throw new Clarification("질문에 명시한 목적과 조회 계획이 일치하지 않습니다. 근거 없는 의미 조건을 추가할 수 없습니다.");
  if (["find", "count", "compare", "create_rule"].includes(plan.operation)) {
    for (const id of evidence.relevant_fields) {
      const field = fieldPaths[id];
      // A generic budget introduction does not add daily to an explicit lifetime predicate.
      if (id === "daily" && !/일\s*예산|하루\s*예산/u.test(queryScopeText(text)) &&
          !evidence.filters.some(item => item.field_id === "daily") && plan.filters.some(filter => filter.field === "budget.lifetime")) continue;
      if (!(id === "name" && plan.semantic) && !plan.filters.some(filter => filter.field === field))
        throw new Clarification("질문에 명시한 조건과 모델의 해석이 일치하지 않습니다. 지정한 항목의 조건을 생략할 수 없습니다.");
    }
  }
  for (const ambiguity of evidence.ambiguities.filter(item => item.endsWith(":ambiguous_predicate"))) {
    const field = fieldPaths[ambiguity.split(":")[0]];
    if (field && !plan.filters.some(filter => filter.field === field))
      throw new Clarification("부정 표현이 포함된 조건을 생략할 수 없습니다. 원하는 조건을 긍정 표현으로 다시 알려주세요.");
  }
  for (const fact of evidence.filters) {
    const actual = plan.filters.find(filter => filter.field === fact.filter.field);
    if (!actual || actual.operator !== fact.filter.operator || JSON.stringify(actual.value) !== JSON.stringify(fact.filter.value))
      throw new Clarification("질문에 명시한 조건과 모델의 해석이 일치하지 않습니다. 조건을 나누어 다시 질문해 주세요.");
  }
  if (literalScope.platforms.length && JSON.stringify([...plan.platforms].sort()) !== JSON.stringify([...literalScope.platforms].sort()))
    throw new Clarification("질문에 명시한 매체의 조회 범위와 계획이 일치하지 않습니다.");
  if (literalScope.entity && literalScope.entity !== plan.entity)
    throw new Clarification("질문에 명시한 조회 대상과 계획이 일치하지 않습니다.");
  if (plan.previous !== !!literalScope.reference || plan.children !== (literalScope.reference === "children"))
    throw new Clarification("이전 결과 참조가 질문과 일치하지 않습니다. 새 조회와 이전 결과 조회를 바꿀 수 없습니다.");
  if (new Set(plan.platforms).size !== plan.platforms.length)
    throw new Clarification("조회 범위와 이전 검색 결과를 확인해 주세요.");
  if (plan.previous && context?.platforms.length && plan.platforms.some(platform => !context.platforms.includes(platform)))
    throw new Clarification("이전 결과의 매체와 다릅니다. 새로 검색할지 이전 결과를 좁힐지 알려주세요.");
  if (plan.children && context && !descendantType(context.entity, plan.entity))
    throw new Clarification("이전 결과 아래에서 조회할 수 있는 하위 대상을 지정해 주세요.");
  if (["audit", "policy", "history"].includes(plan.operation) && plan.filters.length)
    throw new Clarification("조건으로 좁힌 대상의 검수·정책·이력은 해당 화면에서 범위를 선택해 실행해 주세요.");
  const seen = new Set<string>();
  for (const filter of plan.filters) {
    const id = Object.keys(fieldPaths).find(key => fieldPaths[key] === filter.field)!;
    const genericBudget = id === "lifetime" && checked.evidence.has("daily") &&
      !/일\s*예산|하루\s*예산/u.test(checked.unquoted);
    if (!checked.evidence.has(id) && !genericBudget)
      throw new Clarification("질문에 명시한 조건과 조회 계획이 일치하지 않습니다. 근거 없는 조건을 추가할 수 없습니다.");
    if (seen.has(filter.field)) throw new Clarification("같은 항목의 여러 조건을 묶는 방법을 확인해 주세요.");
    seen.add(filter.field);
    // Canonical source facts have already matched field, operator and exact value above.
    if (evidence.filters.some(fact => fact.filter.field === filter.field)) continue;
    const noValue = filter.operator === "is_empty" || filter.operator === "is_not_empty";
    if (noValue !== (filter.value === undefined)) throw new Clarification("조회 조건의 비교 값을 확인해 주세요.");
    let valid = false;
    if (filter.field.startsWith("budget.")) valid = noValue || (["eq", "ne", "gt", "gte", "lt", "lte"].includes(filter.operator) && typeof filter.value === "string" && literals.amounts.includes(filter.value));
    if (filter.field === "status") valid = filter.operator === "in" && Array.isArray(filter.value) &&
      [ACTIVE, INACTIVE].some(values => JSON.stringify([...values].sort()) === JSON.stringify([...filter.value as string[]].sort()));
    if (filter.field === "schedule.end") valid = noValue;
    if (filter.field === "name") valid = ["contains", "not_contains", "eq"].includes(filter.operator) && typeof filter.value === "string" && text.includes(filter.value);
    if (filter.field === "created_at") valid = filter.operator === "between" && literals.dates.length === 1 && literals.dates.some(([, range]) => JSON.stringify(range) === JSON.stringify(filter.value));
    if (!valid) throw new Clarification("질문의 항목과 비교 조건을 확인하고 다시 입력해 주세요.");
    if (filter.field.startsWith("budget.") && (!noValue || literals.amounts.length > 0))
      throw new Clarification("예산의 비교 방향과 설정 유무를 확인하지 못했습니다. 이상·이하·같음 등의 조건을 구체적으로 알려주세요.");
  }
  if (plan.filters.some(filter => filter.field.startsWith("budget.") && !["is_empty", "is_not_empty"].includes(filter.operator)) &&
      plan.currency !== budgetCurrency(checked.unquoted))
    throw new Clarification("질문에 명시한 예산 통화와 조회 계획이 일치하지 않습니다.");
  const products = checked.products;
  assertEntityCapabilities(plan.entity, plan.platforms, products);
  assertExplicitConditions(plan, text, checked);
  return { ...plan, products, text, reference_time: now };
}
const required = (selected: Record<string, Choice>, id: string) => {
  const label = selected[id]?.label;
  if (!label || label === "unknown") throw new Clarification("질문의 조건을 확인하지 못했습니다.");
  return label;
};
export async function interpretQuery(text: string, context: QueryContext | undefined, now: Date, timezone: string, choose: Choose, modelVersion: () => string) {
  const trace: QueryTrace = { source: "laya", version: QUERY_PLAN_VERSION, model_version: modelVersion(), outcome: "uncertain", decisions: {}, stage: "input", grounded: {} };
  const select = (answers: Record<string, Choice>, id: string) => {
    if (!answers[id]?.label || answers[id]?.label === "unknown") trace.failed_decision = id;
    try { return required(answers, id); }
    catch {
      const label = { disposition: "요청 종류", request_kind: "요청 종류", operation: "조회 방식", logic: "조건의 AND/OR 연결", entity: "조회 대상", context: "이전 결과 사용 여부", semantic: "광고 목적", daily: "일예산", lifetime: "총예산", status: "운영 상태", end: "종료일", name: "이름", created: "생성 날짜", id: "원본 ID", currency: "통화" }[id];
      throw new Clarification(`${label} 조건을 확인하지 못했습니다. 해당 항목을 구체적으로 알려주세요.`);
    }
  };
  let call = 0;
  const ask = async (questions: Record<string, ChoiceQuestion>) => {
    if (!Object.keys(questions).length) return {};
    const answers = await choose(queryRequestState(text, context), questions);
    call++;
    for (const [id, answer] of Object.entries(answers)) trace.decisions[`${call}.${id}`] = answer;
    return answers;
  };
  try {
    const prepared = preprocessQuery(text, context, now, timezone, trace);
    const { unquoted, numeric, typed, request, evidence, literalScope, scopeEntity } = prepared;
    const simpleRead = !request.operation || ["find", "count"].includes(request.operation);
    const budgetPredicates = [...text.matchAll(/(일\s*예산|하루\s*예산|총\s*예산|전체\s*예산)(?:이|은|는|가)?\s*\+?\d[\d,]*(?:\.\d+)?\s*(이상|이하|초과|미만)(?:인)?/gu)];
    if (simpleRead && scopeEntity === "campaign" && !literalScope.reference && !numeric.quotedStrings.length && numeric.amounts.length === 1 && budgetPredicates.length === 1) {
      const predicate = budgetPredicates[0];
      const operation = literalListOperation(text.slice(0, predicate.index) + text.slice(predicate.index + predicate[0].length));
      if (operation) {
        const field = /총|전체/u.test(predicate[1]) ? "budget.lifetime" : "budget.daily";
        const operator = { 이상: "gte", 이하: "lte", 초과: "gt", 미만: "lt" }[predicate[2]];
        const query = validatePreparedQuery({ platforms: literalScope.platforms, entity: scopeEntity, operation,
          filters: [{ field, operator, value: numeric.amounts[0] }], logical_operator: "AND", previous: false, children: false, semantic: null, currency: null }, text, context, now, timezone, prepared);
        trace.source = "deterministic_literal"; trace.preflight = "literal_budget"; trace.plan = query; trace.outcome = "query"; trace.stage = "complete";
        return { query, trace };
      }
    }
    const literalOperation = literalListOperation(text);
    if (simpleRead && literalOperation && scopeEntity && !literalScope.reference) {
      const query = validatePreparedQuery({ platforms: literalScope.platforms, entity: scopeEntity, operation: literalOperation,
        filters: [], logical_operator: "AND", previous: false, children: false, semantic: null, currency: null }, text, context, now, timezone, prepared);
      trace.source = "deterministic_literal";
      trace.preflight = literalOperation === "count" ? "literal_count" : "literal_list";
      trace.plan = query; trace.outcome = "query"; trace.stage = "complete";
      return { query, trace };
    }
    trace.outcome = "uncertain";
    const completeEvidence = typed.complete && !!scopeEntity;
    // Choose once before inference; the campaign specialist was trained on narrower budget requests.
    const presenceRequest = (evidence.has("daily") || evidence.has("lifetime")) && !numeric.amounts.length &&
      /비어|미설정|입력|설정|없는|있는/u.test(unquoted);
    const generalRequest = ["name", "created", "id", "end"].some(id => evidence.has(id)) || presenceRequest ||
      request.operations.some(operation => operation !== "count") || /규칙|룰/u.test(unquoted);
    const dispositionId = generalRequest || (scopeEntity && scopeEntity !== "campaign") ? "request_kind" : "disposition";
    trace.stage = "request";
    trace.request_route = completeEvidence ? "evidence" : dispositionId === "request_kind" ? "general" : "specialist";
    const disposition = completeEvidence ? "query" : select(await ask(requestKindQuestions(scopeEntity, generalRequest)), dispositionId);
    if (completeEvidence) trace.grounded!.request_kind = "query";
    if (disposition !== "query") {
      trace.outcome = disposition === "unsupported" ? "unsupported" : "clarification";
      throw new Clarification(disposition === "unsupported" ? "광고 설정 조회와 검수만 지원합니다. 확인할 설정을 질문해 주세요." : "확인할 항목과 조건의 기준을 구체적으로 알려주세요.");
    }
    trace.stage = "metadata";
    const operation = request.operation ?? (completeEvidence ? "find" : undefined);
    if (operation) trace.grounded!.operation = operation;
    const metadata = await ask({
      ...(!scopeEntity ? { entity: choice("사용자가 조회하려는 광고 객체의 종류는 무엇인가요?", { campaign: "캠페인", adgroup: "광고그룹 또는 광고세트", ad: "광고", creative: "광고 소재", keyword: "검색 키워드", asset_group: "애셋그룹", ...unknown }) } : {}),
      ...(!operation ? { operation: choice("사용자가 요청한 조회 방식은 무엇인가요?", { find: "특정 조건에 맞는 목록 조회와 확인: 찾아줘, 보여줘, 알려줘, 추려줘", count: "몇 개, 개수, 몇 건인지 세기", compare: "객체 사이 설정 비교", audit: "특정 조건 없이 전체 설정 검수", history: "과거 변경 이력 조회", policy: "운영 정책 조회", create_rule: "향후 검수 규칙을 제안하거나 생성", ...unknown }) } : {}),
      ...(!completeEvidence && !request.semantic ? { semantic: choice("광고 이름이나 문구가 드러내는 운영 목적과 실제 설정을 비교해야 하나요?", { none: "광고 목적 해석 없이 명시된 설정만 조회", retarget: "리타겟 목적과 타겟 설정 불일치", purchase_mismatch: "구매 목적과 최적화 설정 불일치", branding: "브랜드 인지도 목적 여부", ...unknown }) } : {}),
    });
    const platforms = literalScope.platforms.length ? literalScope.platforms : literalScope.reference && context ? context.platforms : [];
    const contextKind = literalScope.reference ?? "all";
    const plan: QueryPlan = { platforms,
      entity: scopeEntity ?? select(metadata, "entity") as QueryPlan["entity"], operation: operation ?? select(metadata, "operation") as QueryPlan["operation"],
      logical_operator: "AND", previous: contextKind !== "all", children: contextKind === "children",
      semantic: request.semantic ?? (completeEvidence || select(metadata, "semantic") === "none" ? null : select(metadata, "semantic") as QueryPlan["semantic"]), currency: null, filters: typed.filters.map(fact => ({ ...fact.filter })) };
    if (request.semantic) trace.grounded!.semantic = request.semantic;
    trace.grounded!.filters = typed.filters;
    // Preserve the registered four-label specialist for its existing contract. Exact-name requests use the general head's expanded choices.
    const exactName = exactNameRequested(text);
    const filterQuestions = {
      daily: choice("사용자 질문에 명시된 일예산 / 하루 예산 조건은 무엇인가요?", numericOps("일예산")),
      lifetime: choice("사용자 질문에 명시된 총예산 / 전체 예산 조건은 무엇인가요?", numericOps("총예산")),
      status: choice("캠페인의 활성, 운영, 중지 상태에 어떤 조건이 있나요?", { none: "이 항목에 대한 조회 조건 없음", active: "활성, 운영 중, 진행 중인 것", inactive: "활성이 아닌 것, 비활성, 중지, 정지된 것", ...unknown }),
      end: choice("종료일 설정 유무에 어떤 조건이 있나요?", { none: "이 항목에 대한 조회 조건 없음", is_empty: "종료일 없음, 미입력, 미설정, 설정되지 않음", is_not_empty: "종료일 있음, 입력됨, 설정됨", ...unknown }),
      name: choice("캠페인 이름에 특정 글자가 들어가는지 조건이 있나요?", { none: "이름 조건 없음", ...(exactName ? { eq: "이름이 특정 문자열과 정확히 같음" } : {}), contains: "이름에 특정 문자열 포함, 들어간 것", not_contains: "이름에 특정 문자열 제외, 안 들어간 것", ...unknown }),
      created: choice("광고 객체 생성일 또는 만든 날짜 조건이 있나요?", { none: "이 항목에 대한 조회 조건 없음", between: "질문에 나온 날짜 또는 기간에 생성됨", ...unknown }),
    };
    trace.stage = "filters";
    // Keep other heads for mixed or implicit predicates: a recognized field does not prove all others absent.
    const boundFields = new Set(typed.filters.map(fact => fact.field_id));
    const selectedQuestions = Object.fromEntries(Object.entries(filterQuestions).filter(([id]) => !boundFields.has(id as typeof typed.filters[number]["field_id"]) && !completeEvidence));
    const filters = Object.keys(selectedQuestions).length ? await ask(selectedQuestions) : {};
    const literals = queryLiterals(text, now, timezone);
    const valueQuestions: Record<string, ChoiceQuestion> = {};
    const valueMaps = new Map<string, unknown[]>();
    const needValue = (id: string, values: unknown[], labels: string[], instruction: string) => {
      if (!values.length || values.length > 14) throw new Clarification("비교할 값과 항목을 더 구체적으로 알려주세요.");
      if (values.length === 1) {
        const field = fieldPaths[id]!;
        plan.filters.find(filter => filter.field === field)!.value = values[0] as QueryPlan["filters"][number]["value"];
        trace.grounded![id] = values[0];
        return;
      }
      valueMaps.set(id, values);
      valueQuestions[id] = choice(instruction, { ...Object.fromEntries(labels.map((label, i) => [`v${i}`, label])), ...unknown });
    };
    for (const [id, field] of [["daily", "budget.daily"], ["lifetime", "budget.lifetime"], ["status", "status"], ["end", "schedule.end"], ["name", "name"], ["created", "created_at"]] as const) {
      if (boundFields.has(id) || !Object.hasOwn(selectedQuestions, id)) continue;
      const operator = select(filters, id);
      if (operator === "none") continue;
      if (id === "status") plan.filters.push({ field, operator: "in", value: operator === "active" ? ACTIVE : INACTIVE });
      else if (operator === "is_empty" || operator === "is_not_empty") plan.filters.push({ field, operator });
      else {
        plan.filters.push({ field, operator: operator as QueryPlan["filters"][number]["operator"] });
        if (id === "daily" || id === "lifetime") needValue(id, literals.amounts, literals.amounts, `${id === "daily" ? "일예산" : "총예산"}의 비교 기준 금액은 어느 것인가요? 기본 통화 단위로 환산한 값을 고르세요.`);
        else if (id === "created") needValue(id, literals.dates.map(([, range]) => range), literals.dates.map(([label]) => label), "질문에서 지정한 생성 날짜 또는 기간은 어느 것인가요?");
        else {
          const strings = id === "name" && literals.quotedStrings.length ? literals.quotedStrings : [...new Set([boundNameOperand(text), ...literals.strings].filter((value): value is string => !!value))];
          needValue(id, strings, strings, "이름에 포함하거나 제외할 문자열은 어느 것인가요?");
        }
      }
    }
    if (plan.filters.some(f => f.field.startsWith("budget.") && !["is_empty", "is_not_empty"].includes(f.operator))) {
      plan.currency = budgetCurrency(unquoted);
      trace.grounded!.currency = plan.currency;
    }
    if (plan.filters.length > 1 && typed.logical_operator && completeEvidence) {
      plan.logical_operator = typed.logical_operator;
      trace.grounded!.logic = typed.logical_operator;
    } else if (plan.filters.length > 1)
      valueQuestions.logic = choice("여러 조건이 있을 때 어떻게 묶어야 하나요?", { AND: "여러 조건을 모두 만족: 그리고, 이고, 면서, AND. 단일 조건에도 적용", OR: "여러 조건 중 하나라도 만족하면 조회: 또는, 이거나, 아니면, OR", ...unknown });
    else trace.grounded!.logic = "AND";
    if (Object.keys(valueQuestions).length) {
      trace.stage = "values";
      const values = await ask(valueQuestions);
      if (Object.hasOwn(valueQuestions, "logic")) plan.logical_operator = select(values, "logic") as "AND" | "OR";
      for (const [id, candidates] of valueMaps) {
        const label = select(values, id);
        if (!/^v(?:0|[1-9]\d*)$/u.test(label)) throw new Clarification("비교 값을 확인해 주세요.");
        const index = Number(label.slice(1));
        if (index >= candidates.length) throw new Clarification("비교 값을 확인해 주세요.");
        const field = fieldPaths[id]!;
        plan.filters.find(f => f.field === field)!.value = candidates[index] as QueryPlan["filters"][number]["value"];
      }
    }
    trace.plan = plan;
    trace.stage = "validation";
    trace.outcome = "validation";
    const query = validatePreparedQuery(plan, text, context, now, timezone, prepared);
    trace.outcome = "query";
    trace.stage = "complete";
    if (!call) { trace.source = "deterministic_literal"; trace.preflight = "typed_evidence"; }
    trace.model_version = modelVersion();
    return { query, trace };
  } catch (error) {
    trace.model_version = modelVersion();
    if (error instanceof Clarification && !call && trace.stage === "input" && (trace.outcome === "clarification" || trace.outcome === "unsupported")) {
      const reason = { code: trace.capability_guard ?? "input_contract", message: error.message, kind: trace.outcome };
      trace.answerability = { ...(trace.answerability ?? analyzeQueryAnswerability(text, undefined, context)), status: trace.outcome,
        reasons: trace.answerability?.reasons.length ? trace.answerability.reasons : [reason] };
    }
    if (!(error instanceof Clarification)) trace.outcome = "inference";
    throw new QueryModelError(error instanceof Clarification ? error.message : "모델에서 조회 조건을 확인하지 못했습니다. 다시 시도해 주세요.", trace);
  }
}
