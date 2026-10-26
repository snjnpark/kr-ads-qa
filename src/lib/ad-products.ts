export const AD_PRODUCTS: Record<string, Record<string, string>> = {
  naver: { WEB_SITE: "파워링크", SHOPPING: "쇼핑검색", POWER_CONTENTS: "파워컨텐츠", BRAND_SEARCH: "브랜드검색", PLACE: "플레이스" },
  kakao: { TALK_BIZ_BOARD: "비즈보드", DISPLAY: "디스플레이", VIDEO: "동영상", TALK_CHANNEL: "모먼트 채널·메시지", PERSONAL_MESSAGE: "개인화 메시지" },
  kakao_keyword: { PREMIUM_LINK: "프리미엄링크" },
  google: { SEARCH: "검색", DISPLAY: "디스플레이", VIDEO: "동영상", SHOPPING: "쇼핑", MULTI_CHANNEL: "앱", DEMAND_GEN: "Demand Gen", PERFORMANCE_MAX: "PMax", HOTEL: "호텔", TRAVEL: "여행", LOCAL_SERVICES: "지역 서비스", SMART: "스마트", LOCAL: "기존 로컬" },
};
export function productLabel(platform: string, value: unknown): string {
  return typeof value === "string" && value ? AD_PRODUCTS[platform]?.[value] ?? value : "상품 미조회";
}
export function productCode(entity: { extensions?: Record<string, unknown> }): string | null {
  const value = entity.extensions?.product_type ?? entity.extensions?.campaign_type;
  return typeof value === "string" && value ? value : null;
}
export function productKey(entity: { platform: string; extensions?: Record<string, unknown> }): string | null {
  const code = productCode(entity);
  return code ? `${entity.platform}:${code}` : null;
}
export class ProductScopeError extends Error {}

// Preserve offsets so every literal reader sees the same non-name text.
export function unquotedAdText(text: string): string {
  return text.replace(/"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|`[^`]*`/gu, value => " ".repeat(value.length));
}
// Unquoted name operands are values too; their words must not select scope or capabilities.
const nameMarker = "(?:(?:캠페인|광고(?:\\s*(?:그룹|세트))?|(?:애셋|에셋)\\s*그룹|키워드|소재)\\s*(?:이름|명칭)|캠페인명|광고(?:\\s*(?:그룹|세트))?명|(?:애셋|에셋)\\s*그룹명|키워드명|소재명|그룹명|세트명|이름|명칭)";
const unquotedNamePredicate = new RegExp(`(${nameMarker}(?:에|에서)?\\s+)[^\\s,;\\x22\\x27\\x60“”‘’]{1,64}(?:\\s+[^\\s,;\\x22\\x27\\x60“”‘’]{1,64}){0,3}?\\s*(?:가|이|을|를)?\\s*(?:포함|들어|제외|빠진|뺀|없|있)[가-힣]*`, "gu");
const unquotedExactName = new RegExp(`(${nameMarker}(?:이|가)\\s+)[^\\s,;\\x22\\x27\\x60“”‘’]{1,64}?(?:인|와\\s*같은|과\\s*같은)(?=\\s|$)`, "gu");
export const precedingQuotedName = /(?:"[^"]+"|'[^']+'|“[^”]+”|‘[^’]+’|`[^`]+`)(?:\s*(?:이라는|라는)\s*(?:문구|말|글자|단어|문자열))?(?:이|가|을|를|와|과)?\s*$/u;
export const queryIntroduction = /^\s*(?:인수인계(?:를)?\s*받는\s*담당자(?:야|입니다)[.!?]?|검수\s*담당자(?:라|인데)|보고서에\s*쓸|다음\s*담당자에게\s*줄|담당\s*캠페인을\s*점검하려고요[.!?])(?=\s|$)/u;
export function queryScopeText(text: string): string {
  // Keep the complete marker for object ownership and unresolved field detection; mask only its value clause.
  const maskValue = (match: string, marker: string, offset: number, source: string) => precedingQuotedName.test(source.slice(0, offset))
    ? match : marker + " ".repeat(match.length - marker.length);
  return unquotedAdText(text
    .replace(unquotedNamePredicate, maskValue)
    .replace(unquotedExactName, maskValue)).replace(queryIntroduction,
      value => " ".repeat(value.length));
}
export function performanceMetricText(text: string): string {
  return queryScopeText(text).replace(/실적\s*최대화/giu, " ");
}

export const AD_SCOPE_EXCLUSION = /^(?:의|은|는|이|가|을|를|만)?\s*(?:제외(?:하고|한|해)?|빼고|말고|대신|아닌|아니라|아니고|외의)/u;
export const AD_SCOPE_COORDINATION = /^(?:\s*(?:와|과|및|,|·|\/|&|랑|하고|그리고|또는|혹은|이나|나|\bAND\b|\bOR\b)\s*)+$/iu;
export function ownedAdSpans<T extends { start: number; end: number }>(mentions: T[]): T[] {
  return mentions.filter(mention => !mentions.some(other => other.start <= mention.start && other.end >= mention.end && other.end - other.start > mention.end - mention.start))
    .sort((left, right) => left.start - right.start || right.end - left.end);
}
export function coordinatedAdExclusions<T extends { start: number; end: number; negative: boolean }>(mentions: T[], text: string): T[] {
  for (let i = 0; i < mentions.length; i++) if (mentions[i].negative) {
    for (let j = i - 1; j >= 0 && AD_SCOPE_COORDINATION.test(text.slice(mentions[j].end, mentions[j + 1].start)); j--) mentions[j].negative = true;
  }
  return mentions;
}
const vendorAliases: Record<string, string> = {
  meta: "메타|메따|매타|페이스북|인스타그램|meta|facebook|instagram",
  naver: "네이\\s*버|naver", kakao: "카카오(?:\\s*모먼트)?|모먼트|kakao(?:\\s*moment)?|moment",
  google: "구글|google", kakao_keyword: "카카오\\s*(?:키워드(?:검색)?\\s*광고|검색광고|프리미엄\\s*링크)|프리미엄\\s*링크|kakao_keyword",
};
const vendorSuffix = "(?=$|[\\s,:/·]|에서|에|의|와|과|랑|나|하고|는|은|가|이|를|을|만|도|로|쪽|기준|말고|빼고|제외|광고|캠페인)";
const vendorPatterns = Object.entries(vendorAliases).map(([platform, aliases]) => [platform, new RegExp(`(?<![\\p{L}\\p{N}_])(?:${aliases})${vendorSuffix}`, "giu")] as const);
/** Canonical vendor ownership, boundaries and exclusions for both product and query scope. */
export function adVendorSpans(text: string) {
  const clean = queryScopeText(text);
  const mentions = vendorPatterns.flatMap(([platform, pattern]) => [...clean.matchAll(pattern)].map(match => {
    const end = match.index + match[0].length, exclusion = AD_SCOPE_EXCLUSION.exec(clean.slice(end));
    return { platform, start: match.index, end, negative: !!exclusion, exclusion_end: end + (exclusion?.[0].length ?? 0) };
  }));
  return coordinatedAdExclusions(ownedAdSpans(mentions), clean);
}

const productMentions: [string, RegExp][] = [
  ["naver:WEB_SITE", /파워\s*링크|\bpower\s*link\b/iu],
  ["naver:POWER_CONTENTS", /파워\s*(?:[컨콘]텐츠|컨테츠)|\bpower\s*contents?\b/iu],
  ["naver:BRAND_SEARCH", /브랜드\s*검색|신제품\s*검색/iu],
  ["naver:PLACE", /플레이스/iu],
  ["kakao_keyword:PREMIUM_LINK", /프리미엄\s*링크|카카오\s*(?:키워드(?:검색)?\s*광고|검색광고)|\bkakao_keyword\b/iu],
  ["google:PERFORMANCE_MAX", /\bPMax\b|\bPerformance\s*Max\b|실적\s*최대화/iu],
  ["google:DEMAND_GEN", /\bDemand\s*Gen\b|디맨드\s*젠/iu],
  ["naver:SHOPPING", /쇼핑(?:\s*검색)?|\bshopping\b/iu],
  ["google:SHOPPING", /쇼핑(?:\s*검색)?|\bshopping\b/iu],
  ["kakao:TALK_BIZ_BOARD", /비즈\s*보드|\bbiz\s*board\b/iu],
  ["kakao:DISPLAY", /디스플레이|\bdisplay\b/iu],
  ["kakao:VIDEO", /동영상|비디오|\bvideo\b/iu],
  ["kakao:TALK_CHANNEL", /모먼트\s*채널(?:\s*[·ㆍ/&]\s*메시지)?|톡\s*채널|채널\s*[·ㆍ/&]\s*메시지|(?:채널|메시지)(?=\s*(?:광고|캠페인))/iu],
  ["kakao:PERSONAL_MESSAGE", /개인화\s*메시지/iu],
  ["google:SEARCH", /구글(?:의|에서)?\s*검색|검색(?=\s*(?:광고|캠페인))|\bsearch\b/iu],
  ["google:DISPLAY", /디스플레이|\bdisplay\b/iu],
  ["google:VIDEO", /동영상|비디오|유튜브|\bvideo\b/iu],
  ["google:MULTI_CHANNEL", /앱|\bapp\b/iu],
  ["google:HOTEL", /호텔|\bhotel\b/iu],
  ["google:TRAVEL", /여행|\btravel\b/iu],
  ["google:SMART", /스마트|\bsmart\b/iu],
  ["google:LOCAL_SERVICES", /지역\s*서비스|\blocal\s*services\b/iu],
  ["google:LOCAL", /(?:기존\s*)?로컬|\blocal\b/iu],
];
const productPattern = (pattern: RegExp) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern.source})(?=$|[^\\p{L}\\p{N}_]|에서|에|으로|로|의|은|는|이|가|을|를|만|도|와|과|랑|하고|이나|광고|캠페인|키워드|소재|그룹|세트)`, "giu");
export function adProductSpans(text: string) {
  const clean = queryScopeText(text);
  const mentions = productMentions.flatMap(([key, pattern]) => [...clean.matchAll(productPattern(pattern))].map(match => ({ key, start: match.index, end: match.index + match[0].length })));
  // A complete product name owns overlapping generic words in both scope and request parsing.
  return ownedAdSpans(mentions);
}
export function stripAdProductMentions(text: string, spans = adProductSpans(text)): string {
  const characters = text.split("");
  for (const { start, end } of spans) characters.fill(" ", start, end);
  return characters.join("");
}
export function literalProducts(text: string, platforms: readonly string[]): string[] {
  const clean = queryScopeText(text);
  const vendors = adVendorSpans(text).filter(vendor => !vendor.negative);
  const longest = adProductSpans(text);
  const found = new Set<string>();
  const resolved = new Map<string, { owners: string[]; selected: string[] }>();
  for (const mention of longest) {
    if (/^(?:은|는|이|가|을|를|만)?\s*(?:(?:광고|캠페인)(?:은|는|이|가|을|를|만)?\s*)?(?:제외|빼고|빼줘|말고|아닌|아니라|아니고)/u.test(clean.slice(mention.end)) || /(?:제외한|제외할|아닌)\s*$/u.test(clean.slice(0, mention.start)))
      throw new ProductScopeError("상품을 제외하는 범위는 지원하지 않습니다. 조회할 광고상품만 지정해 주세요.");
    let vendorIndex = vendors.findLastIndex(vendor => vendor.start <= mention.start);
    const owners: string[] = [];
    if (vendorIndex >= 0) {
      owners.push(vendors[vendorIndex].platform);
      while (vendorIndex > 0 && !longest.some(other => other.start === vendors[vendorIndex - 1].start && other.end === vendors[vendorIndex - 1].end) && AD_SCOPE_COORDINATION.test(clean.slice(vendors[vendorIndex - 1].end, vendors[vendorIndex].start))) {
        vendorIndex--;
        owners.push(vendors[vendorIndex].platform);
      }
    }
    const platform = mention.key.split(":")[0];
    const scope = `${mention.start}:${mention.end}`;
    const resolvedScope = resolved.get(scope) ?? { owners, selected: [] };
    resolved.set(scope, resolvedScope);
    if ((!owners.length || owners.includes(platform)) && (!platforms.length || platforms.includes(platform))) {
      found.add(mention.key);
      resolvedScope.selected.push(platform);
    }
  }
  // A recognized but incompatible product must never turn into an unrestricted query.
  if ([...resolved.values()].some(scope => !scope.selected.length || scope.owners.some(owner => !scope.selected.includes(owner))) ||
      (found.size && vendors.some(vendor => ![...found].some(key => key.startsWith(`${vendor.platform}:`)))))
    throw new ProductScopeError("매체와 광고상품이 일치하지 않습니다. 조회할 매체와 상품을 확인해 주세요.");
  return productMentions.map(([key]) => key).filter(key => found.has(key));
}
export function excludedAdProduct(text: string): boolean {
  const clean = queryScopeText(text);
  return /\bGFA\b|성과형\s*디스플레이|톡채널\s*검색|\b(?:DV360|SA360)\b|\bAd\s*Manager\b/iu.test(clean) || (/톡채널\s*광고/iu.test(clean) && !/모먼트|\bmoment\b/iu.test(clean));
}
