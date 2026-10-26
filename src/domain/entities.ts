import { TEST_MODE } from "../lib/runtime";
export * from "../contracts/domain";
import { PLATFORMS, FIELD_STATES, type Entity, type FieldState, type EntityInput, type Settings, type Coverage } from "../contracts/domain";
export const entityKey = (
  entity: Pick<Entity, "platform" | "account_id" | "entity_type" | "entity_id">,
) =>
  `${entity.platform}/${entity.account_id}/${entity.entity_type}/${entity.entity_id}`;
export function createEntity(input: EntityInput): Entity {
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const invalid = () => {
    throw new Error("광고 설정을 읽지 못했습니다. 다시 조회해 주세요.");
  };
  if (!record(input)) invalid();
  for (const key of ["account_id", "entity_id", "entity_type"] as const)
    if (typeof input[key] !== "string" || !input[key].trim()) invalid();
  for (const key of [
    "account_id",
    "entity_id",
    "entity_type",
    "name",
    "currency",
    "timezone",
  ] as const)
    if (input[key] !== undefined && typeof input[key] !== "string") invalid();
  for (const key of [
    "parent_id",
    "status",
    "effective_status",
    "text",
    "created_at",
    "fetched_at",
  ] as const)
    if (input[key] != null && typeof input[key] !== "string") invalid();
  for (const key of [
    "budget",
    "bid",
    "schedule",
    "targeting",
    "tracking",
    "optimization",
    "fields",
    "sources",
    "raw_data",
    "extensions",
  ] as const)
    if (input[key] !== undefined && !record(input[key])) invalid();
  for (const value of Object.values(input.fields || {}))
    if (!FIELD_STATES.includes(value)) invalid();
  for (const value of Object.values(input.sources || {}))
    if (typeof value !== "string") invalid();
  for (const [group, keys] of Object.entries({
    budget: ["daily", "lifetime", "level", "unit", "inherited_from"],
    bid: ["amount", "strategy"],
    schedule: ["start", "end"],
    optimization: ["objective", "goal", "event"],
    tracking: ["url"],
  }))
    for (const key of keys) {
      const value = (input as Record<string, any>)[group]?.[key];
      if (value != null && typeof value !== "string") invalid();
    }
  for (const value of [
    input.budget?.daily,
    input.budget?.lifetime,
    input.bid?.amount,
  ])
    if (value != null && !/^[+-]?\d+(?:\.\d+)?$/.test(value)) invalid();
  for (const key of [
    "countries",
    "custom_audiences",
    "excluded_audiences",
  ] as const) {
    const value = input.targeting?.[key];
    if (
      value !== undefined &&
      (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    )
      invalid();
  }
  for (const value of [input.targeting?.age_min, input.targeting?.age_max])
    if (value != null && (!Number.isSafeInteger(value) || value < 0)) invalid();
  if (
    input.tracking?.parameters !== undefined &&
    (!record(input.tracking.parameters) ||
      Object.values(input.tracking.parameters).some(
        (value) => typeof value !== "string",
      ))
  )
    invalid();
  if (
    !PLATFORMS.includes(input.platform) ||
    !input.account_id.trim() ||
    !input.entity_id.trim() ||
    !input.entity_type.trim()
  )
    throw new Error(
      "광고 항목 정보가 올바르지 않습니다. 계정 연결을 확인하고 다시 조회해 주세요.",
    );
  const observed: Record<string, FieldState> = {};
  const paths = [
    "platform",
    "account_id",
    "entity_type",
    "entity_id",
    "parent_id",
    "name",
    "status",
    "effective_status",
    "currency",
    "timezone",
    "text",
    "created_at",
    "budget",
    "budget.daily",
    "budget.lifetime",
    "budget.level",
    "budget.unit",
    "budget.inherited_from",
    "bid",
    "bid.strategy",
    "bid.amount",
    "schedule",
    "schedule.start",
    "schedule.end",
    "targeting",
    "targeting.countries",
    "targeting.age_min",
    "targeting.age_max",
    "targeting.custom_audiences",
    "targeting.excluded_audiences",
    "tracking",
    "tracking.url",
    "tracking.parameters",
    "optimization",
    "optimization.objective",
    "optimization.goal",
    "optimization.event",
  ];
  for (const path of paths) {
    let current: any = input,
      present = true;
    for (const part of path.split(".")) {
      if (
        !current ||
        typeof current !== "object" ||
        !Object.hasOwn(current, part)
      ) {
        present = false;
        break;
      }
      current = current[part];
    }
    observed[path] = !present
      ? "NOT_RETURNED"
      : current == null
        ? "NOT_SET"
        : "PRESENT";
  }
  return {
    parent_id: null,
    name: "",
    status: null,
    effective_status: null,
    currency: "KRW",
    timezone: "Asia/Seoul",
    text: null,
    created_at: null,
    sources: {},
    raw_data: {},
    extensions: {},
    fetched_at: new Date().toISOString(),
    ...input,
    key: entityKey(input),
    fields: { ...observed, ...input.fields },
    budget: {
      daily: null,
      lifetime: null,
      level: "entity",
      inherited_from: null,
      unit: "major",
      ...input.budget,
    },
    bid: { strategy: null, amount: null, ...input.bid },
    schedule: { start: null, end: null, ...input.schedule },
    targeting: {
      countries: [],
      age_min: null,
      age_max: null,
      custom_audiences: [],
      excluded_audiences: [],
      ...input.targeting,
    },
    tracking: { url: null, parameters: {}, ...input.tracking },
    optimization: {
      objective: null,
      goal: null,
      event: null,
      ...input.optimization,
    },
  };
}
export const DEFAULT_SETTINGS: Settings = {
  mode: TEST_MODE ? "mock" : "live",
  ai_mode: "laya",
  database: TEST_MODE ? "data/testing/laya_ads_qa.db" : "data/production/laya_ads_qa.db",
  policy_directory: TEST_MODE ? "policies/local/testing" : "policies/local/production",
  cache_ttl_seconds: 300,
  batch_size: 8,
  semantic_threshold: 0.8,
  timezone: "Asia/Seoul",
  snapshot_interval_seconds: 0,
  preload_model: false,
  inference_backend: "onnx",
  onnx_directory: "data/models/releases",
  cpu_threads: 8,
  mock_dataset: "api",
};
export const createCoverage = (): Coverage => ({
  requested_count: null,
  fetched_count: 0,
  evaluated_count: 0,
  failed_count: 0,
  failed_requests: 0,
  skipped_count: 0,
  unknown_count: 0,
  complete: true,
  errors: [],
});
