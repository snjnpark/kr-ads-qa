import type { Entity, FieldState, ResultStatus } from "../../contracts/domain";
import type { Operator, Predicate, Policy } from "../../contracts/policy";
import { entityKey } from "../models";
import { activePolicyRules } from "../../lib/policy-conditions";
import { compareValue } from "./values";

export type Observed = {
  value: unknown;
  state: FieldState;
  source?: string;
  known: boolean;
};
export type EntityIndex =
  Map<string, Entity> | Record<string, Entity> | Entity[];
export type FieldEvidence = {
  field: string;
  actual: unknown;
  state: FieldState;
  source?: string;
  operator: Operator;
  expected: unknown;
};

export function observe(entity: Entity, path: string): Observed {
  let value: unknown = entity;
  let provided = true;
  for (const part of path.split(".")) {
    provided =
      provided &&
      value !== null &&
      typeof value === "object" &&
      Object.hasOwn(value, part);
    value =
      value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)[part]
        : undefined;
    if (value == null) break;
  }
  const parent = path.slice(0, path.lastIndexOf("."));
  const parentState = entity.fields?.[parent];
  const state =
    entity.fields?.[path] ??
    (parentState && parentState !== "PRESENT"
      ? parentState
      : provided && value != null
        ? "PRESENT"
        : "NOT_RETURNED");
  return {
    value: value ?? null,
    state,
    source: entity.sources?.[path],
    known: state === "PRESENT" || state === "NOT_SET",
  };
}
function indexValues(entities: EntityIndex): Entity[] {
  return entities instanceof Map
    ? [...entities.values()]
    : Array.isArray(entities)
      ? entities
      : Object.values(entities);
}
export function resolveParent(
  entity: Entity,
  entities: EntityIndex,
  identifier?: string,
): Entity | null {
  let type = (
    {
      ad: "adgroup",
      creative: "adgroup",
      keyword: "adgroup",
      adgroup: "campaign",
      adset: "campaign",
      asset_group: "campaign",
      time_contract: "adgroup",
      brand_new_contract: "adgroup",
    } as Record<string, string>
  )[entity.entity_type];
  if (
    identifier !== undefined &&
    ["campaign", "adgroup", "adset"].includes(entity.budget.level)
  )
    type = entity.budget.level === "adset" ? "adgroup" : entity.budget.level;
  const target = identifier ?? entity.parent_id;
  const types = type ? [type] : entity.entity_type === "ad_extension" ? ["campaign", "adgroup"] : [];
  if (!target || !types.length) return null;
  const found = indexValues(entities).filter(
    (item) =>
      item.platform === entity.platform &&
      item.account_id === entity.account_id &&
      types.includes(item.entity_type) &&
      item.entity_id === target,
  );
  return found.length === 1 ? found[0] : null;
}
export function effectiveBudget(
  entity: Entity,
  entities: EntityIndex,
  field: "daily" | "lifetime",
): Observed {
  let current = entity;
  const seen = new Set<string>();
  while (!seen.has(entityKey(current))) {
    seen.add(entityKey(current));
    const budget = observe(current, `budget.${field}`);
    if (budget.state === "PRESENT" && budget.value != null)
      return current.budget.unit === "major"
        ? budget
        : {
            value: budget.value,
            state: "NOT_RETURNED",
            source: `unconverted monetary unit:${current.budget.unit}`,
            known: false,
          };
    if (
      current.entity_type === "campaign" &&
      ["adgroup", "adset"].includes(current.budget.level)
    )
      return {
        value: null,
        state: "NOT_APPLICABLE",
        source: "budget explicitly managed by child objects",
        known: false,
      };
    if (!current.budget.inherited_from) return budget;
    const parent = resolveParent(
      current,
      entities,
      current.budget.inherited_from,
    );
    if (!parent)
      return {
        value: null,
        state: "NOT_RETURNED",
        source: `inherited:${current.budget.inherited_from}`,
        known: false,
      };
    current = parent;
  }
  return {
    value: null,
    state: "FETCH_FAILED",
    source: "cyclic budget inheritance",
    known: false,
  };
}
function resolveField(
  entity: Entity,
  path: string,
  entities: EntityIndex,
  policy?: Policy | null,
): Observed {
  if (
    [
      "budget.daily",
      "budget.lifetime",
      "bid.amount",
      "effective_daily_budget",
      "effective_lifetime_budget",
    ].includes(path) &&
    policy?.settings.currency
  ) {
    const currency = observe(entity, "currency");
    if (!currency.known || currency.value !== policy.settings.currency)
      return {
        value: null,
        state: "NOT_RETURNED",
        source: "policy/account currency mismatch or unknown",
        known: false,
      };
  }
  if (
    ["budget.daily", "budget.lifetime", "bid.amount"].includes(path) &&
    entity.budget.unit !== "major"
  )
    return {
      value: null,
      state: "NOT_RETURNED",
      source: "unconverted monetary unit",
      known: false,
    };
  if (path === "effective_daily_budget" || path === "effective_lifetime_budget")
    return effectiveBudget(
      entity,
      entities,
      path === "effective_daily_budget" ? "daily" : "lifetime",
    );
  if (path === "targeting.approved_retarg_audience_present") {
    const audiences = observe(entity, "targeting.custom_audiences");
    if (!policy?.settings.approved_audiences.length)
      return {
        value: null,
        state: "NOT_RETURNED",
        source: "approved audience policy missing",
        known: false,
      };
    if (!audiences.known) return audiences;
    return {
      value: (Array.isArray(audiences.value) ? audiences.value : []).some(
        (id) => policy.settings.approved_audiences.includes(String(id)),
      ),
      state: "PRESENT",
      source: audiences.source,
      known: true,
    };
  }
  return observe(entity, path);
}
export function evaluatePredicate(
  predicate: Predicate,
  entity: Entity,
  entities: EntityIndex = [entity],
  policy?: Policy | null,
): [boolean | null, FieldEvidence[]] {
  if (predicate.all || predicate.any) {
    const results = (predicate.all ?? predicate.any!).map((item) =>
      evaluatePredicate(item, entity, entities, policy),
    );
    const values = results.map(([value]) => value);
    const answer = predicate.all
      ? values.includes(false)
        ? false
        : values.includes(null)
          ? null
          : true
      : values.includes(true)
        ? true
        : values.includes(null)
          ? null
          : false;
    return [answer, results.flatMap(([, evidence]) => evidence)];
  }
  if (predicate.not) {
    const [value, evidence] = evaluatePredicate(
      predicate.not,
      entity,
      entities,
      policy,
    );
    return [value === null ? null : !value, evidence];
  }
  const observed = resolveField(entity, predicate.field!, entities, policy);
  const evidence: FieldEvidence[] = [
    {
      field: predicate.field!,
      actual: observed.value,
      state: observed.state,
      source: observed.source,
      operator: predicate.operator!,
      expected: predicate.value ?? null,
    },
  ];
  return [
    observed.known
      ? compareValue(
          observed.value,
          predicate.operator!,
          predicate.value,
          predicate.field,
        )
      : null,
    evidence,
  ];
}
export function customRuleResults(
  entity: Entity,
  entities: EntityIndex,
  policy: Policy,
): Record<string, unknown>[] {
  if (
    !policy.platforms.includes(entity.platform) ||
    (policy.account_ids.length > 0 &&
      !policy.account_ids.includes(entity.account_id))
  )
    return [];
  const output: Record<string, unknown>[] = [];
  for (const rule of policy.evaluation_mode === "conditions"
    ? activePolicyRules(policy.rules, entity.platform, entity.account_id) : policy.rules) {
    if (
      !rule.enabled ||
      !["*", entity.entity_type].includes(rule.entity) ||
      (rule.platforms.length > 0 &&
        !rule.platforms.includes(entity.platform)) ||
      (rule.account_ids.length > 0 &&
        !rule.account_ids.includes(entity.account_id))
    )
      continue;
    let applies: boolean | null = true;
    const evidence: FieldEvidence[] = [];
    if (rule.exclude) {
      const [excluded, rows] = evaluatePredicate(
        rule.exclude,
        entity,
        entities,
        policy,
      );
      evidence.push(...rows);
      applies = excluded === null ? null : !excluded;
    }
    if (applies === true && rule.when) {
      const [value, rows] = evaluatePredicate(
        rule.when,
        entity,
        entities,
        policy,
      );
      evidence.push(...rows);
      applies = value;
    }
    let status: ResultStatus;
    if (applies === false) status = "NOT_APPLICABLE";
    else if (applies === null) status = "UNKNOWN";
    else {
      const [valid, rows] = evaluatePredicate(
        rule.check,
        entity,
        entities,
        policy,
      );
      evidence.push(...rows);
      status =
        valid === null
          ? rows.every((row) =>
              ["NOT_SUPPORTED", "NOT_APPLICABLE"].includes(row.state),
            )
            ? "NOT_APPLICABLE"
            : "UNKNOWN"
          : valid
            ? "PASS"
            : ["critical", "error"].includes(rule.severity)
              ? "FAIL"
              : rule.severity === "review"
                ? "REVIEW"
                : "WARNING";
    }
    output.push({
      rule_id: rule.rule_id,
      platform: entity.platform,
      account_id: entity.account_id,
      entity_id: entity.entity_id,
      entity_name: entity.name,
      status,
      severity: rule.severity,
      expected: rule.check,
      actual: Object.fromEntries(
        evidence.map((row) => [row.field, row.actual]),
      ),
      evidence: {
        fields: evidence,
        rule_description: rule.name || rule.rule_id,
        policy_id: policy.policy_id,
        policy_version: policy.version,
        entity_key: entityKey(entity),
      },
      checked_at: new Date().toISOString(),
    });
  }
  return output;
}
