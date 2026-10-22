import type { Entity, Json } from "./models";
import { decimal } from "./policies/values";
import { observe } from "./policies/evaluation";

export const ANOMALY_FIELDS = new Set([
  "optimization.objective",
  "optimization.goal",
  "optimization.event",
  "bid.strategy",
  "bid.amount",
  "budget.daily",
  "budget.lifetime",
  "targeting.countries",
]);
type Options = {
  groups?: Record<string, string>;
  fields?: string[];
  min_group_size?: number;
  majority_ratio?: number;
};
const monetary = (field: string) =>
  ["budget.daily", "budget.lifetime", "bid.amount"].includes(field);
function canonical(value: unknown): unknown {
  if (Array.isArray(value))
    return value
      .map(canonical)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function fingerprint(value: unknown, field: string) {
  return JSON.stringify(
    canonical(monetary(field) ? (decimal(value)?.toFixed() ?? value) : value),
  );
}
function nameGroup(entity: Entity): string | null {
  const name = observe(entity, "name");
  if (!name.known || typeof name.value !== "string" || !name.value.trim())
    return null;
  const family = name.value.replace(/[_\-\s]+\d+(?:[_\-\s].*)?$/, "").trim();
  return family ? `${entity.parent_id || "root"}:${family}` : null;
}
/** Frequency differences are review candidates; the majority is never an operating policy. */
export function detectAnomalies(
  entities: Entity[],
  options: Options = {},
): Json[] {
  const minimum = options.min_group_size ?? 5,
    ratio = options.majority_ratio ?? 0.8,
    fields = options.fields ?? [
      "optimization.objective",
      "optimization.goal",
      "optimization.event",
      "bid.strategy",
      "budget.daily",
    ];
  if (
    !Number.isInteger(minimum) ||
    minimum < 3 ||
    !Number.isFinite(ratio) ||
    ratio <= 0.5 ||
    ratio > 1
  )
    throw new Error(
      "빈도 비교는 관측값 3개 이상과 50%를 넘는 다수 비율이 필요합니다.",
    );
  if (fields.some((field) => !ANOMALY_FIELDS.has(field)))
    throw new Error("지원하지 않는 빈도 비교 항목입니다.");
  const buckets = new Map<string, { group: string; members: Entity[] }>();
  for (const entity of entities) {
    const group = options.groups
      ? options.groups[entity.key]
      : nameGroup(entity);
    if (!group) continue;
    const key = JSON.stringify([
        entity.platform,
        entity.account_id,
        entity.entity_type,
        group,
      ]),
      bucket = buckets.get(key) ?? { group, members: [] };
    bucket.members.push(entity);
    buckets.set(key, bucket);
  }
  const results: Json[] = [];
  for (const { group, members } of buckets.values()) {
    if (members.length < minimum) continue;
    for (const field of fields) {
      const observed = members
        .map((entity) => ({ entity, value: observe(entity, field) }))
        .filter(
          ({ entity, value }) =>
            value.known &&
            value.value != null &&
            (!monetary(field) ||
              (observe(entity, "currency").known &&
                observe(entity, "budget.unit").known &&
                entity.budget.unit === "major")),
        );
      if (
        observed.length < minimum ||
        (monetary(field) &&
          new Set(observed.map(({ entity }) => entity.currency)).size !== 1)
      )
        continue;
      const counts = new Map<string, number>();
      for (const { value } of observed) {
        const key = fingerprint(value.value, field);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const [majority, frequency] = [...counts].sort((a, b) => b[1] - a[1])[0];
      if (counts.size === 1 || frequency / observed.length < ratio) continue;
      const majorityValue = observed.find(
        ({ value }) => fingerprint(value.value, field) === majority,
      )!.value.value;
      for (const { entity, value } of observed) {
        if (fingerprint(value.value, field) === majority) continue;
        results.push({
          rule_id: `ANOMALY_${field.toUpperCase().replaceAll(".", "_")}`,
          platform: entity.platform,
          account_id: entity.account_id,
          entity_id: entity.entity_id,
          entity_name: entity.name,
          status: "REVIEW",
          severity: "review",
          expected: majorityValue,
          actual: value.value,
          evidence: {
            field,
            value: value.value,
            state: value.state,
            source: value.source,
            entity_key: entity.key,
            group,
            group_source: options.groups
              ? "supplied_group"
              : "name_and_structure",
            group_count: members.length,
            observed_count: observed.length,
            majority_count: frequency,
            majority_ratio: frequency / observed.length,
            note: "다수와 다른 설정입니다. 운영 의도에 맞는 예외일 수 있어 사용자 확인이 필요합니다.",
          },
          checked_at: new Date().toISOString(),
          model_version: null,
          scores: {},
        });
      }
    }
  }
  return results;
}
export class FrequencyAnomalyDetector {
  run(entities: Entity[], options: Options = {}) {
    return detectAnomalies(entities, options);
  }
}
