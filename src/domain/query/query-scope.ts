import { literalProducts, queryIntroduction, stripAdProductMentions, unquotedAdText, queryScopeText, ProductScopeError, adVendorSpans, adProductSpans,
  ownedAdSpans, coordinatedAdExclusions, AD_SCOPE_COORDINATION as coordination, AD_SCOPE_EXCLUSION as excluded } from "../../lib/ad-products";
import { PLATFORMS } from "../entities";
import { Clarification } from "./query";
import type { QueryPlan } from "./query-model";
import type { Scope } from "../../contracts/domain";
import { carrierResidual, queryCarrierOperation } from "./query-evidence";
import { consumeQueryDeclarations } from "./query-clauses";
const entityPatterns: [QueryPlan["entity"], string][] = [
  ["adgroup", "광고\\s*(?:그룹|세트|셋)명?|(?<![가-힣])(?:그룹명|세트명)|\\bad\\s*(?:groups?|sets?)\\b"],
  ["asset_group", "(?:애셋|에셋)\\s*그룹명?|\\basset\\s*groups?\\b"],
  ["creative", "소재명?|\\bcreatives?\\b"], ["keyword", "키워드명?|\\bkeywords?\\b"],
  ["campaign", "캠페인명?|\\bcampaigns?\\b"],
  ["ad", "광고\\s*(?:이름|명칭)|광고명|(?<![\\p{L}\\p{N}_])광고(?!\\s*(?:그룹|세트|셋|계정|설정|세팅|상품|운영|검수|정책|캠페인|목적|이름|키워드|소재|애셋|에셋))(?:들)?(?=$|[\\s을를이가만중의와과랑에은는]|하고|(?:입니다|으로|로)(?=$|[\\s,.;?!]|만|는|도))|\\bads?\\b"],
];
const descendants: Record<string, readonly string[]> = {
  campaign: ["adgroup", "asset_group", "ad", "creative", "keyword"],
  adgroup: ["ad", "creative", "keyword"],
};
export const childEntity = (parent: string) => ({ campaign: "adgroup", adgroup: "ad" } as Record<string, QueryPlan["entity"]>)[parent];
export const descendantType = (parent: string, child: string) => descendants[parent]?.includes(child) ?? false;
// Normalized rows actually returned by each connector. Do not rename reusable creatives into ads.
export const QUERY_ENTITY_CAPABILITIES: Record<string, readonly string[]> = {
  meta: ["campaign", "adgroup", "ad", "creative"], naver: ["campaign", "adgroup", "ad", "keyword"],
  kakao: ["campaign", "adgroup", "creative"], kakao_keyword: ["campaign", "adgroup", "ad", "creative", "keyword"],
  google: ["campaign", "adgroup", "ad", "keyword", "asset_group"],
};
export function assertEntityCapabilities(entity: string, platforms: readonly string[], products: readonly string[] = []) {
  if (platforms.some(platform => !QUERY_ENTITY_CAPABILITIES[platform]?.includes(entity)))
    throw new Clarification(entity === "creative" ? "선택한 매체에서는 독립 소재를 조회할 수 없습니다. 광고 또는 구글 애셋그룹으로 조회해 주세요."
      : entity === "ad" && platforms.includes("kakao") ? "카카오 모먼트의 광고는 소재로 조회해 주세요."
        : "선택한 매체에서 조회할 수 있는 광고 항목 종류를 지정해 주세요.");
  if ((entity === "keyword" && products.some(product => ["naver:SHOPPING", "naver:PLACE"].includes(product))) ||
      (products.includes("google:PERFORMANCE_MAX") && !["campaign", "asset_group"].includes(entity)))
    throw new Clarification("선택한 광고상품에서는 해당 항목을 조회할 수 없습니다. 캠페인 또는 지원하는 하위 항목을 지정해 주세요.");
}

/** A selected scope constrains a request; it must never silently drop an explicit part. */
export function resolveQueryScope(request: { entity?: string; platforms: readonly string[]; products?: readonly string[] }, selected: Scope): Scope {
  if (selected.platforms?.length && request.platforms.some(platform => !selected.platforms!.includes(platform)))
    throw new Clarification("질문의 플랫폼과 선택한 플랫폼이 다릅니다. 요청한 모든 플랫폼을 선택해 주세요.");
  if (selected.products?.length && request.products?.some(product => !selected.products!.includes(product)))
    throw new Clarification("질문의 광고상품과 선택한 광고상품이 다릅니다. 요청한 모든 광고상품을 선택해 주세요.");
  const platforms = request.platforms.length ? [...request.platforms] : selected.platforms;
  const selectedProducts = selected.products?.filter(product => !platforms?.length || platforms.includes(product.split(":")[0]));
  if (selected.products?.length && !selectedProducts?.length)
    throw new Clarification("질문의 플랫폼과 선택한 광고상품이 다릅니다. 같은 매체의 광고상품을 선택해 주세요.");
  const products = request.products?.length ? [...request.products] : selectedProducts;
  if (request.entity) assertEntityCapabilities(request.entity, platforms ?? [], products ?? []);
  return { ...selected, ...(platforms ? { platforms } : {}), ...(products ? { products } : {}) };
}
type ScopeSpan = { start: number; end: number; negative: boolean; exclusion_end: number; name_field?: boolean };
function entityScopeMentions(objectText: string) {
  const mentions: (ScopeSpan & { entity: QueryPlan["entity"] })[] = [];
  for (const [entity, pattern] of entityPatterns) for (const match of objectText.matchAll(new RegExp(pattern, "giu"))) {
    const end = match.index! + match[0].length, exclusion = excluded.exec(objectText.slice(end));
    mentions.push({ entity, start: match.index!, end, negative: !!exclusion, exclusion_end: end + (exclusion?.[0].length ?? 0), name_field: /(?:명|이름|명칭)$/u.test(match[0]) });
  }
  return coordinatedAdExclusions(ownedAdSpans(mentions), objectText);
}
function scopeSpans(mentions: ScopeSpan[], text: string): [number, number][] {
  const spans: [number, number][] = mentions.filter(mention => !mention.name_field).map(mention => [mention.start, mention.exclusion_end]);
  for (let i = 1; i < mentions.length; i++) {
    if (!mentions[i - 1].name_field && !mentions[i].name_field && coordination.test(text.slice(mentions[i - 1].end, mentions[i].start)))
      spans.push([mentions[i - 1].end, mentions[i].start]);
  }
  return spans;
}
const scopeBoundary = "(?=$|[\\s,.;?!]|캠페인|광고|소재|키워드|애셋|에셋)";
const vendorCarrier = new RegExp(`^\\s*(?:쪽(?:의|에서|은|는)?|기준(?:으로|에서)?|에서는|에는|에서도|에도|에서|에|의|은|는|으로요|로요|으로|로)${scopeBoundary}`, "u");
const complementCarrier = new RegExp(`^\\s*나머지\\s*(?:매체|플랫폼)(?:의|에서|를|만)?${scopeBoundary}`, "u");
const platformCountCarrier = new RegExp(`^\\s*(\\d+|두|둘|세|셋|네|넷|다섯)\\s*(?:개\\s*)?(?:매체|플랫폼)(?:의|에서|를|만)?${scopeBoundary}`, "u");
const productCarrier = /^\s*(?:상품(?:(?:으로|로)\s*(?:등록된|설정된)|(?:에|에서)\s*(?:등록된|속한|있는)|의)|(?:으로|로)\s*(?:운영하는|등록한|등록된|설정한|설정된)|(?:에|에서)\s*(?:등록한|등록된|속한|있는))(?=$|\s|캠페인|광고|소재|키워드|애셋|에셋)/u;
const referenceObject = "(?:캠페인|광고\\s*(?:그룹|세트)|(?:애셋|에셋)\\s*그룹|소재|키워드|광고)(?:들)?";
const resultNoun = `(?:(?:빈\\s*)?(?:(?:검색|조회)\\s*)?(?:${referenceObject}\\s*)?(?:(?:검색|조회)\\s*)?(?:결과|목록|리스트)|것들?|항목들?)`;
const referenceTail = "(?=$|[\\s,.;?!]|의|중|에(?:서|는)?(?=\\s|$|하위|아래|밑|캠페인|광고|소재|키워드|애셋|에셋)|은|는|을|를|만|도|하위|아래|밑|캠페인|광고|소재|키워드|애셋|에셋)";
const priorTime = "(?:방금|아까|앞서|앞선|(?:이전|직전)(?:에|의)?)";
const retrieval = "(?:찾(?:은|았던)|검색(?:한|했던)|조회(?:한|했던)|나온|확인(?:한|했던)|추린|보여\\s*준)";
const childObject = `${referenceObject}(?=$|[\\s,.;?!]|은|는|이|가|을|를|의|에서|에|만|중|명)`;
const childRole = `(?:하위|아래|밑)(?:\\s*범위)?(?:의|에서|에|만)?(?:\\s*(?:있는|속한|연결된|등록된|확인할\\s*수\\s*있는))?(?=\\s*(?:${childObject}|목록|리스트|대상|항목|경우|것|보여|찾아|조회|알려|$))`;
const referencePattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:그\\s*중|이\\s*중|${priorTime}\\s*${retrieval}(?:\\s*(?:${resultNoun}|${referenceObject}))?${referenceTail}|${priorTime}\\s*${resultNoun}${referenceTail}|${priorTime}\\s*${referenceObject}(?=\\s*(?:의\\s*)?${childRole})|여기서|(?:이|그|해당)\\s*(?:${resultNoun}|${referenceObject})${referenceTail})`, "gu");
const directChildRole = `(?:에|에서)\\s*(?:속한|연결된|포함된)(?=\\s*${childObject})`;
const childReferenceRole = new RegExp(`^\\s*(?:(?:(?:의|에서|에는|에|중에서|중)\\s*)?(?:${referenceObject}(?:의|에서|에)?\\s*)?${childRole}|${directChildRole})`, "u");
const childPrefixRole = new RegExp(`^\\s*(?:(?:의|에서|에는|에|중에서|중)\\s*)?(?:${referenceObject}(?:의|에서|에)?\\s*)?(?:하위|아래|밑)(?:\\s*범위)?(?:의|에서|에|만)?(?:\\s*(?:있는|속한|연결된|등록된))?(?=\\s+(?:일\\s*예산|총\\s*예산|종료\\s*(?:일|날짜)|상태|이름|명칭|생성일|ID\\b|아이디))`, "iu");
const freshSearchRole = /^\s*(?:(?:의\s*)?범위(?:를|는)?\s*적용하지\s*않고\s*(?:새롭게|새로|처음부터)\s*(?:(?:조회|검색)(?:해서|하여)?|찾)|(?:와|과)\s*관계없이\s*(?:새롭게|새로|처음부터)\s*(?:(?:조회|검색)(?:해서|하여)?|찾)|에\s*제한하지\s*않고\s*(?:확인|조회|검색)(?:해서|하여)?|(?:를|을|는|은)\s*사용하지\s*않고\s*(?:새롭게|새로|처음부터)\s*(?:(?:조회|검색)(?:해서|하여)?|찾))/u;
const freshSearchReference = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${priorTime}|기존|이|그|해당)\\s*${resultNoun}`, "gu");
const selectedScopePattern = /(?<![\p{L}\p{N}_])(?:(?:현재|화면(?:에서|의)?)(?:\s*현재)?\s*)?선택(?:한|된)\s*(?:조회\s*)?범위(?:를|는)?\s*적용(?:하여|해서|해)(?=$|[\s,.;?!])/gu;

export type QueryScopeRole = { kind: "entity" | "scope" | "reference" | "relation"; span: [number, number]; text: string; entity?: QueryPlan["entity"] };
const hierarchy = /^\s*(?:들\s*)?(?:(?:(?:검색|조회)\s*)?(?:결과|목록|리스트)\s*)?(?:(?:의|에|에서)\s*)?(?:(?:하위|아래|밑)(?:의|에서|에)?(?:\s*(?:속한|있는|연결된|등록된))?|속한)\s*/u;

/** Closed object relations stay distinct from budget ranking even when another scope obligation needs clarification. */
export function queryClosedHierarchyRoles(text: string): QueryScopeRole[] {
  const clean = queryScopeText(text), objectText = stripAdProductMentions(clean, adProductSpans(text));
  const objects = entityScopeMentions(objectText).filter(mention => !mention.negative);
  return objects.slice(1).flatMap((child, index) => {
    const parent = objects[index], bridge = clean.slice(parent.end, child.start), relation = hierarchy.exec(bridge);
    if (parent.name_field || child.name_field || !descendantType(parent.entity, child.entity) ||
        !relation || relation[0].length !== bridge.length || /[.;?!\n]/u.test(bridge) || bridge !== text.slice(parent.end, child.start)) return [];
    return [{ kind: "relation", span: [parent.end, child.start], text: text.slice(parent.end, child.start) }];
  });
}

export function queryScopeEvidence(text: string, contextEntity?: string) {
  const clean = queryScopeText(text);
  const conditionMarker = /일\s*예산|하루\s*예산|총\s*예산|전체\s*예산|예산|종료\s*(?:일|날짜)|상태|이름|명칭|생성(?:일|\s*날짜)?|만든|\bID\b|아이디/iu;
  const displayOnly = /^(?:도|을|를)?\s*(?:(?:함께|같이)\s*)?(?:보여|표시|알려|출력)/u;
  const accountFields = clean.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])(?:광고\\s*)?계정(?:의)?\\s*(?:${conditionMarker.source})`, "giu"));
  for (const field of accountFields) {
    if (!displayOnly.test(clean.slice(field.index + field[0].length).trimStart()))
      throw new Clarification("계정 필드의 조건을 광고 항목의 조건으로 바꿀 수 없습니다. 조회할 계정은 화면에서 선택해 주세요.");
  }
  if (/제외하지|빼지|아니지/u.test(clean)) throw new Clarification("제외하지 않을 범위를 긍정 표현으로 다시 지정해 주세요.");
  const mentions = adVendorSpans(text);
  const positive = new Set(mentions.filter(m => !m.negative).map(m => m.platform));
  const negative = new Set(mentions.filter(m => m.negative).map(m => m.platform));
  if ([...positive].some(p => negative.has(p))) throw new Clarification("같은 매체의 포함과 제외가 함께 지정되었습니다.");
  const requested = positive.size ? [...positive] : negative.size ? PLATFORMS.filter(p => !negative.has(p)) : [];
  if (negative.size && !requested.length) throw new Clarification("조회할 매체가 남아 있지 않습니다. 포함할 매체를 지정해 주세요.");
  let products: string[];
  try { products = literalProducts(text, requested); }
  catch (error) { throw new Clarification((error as ProductScopeError).message); }
  const platforms = (requested.length ? requested : [...new Set(products.map(p => p.split(":")[0]))]) as QueryPlan["platforms"];
  const productsFound = adProductSpans(text);
  const genericAdvertisingSpans: [number, number][] = [];
  const objectText = stripAdProductMentions(clean, productsFound).replace(/광고의\s*(?=캠페인|광고\s*(?:그룹|세트|셋)|소재|키워드|(?:애셋|에셋)\s*그룹)/gu, (match, offset: number) => {
    if (!mentions.some(vendor => !vendor.negative && vendor.end <= offset && /^\s*(?:의\s*)?$/u.test(clean.slice(vendor.end, offset)))) return match;
    genericAdvertisingSpans.push([offset, offset + match.length]);
    return " ".repeat(match.length);
  });
  // Owned scope words may occur inside a reference bridge; unknown words and conditions stay visible.
  const relationCharacters = text.split("");
  for (const [start, end] of genericAdvertisingSpans) relationCharacters.fill(" ", start, end);
  for (const mention of mentions) {
    relationCharacters.fill(" ", mention.start, mention.exclusion_end);
    const carrier = (mention.negative ? complementCarrier : vendorCarrier).exec(text.slice(mention.exclusion_end));
    if (carrier) relationCharacters.fill(" ", mention.exclusion_end, mention.exclusion_end + carrier[0].length);
  }
  for (const { start, end } of productsFound) {
    relationCharacters.fill(" ", start, end);
    const carrier = productCarrier.exec(text.slice(end));
    if (carrier) relationCharacters.fill(" ", end, end + carrier[0].length);
  }
  const relationText = relationCharacters.join("");
  // Scope bridges may be skipped, but protected name text must never introduce a reference.
  const referenceMatches = (pattern: RegExp) => [...relationText.matchAll(pattern)].filter(match =>
    clean.slice(match.index, match.index + match[0].length) === text.slice(match.index, match.index + match[0].length));
  const objects = entityScopeMentions(objectText);
  const matches = objects.filter(mention => !mention.negative);
  const entities = [...new Set(matches.map(m => m.entity))];
  const relationSpans: [number, number][] = [];
  if (entities.length > 1) {
    const descending = entities.every((e,i) => i === 0 || descendantType(entities[i-1], e));
    const bridges = matches.slice(1).map((mention, index) => ({ start: matches[index].end, end: mention.start,
      text: relationText.slice(matches[index].end, mention.start) }));
    if (matches.slice(0, -1).some(mention => mention.name_field) || bridges.some(bridge => {
      const condition = conditionMarker.exec(bridge.text);
      return condition && !hierarchy.test(bridge.text.slice(0, condition.index));
    }))
      throw new Clarification("상위 항목의 조건을 하위 항목의 조건으로 바꿀 수 없습니다. 상위 항목을 먼저 검색한 뒤 하위 항목을 조회해 주세요.");
    if (!descending || bridges.some(bridge => /(?:^|\s)(?:와|과|및|하고|이나|또는|혹은|상위|부모)(?=$|\s)|,/u.test(bridge.text.replace(/^\s*들/u, ""))) ||
        bridges.some(bridge => /[.;?!\n]/u.test(bridge.text)) ||
        bridges.some(bridge => /속한/u.test(bridge.text) && !hierarchy.test(bridge.text)))
      throw new Clarification("조회할 대상 종류를 하나만 지정해 주세요.");
    for (const bridge of bridges) {
      const relation = hierarchy.exec(bridge.text);
      if (relation) relationSpans.push([bridge.start, bridge.start + relation[0].length]);
    }
  }
  const entity = entities.at(-1);
  const freshSearchSpans: [number, number][] = [];
  const newSearchDeclarations = [...clean.matchAll(/(?<![\p{L}\p{N}_])(?:새(?:로운)?\s*(?:검색|조회)(?:으로|로))(?=$|[\s,.;?!])/gu)];
  freshSearchSpans.push(...newSearchDeclarations.map(match => [match.index, match.index + match[0].length] as [number, number]));
  for (const match of referenceMatches(freshSearchReference)) {
    const reset = freshSearchRole.exec(clean.slice(match.index + match[0].length));
    if (reset) freshSearchSpans.push([match.index, match.index + match[0].length + reset[0].length]);
  }
  const referenceMentions = referenceMatches(referencePattern)
    .filter(match => !freshSearchSpans.some(([start, end]) => start <= match.index && end >= match.index + match[0].length));
  const temporalReference = referenceMentions.some(match => new RegExp(`^${priorTime}`, "u").test(match[0]));
  // A list introduced by this question's own object and condition is a local referent.
  // Earlier references and any proved temporal reference retain the previous-result obligation.
  const references = referenceMentions.filter(match => !(/^(?:해당\s*목록|그\s*항목)$/u.test(match[0]) && !temporalReference &&
    !excluded.test(clean.slice(match.index + match[0].length)) && !referenceMentions.some(other => other.index < match.index) &&
    matches.some(object => !object.name_field && object.end < match.index && conditionMarker.test(clean.slice(object.end, match.index)))));
  if (newSearchDeclarations.length && references.length)
    throw new Clarification("새 검색과 이전 결과 참조를 함께 적용할 수 없습니다. 조회 범위를 하나로 지정해 주세요.");
  if (references.some(match => excluded.test(clean.slice(match.index + match[0].length))))
    throw new Clarification("이전 결과를 이어서 볼지 새로 조회할지 명확히 지정해 주세요.");
  const membershipSpans: [number, number][] = [];
  const childSpans = references.flatMap(match => {
    const start = match.index + match[0].length, role = childReferenceRole.exec(relationText.slice(start)) ?? childPrefixRole.exec(relationText.slice(start));
    const member = /^\s*(?:에\s*한해서|에\s*한해|안(?:에서|에\s*있는|의)|에\s*있는|에\s*속한)(?=$|\s)/u.exec(relationText.slice(start));
    if (member) membershipSpans.push([start, start + member[0].length]);
    if (contextEntity && entity && member) {
      if (entity === contextEntity) return [];
      if (!descendantType(contextEntity, entity) || !/있는|속한/u.test(member[0]))
        throw new Clarification("이전 결과와 다른 종류의 대상을 조회하려면 하위 관계를 명확히 지정해 주세요.");
      return [[start, start + member[0].length] as [number, number]];
    }
    return role ? [[start, start + role[0].length] as [number, number]] : [];
  });
  const reference = references.length ? (childSpans.length ? "children" as const : "previous" as const) : undefined;
  const referenceClaims = references.map(match => {
    const end = match.index + match[0].length;
    const inside = matches.find(mention => mention.start >= match.index && mention.end <= end);
    const following = matches.find(mention => mention.start >= end);
    const owner = inside ?? (new RegExp(`^${priorTime}`, "u").test(match[0]) && following && !relationText.slice(end, following.start).trim() ? following : undefined);
    return { span: [match.index, owner ? Math.max(end, owner.end) : end] as [number, number], ...(owner ? { entity: owner.entity } : {}) };
  });
  const claimedEntities = [...new Set(referenceClaims.flatMap(claim => claim.entity ? [claim.entity] : []))];
  if (claimedEntities.length > 1 || (contextEntity && claimedEntities.some(claim => claim !== contextEntity)))
    throw new Clarification("질문에 명시한 이전 대상과 현재 결과의 대상 종류가 다릅니다. 이전 결과를 다시 검색해 주세요.");
  if (reference === "previous" && contextEntity && entity && contextEntity !== entity)
    throw new Clarification("이전 결과와 다른 종류의 대상을 조회하려면 하위 관계를 명확히 지정해 주세요.");
  if (reference === "children" && contextEntity && entity && !descendantType(contextEntity, entity))
    throw new Clarification("이전 결과 아래에서 조회할 수 있는 하위 대상을 지정해 주세요.");
  if (reference === "children" && references.some(match => conditionMarker.test(clean.slice(0, match.index))))
    throw new Clarification("이전 결과 앞의 조건은 상위 항목을 수식할 수 있습니다. 하위 관계를 먼저 지정한 뒤 하위 항목의 조건을 알려주세요.");
  const selectedScopeSpans: [number, number][] = [...clean.matchAll(selectedScopePattern)].map(match => [match.index, match.index + match[0].length]);
  const spans: [number, number][] = [...scopeSpans(mentions, clean), ...scopeSpans(objects, objectText), ...genericAdvertisingSpans, ...relationSpans, ...childSpans, ...membershipSpans, ...freshSearchSpans, ...selectedScopeSpans,
    ...referenceMentions.map(match => [match.index, match.index + match[0].length] as [number, number])];
  for (const mention of mentions) {
    const carrier = (mention.negative ? complementCarrier : vendorCarrier).exec(text.slice(mention.exclusion_end));
    if (carrier) spans.push([mention.exclusion_end, mention.exclusion_end + carrier[0].length]);
    if (reference && !mention.negative) {
      const narrowing = /^\s*(?:으로|로)\s*(?:범위(?:를)?\s*)?(?:좁혀|한정해)(?:서)?(?=$|[\s,.;?!])/u.exec(clean.slice(mention.end));
      if (narrowing) spans.push([mention.end, mention.end + narrowing[0].length]);
    }
  }
  if (reference) for (const target of matches.filter(mention => !mention.name_field)) {
    const owner = mentions.some(vendor => !vendor.negative && vendor.end <= target.start && /^\s*(?:의|에서)?\s*$/u.test(clean.slice(vendor.end, target.start)));
    const restriction = owner && /^\s*(?:으로|로)\s*한정해(?:서)?(?=$|[\s,.;?!])/u.exec(clean.slice(target.end));
    if (restriction) spans.push([target.end, target.end + restriction[0].length]);
  }
  const introduction = queryIntroduction.exec(text);
  if (introduction) spans.push([introduction.index, introduction.index + introduction[0].length]);
  const finalVendor = mentions.at(-1);
  if (finalVendor && !finalVendor.negative) {
    const descriptor = platformCountCarrier.exec(text.slice(finalVendor.end));
    if (descriptor) {
      const counts: Record<string, number> = { 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5 };
      if ((counts[descriptor[1]] ?? Number(descriptor[1])) !== positive.size)
        throw new Clarification("지정한 매체 수와 포함할 매체 목록을 확인해 주세요.");
      spans.push([finalVendor.end, finalVendor.end + descriptor[0].length]);
    }
  }
  if (!mentions.length) for (const allScope of clean.matchAll(/(?<![\p{L}\p{N}_])(?:(?:연결(?:해\s*둔|된|한)|연동된)\s*(?:(?:매체|플랫폼)\s*(?:전체|전부)|(?:(?:모든|전체)\s*)?(?:매체|플랫폼))|(?:(?:모든|전체)\s*)?(?:매체|플랫폼))(?:에서|의|를|만)?(?=$|\s|캠페인|광고|소재|키워드|애셋|에셋)/gu))
    spans.push([allScope.index, allScope.index + allScope[0].length]);
  // Product words inside names are values; only unquoted, scope-proven product positions are consumed.
  const productSpans: [number, number][] = productsFound.map(({ start, end }) => [start, end]);
  spans.push(...productSpans);
  if (products.length) for (const restatement of clean.matchAll(/(?<![\p{L}\p{N}_])(?:선택한\s*상품에\s*해당하는|그\s*상품\s*종류에\s*속하는|해당\s*광고상품으로\s*운영하는)(?=$|\s|캠페인|광고|소재|키워드|애셋|에셋)/gu))
    spans.push([restatement.index, restatement.index + restatement[0].length]);
  // Registration/membership wording belongs to a product only when directly attached to its proved span.
  for (const [, end] of productSpans) {
    const carrier = productCarrier.exec(text.slice(end));
    if (carrier) spans.push([end, end + carrier[0].length]);
  }
  const targets = matches.filter(mention => !mention.name_field).map(({ start, end, entity }) => ({ start, end, entity }));
  const characters = text.split("");
  for (const [start, end] of spans) characters.fill(" ", start, end);
  const declarations = consumeQueryDeclarations(text, characters.join(""), targets);
  if (declarations.clauses.some(clause => targets.filter(target => target.start >= clause.span[0] && target.end <= clause.span[1]).at(-1)!.entity !== entity))
    throw new Clarification("선언한 조회 대상과 실제 조회 대상이 다릅니다. 대상 종류를 하나로 지정해 주세요.");
  const prefixRemainder = (end: number) => carrierResidual(declarations.text.slice(0, end));
  if (entities.length > 1 && matches.slice(0, -1).some(parent => prefixRemainder(parent.start)))
    throw new Clarification("상위 항목의 조건을 하위 항목의 조건으로 바꿀 수 없습니다. 상위 항목을 먼저 검색한 뒤 하위 항목을 조회해 주세요.");
  for (const account of objectText.matchAll(/(?<![\p{L}\p{N}_])(?:광고\s*)?계정(?=$|\s|의|에|명)/gu)) {
    if ((!matches.length || account.index < matches[0].start) && prefixRemainder(account.index))
      throw new Clarification("계정 필드의 조건을 광고 항목의 조건으로 바꿀 수 없습니다. 조회할 계정은 화면에서 선택해 주세요.");
  }
  const roles: QueryScopeRole[] = [
    ...mentions.map((mention): QueryScopeRole => ({ kind: "scope", span: [mention.start, mention.exclusion_end], text: text.slice(mention.start, mention.exclusion_end) })),
    ...productSpans.map((span): QueryScopeRole => ({ kind: "scope", span, text: text.slice(...span) })),
    ...selectedScopeSpans.map((span): QueryScopeRole => ({ kind: "scope", span, text: text.slice(...span) })),
    ...matches.map((mention): QueryScopeRole => ({ kind: "entity", entity: mention.entity, span: [mention.start, mention.end], text: text.slice(mention.start, mention.end) })),
    ...referenceClaims.map((claim): QueryScopeRole => ({ kind: "reference", ...claim, text: text.slice(...claim.span) })),
    ...[...relationSpans, ...childSpans].map((span): QueryScopeRole => ({ kind: "relation", span, text: text.slice(...span) })),
  ];
  return { scope: { ...(entity ? { entity } : {}), platforms, ...(reference ? { reference } : {}) }, spans, targets,
    roles: [...new Map(roles.map(role => [`${role.kind}:${role.span.join(":")}`, role])).values()],
    residual: declarations.text, clauses: declarations.clauses, ...(claimedEntities.length ? { reference_entity: claimedEntities[0] } : {}) };
}

export function queryLiteralScope(text: string, contextEntity?: string) {
  return queryScopeEvidence(text, contextEntity).scope;
}

/** Remove only scope spans proved by the same interpretation used by queryLiteralScope. */
export function queryRequestEvidence(text: string, contextEntity?: string) {
  const { residual, clauses } = queryScopeEvidence(text, contextEntity);
  return { residual, clauses };
}

export function queryRequestRemainder(text: string): string {
  return queryRequestEvidence(text).residual;
}

/** An exact complete list/count command has no unresolved predicate for a model to decide. */
export function literalListOperation(text: string): "find" | "count" | undefined {
  if (unquotedAdText(text).trim() !== text.trim() || /말고|제외|빼고|아닌|그중|이중|하위|이전|방금|(?<![\p{L}])(?:이|해당)\s*캠페인/u.test(text)) return;
  return queryCarrierOperation(queryRequestRemainder(text));
}
