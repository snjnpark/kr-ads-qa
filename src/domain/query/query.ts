import Decimal from "decimal.js";
import { DateTime } from "luxon";
import type { Entity, Platform } from "../entities";
import { observe, resolveParent } from "../policies/evaluation";
import { compareValue } from "../policies/values";
import { excludedAdProduct, literalProducts, productKey, queryScopeText } from "../../lib/ad-products";

export class Clarification extends Error {}
export type Filter = { field: string; operator: string; value?: unknown };
export type Query = {
  platforms: Platform[];
  products?: string[];
  entity: string;
  operation: string;
  filters: Filter[];
  logical_operator: "AND" | "OR";
  previous: boolean;
  children: boolean;
  semantic: string | null;
  text: string;
  currency: string | null;
  reference_time: Date;
  date_expression?: string;
};
export type QueryContext = {
  result_keys: string[];
  platforms: Platform[];
  account_ids: string[];
  entity: string;
  has_results: boolean;
  scope?: string;
  data_generation?: string;
};
export const emptyContext = (): QueryContext => ({
  result_keys: [],
  platforms: [],
  account_ids: [],
  entity: "campaign",
  has_results: false,
});
const aliases: Record<Platform, string[]> = {
  meta: ["메타", "메따", "페이스북", "meta"],
  naver: ["네이버", "naver"],
  kakao: ["카카오", "kakao"],
  kakao_keyword: ["카카오 키워드", "카카오키워드", "카카오 검색광고", "프리미엄링크", "kakao_keyword"],
  google: ["구글", "google"],
};
export const ACTIVE = ["ACTIVE", "ENABLED", "ON", "ELIGIBLE", "NORMAL"];
export const INACTIVE = [
  "PAUSED",
  "DISABLED",
  "OFF",
  "REMOVED",
  "DELETED",
  "ARCHIVED",
  "STOPPED",
];
export function parseMoney(text: string) {
  const m = text.match(
    /(?<![\d.])([\d,]+(?:\.\d+)?)\s*(억|천만|백만|십만|만|천)?\s*원?/,
  );
  return m
    ? new Decimal(m[1].replaceAll(",", ""))
        .mul(
          (
            {
              억: 100000000,
              천만: 10000000,
              백만: 1000000,
              십만: 100000,
              만: 10000,
              천: 1000,
            } as Record<string, number>
          )[m[2]] ?? 1,
        )
        .toFixed()
    : null;
}
export function dateRange(
  text: string,
  now = new Date(),
  timezone = "Asia/Seoul",
): [number, number] | null {
  text = queryScopeText(text);
  let start = DateTime.fromJSDate(now, { zone: timezone }).startOf("day"),
    end: DateTime;
  if (!start.isValid) throw new Clarification("계정의 시간대를 확인해 주세요.");
  if (text.includes("그제")) {
    start = start.minus({ days: 2 });
    end = start.plus({ days: 1 });
  } else if (text.includes("어제")) {
    start = start.minus({ days: 1 });
    end = start.plus({ days: 1 });
  } else if (text.includes("오늘")) end = start.plus({ days: 1 });
  else if (/지난\s?주/.test(text)) {
    start = start.startOf("week").minus({ weeks: 1 });
    end = start.plus({ weeks: 1 });
  } else if (/이번\s?주/.test(text)) {
    start = start.startOf("week");
    end = start.plus({ weeks: 1 });
  } else if (/이번\s?달/.test(text)) {
    start = start.startOf("month");
    end = start.plus({ months: 1 });
  } else if (/지난\s?달/.test(text)) {
    start = start.startOf("month").minus({ months: 1 });
    end = start.plus({ months: 1 });
  } else {
    const match = text.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/) ?? text.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
    if (!match) return null;
    start = DateTime.fromObject(
      { year: +match[1], month: +match[2], day: +match[3] },
      { zone: timezone },
    );
    if (!start.isValid) throw new Clarification("날짜를 확인해 주세요.");
    end = start.plus({ days: 1 });
  }
  return [+start, +end];
}
export function parse(
  text: string,
  context?: QueryContext,
  now = new Date(),
  timezone = "Asia/Seoul",
): Query {
  if (!text.trim() || text.length > 2000)
    throw new Clarification("2,000자 이내의 광고 설정 질문을 입력해 주세요.");
  if (excludedAdProduct(text)) throw new Clarification("선택한 광고상품은 연결 범위에 포함되지 않습니다.");
  const q: Query = {
    platforms: [],
    entity: "campaign",
    operation: "find",
    filters: [],
    logical_operator: /또는|혹은/.test(text) ? "OR" : "AND",
    previous: /그\s?중|여기서|이 캠페인|해당|이 광고|이 결과/.test(text),
    children: text.includes("하위"),
    semantic: null,
    text,
    currency: null,
    reference_time: now,
  };
  if (
    /(예산|광고|캠페인|광고그룹).*(변경해|삭제해|꺼줘|켜줘|중지해|수정해)/.test(
      text,
    )
  )
    throw new Clarification("광고 설정 조회와 검수만 지원합니다.");
  for (const [id, names] of Object.entries(aliases))
    if (names.some((name) => text.toLowerCase().includes(name)))
      q.platforms.push(id as Platform);
  if (q.platforms.includes("kakao_keyword") && !/모먼트|moment/iu.test(text)) q.platforms = q.platforms.filter(value => value !== "kakao");
  q.products = literalProducts(text, q.platforms);
  if (!q.platforms.length && q.products.length) q.platforms = [...new Set(q.products.map(value => value.split(":")[0]))] as Platform[];
  if (context?.has_results && text.includes("만 보여") && !q.platforms.length)
    q.previous = true;
  if (q.previous && !context?.has_results)
    throw new Clarification("먼저 광고를 검색한 뒤 결과를 좁혀 주세요.");
  if (q.previous && context) {
    q.entity = context.entity;
    if (!q.platforms.length) q.platforms = context.platforms;
  }
  const kinds: [string, RegExp][] = [
    ["asset_group", /에셋\s?그룹|애셋/],
    ["adgroup", /광고\s?그룹|광고\s?세트/],
    ["keyword", /키워드/],
    ["creative", /소재/],
    ["campaign", /캠페인/],
    ["ad", /광고 중|광고만|생성한 광고/],
  ];
  let explicitKind: string | null = null;
  for (const [kind, pattern] of kinds)
    if (pattern.test(text.replace(/카카오\s*키워드(?:검색)?\s*광고/gu, "카카오상품"))) {
      q.entity = kind;
      explicitKind = kind;
      break;
    }
  if (q.children && (!explicitKind || explicitKind === context?.entity))
    q.entity =
      context?.entity === "adgroup"
        ? "ad"
        : context?.entity === "ad"
          ? "creative"
          : "adgroup";
  if (/앞으로|규칙 추가|규칙 만들어/.test(text)) {
    q.operation = "create_rule";
    return q;
  }
  if (/QA|전체 검수|전체 검사/i.test(text)) {
    q.operation = "audit";
    return q;
  }
  if (/바뀐|변경된|변경점|변경 이력|어제[와랑] 비교|예산이 증가/.test(text)) {
    q.operation = "history";
    return q;
  }
  if (text.includes("정책") && /위반|기준|검사|적용/.test(text)) {
    q.operation = "policy";
    return q;
  }
  if (text.includes("비교")) q.operation = "compare";
  if (/몇\s?개|개수/.test(text)) q.operation = "count";
  if (/비활성|중지된|중지 상태|활성화되지|활성(?:화)?(?:이|가)?\s*아닌/.test(text))
    q.filters.push({ field: "status", operator: "in", value: INACTIVE });
  else if (/활성|운영 중/.test(text))
    q.filters.push({ field: "status", operator: "in", value: ACTIVE });
  if (text.includes("예산")) {
    const field = text.includes("총예산") ? "budget.lifetime" : "budget.daily";
    if (
      /없는|미설정|설정되지|설정 안/.test(text) ||
      /예산(?:이|은|을)?\s*(?:안\s*잡|잡히지\s*않)/.test(text)
    )
      q.filters.push({ field, operator: "is_empty" });
    else if (/이상한|이상인/.test(text) && !/[0-9]/.test(text))
      q.operation = "audit";
    else {
      const value = parseMoney(text.slice(text.indexOf("예산") + 2));
      if (value !== null) {
        q.currency = text.includes("원") ? "KRW" : null;
        const ops: [string, string][] = [
          ["초과", "gt"],
          ["이상", "gte"],
          ["미만", "lt"],
          ["이하", "lte"],
          ["같은", "eq"],
        ];
        const operator = ops.find(([word]) => text.includes(word))?.[1] ??
          (/[\d억만천원]\s*(?:아래|보다\s*(?:적|작))/.test(
            text.slice(text.indexOf("예산") + 2),
          ) ? "lt" : undefined);
        if (!operator)
          throw new Clarification(
            "금액 조건에 초과·이상·미만·이하 중 하나를 지정해 주세요.",
          );
        q.filters.push({ field, operator, value });
      }
    }
  }
  if (text.includes("종료일")) {
    if (/없는|미설정|설정되지/.test(text))
      q.filters.push({ field: "schedule.end", operator: "is_empty" });
    else if (/있는|설정된/.test(text))
      q.filters.push({ field: "schedule.end", operator: "is_not_empty" });
  }
  if (text.includes("생성")) {
    const range = dateRange(text, now, timezone);
    if (!range)
      throw new Clarification(
        "생성일은 오늘·어제·지난주·이번달 또는 YYYY-MM-DD로 입력해 주세요.",
      );
    q.filters.push({ field: "created_at", operator: "between", value: range });
  }
  const name =
    text.match(/이름에\s*['"“]([^'"”]+)['"”]\s*(?:가|이)?\s*(?:포함|들어)/) ??
    text.match(/이름에\s*([\w가-힣_-]+?)(?:가|이)?\s*(?:포함|들어)/);
  if (name)
    q.filters.push({
      field: "name",
      operator: /포함되지|포함 안/.test(text) ? "not_contains" : "contains",
      value: name[1],
    });
  const id = text.match(/\bID\s*[:=]?\s*([\w-]+)/i);
  if (id) q.filters.push({ field: "entity_id", operator: "eq", value: id[1] });
  if (text.includes("리타겟팅") && /보이|실제|목적|설정이 다른/.test(text))
    q.semantic = "retarget";
  else if (text.includes("구매") && /최적화가 아닌|구매 최적화/.test(text))
    q.semantic = "purchase_mismatch";
  else if (/브랜딩|브랜드 인지/.test(text)) q.semantic = "branding";
  if (
    q.logical_operator === "OR" &&
    (q.filters.length > 2 || text.includes(" 중 "))
  )
    throw new Clarification(
      "여러 조건을 어떻게 묶을지 확인하지 못했습니다. 조건을 나눠 검색하거나 이전 결과를 좁혀 주세요.",
    );
  if (
    /타겟팅한|만 타겟팅|연령|나이|세 이상|세 이하|여성|남성|심사 거절|클릭률/.test(
      text,
    ) &&
    !q.semantic
  )
    throw new Clarification(
      "이 조건은 전체 QA 또는 운영 정책에서 검사해 주세요.",
    );
  if (text.includes("이름에") && !name)
    throw new Clarification(
      "이름 조건은 ‘이름에 브랜드가 포함된’처럼 입력해 주세요.",
    );
  if (
    !q.filters.length &&
    !q.semantic &&
    !q.previous &&
    q.operation !== "compare" &&
    / 중 |인데|이름이|목적이|설정이|없는|누락된|입찰가/.test(text)
  )
    throw new Clarification(
      "조건을 정확히 해석하지 못했습니다. 예산·상태·이름·날짜 조건을 구체적으로 입력해 주세요.",
    );
  if (
    !q.filters.length &&
    !q.semantic &&
    !q.platforms.length &&
    !q.previous &&
    !/캠페인|광고그룹|광고 세트|키워드|소재|에셋/.test(text)
  )
    throw new Clarification(
      "매체와 광고 항목, 확인할 설정을 구체적으로 입력해 주세요.",
    );
  if (/성과|매출|클릭률|ROAS|좋은|효율/i.test(text) && !q.filters.length)
    throw new Clarification(
      "예산·상태·일정·타겟팅 등 광고 설정 조건을 지정해 주세요.",
    );
  return q;
}
export function execute(
  query: Query,
  entities: Entity[],
  context?: QueryContext,
): [Entity[], Entity[]] {
  const matched: Entity[] = [],
    unknown: Entity[] = [],
    previous = query.previous ? new Set(context?.result_keys ?? []) : null;
  const identity = (entity: Entity, id: string) => JSON.stringify([entity.platform, entity.account_id, id]);
  const parentCandidates = new Map<string, Entity[]>();
  if (query.children && previous?.size) for (const entity of entities) {
    const key = identity(entity, entity.entity_id), candidates = parentCandidates.get(key) ?? [];
    candidates.push(entity); parentCandidates.set(key, candidates);
  }
  const parentOf = (entity: Entity) => resolveParent(entity, parentCandidates.get(identity(entity, entity.parent_id ?? "")) ?? []);
  const hasPreviousAncestor = (entity: Entity) => {
    const seen = new Set([entity.key]);
    let parent = parentOf(entity);
    while (parent && !seen.has(parent.key)) {
      if (previous?.has(parent.key)) return true;
      seen.add(parent.key);
      parent = parentOf(parent);
    }
    return false;
  };
  for (const entity of entities) {
    if (query.platforms.length && !query.platforms.includes(entity.platform))
      continue;
    if (query.products?.length && !query.products.includes(productKey(entity) ?? "")) continue;
    if (entity.entity_type !== query.entity) continue;
    if (
      previous &&
      (query.children
        ? !hasPreviousAncestor(entity)
        : !previous.has(entity.key))
    )
      continue;
    const outcomes = query.filters.map((filter) => {
      const item = observe(entity, filter.field);
      if (
        !item.known ||
        (filter.field.startsWith("budget.") &&
          (!observe(entity, "budget.unit").known ||
            entity.budget.unit !== "major" ||
            (query.currency &&
              (!observe(entity, "currency").known ||
                entity.currency !== query.currency))))
      )
        return null;
      if (filter.operator === "between") {
        if (
          !observe(entity, "timezone").known ||
          typeof item.value !== "string" ||
          !/(Z|[+-]\d{2}:\d{2})$/.test(item.value)
        )
          return null;
        try {
          const range = dateRange(
            query.text,
            query.reference_time,
            entity.timezone,
          );
          const stamp = Date.parse(item.value);
          return range && Number.isFinite(stamp)
            ? stamp >= range[0] && stamp < range[1]
            : null;
        } catch {
          return null;
        }
      }
      if (
        filter.field.startsWith("budget.") &&
        ["eq", "ne"].includes(filter.operator) &&
        item.value != null
      )
        return (
          new Decimal(String(item.value)).eq(String(filter.value)) ===
          (filter.operator === "eq")
        );
      return compareValue(
        item.value,
        filter.operator as Parameters<typeof compareValue>[1],
        filter.value,
        filter.field,
      );
    });
    const result =
      query.logical_operator === "AND"
        ? outcomes.includes(false)
          ? false
          : outcomes.includes(null)
            ? null
            : true
        : outcomes.includes(true)
          ? true
          : outcomes.includes(null)
            ? null
            : !outcomes.length;
    if (result === null) unknown.push(entity);
    else if (result) matched.push(entity);
  }
  return [matched, unknown];
}
