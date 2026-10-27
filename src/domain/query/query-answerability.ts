import { excludedAdProduct, missingNameOperand, performanceMetricText, precedingQuotedName, queryScopeText } from "../../lib/ad-products";
import type { QueryContext } from "./query";
import type { QueryPlan } from "./query-model";
import { queryLiteralScope, queryRequestRemainder } from "./query-scope";
import { explicitReadRequest } from "./query-language";

type Operation = QueryPlan["operation"];
type Semantic = NonNullable<QueryPlan["semantic"]>;
type Evidence = { complete: boolean; filters: { filter: QueryPlan["filters"][number] }[]; unresolved: string[]; ambiguities: string[] };
type Reason = { code: string; message: string; kind: "unsupported" | "clarification"; capability?: "read_only" | "performance_metrics" | "excluded_product" | "unsupported_condition" | "unsupported_platform" };
export type QueryAnswerability = {
  status: "supported" | "model_needed" | "clarification" | "unsupported";
  reasons: Reason[];
  operations: Operation[];
  operation?: Operation;
  semantic?: Semantic;
  data_requirements: string[];
  operation_evidence?: { operation: Operation; span: [number, number]; text: string }[];
};

// These are the operations/data this query executor can actually represent, not connector-wide API capabilities.
export const QUERY_EXECUTION_CAPABILITIES = {
  operations: ["find", "count", "compare", "audit", "policy", "history", "create_rule"] as const,
  fields: ["budget.daily", "budget.lifetime", "schedule.end", "status", "name", "created_at", "entity_id"] as const,
  unfiltered_operations: ["audit", "policy", "history"] as const,
  semantic: ["retarget", "purchase_mismatch", "branding"] as const,
};
const workflowHeads: [Operation, RegExp][] = [
  ["create_rule", /(?:규칙|룰)(?:안)?(?:을|를)?[^.;?!]{0,45}(?:제안|만들|생성|작성)|(?:제안|만들|생성|작성)[^.;?!]{0,30}(?:규칙|룰)|(?:규칙|룰)\s*(?:초안|안)?(?:을|를)?\s*(?:주세요|주십시오|요청|부탁)/u],
  ["history", /이력|변경[^.;?!]*(?:내역|기록)|설정이?\s*바뀐\s*(?:내역|기록)/u],
  ["policy", /정책|가이드/u],
  ["audit", /검수|점검(?!표)|\bQA\b|(?:전체\s*)?설정(?:값)?(?:을|의|에\s*대한)?\s*(?:(?:전체|전부|모두)(?:을|를)?\s*)?검사|검사(?=해|하|를\s*(?:부탁|요청))/iu],
  ["compare", /비교|설정[^.;?!]*(?:차이|대조)|(?:간|사이)(?:의)?\s*차이(?:점)?/u],
];
const countRequest = /개수|수량|몇\s*(?:개|건)|(?:캠페인|광고(?:\s*(?:그룹|세트))?|애셋\s*그룹|에셋\s*그룹|소재|키워드|항목|대상|것)(?:들)?\s*(?:의\s*)?(?:총\s*)?수(?:를|는|가|부터|만|도|\s|[?.!]|$)|(?:수를|수는)\s*(?:세|알|확인|얼마)|(?<![\p{L}\p{N}_])(?:세어|세(?=\s*(?:줘|주세요|주십시오|주실래|줄래)))(?=$|\s|줘|주세요|주십시오|주실래|줄래)/u;

/** Request obligations are read before inference and checked again against the final plan. */
export function analyzeQueryAnswerability(text: string, evidence?: Evidence, context?: QueryContext, scope?: {reference?: "previous" | "children"}): QueryAnswerability {
  const clean = queryScopeText(text), metrics = performanceMetricText(text);
  const reasons: Reason[] = [];
  const add = (code: string, message: string, kind: Reason["kind"], capability?: Reason["capability"]) => reasons.push({ code, message, kind, ...(capability ? { capability } : {}) });
  let reference: "previous" | "children" | undefined;
  if (scope) reference = scope.reference;
  else try { reference = queryLiteralScope(text, context?.has_results ? context.entity : undefined).reference; } catch { /* The caller reports incompatible scope using the same grammar. */ }
  if (reference && !context?.has_results) add("context_required", "먼저 광고를 검색한 뒤 결과를 좁혀 주세요.", "clarification");
  const workflowText = clean.replace(/비교(?=하면|할\s*때|\s*기준)|(?:검수|점검|검사)(?=에서|용|\s*기준)/gu, value => " ".repeat(value.length))
    .replace(/[^.;?!]*(?:검수|점검|검사)[^.;?!]*(?:끝났|완료됐|완료했)[^.;?!]*[.;?!]/gu, value => " ".repeat(value.length))
    // Consume the operation word only inside its own grammatical role; independent verbs remain visible.
    .replace(/(?:검수|점검|검사)(?=\s*정책)/gu, value => " ".repeat(value.length))
    .replace(/(?:검수|점검|검사|QA)(?=(?:하는|할|하도록|용)?\s*(?:새(?:로운)?\s*)?(?:규칙|룰))/giu, value => " ".repeat(value.length))
    .replace(/정책(?:을|를|에)?\s*(?:기준으로|따라|적용해)/gu, match => match.replace("정책", "  "))
    .replace(/정책(?:의)?\s*(?:(?:적용|배정|연결)\s*(?:상태|내용|여부|내역)(?:을|를|은|는)?|(?:을|를))\s*(?:검수|점검)/gu,
      match => match.replace(/검수|점검/gu, "  "));
  const operation_evidence = workflowHeads.flatMap(([operation, pattern]) => {
    const found = pattern.exec(workflowText);
    return found ? [{ operation, span: [found.index, found.index + found[0].length] as [number, number], text: text.slice(found.index, found.index + found[0].length) }] : [];
  });
  const operations = operation_evidence.map(item => item.operation);
  const counted = countRequest.exec(clean);
  if (counted) {
    operations.push("count");
    operation_evidence.push({ operation: "count", span: [counted.index, counted.index + counted[0].length], text: text.slice(counted.index, counted.index + counted[0].length) });
  }
  const coordinatedList = /(?:보여|알려|찾아|조회해)(?:\s*주)?(?:고|준\s*(?:뒤|후)|준\s*다음)[^.;?!]*(?:검수|점검|이력|정책|비교|규칙|룰)/u;
  const followingList = /(?:비교|검수|점검|이력|정책)[^.;?!]*(?:한\s*(?:후|뒤|다음)|하고|해\s*주고)[^.;?!]*(?:(?:목록|리스트)(?:도|을|를)?\s*(?:보여|알려|조회)|찾아)/u;
  const countedList = /(?:목록|리스트)(?:과|와|하고|\s*및)\s*(?:개수|수량)|(?:개수|수량)(?:과|와|하고|\s*및)\s*(?:목록|리스트)|(?:보여|찾아|조회해)(?:\s*주)?고[^.;?!]*(?:개수|수량|세어|세줘)|(?:세고|센\s*(?:뒤|후)|세어\s*주고)[^.;?!]*(?:목록|리스트)(?:도|을|를)?\s*(?:보여|알려|조회)/u;
  const clauses = workflowText.split(/[.;?!\n]+|(?<![\p{L}\p{N}_])그리고(?=$|\s)/u);
  const independentList = clauses.length > 1 && clauses.some(clause => {
    if (!/캠페인|광고|소재|키워드|애셋|에셋|목록|리스트/u.test(clause) || workflowHeads.some(([, pattern]) => pattern.test(clause)) || countRequest.test(clause)) return false;
    try { return explicitReadRequest(queryRequestRemainder(clause)); }
    catch { return false; } // The shared scope reader reports incompatible object obligations.
  });
  if (operations.length && (coordinatedList.test(clean) || followingList.test(clean) || countedList.test(clean) || independentList)) operations.push("find");
  const requested = [...new Set(operations)];
  if (requested.length > 1) add("multiple_operations", "목록·개수·비교·검수·정책·이력·규칙 작업을 하나씩 질문해 주세요.", "clarification");
  if ([...clean.matchAll(/비교|검수|점검|검사|이력|정책|규칙|룰/gu)].some(match =>
    /말고|제외|아닌|하지|않|없이|대신/u.test(clean.slice(match.index + match[0].length).split(/캠페인|광고\s*(?:그룹|세트)|일\s*예산|총\s*예산|종료일|이름|[.;]/u)[0])))
    add("excluded_workflow", "제외할 작업 대신 실행할 작업만 지정해 주세요.", "clarification");

  const semantics: Semantic[] = [];
  const retarget = /리타겟|리타깃|리마케팅|재방문|기존\s*(?:방문자|고객)|방문(?:했던|한)\s*사람[^.;?!]{0,20}다시\s*광고/u.test(clean) && /목적|의도|설정|어긋|불일치|맞지/u.test(clean);
  const opposedRelationship = /(?<!불)일치(?:하는|한|인)|(?<!안\s*)맞는|어긋나지\s*않|불일치하지\s*않|불일치(?:가|는)?\s*아닌|맞지\s*않는\s*(?:(?:게|것이|것은)\s*)?아닌/u.test(clean);
  const mismatchRelationship = /어긋(?:나는|난)|불일치|맞지\s*않|안\s*맞|타겟\s*설정이?\s*다른/u.test(clean);
  if (retarget) {
    if (!opposedRelationship && mismatchRelationship) semantics.push("retarget");
    else add("retarget_relationship", "리타겟 목적과 실제 타겟 설정의 불일치를 확인할지 알려주세요. 일치 대상만의 조회는 지원하지 않습니다.", "clarification");
  }
  if (/구매/u.test(clean) && /목적|의도|전환|최적화/u.test(clean)) {
    const contrast = /구매\s*(?:목적|의도)\s*대비\s*최적화(?:\s*설정)?(?:이|가|은|는)?\s*/u.exec(clean);
    const predicate = contrast ? clean.slice(contrast.index + contrast[0].length) : "";
    const opposedContrast = /^(?:잘못되지\s*않(?:은|는)|잘못된\s*(?:게|것이|것은)\s*아닌)/u.test(predicate);
    if (opposedRelationship || opposedContrast) add("purchase_relationship", "구매 목적과 최적화 설정의 불일치를 확인할지 알려주세요. 일치 대상만의 조회는 지원하지 않습니다.", "clarification");
    else if (mismatchRelationship || /다른/u.test(clean) || /^잘못된(?=\s|$|캠페인|광고)/u.test(predicate)) semantics.push("purchase_mismatch");
  }
  if ((/브랜딩|브랜드\s*(?:인지도|인지|알리)/u.test(clean) && /목적|의도|설정|해당/u.test(clean)) || /브랜드(?:를)?\s*(?:널리\s*)?알리(?:기\s*위한|려는)/u.test(clean) || /운영\s*의도가\s*브랜드를\s*알리는\s*데\s*있는/u.test(clean)) {
    if (/(?:브랜딩|브랜드\s*(?:인지도|인지))\s*(?:(?:목적|의도)(?:이|가|은|는|을|를)?\s*)?(?:아닌|아니|제외|말고)/u.test(clean))
      add("branding_polarity", "브랜딩 목적이 있는 대상의 조회만 지원합니다. 목적 부정 조건을 생략해서 조회할 수 없습니다.", "clarification");
    else semantics.push("branding");
  }
  if (semantics.length > 1) add("multiple_semantics", "확인할 광고 목적을 하나씩 지정해 주세요.", "clarification");

  if (/\b(?:ROAS|CTR|CPC|CPM|CVR|CPA)\b|클릭률|전환율|(?:노출|클릭|구매|전환|도달)(?:당|별)?\s*(?:수|횟수|건수|비용|단가|률|율)|(?:노출|클릭|구매|전환|도달)(?:이|가|은|는)?\s*(?:(?:한\s*(?:번|건)도?|단\s*한\s*(?:번|건)도?)\s*)?(?:0|없|있(?:는|었|던)|발생(?:한|하지\s*않|하지\s*안|하지\s*못))|(?:노출|클릭|구매|전환|도달|효율)(?:이|가|은|는)?\s*(?:낮|적|높|많|좋|나쁜|나쁘)|성과|실적|매출|소진\s*(?:금액|비용)|광고비\s*(?:지출|사용)|비용(?:이|가|은|는)?\s*(?:많|적|높|낮)/iu.test(metrics))
    add("performance_data", "성과 지표는 현재 질문 조회에서 지원하지 않습니다. 예산·상태 등 광고 설정을 질문해 주세요.", "unsupported", "performance_metrics");
  if (excludedAdProduct(text)) add("excluded_product", "현재 지원하지 않는 광고상품입니다. 지원하는 광고상품의 설정을 질문해 주세요.", "unsupported", "excluded_product");
  if (/(?:광고|캠페인|세트|그룹|키워드|소재|예산|이름)[^.;?!]*(?:삭제|복제|복사|수정|변경|증액|감액|중지|활성화|비활성화)(?:해|하겠|하자|하라|시켜|해\s*주|하(?:여|고)\s*주|\s*부탁)|(?:예산|이름|종료일|상태)[^.;?!]*(?:바꿔|고쳐|올려|내려|늘려|줄여)|(?:캠페인|광고\s*세트|광고\s*그룹|소재)[^.;?!]*(?:새로\s*만들어|지워\s*줘)|(?:광고|캠페인|소재|그룹|세트)[^.;?!]*(?:삭제|복제|복사|수정|변경)한\s*(?:다음|뒤|후)|예산[^.;?!]*(?:원|달러)(?:씩)?\s*넣어\s*(?:주|줘|달라)/u.test(clean) ||
      /(?:예산|광고|캠페인|그룹|세트|소재|키워드)[^.;?!]*(?:제거해|꺼\s*(?:줘|주세요)|켜\s*(?:줘|주세요)|바꿔\s*줘|올려\s*줘|내려\s*줘)|(?:광고|캠페인|예산|이름|계정)[^.;?!]*(?:지우는|복사(?:한|할)|복제(?:한|할)|결제해|변경하는\s*작업|멈추게\s*해|고쳐\s*줘|늘려\s*줘|켜서\s*실행|두\s*배로\s*올려)|이름[^.;?!]*새로\s*붙인\s*후/u.test(clean))
    add("mutating_action", "광고 설정을 바꾸는 작업은 지원하지 않습니다. 현재 설정 조회와 검수만 가능합니다.", "unsupported", "read_only");
  if (!operations.includes("create_rule") && /(?:광고|캠페인|그룹|세트|소재|키워드)[^.;?!]{0,40}(?:생성|추가|개설|만들어)(?:해)?\s*(?:주|줄|줘|달라)/u.test(clean))
    add("creating_entity", "새 광고 객체를 생성하는 작업은 지원하지 않습니다. 현재 설정 조회와 검수만 가능합니다.", "unsupported", "read_only");
  if (/예산[^.;?!]*(?:높은\s*순|낮은\s*순|정렬|상위|하위|평균(?!적인)|중앙값|합계|총합|예측|추천|순위|환율|환산|사이|가장\s*(?:큰|높|적|낮)|어제보다\s*(?:늘|줄|많|적)|다른\s*(?:캠페인|광고\s*그룹|광고\s*세트|것)[^.;?!]*보다)|(?:평균|중앙값)[^.;?!]*예산|(?:일|하루)\s*예산[^.;?!]*(?:총|전체)\s*예산[^.;?!]*(?:차이|합|비율|보다)|총\s*예산[^.;?!]*일\s*예산[^.;?!]*보다|총\s*예산보다[^.;?!]*일\s*예산|일\s*예산보다[^.;?!]*총\s*예산|가장[^.;?!]*예산/u.test(clean))
    add("derived_budget", "예산의 정렬·순위·집계·환산·예측은 지원하지 않습니다. 하나의 기준 금액으로 비교해 주세요.", "unsupported", "unsupported_condition");
  if (/종료(?:일|\s*날짜)?(?:까지|후|된|했|한|됐)|종료(?:일|\s*날짜)[^.;?!]{0,24}(?:남[은았]|지[난났])|(?:어제|오늘|그제|지난\s*주)[^.;?!]{0,12}종료/u.test(clean) &&
      /남[은았]|지[난났]|종료(?:된|했|한|됐)|\d+\s*일|사흘|이틀|나흘|며칠/u.test(clean))
    add("derived_schedule", "종료 시점의 전후·남은 기간은 지원하지 않습니다. 종료일의 설정 유무를 질문해 주세요.", "unsupported", "unsupported_condition");
  if (/종료(?:일|\s*날짜)(?:이|가|은|는)?\s*(?:내일|모레|오늘|어제|그제|다음\s*(?:주|달)|\d{4}[-./]\d{1,2}[-./]\d{1,2})(?:인|이|$|\s)/u.test(clean))
    add("end_date_value", "종료일은 날짜 값 비교 대신 설정 유무만 조회할 수 있습니다.", "clarification");
  if (/(?:얼마\s*전|최근|근래|요즘|조금\s*전|며칠\s*전)(?:\s*\d+\s*(?:일|주|개월|달|시간))?(?:\s*(?:이내|내|동안|간))?(?:에|의)?\s*(?:새로\s*)?(?:등록|생성|만들)|(?:등록|생성)(?:일|\s*날짜)(?:이|가|은|는)?\s*(?:얼마\s*전|최근|근래|요즘|며칠\s*전)/u.test(clean))
    add("missing_creation_period", "등록 날짜의 범위를 지정해 주세요. 예: 오늘, 지난주, 2026-10-20.", "clarification");
  const endCriterion = /종료(?:일|\s*날짜)(?:이|가|은|는)?([^.;?!]*)/u.exec(clean)?.[1]
    .split(/예산|상태|이름|명칭|생성|원본\s*ID|\bID\b|아이디/iu)[0];
  if (endCriterion && /(?:행사|프로모션|이벤트|일정|기준일|마감)[^.;?!]{0,24}(?:전|후|날|시작|종료)|(?:전|후)(?:인|으로|에|까지)|(?:이전|이후)(?:인|으로|에|\s|$)/u.test(endCriterion))
    add("unresolved_end_date", "종료일은 설정 유무만 조회할 수 있습니다. 행사 날짜 등의 조건을 생략해서 조회할 수 없습니다.", "clarification");
  if (/예산(?:이|은|는|가|\s*값이)?\s*(?:애매한|충분한|적당한|적정한|대략적인)(?:\s*(?:정도|수준))?/u.test(clean) && !/\d/u.test(clean))
    add("missing_budget_criterion", "예산의 정도를 판단할 기준 금액과 비교 방향을 지정해 주세요.", "clarification");
  if (/틱톡|tiktok|링크드인|linkedin|핀터레스트|pinterest|마이크로소프트\s*광고|\bbing\b/iu.test(clean))
    add("unsupported_vendor", "현재 연결할 수 있는 광고 매체로 조회 범위를 지정해 주세요.", "unsupported", "unsupported_platform");
  if (/예산/u.test(clean) && /유로|엔화|\d\s*엔|위안|파운드|\b(?:EUR|JPY|CNY|GBP)\b|[€¥￥£]/iu.test(clean))
    add("unsupported_currency", "예산 비교는 원화 또는 달러로 지정해 주세요.", "unsupported", "unsupported_condition");
  if (/(?:앞|처음|뒤|마지막)(?:의|에서)?\s*(?:\d+|한|두|세|네|다섯|열)\s*(?:개|건)(?:만|를|을)?/u.test(clean))
    add("result_limit", "조회 결과 개수 제한은 지원하지 않습니다. 조건에 맞는 전체 목록이나 개수를 질문해 주세요.", "unsupported", "unsupported_condition");
  // A qualified source cannot silently become the all-connected-media default.
  // Resolve it using the same scope grammar, without guessing an unknown vendor's identity.
  const source = /^\s*([\p{L}\p{N}_-]{1,32})\s+(?:광고|매체|플랫폼)(?:에서|의)/u.exec(clean);
  if (source && !/^(?:모든|전체|연결된|등록된|현재|기존|활성|중지된|해당|이|그)$/u.test(source[1])) {
    if (!queryLiteralScope(source[1]).platforms.length)
      add("unresolved_source", "조회할 매체를 지원하는 이름으로 지정하거나 광고 이름 조건으로 구분해 주세요.", "clarification");
  }
  if (/타겟팅한|만\s*타겟팅|연령|나이|세\s*이상|세\s*이하|여성|남성|심사\s*거절|입찰가|(?:PC|모바일|데스크톱|스마트폰)(?:\s*기기)?(?:에|에서)?\s*만|(?:노출|타겟|게재)\s*(?:지역|위치)|지역(?:을|를|만)?\s*타겟|(?:지역|기기)(?:으로|로)\s*(?:설정한|지정한)|(?:서울|부산|한국|대한민국)(?:\s*지역)?(?:에|에서)?\s*만/iu.test(clean))
    add("unsupported_configuration_field", "기기·지역·입찰·심사 조건은 현재 조회에서 지원하지 않습니다.", "unsupported", "unsupported_condition");
  if (/(?:타겟(?:팅)?\s*)?(?:국가|나라)(?:\s*(?:코드|설정))?(?=$|[\s:：=]|이|가|은|는|을|를|로|에|만)|(?:랜딩|도착|연결|최종|목적지)\s*(?:URL|주소)|\bURL(?=$|[\s:：=]|에|이|가|은|는|을|로|만)/iu.test(clean))
    add("unrepresentable_filter_field", "국가·랜딩 URL 조건은 현재 검색에서 지원하지 않습니다. 해당 조건을 생략해서 조회할 수 없습니다.", "unsupported", "unsupported_condition");
  if ([...clean.matchAll(/(?:이름|명칭)(?:에서|에)/gu)].some(match => !precedingQuotedName.test(text.slice(0, match.index)) && missingNameOperand(text.slice(match.index + match[0].length))))
    add("missing_name_operand", "이름에 포함하거나 제외할 문자열을 지정해 주세요.", "clarification");
  const domain = /예산|종료|상태|이름|명칭|\bID\b|아이디|광고|캠페인|소재|키워드|애셋|에셋|매체|메타|페이스북|인스타그램|네이버|카카오|구글|\b(?:meta|google|naver|kakao|PMax)\b|그\s*중|이\s*중|방금|아까|이전\s*결과|해당\s*결과/iu.test(clean);
  if (!domain && !operations.length && !reference)
    add("outside_configuration_domain", "광고 설정으로 답변할 수 있는 질문을 입력해 주세요.", "unsupported");

  const operation = requested.length === 1 ? requested[0] : undefined;
  if (operation && (QUERY_EXECUTION_CAPABILITIES.unfiltered_operations as readonly Operation[]).includes(operation)) {
    if (evidence?.filters.length || reference || semantics.length)
      add("filtered_workflow", "조건으로 좁힌 대상이나 이전 결과의 검수·정책·이력은 해당 화면에서 범위를 선택해 실행해 주세요.", "clarification");
  }
  const unsupported = reasons.some(reason => reason.kind === "unsupported");
  return {
    status: unsupported ? "unsupported" : reasons.length ? "clarification" : evidence?.complete ? "supported" : "model_needed",
    reasons, operations: requested, ...(operation ? { operation } : {}), ...(semantics.length === 1 ? { semantic: semantics[0] } : {}),
    data_requirements: operation === "history" ? ["connected_settings", "previous_snapshot"] : operation === "policy" || operation === "audit" ? ["connected_settings", "policy_scope"] : ["connected_settings", ...(semantics.length ? ["declared_intent", "actual_configuration"] : [])],
    operation_evidence,
  };
}

/** Attach field obligations without reading the original request and its workflow a second time. */
export function withQueryEvidence(request: QueryAnswerability, evidence: Evidence): QueryAnswerability {
  const reasons = [...request.reasons];
  if (request.operation && (QUERY_EXECUTION_CAPABILITIES.unfiltered_operations as readonly Operation[]).includes(request.operation) && (evidence.filters.length || request.semantic) && !reasons.some(reason => reason.code === "filtered_workflow"))
    reasons.push({ code: "filtered_workflow", message: "조건으로 좁힌 대상이나 이전 결과의 검수·정책·이력은 해당 화면에서 범위를 선택해 실행해 주세요.", kind: "clarification" });
  return { ...request, reasons, status: reasons.some(reason => reason.kind === "unsupported") ? "unsupported" : reasons.length ? "clarification" : evidence.complete ? "supported" : "model_needed" };
}

export function requestPlanMismatch(request: QueryAnswerability, plan: QueryPlan): string | undefined {
  if (request.status === "unsupported" || request.status === "clarification") return request.reasons.find(reason => reason.kind === request.status)?.message;
  if (request.operation && request.operation !== plan.operation) return "질문에 명시한 작업과 모델의 해석이 일치하지 않습니다. 요청한 작업을 생략할 수 없습니다.";
  if (!["find", "count"].includes(plan.operation) && !request.operations.includes(plan.operation)) return "조회 방식과 질문의 요청이 일치하지 않습니다. 목록·개수·비교·검수·이력 중 원하는 작업을 알려주세요.";
  if (request.semantic && request.semantic !== plan.semantic) return "질문에 명시한 광고 목적과 모델의 해석이 일치하지 않습니다. 목적과 실제 설정의 비교를 생략할 수 없습니다.";
}
