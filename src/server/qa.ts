import type { Entity, Json, ResultStatus } from "./models";
import type { Policy } from "../contracts/policy";
import { decimal } from "./policies/values";
import { loadPolicy } from "./policies/schema";
import {
  customRuleResults,
  effectiveBudget,
  observe,
  resolveParent,
  type Observed,
} from "./policies/evaluation";

import { RULES } from "../lib/audit-rules";
import { productRuleResults } from "./product-qa";
export { RULES } from "../lib/audit-rules";

const ACTIVE = new Set(["ACTIVE", "ENABLED", "ON", "ELIGIBLE", "NORMAL"]);
const INACTIVE = new Set([
  "PAUSED",
  "DISABLED",
  "OFF",
  "REMOVED",
  "DELETED",
  "ARCHIVED",
  "STOPPED",
]);
const RESTRICTED = new Set([
  "DISAPPROVED",
  "REJECTED",
  "SUSPENDED",
  "WITH_ISSUES",
  "LIMITED",
  "SYSTEM_STOPPED",
]);
const GROUPS = new Set(["campaign", "adgroup", "adset", "asset_group"]);
const ADS = new Set(["ad", "creative"]);
const notApplicable = (item: Observed) =>
  ["NOT_SUPPORTED", "NOT_APPLICABLE"].includes(item.state);
const truthy = (value: unknown) =>
  Array.isArray(value)
    ? value.length > 0
    : value != null && value !== "" && value !== false && value !== 0;
const upper = (value: unknown) => String(value).toUpperCase();
const instant = (value: unknown) => {
  if (
    !(value instanceof Date) &&
    (typeof value !== "string" || !/(Z|[+-]\d\d:\d\d)$/i.test(value))
  )
    return null;
  const result = new Date(value as string | Date).getTime();
  return Number.isFinite(result) ? result : null;
};
const amountAtMost = (actual: unknown, limit: unknown) => {
  const first = decimal(actual),
    second = decimal(limit);
  return first && second ? first.lte(second) : null;
};
const query = (value: unknown) => {
  const address = String(value ?? "").split("#")[0];
  const start = address.indexOf("?");
  return new URLSearchParams(start < 0 ? "" : address.slice(start + 1));
};
type CheckOptions = {
  severity?: string;
  applies?: boolean;
  missing?: "skip" | "fail";
  observations?: Record<string, Observed>;
  failure?: ResultStatus;
};

export class QAEngine {
  private readonly now: number;
  constructor(now: Date = new Date()) {
    this.now = now.getTime();
    if (!Number.isFinite(this.now))
      throw new Error("QA 기준 시각이 올바르지 않습니다.");
  }
  run(
    entities: Entity[],
    policy?: Policy | Record<string, unknown> | null,
  ): Json[] {
    const checked = policy ? loadPolicy(policy) : null;
    const index = new Map(entities.map((entity) => [entity.key, entity]));
    return entities.flatMap((entity) => {
      if (
        checked &&
        (!checked.platforms.includes(entity.platform) ||
          (checked.account_ids.length &&
            !checked.account_ids.includes(entity.account_id)))
      )
        return [];
      return [
        ...(checked?.evaluation_mode === "conditions" ? [] : [...this.entity(entity, index, checked), ...productRuleResults(entity, index)]),
        ...(checked ? customRuleResults(entity, index, checked) : []),
      ];
    });
  }
  private entity(
    entity: Entity,
    index: Map<string, Entity>,
    policy: Policy | null,
  ): Json[] {
    const output: Json[] = [],
      settings = policy?.settings;
    const policyMoney = (observed: Observed, unit = "major"): Observed => {
      if (unit !== "major")
        return {
          value: observed.value,
          state: "NOT_RETURNED",
          source: `unconverted monetary unit:${unit}`,
          known: false,
        };
      const currency = observe(entity, "currency");
      return settings?.currency &&
        (!currency.known || currency.value !== settings.currency)
        ? {
            value: observed.value,
            state: "NOT_RETURNED",
            source: `policy currency ${settings.currency}; account currency ${currency.value}`,
            known: false,
          }
        : observed;
    };
    const record = (
      id: string,
      status: ResultStatus,
      expected: unknown,
      observations: Record<string, Observed>,
      severity = "warning",
    ) => {
      const evidence = Object.fromEntries(
        Object.entries(observations).map(([field, item]) => [
          field,
          { value: item.value, state: item.state, source: item.source ?? null },
        ]),
      );
      output.push({
        rule_id: id,
        platform: entity.platform,
        account_id: entity.account_id,
        entity_id: entity.entity_id,
        entity_name: entity.name,
        status,
        severity,
        expected,
        actual: Object.fromEntries(
          Object.entries(observations).map(([field, item]) => [
            field,
            item.value,
          ]),
        ),
        evidence: {
          ...evidence,
          entity_key: entity.key,
          fetched_at: entity.fetched_at,
          rule_description: RULES[id],
        },
        checked_at: new Date().toISOString(),
        model_version: null,
        scores: {},
      });
    };
    const check = (
      id: string,
      paths: string[],
      expected: unknown,
      predicate: (...values: unknown[]) => boolean | null,
      options: CheckOptions = {},
    ) => {
      const observed =
          options.observations ??
          Object.fromEntries(
            paths.map((field) => [field, observe(entity, field)]),
          ),
        values = Object.values(observed);
      let status: ResultStatus;
      if (options.applies === false || values.some(notApplicable))
        status = "NOT_APPLICABLE";
      else if (values.some((value) => !value.known)) status = "UNKNOWN";
      else if (
        options.missing !== "fail" &&
        values.some((value) => value.value == null)
      )
        status = "NOT_APPLICABLE";
      else {
        try {
          const valid = predicate(...values.map((item) => item.value));
          status =
            valid === null
              ? "UNKNOWN"
              : valid
                ? "PASS"
                : (options.failure ??
                  (["critical", "error"].includes(options.severity ?? "warning")
                    ? "FAIL"
                    : "WARNING"));
        } catch {
          status = "UNKNOWN";
        }
      }
      record(id, status, expected, observed, options.severity);
    };
    const group = GROUPS.has(entity.entity_type),
      ad = ADS.has(entity.entity_type) || (entity.entity_type === "asset_group" && entity.extensions.creative_container === true);
    const daily = effectiveBudget(entity, index, "daily"),
      lifetime = effectiveBudget(entity, index, "lifetime"),
      budgets = [daily, lifetime];
    const presence: ResultStatus = !group
      ? "NOT_APPLICABLE"
      : budgets.some((item) => item.known && item.value != null)
        ? "PASS"
        : budgets.every(notApplicable)
          ? "NOT_APPLICABLE"
          : budgets.every((item) => item.known || notApplicable(item))
            ? "FAIL"
            : "UNKNOWN";
    record(
      "BUDGET_001",
      presence,
      "일예산 또는 총예산 (명시된 상속 포함)",
      { effective_daily_budget: daily, effective_lifetime_budget: lifetime },
      "critical",
    );
    check("BUDGET_002", [], "> 0", (value) => decimal(value)?.gt(0) ?? false, {
      severity: "critical",
      applies: group,
      observations: { effective_daily_budget: daily },
    });
    check("BUDGET_003", [], "> 0", (value) => decimal(value)?.gt(0) ?? false, {
      severity: "critical",
      applies: group,
      observations: { effective_lifetime_budget: lifetime },
    });
    for (const [id, field, limit] of [
      ["BUDGET_004", "daily", settings?.daily_budget_max],
      ["BUDGET_005", "lifetime", settings?.lifetime_budget_max],
    ] as const)
      check(
        id,
        [],
        `<= ${limit ?? "—"}`,
        (value) => amountAtMost(value, limit),
        {
          severity: "critical",
          applies: group && limit != null,
          observations: {
            [`effective_${field}_budget`]: policyMoney(
              field === "daily" ? daily : lifetime,
            ),
          },
        },
      );
    check(
      "BUDGET_006",
      ["currency"],
      "3자리 대문자 통화 코드 형식",
      (value) => typeof value === "string" && /^[A-Z]{3}$/.test(value),
      { severity: "error", applies: group },
    );
    check(
      "BUDGET_007",
      ["currency"],
      settings?.currency ?? null,
      (value) => value === settings?.currency,
      { severity: "critical", applies: group && !!settings?.currency },
    );
    check(
      "BUDGET_008",
      ["budget.unit"],
      "major (통화 기본 단위)",
      (value) => (value === "major" ? true : null),
      { severity: "critical", applies: group },
    );

    const parent = resolveParent(entity, index);
    check(
      "STATUS_001",
      [],
      "활성 객체의 상위 객체 활성",
      (child, upperStatus) =>
        !(ACTIVE.has(upper(child)) && INACTIVE.has(upper(upperStatus))),
      {
        applies: entity.parent_id !== null,
        observations: {
          status: observe(entity, "status"),
          "parent.status": parent
            ? observe(parent, "status")
            : { value: null, state: "NOT_RETURNED", known: false },
        },
      },
    );
    check(
      "STATUS_002",
      ["status", "effective_status"],
      "활성 객체 집행 제한 없음",
      (requested, effective) =>
        !(ACTIVE.has(upper(requested)) && RESTRICTED.has(upper(effective))),
      { severity: "critical" },
    );
    check(
      "STATUS_003",
      ["extensions.review_status"],
      "심사 거절 없음",
      (value) => !RESTRICTED.has(upper(value)),
      { severity: "critical", applies: ad },
    );
    check(
      "SCHEDULE_001",
      ["schedule.start", "schedule.end"],
      "start <= end",
      (start, end) =>
        instant(start) === null || instant(end) === null
          ? null
          : instant(start)! <= instant(end)!,
      { severity: "critical", applies: group },
    );
    check(
      "SCHEDULE_002",
      ["status", "schedule.end"],
      "종료일 이후 활성 상태 확인",
      (status, end) =>
        instant(end) === null
          ? null
          : !(ACTIVE.has(upper(status)) && instant(end)! < this.now),
      { applies: group },
    );
    check(
      "SCHEDULE_003",
      ["status", "schedule.start"],
      "시작일 이전 활성 상태 확인",
      (status, start) =>
        instant(start) === null
          ? null
          : !(ACTIVE.has(upper(status)) && instant(start)! > this.now),
      { applies: group },
    );
    check(
      "SCHEDULE_004",
      ["schedule.end"],
      "프로모션 종료일 설정",
      (value) => value != null,
      {
        severity: "error",
        applies:
          group &&
          /프로모션|프로모|11절|promotion/i.test(entity.name) &&
          !!settings?.require_promotion_end,
        missing: "fail",
      },
    );
    check("SCHEDULE_005", ["timezone"], "조회 가능한 IANA 시간대", (value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: String(value) });
        return true;
      } catch {
        return null;
      }
    });
    check(
      "TARGET_001",
      ["targeting.age_min", "targeting.age_max"],
      "age_min <= age_max",
      (minimum, maximum) =>
        typeof minimum === "number" && typeof maximum === "number"
          ? minimum <= maximum
          : null,
      { severity: "error", applies: group },
    );
    check(
      "TARGET_002",
      ["targeting.age_min"],
      `>= ${settings?.age_min ?? "—"}`,
      (value) =>
        typeof value === "number" ? value >= settings!.age_min! : null,
      { severity: "error", applies: group && settings?.age_min != null },
    );
    check(
      "TARGET_003",
      ["targeting.age_max"],
      `<= ${settings?.age_max ?? "—"}`,
      (value) =>
        typeof value === "number" ? value <= settings!.age_max! : null,
      { severity: "error", applies: group && settings?.age_max != null },
    );
    check(
      "TARGET_004",
      ["targeting.countries"],
      settings?.allowed_countries ?? [],
      (value) =>
        !Array.isArray(value)
          ? null
          : value.length > 0 &&
            value.every((country) =>
              settings!.allowed_countries.includes(country),
            ),
      {
        severity: "error",
        applies: group && !!settings?.allowed_countries.length,
        missing: "fail",
      },
    );
    check(
      "TARGET_005",
      ["targeting.custom_audiences", "targeting.excluded_audiences"],
      "포함·제외 오디언스 ID 중복 없음",
      (included, excluded) =>
        Array.isArray(included) && Array.isArray(excluded)
          ? !included.some((value) => excluded.includes(value))
          : null,
      { applies: group, missing: "fail" },
    );
    check(
      "TARGET_006",
      ["targeting.custom_audiences"],
      "리타겟팅 이름의 실제 오디언스 확인",
      truthy,
      {
        severity: "review",
        applies: group && /리타겟|리타깃|retarget/i.test(entity.name),
        missing: "fail",
        failure: "REVIEW",
      },
    );
    check(
      "OPTIMIZATION_001",
      ["optimization.objective"],
      "캠페인 목적 설정",
      truthy,
      {
        severity: "error",
        applies: entity.entity_type === "campaign",
        missing: "fail",
      },
    );
    check(
      "OPTIMIZATION_002",
      ["optimization.goal"],
      "최적화 목표 설정",
      truthy,
      {
        severity: "error",
        applies: ["adgroup", "adset"].includes(entity.entity_type),
        missing: "fail",
      },
    );
    check(
      "OPTIMIZATION_003",
      ["optimization.event"],
      "구매 명칭과 이벤트 수동 확인",
      (value) => ["PURCHASE", "PURCHASES", "VALUE"].includes(upper(value)),
      {
        severity: "review",
        applies: group && /구매|purchase/i.test(entity.name),
        missing: "fail",
        failure: "REVIEW",
      },
    );
    check(
      "BID_001",
      ["bid.amount"],
      "> 0",
      (value) => decimal(value)?.gt(0) ?? null,
      { severity: "error", applies: group || entity.entity_type === "keyword" },
    );
    check(
      "BID_002",
      [],
      `<= ${settings?.bid_max ?? "—"}`,
      (value) => amountAtMost(value, settings?.bid_max),
      {
        severity: "error",
        applies: settings?.bid_max != null,
        observations: {
          "bid.amount": policyMoney(observe(entity, "bid.amount"), entity.budget.unit),
        },
      },
    );
    check(
      "BID_003",
      ["bid.amount"],
      "상한·수동 입찰 금액 설정",
      (value) => value != null,
      {
        severity: "error",
        applies: [
          "BID_CAP",
          "COST_CAP",
          "LOWEST_COST_WITH_BID_CAP",
          "MANUAL_CPC",
        ].includes(entity.bid.strategy ?? ""),
        missing: "fail",
      },
    );
    check(
      "CREATIVE_001",
      ["text"],
      "빈 문자열이 아닌 소재 문구",
      (value) => typeof value === "string" && !!value.trim(),
      { applies: ad, missing: "fail" },
    );
    check("URL_001", ["tracking.url"], "랜딩 URL 설정", truthy, {
      severity: "error",
      applies: ad,
      missing: "fail",
    });
    check(
      "URL_002",
      ["tracking.url"],
      "http(s)://host",
      (value) => {
        try {
          const parsed = new URL(String(value));
          return (
            ["http:", "https:"].includes(parsed.protocol) &&
            !!parsed.hostname &&
            !/\s/.test(String(value))
          );
        } catch {
          return false;
        }
      },
      { severity: "error", applies: ad },
    );
    check(
      "URL_003",
      ["tracking.url", "tracking.parameters"],
      settings?.required_utm ?? [],
      (url, parameters) => {
        const merged = Object.fromEntries(query(url));
        if (parameters && typeof parameters === "object")
          Object.assign(merged, parameters);
        return settings!.required_utm.every((name) => !!merged[name]);
      },
      { applies: ad && !!settings?.required_utm.length, missing: "fail" },
    );
    check(
      "URL_004",
      ["tracking.url"],
      "중복 query key 없음",
      (value) => {
        const keys = [...query(value).keys()];
        return new Set(keys).size === keys.length;
      },
      { applies: ad },
    );
    if (ad && Array.isArray(entity.extensions.landing_urls)) {
      // Each device/component link needs its own evidence; a valid PC link must not hide a broken mobile link.
      const links = entity.extensions.landing_urls;
      for (const link of links) {
        if (!link || typeof link.url !== "string" || link.url === entity.tracking.url) continue;
        const linked = { ...entity, tracking: { ...entity.tracking, url: link.url }, extensions: { ...entity.extensions, landing_urls: undefined } };
        linked.fields = { ...entity.fields, "tracking.url": "PRESENT" };
        linked.sources = { ...entity.sources, "tracking.url": typeof link.source === "string" ? link.source : "extensions.landing_urls" };
        output.push(...this.entity(linked, index, policy).filter(result => result.rule_id.startsWith("URL_")).map(result => ({ ...result, evidence: { ...result.evidence, landing_device: link.device ?? "UNSPECIFIED" } })));
      }
    }
    return output;
  }
}
