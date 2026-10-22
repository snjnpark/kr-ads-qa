import Decimal from "decimal.js";
import {
  isAlias,
  isMap,
  isScalar,
  parseDocument,
  stringify,
  visit,
} from "yaml";
import { z } from "zod";
import { PLATFORMS } from "../../contracts/domain";
import { OPERATORS, type Predicate, type Policy } from "../../contracts/policy";
import { decimal, safeRegex } from "./values";

export const POLICY_FIELDS = new Set([
  "platform",
  "extensions.product_type",
  "extensions.product_subtype",
  "extensions.product_settings.appCampaignSetting.appId",
  "extensions.product_settings.appCampaignSetting.appStore",
  "extensions.product_settings.shoppingSetting.merchantId",
  "extensions.product_settings.shoppingSetting.feedLabel",
  "extensions.product_settings.hotelSetting.hotelCenterId",
  "extensions.assets",
  "extensions.shopping_products",
  "extensions.listing_group_filters",
  "extensions.targeting_criteria",
  "extensions.conversion_configuration",
  "extensions.creative_id",
  "extensions.biz_channel_id",
  "extensions.landing_urls",
  "account_id",
  "entity_type",
  "entity_id",
  "parent_id",
  "name",
  "status",
  "effective_status",
  "currency",
  "timezone",
  "created_at",
  "budget.daily",
  "budget.lifetime",
  "budget.level",
  "bid.strategy",
  "bid.amount",
  "schedule.start",
  "schedule.end",
  "targeting.countries",
  "targeting.age_min",
  "targeting.age_max",
  "targeting.custom_audiences",
  "targeting.excluded_audiences",
  "optimization.objective",
  "optimization.goal",
  "optimization.event",
  "tracking.url",
  "tracking.parameters",
  "text",
  "effective_daily_budget",
  "effective_lifetime_budget",
  "targeting.approved_retarg_audience_present",
]);
const predicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z
    .strictObject({
      field: z.string().optional(),
      operator: z.enum(OPERATORS).optional(),
      value: z.unknown().optional(),
      all: z.array(predicateSchema).min(1).optional(),
      any: z.array(predicateSchema).min(1).optional(),
      not: predicateSchema.optional(),
    })
    .superRefine((item, ctx) => {
      const branches = [item.all, item.any, item.not].filter(
        (value) => value !== undefined,
      ).length;
      if (branches) {
        if (
          branches !== 1 ||
          item.field !== undefined ||
          item.operator !== undefined ||
          item.value != null
        )
          ctx.addIssue({
            code: "custom",
            message: "all·any·not 또는 단일 비교 조건 중 하나만 사용하세요.",
          });
        return;
      }
      if (!item.field || !POLICY_FIELDS.has(item.field) || !item.operator) {
        ctx.addIssue({
          code: "custom",
          message: "지원되는 필드와 비교 연산자가 필요합니다.",
        });
        return;
      }
      const unary = ["is_empty", "is_not_empty", "exists"].includes(
        item.operator,
      );
      if (unary ? item.value != null : item.value == null)
        ctx.addIssue({
          code: "custom",
          message: unary
            ? "존재·미설정 검사에는 비교 값을 넣을 수 없습니다."
            : "비교 값이 필요합니다.",
        });
      if (
        ["in", "not_in"].includes(item.operator) &&
        !Array.isArray(item.value)
      )
        ctx.addIssue({
          code: "custom",
          message: "포함 여부 검사에는 값 목록이 필요합니다.",
        });
      if (item.operator === "regex") {
        try {
          if (typeof item.value !== "string")
            throw new Error("정규식에는 문자열 패턴이 필요합니다.");
          safeRegex(item.value);
        } catch (error) {
          ctx.addIssue({ code: "custom", message: (error as Error).message });
        }
      }
    }),
);
const identifier = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_-]{0,79}$/,
    "ID는 영문자로 시작하는 영문·숫자·밑줄·하이픈 80자 이내여야 합니다.",
  );
const moneySchema = z
  .union([z.string(), z.number()])
  .refine((value) => {
    const number = decimal(value);
    return number !== null && number.gte(0);
  }, "금액은 0 이상의 유한한 수여야 합니다.")
  .transform((value) => new Decimal(value).toFixed())
  .nullable()
  .optional();
const settingsSchema = z
  .strictObject({
    daily_budget_max: moneySchema,
    lifetime_budget_max: moneySchema,
    bid_max: moneySchema,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .optional(),
    allowed_countries: z.array(z.string()).default([]),
    age_min: z.number().int().min(0).max(120).nullable().optional(),
    age_max: z.number().int().min(0).max(120).nullable().optional(),
    required_utm: z.array(z.string()).default([]),
    approved_audiences: z.array(z.string()).default([]),
    require_promotion_end: z.boolean().default(false),
  })
  .superRefine((item, ctx) => {
    if (
      item.age_min != null &&
      item.age_max != null &&
      item.age_min > item.age_max
    )
      ctx.addIssue({
        code: "custom",
        message: "최소 연령은 최대 연령을 초과할 수 없습니다.",
      });
  });
const ruleSchema = z.strictObject({
  rule_id: identifier,
  name: z.string().default(""),
  entity: z
    .enum([
      "*",
      "account",
      "campaign",
      "adgroup",
      "adset",
      "ad",
      "creative",
      "keyword",
      "asset_group",
      "asset",
      "ad_extension",
      "business_channel",
      "product_group",
      "time_contract",
      "brand_new_contract",
    ])
    .default("campaign"),
  platforms: z.array(z.enum(PLATFORMS)).default([]),
  account_ids: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  severity: z
    .enum(["critical", "error", "warning", "review", "info"])
    .default("warning"),
  when: predicateSchema.optional(),
  check: predicateSchema,
  exclude: predicateSchema.optional(),
});
const policySchema = z
  .strictObject({
    policy_id: identifier,
    name: z.string(),
    version: z.number().int().min(1).default(1),
    platforms: z.array(z.enum(PLATFORMS)).default([...PLATFORMS]),
    account_ids: z.array(z.string()).default([]),
    evaluation_mode: z.literal("conditions").optional(),
    settings: settingsSchema.prefault({}),
    rules: z.array(ruleSchema).default([]),
  })
  .superRefine((item, ctx) => {
    if (item.evaluation_mode === "conditions") {
      for (const [index, rule] of item.rules.entries()) {
        const pending = [rule.check, rule.when, rule.exclude].filter(Boolean) as Predicate[];
        while (pending.length) {
          const condition = pending.pop()!;
          pending.push(...condition.all ?? [], ...condition.any ?? [], ...condition.not ? [condition.not] : []);
          if (!condition.field || ["is_empty", "is_not_empty", "exists"].includes(condition.operator ?? "")) continue;
          const numeric = ["budget.daily", "budget.lifetime", "effective_daily_budget", "effective_lifetime_budget", "bid.amount", "targeting.age_min", "targeting.age_max"].includes(condition.field);
          if (numeric && ["gt", "gte", "lt", "lte", "eq", "ne"].includes(condition.operator ?? "") &&
            (decimal(condition.value) === null || decimal(condition.value)!.lt(0)))
            ctx.addIssue({ code: "custom", path: ["rules", index], message: "금액·연령 조건값은 0 이상의 유한한 수여야 합니다." });
          if (["schedule.start", "schedule.end"].includes(condition.field) && ["gt", "gte", "lt", "lte"].includes(condition.operator ?? "") &&
            (typeof condition.value !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(condition.value) || !Number.isFinite(Date.parse(condition.value))))
            ctx.addIssue({ code: "custom", path: ["rules", index], message: "날짜 조건값에는 유효한 날짜와 시간대가 필요합니다." });
        }
      }
    }
    if (
      new Set(item.rules.map((rule) => rule.rule_id)).size !== item.rules.length
    )
      ctx.addIssue({ code: "custom", message: "규칙 ID가 중복되었습니다." });
  });

function boundedTree(value: unknown): void {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > 20_000 || item.depth > 40)
      throw new Error("정책의 조건 수 또는 중첩 깊이가 제한을 초과했습니다.");
    if (item.value && typeof item.value === "object")
      for (const child of Object.values(item.value))
        pending.push({ value: child, depth: item.depth + 1 });
  }
}

export function loadYaml(source: string): Record<string, unknown> {
  if (Buffer.byteLength(source, "utf8") > 1_000_000)
    throw new Error("정책 파일은 1 MB 이하여야 합니다.");
  const document = parseDocument(source, { strict: true, intAsBigInt: true });
  if (document.errors.length || document.warnings.length)
    throw new Error(
      "YAML 형식을 확인해 주세요. 중복 키와 사용자 정의 태그는 지원하지 않습니다.",
    );
  visit(document, (_key, node) => {
    if (isAlias(node)) throw new Error("YAML 별칭은 지원하지 않습니다.");
    if (isMap(node))
      for (const pair of node.items)
        if (!isScalar(pair.key) || typeof pair.key.value !== "string")
          throw new Error("YAML 키는 문자열이어야 합니다.");
    if (isScalar(node) && typeof node.value === "bigint") {
      node.value =
        node.value <= BigInt(Number.MAX_SAFE_INTEGER) &&
        node.value >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(node.value)
          : String(node.value);
    }
    if (isScalar(node) && typeof node.value === "number") {
      if (!Number.isFinite(node.value))
        throw new Error("YAML에는 유한한 숫자만 사용할 수 있습니다.");
      if (
        node.source &&
        /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(node.source)
      ) {
        const exact = new Decimal(node.source);
        if (!exact.eq(new Decimal(String(node.value))))
          node.value = exact.toFixed();
      }
    }
  });
  const data = document.toJS({ maxAliasCount: 0 });
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("정책은 이름과 값으로 구성된 문서여야 합니다.");
  boundedTree(data);
  return data as Record<string, unknown>;
}

export function loadPolicy(
  source: string | Record<string, unknown> | Policy,
): Policy {
  const original = typeof source === "string" ? loadYaml(source) : source;
  boundedTree(original);
  const data = structuredClone(original) as Record<string, unknown>;
  if (Array.isArray(data.rules))
    data.rules = data.rules.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
      const item = { ...raw } as Record<string, unknown>;
      if (Object.hasOwn(item, "id")) {
        if (Object.hasOwn(item, "rule_id"))
          throw new Error("규칙 ID를 중복 지정할 수 없습니다.");
        item.rule_id = item.id;
        delete item.id;
      }
      if (!Object.hasOwn(item, "check") && Object.hasOwn(item, "field")) {
        item.check = Object.fromEntries(
          ["field", "operator", "value"]
            .filter((key) => Object.hasOwn(item, key))
            .map((key) => [key, item[key]]),
        );
        delete item.field;
        delete item.operator;
        delete item.value;
      }
      for (const key of ["when", "exclude"])
        if (item[key] === null) delete item[key];
      return item;
    });
  const result = policySchema.safeParse(data);
  if (!result.success)
    throw new Error(
      `정책 입력을 확인해 주세요: ${result.error.issues.map((issue) => `${issue.path.join(".") || "정책"}: ${issue.message}`).join(" / ")}`,
    );
  return result.data as Policy;
}
export function validatePolicy(
  source: string | Record<string, unknown> | Policy,
): Policy {
  return loadPolicy(source);
}
export function policyYaml(policy: Policy): string {
  return stringify(JSON.parse(JSON.stringify(policy)));
}

