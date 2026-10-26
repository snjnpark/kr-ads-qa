import Decimal from "decimal.js";
import { literalProducts, unquotedAdText, queryScopeText } from "../../lib/ad-products";
import { Clarification, dateRange, type QueryContext } from "./query";
import { queryLiteralScope, queryRequestRemainder, queryRequestEvidence, childEntity, descendantType, assertEntityCapabilities } from "./query-scope";
import { analyzeQueryEvidence, queryPlanRemainder, type GroundedQueryFilter } from "./query-evidence";
import { analyzeQueryAnswerability } from "./query-answerability";
import type { QueryPlan, QueryTrace } from "./query-model";

const MONEY_UNITS: Record<string, number> = { 억: 100000000, 만: 10000, 천: 1000, 백: 100, 십: 10 };
const DATE_LITERAL = /\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일|그제|어제|오늘|금일|지난\s?주|이번\s?주|이번\s?달|지난\s?달/gu;

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
export const namePredicateText = (text: string) => unquotedAdText(text).match(/(?:이름|명칭)[^,;]{0,120}/u)?.[0]
  .split(/일\s*예산|하루\s*예산|총\s*예산|전체\s*예산|예산|종료일|상태|생성|원본\s*ID|\bID\b/iu)[0];
// Only a value owned by the name predicate may be selected; another word
// occurring elsewhere in the question is not an alternative name operand.
export function boundNameOperand(text: string) {
  if (/(?:이름|명칭)(?:에서|에|이|가)\s*(?:(?:정확히|정확하게|완전히|딱)\s*)?['"“‘`]/u.test(text)) return;
  const clause = namePredicateText(text);
  return clause?.match(/^(?:이름|명칭)(?:에서|에|이|가)\s*([\p{L}\p{N}_./()-]{1,64}?)(?:이|가|을|를|와|과|하고)?\s*(?:(?:정확히|정확하게|완전히)\s*)?(?:같은|동일한|일치하는|포함|들어|제외|없는|있는|인(?=\s|$))/u)?.[1];
}
export const exactNameRequested = (text: string) => /정확히\s*같|(?:와|과)\s*같/u.test(namePredicateText(text) ?? "") ||
  [...unquotedAdText(text).matchAll(/(?:이름|명칭)이/gu)].some(match =>
    /^(?:이름|명칭)이\s*(?:'[^']+'|"[^"]+"|“[^”]+”|‘[^’]+’|`[^`]+`|[\w가-힣-]+)\s*인/u.test(text.slice(match.index)));

export function budgetCurrency(text: string): QueryPlan["currency"] {
  const krw = /(?:[\d영일이삼사오육칠팔구억만천백십열]\s*원|원화|\bKRW\b)/iu.test(text);
  const usd = /달러|\bUSD\b/iu.test(text);
  if (krw && usd) throw new Clarification("예산 비교에 사용할 통화를 하나만 지정해 주세요.");
  return krw ? "KRW" : usd ? "USD" : null;
}

function idFacts(text: string) {
  return [...queryScopeText(text).matchAll(/(?:원본\s*(?:(?:캠페인|광고\s*(?:그룹|세트)?|(?:애셋|에셋)\s*그룹|소재|키워드)\s*)?)?(?:\bID\b|아이디)/giu)].flatMap(match => {
    const tail = text.slice(match.index + match[0].length);
    const quoted = /^(?:(?:가|는|[:：])?\s*|를\s*(?:대조하면|확인하면)\s*)(?:'([^']+)'|"([^"]+)"|“([^”]+)”|‘([^’]+)’|`([^`]+)`)/u.exec(tail);
    const bare = tail.match(/^(?:가|는|[:：])?\s*([A-Za-z0-9][A-Za-z0-9_-]{0,63})/u);
    const operand = quoted ?? bare;
    if (!operand) return [];
    const value = quoted ? quoted.slice(1).find(part => part !== undefined)! : bare![1];
    const rest = tail.slice(operand[0].length);
    const suffix = /^\s*(?:에\s*해당하는|으로\s*표시된|(?:를|을)\s*가진|(?:와|과)\s*(?:(?:정확히|완전히)\s*)?(?:같은|동일한|일치하는)|하나(?:를|만)|(?:으)?로(?=\s|$)(?!\s*(?:시작|끝나|끝난|포함))|인(?=\s|$)|이고|이며|(?:이야|야)(?=[\s.!?]|$))?/u.exec(rest)![0];
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
    const after = new RegExp(`(?:생성(?:일|\\s*날짜)|등록일)(?:이|가|은|는)?\\s*(?:기준(?:은|이|는)?\\s*)?${escaped}(?:인)?`, "u").exec(clean);
    const found = before ?? after;
    if (found) {
      const span: [number, number] = [found.index, found.index + found[0].length];
      literalFacts.push({ field_id: "created", filter: { field: "created_at", operator: "between", value: range }, span, text: text.slice(...span) });
    }
  }
  const request = analyzeQueryAnswerability(text);
  return analyzeQueryEvidence(text, numeric, {
    literalsFor: clause => queryLiterals(clause, now, timezone), requestRemainder: queryRequestRemainder, literalFacts,
    semantic: request.semantic, operation: request.operation,
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
export function assertQueryInput(text: string) {
  if (!text.trim() || text.length > 2000) throw new Clarification("2,000자 이내의 광고 설정 질문을 입력해 주세요.");
}

// Both inference and direct-plan validation consume the same checked source facts.
export function preprocessQuery(text: string, context: QueryContext | undefined, now: Date, timezone: string, trace: Partial<QueryTrace> = {}) {
  trace.outcome = "clarification";
  assertQueryInput(text);
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
      (/이름|명칭/u.test(unquotedAdText(text)) && /아직|나중에|다음에|미정|비워|모르겠|무엇이|(?:그|이)\s*(?:단어|문구)|해당\s*문구|지정할\s*문구/u.test(unquotedAdText(text)) && !numeric.quotedStrings.length) ||
      /(?:이름|명칭).*(?:특정\s*(?:단어|문구)|검색어|어떤\s*(?:단어|문구))/u.test(unquotedAdText(text)) && !numeric.quotedStrings.length ||
      /일예산인지.*(?:전체|총)\s*예산인지|예산\s*종류(?:가|는)?\s*다른|금액\s*단위는\s*빠졌/u.test(unquoted))
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
  const boundFields = new Set(typed.filters.map(fact => fact.field_id));
  const unfiltered = !!request.operation && ["audit", "policy", "history"].includes(request.operation);
  const modelFields = typed.complete || unfiltered ? [] : typed.relevant_fields.filter(field => !boundFields.has(field));
  // An unqualified, unresolved budget retains both trained budget choices.
  if (modelFields.includes("daily") && !/일\s*예\s*산|하루\s*예\s*산|일일(?:에)?\s*예\s*산|총\s*예\s*산|전체\s*예\s*산/u.test(unquoted))
    modelFields.push("lifetime");
  trace.grounded = { ...trace.grounded, model_fields: modelFields };
  const clauses = queryRequestEvidence(text).clauses;
  if (clauses.length) trace.grounded.request_clauses = clauses;
  if (!modelFields.length && queryPlanRemainder(typed.residual, request.operation, request.semantic))
    throw new Clarification("해석하지 못한 추가 조건이 있습니다. 적용할 조건을 나누어 구체적으로 알려주세요.");
  return { unquoted, numeric, typed, request, evidence, literalScope, scopeEntity, products, modelFields };
}
export type PreparedQuery = ReturnType<typeof preprocessQuery>;

