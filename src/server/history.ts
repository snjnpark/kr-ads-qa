const randomUUID = () => crypto.randomUUID();
import { DateTime } from "luxon";
import {
  createEntity,
  entityKey,
  PLATFORMS,
  type Account,
  type Entity,
  type NativeEvent,
  type Platform,
} from "./models";
import { decimal, deepEqual } from "./policies/values";
import { observe } from "./policies/evaluation";
import type { BrowserStorage } from "../browser/storage";
type Storage = Pick<BrowserStorage, "get" | "put" | "list" | "delete">;
import { productKey } from "../lib/ad-products";
import { PlatformError } from "./platforms/base";

export type { Scope as SnapshotScope } from "../contracts/domain";
import type { Scope as SnapshotScope } from "../contracts/domain";

export type Snapshot = {
  snapshot_id: string;
  created_at: string;
  entities: Entity[];
  complete: boolean;
  errors: string[];
  timezone: string;
  scope?: SnapshotScope;
};
export type SnapshotOptions = {
  complete?: boolean;
  errors?: string[];
  timezone?: string;
  created_at?: string;
  scope?: SnapshotScope;
};
export type Change = {
  platform: Platform;
  account_id: string;
  entity_type: string;
  entity_id: string;
  entity_name: string;
  field: string;
  before: unknown;
  after: unknown;
  change_type: "CREATED" | "REMOVED" | "MODIFIED";
  source: "local_snapshot";
  before_snapshot_id: string;
  after_snapshot_id: string;
  observed_from: string;
  observed_to: string;
};
export type DiffReport = {
  changes: Change[];
  warnings: string[];
  skipped_fields: Record<string, string>[];
  comparable: boolean;
  complete: boolean;
};
export const COMPARABLE_FIELDS = [
  "name",
  "parent_id",
  "status",
  "effective_status",
  "currency",
  "timezone",
  "budget.daily",
  "budget.lifetime",
  "budget.level",
  "budget.inherited_from",
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
  "text",
  "tracking.url",
  "tracking.parameters",
  "extensions.product_type",
  "extensions.product_subtype",
  "extensions.product_settings",
  "extensions.landing_urls",
  "extensions.assets",
  "extensions.shopping_products",
  "extensions.listing_group_filters",
  "extensions.targeting_criteria",
  "extensions.conversion_configuration",
  "extensions.creative_id",
];
const SET_FIELDS = new Set([
  "targeting.countries",
  "targeting.custom_audiences",
  "targeting.excluded_audiences",
]);
const PRODUCT_COLLECTION_FIELDS = new Set(["extensions.landing_urls", "extensions.assets", "extensions.shopping_products", "extensions.listing_group_filters", "extensions.targeting_criteria"]);
function collectionValues(values: unknown[]): string[] {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
  return values.map(value => JSON.stringify(stable(value))).sort();
}
function awareTime(value: string): number {
  if (
    typeof value !== "string" ||
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    throw new Error("시각에는 유효한 ISO 시간대가 필요합니다.");
  const parsed = DateTime.fromISO(value, { setZone: true });
  if (!parsed.isValid)
    throw new Error("시각에는 유효한 ISO 시간대가 필요합니다.");
  return parsed.toMillis();
}
function validateSnapshotScope(scope?: SnapshotScope): void {
  if (scope !== undefined) {
    if (!scope || typeof scope !== "object" || Array.isArray(scope))
      throw new Error("저장 기록의 조회 범위를 확인해 주세요.");
    for (const field of ["platforms", "accounts", "products"] as const) {
      const values = scope[field];
      if (values !== undefined && (!Array.isArray(values) || values.length > 1000 || values.some(value => typeof value !== "string" || !value.trim())))
        throw new Error("저장 기록의 조회 범위를 확인해 주세요.");
    }
  }
}
function validateSnapshot(snapshot: Snapshot): void {
  awareTime(snapshot.created_at);
  validateSnapshotScope(snapshot.scope);
  if (
    new Set(snapshot.entities.map(entityKey)).size !== snapshot.entities.length
  )
    throw new Error("스냅샷에 동일한 광고 객체가 중복되었습니다.");
}

export class SnapshotManager {
  constructor(
    readonly storage: Pick<Storage, "put" | "get" | "list" | "delete">,
  ) {}
  save(entities: Entity[], options: SnapshotOptions = {}): Snapshot {
    const snapshot: Snapshot = {
      snapshot_id: randomUUID().replaceAll("-", ""),
      created_at: options.created_at ?? new Date().toISOString(),
      entities: structuredClone(entities),
      complete: options.complete ?? true,
      errors: [...(options.errors ?? [])],
      timezone: options.timezone ?? "Asia/Seoul",
      ...(options.scope === undefined ? {} : { scope: structuredClone(options.scope) }),
    };
    validateSnapshot(snapshot);
    this.storage.put("entity_snapshots", snapshot.snapshot_id, snapshot);
    return snapshot;
  }
  get(id: string): Snapshot {
    const snapshot = this.storage.get<Snapshot>("entity_snapshots", id);
    if (!snapshot) throw new Error("선택한 스냅샷을 찾을 수 없습니다.");
    const restored = {
      ...snapshot,
      entities: snapshot.entities.map((entity) => createEntity(entity)),
    };
    validateSnapshot(restored);
    return restored;
  }
  list(): Snapshot[] {
    return this.storage
      .list<Snapshot>("entity_snapshots")
      .map((snapshot) => this.get(snapshot.snapshot_id))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }
  delete(id: string): void {
    this.storage.delete("entity_snapshots", id);
  }
  compare(beforeId: string, afterId: string): DiffReport {
    return compareSnapshots(this.get(beforeId), this.get(afterId));
  }
}

export function compareSnapshots(
  before: Snapshot,
  after: Snapshot,
  scope?: SnapshotScope,
): DiffReport {
  validateSnapshot(before);
  validateSnapshot(after);
  validateSnapshotScope(scope);
  if (awareTime(before.created_at) >= awareTime(after.created_at))
    throw new Error("이전 스냅샷은 이후 스냅샷보다 빨라야 합니다.");
  if (scope?.platforms?.length || scope?.accounts?.length) {
    const within = (entity: Entity) => (!scope.platforms?.length || scope.platforms.includes(entity.platform)) &&
      (!scope.accounts?.length || scope.accounts.includes(entity.account_id) || scope.accounts.includes(`${entity.platform}/${entity.account_id}`));
    before = { ...before, entities: before.entities.filter(within) };
    after = { ...after, entities: after.entities.filter(within) };
  }
  const observedBefore = new Set(before.entities.map(entityKey)), observedAfter = new Set(after.entities.map(entityKey));
  const beforeProducts = new Set(before.scope?.products ?? []), afterProducts = new Set(after.scope?.products ?? []);
  const requestedProducts = new Set(scope?.products ?? []);
  const productWarnings: string[] = [], productSkipped: Record<string, string>[] = [];
  if (beforeProducts.size || afterProducts.size || requestedProducts.size) {
    const common = new Set(beforeProducts.size ? beforeProducts : afterProducts.size ? afterProducts : requestedProducts);
    for (const products of [afterProducts, requestedProducts])
      if (products.size) for (const product of common) if (!products.has(product)) common.delete(product);
    // An old snapshot with no scope metadata cannot prove that another product was read.
    if (!before.scope || !after.scope || !common.size) {
      return {
        changes: [], comparable: false, complete: false,
        warnings: ["두 저장 기록에 공통으로 조회된 광고상품 범위를 확인할 수 없어 비교하지 않았습니다."],
        skipped_fields: [...new Set([...before.entities, ...after.entities].map(entityKey))].map(key => ({ entity_key: key, field: "__entity__", reason: "product scope not observed in both snapshots" })),
      };
    }
    const within = (entity: Entity) => common.has(productKey(entity) ?? "");
    for (const entity of [...before.entities, ...after.entities])
      if (!within(entity)) productSkipped.push({ entity_key: entity.key, field: "__entity__", reason: "outside common product scope" });
    if (!deepEqual([...beforeProducts].sort(), [...afterProducts].sort()))
      productWarnings.push("조회한 광고상품이 달라 두 기록에 공통으로 포함된 광고상품만 비교했습니다.");
    before = { ...before, entities: before.entities.filter(within) };
    after = { ...after, entities: after.entities.filter(within) };
  }
  const previous = new Map(
    before.entities.map((entity) => [entityKey(entity), entity]),
  );
  const current = new Map(
    after.entities.map((entity) => [entityKey(entity), entity]),
  );
  const report: DiffReport = {
    changes: [],
    warnings: productWarnings,
    skipped_fields: productSkipped,
    comparable: [...previous.keys()].some((key) => current.has(key)),
    complete:
      before.complete &&
      after.complete &&
      !before.errors.length &&
      !after.errors.length,
  };
  if (!report.complete)
    report.warnings.push(
      "부분 조회 기록이 포함되어 추가·삭제 여부는 확인할 수 없습니다.",
    );
  if (before.timezone !== after.timezone)
    report.warnings.push(
      "두 저장 기록의 시간대가 달라 같은 기준 시각으로 비교했습니다.",
    );
  const oldScopes = new Set(
    before.entities.map((item) => `${item.platform}/${item.account_id}`),
  );
  const newScopes = new Set(
    after.entities.map((item) => `${item.platform}/${item.account_id}`),
  );
  if (!deepEqual([...oldScopes].sort(), [...newScopes].sort()))
    report.warnings.push(
      "조회한 계정이 달라 두 기록에 공통으로 포함된 계정만 비교했습니다.",
    );
  const append = (
    entity: Entity,
    field: string,
    first: unknown,
    second: unknown,
    changeType: Change["change_type"],
  ) =>
    report.changes.push({
      platform: entity.platform,
      account_id: entity.account_id,
      entity_type: entity.entity_type,
      entity_id: entity.entity_id,
      entity_name: entity.name,
      field,
      before: first,
      after: second,
      change_type: changeType,
      source: "local_snapshot",
      before_snapshot_id: before.snapshot_id,
      after_snapshot_id: after.snapshot_id,
      observed_from: before.created_at,
      observed_to: after.created_at,
    });
  for (const key of [
    ...new Set([...previous.keys(), ...current.keys()]),
  ].sort()) {
    const old = previous.get(key),
      next = current.get(key);
    const entity = next ?? old!;
    if (!old || !next) {
      if ((!old && observedBefore.has(key)) || (!next && observedAfter.has(key))) {
        report.skipped_fields.push({ entity_key: key, field: "__entity__", reason: "product classification differs or is unavailable" });
        continue;
      }
      const scope = `${entity.platform}/${entity.account_id}`;
      if (report.complete && oldScopes.has(scope) && newScopes.has(scope))
        append(
          entity,
          "__entity__",
          old?.name ?? null,
          next?.name ?? null,
          next ? "CREATED" : "REMOVED",
        );
      continue;
    }
    for (const path of COMPARABLE_FIELDS) {
      const first = observe(old, path),
        second = observe(next, path);
      if (!first.known || !second.known) {
        report.skipped_fields.push({
          entity_key: key,
          field: path,
          before_state: first.state,
          after_state: second.state,
        });
        continue;
      }
      if (
        ["budget.daily", "budget.lifetime", "bid.amount"].includes(path) &&
        (old.currency !== next.currency ||
          old.budget.unit !== "major" ||
          next.budget.unit !== "major")
      ) {
        report.skipped_fields.push({
          entity_key: key,
          field: path,
          reason: "currency/unit differs or is unnormalized",
        });
        continue;
      }
      let oldValue = first.value,
        newValue = second.value;
      let oldNormal = oldValue,
        newNormal = newValue;
      if (["budget.daily", "budget.lifetime", "bid.amount"].includes(path)) {
        const firstAmount = oldValue == null ? null : decimal(oldValue);
        const secondAmount = newValue == null ? null : decimal(newValue);
        if (
          (oldValue != null && !firstAmount) ||
          (newValue != null && !secondAmount)
        ) {
          report.skipped_fields.push({
            entity_key: key,
            field: path,
            reason: "invalid monetary value",
          });
          continue;
        }
        oldNormal = firstAmount?.toFixed() ?? null;
        newNormal = secondAmount?.toFixed() ?? null;
      }
      if (path === "schedule.start" || path === "schedule.end") {
        try {
          oldNormal = oldValue == null ? null : awareTime(String(oldValue));
          newNormal = newValue == null ? null : awareTime(String(newValue));
        } catch {
          report.skipped_fields.push({
            entity_key: key,
            field: path,
            reason: "timezone missing or invalid time",
          });
          continue;
        }
      }
      if (SET_FIELDS.has(path)) {
        oldNormal = [
          ...new Set(Array.isArray(oldValue) ? oldValue : []),
        ].sort();
        newNormal = [
          ...new Set(Array.isArray(newValue) ? newValue : []),
        ].sort();
      }
      if (PRODUCT_COLLECTION_FIELDS.has(path) && Array.isArray(oldValue) && Array.isArray(newValue)) {
        oldNormal = collectionValues(oldValue);
        newNormal = collectionValues(newValue);
      }
      if (!deepEqual(oldNormal, newNormal))
        append(next, path, oldValue, newValue, "MODIFIED");
    }
  }
  report.comparable = report.comparable || report.changes.length > 0;
  if (!report.comparable)
    report.warnings.push("두 저장 시점에 공통으로 조회된 광고가 없습니다.");
  return report;
}

export interface HistoryAdapter {
  getCapabilities(): Promise<Record<string, unknown>> | Record<string, unknown>;
  listAccounts(): Promise<Account[]>;
  getChangeHistory?(
    accountId: string,
    start: Date,
    end: Date,
  ): Promise<NativeEvent[]>;
}
export interface HistoryApplication {
  adapters: Record<string, HistoryAdapter> | Map<Platform, HistoryAdapter>;
  storage: Pick<Storage, "put">;
}
export type HistoryScope = {
  platforms?: string[] | null;
  accounts?: string[] | null;
  products?: string[] | null;
};
type NativeError = {
  platform: string | null;
  account_id: string | null;
  stage: string;
  kind: string;
  cause_kind: string;
  reason: string;
};
type PartialHistoryError = Error & {
  kind?: string;
  cause_kind?: string;
  cause?: { kind?: string };
  partial_accounts?: Account[];
  partial_entities?: Entity[];
  partial_events?: NativeEvent[];
};

export async function queryNativeHistory(
  application: HistoryApplication,
  start: string | Date,
  end: string | Date,
  scope: HistoryScope = {},
) {
  const startText = start instanceof Date ? start.toISOString() : start;
  const endText = end instanceof Date ? end.toISOString() : end;
  const startMs = awareTime(startText),
    endMs = awareTime(endText);
  if (startMs >= endMs || endMs > Date.now())
    throw new Error("과거의 유효한 시작·종료 범위를 입력해 주세요.");
  if (scope.products?.length)
    throw new PlatformError("UNSUPPORTED", "매체의 원본 변경 이력은 광고상품별 조회 범위를 검증할 수 없습니다. 상품 선택을 해제하거나 저장한 설정 비교를 사용해 주세요.");
  const selected = scope.platforms?.length ? new Set(scope.platforms) : null;
  if (
    selected &&
    [...selected].some((platform) => !PLATFORMS.includes(platform as Platform))
  )
    throw new Error("지원되는 플랫폼을 선택해 주세요.");
  const scopeAccounts = new Set(scope.accounts ?? []);
  for (const account of scopeAccounts) {
    if (typeof account !== "string" || !account.trim())
      throw new Error("조회할 계정 ID가 올바르지 않습니다.");
    if (account.includes("/")) {
      const [platform, id, extra] = account.split("/");
      if (
        !PLATFORMS.includes(platform as Platform) ||
        !id ||
        extra !== undefined
      )
        throw new Error("계정 범위는 플랫폼/계정ID 형식이어야 합니다.");
    }
  }
  const errors: NativeError[] = [],
    events: NativeEvent[] = [],
    queried: string[] = [];
  const seenAccounts = new Set<string>();
  const entries =
    application.adapters instanceof Map
      ? [...application.adapters.entries()]
      : Object.entries(application.adapters);
  const candidates = entries.filter(
    ([platform]) => !selected || selected.has(platform),
  );
  function failure(
    platform: string | null,
    accountId: string | null,
    stage: string,
    error: unknown,
    fallbackKind = "FETCH_FAILED",
  ) {
    const typed = error as PartialHistoryError;
    errors.push({
      platform,
      account_id: accountId,
      stage,
      kind: typed?.kind ?? fallbackKind,
      cause_kind:
        typed?.cause_kind ?? typed?.cause?.kind ?? typed?.kind ?? "Error",
      reason:
        typed?.kind || fallbackKind !== "FETCH_FAILED"
          ? (typed?.message ?? "변경 이력 처리 중 오류가 발생했습니다.")
          : "변경 이력 처리 중 오류가 발생했습니다.",
    });
  }
  function retain(platform: string, accountId: string, values: NativeEvent[]) {
    for (const event of values) {
      let valid = false;
      try {
        const occurred = awareTime(event.timestamp);
        valid =
          event.source === "platform_change_log" &&
          event.platform === platform &&
          event.account_id === accountId &&
          startMs <= occurred &&
          occurred < endMs;
      } catch {
        /* Invalid platform records are reported, never guessed. */
      }
      if (!valid) {
        failure(
          platform,
          accountId,
          "normalize",
          new Error("이벤트의 계정·출처·실제 시각을 확인하지 못했습니다."),
          "INVALID_RESPONSE",
        );
        continue;
      }
      events.push(event);
    }
  }
  for (const platform of selected ?? [])
    if (!candidates.some(([name]) => name === platform))
      failure(
        platform,
        null,
        "connection",
        new Error("연결된 매체가 아닙니다."),
        "CONFIGURATION",
      );
  if (!candidates.length && !errors.length)
    failure(
      null,
      null,
      "connection",
      new Error("연결된 매체가 없습니다."),
      "CONFIGURATION",
    );
  for (const [platform, adapter] of candidates) {
    if (
      scopeAccounts.size &&
      ![...scopeAccounts].some(
        (value) => !value.includes("/") || value.startsWith(`${platform}/`),
      )
    )
      continue;
    try {
      const capabilities = await adapter.getCapabilities();
      if (
        capabilities.mode === "mock" ||
        capabilities.change_history === "UNSUPPORTED" ||
        typeof adapter.getChangeHistory !== "function"
      ) {
        failure(
          platform,
          null,
          "capability",
          new Error("이 연결에서는 변경 기록을 제공하지 않습니다."),
          "UNSUPPORTED",
        );
        continue;
      }
    } catch (error) {
      failure(platform, null, "capability", error);
      continue;
    }
    let found: Account[];
    try {
      found = await adapter.listAccounts();
    } catch (error) {
      const typed = error as PartialHistoryError;
      found =
        typed.partial_accounts ??
        typed.partial_entities?.filter(
          (entity) => entity.entity_type === "account",
        ) ??
        [];
      failure(platform, null, "accounts", error);
    }
    for (const account of found) {
      const key = `${platform}/${account.account_id}`;
      if (
        scopeAccounts.size &&
        !scopeAccounts.has(key) &&
        !scopeAccounts.has(account.account_id)
      )
        continue;
      if (seenAccounts.has(key)) continue;
      if (account.platform !== platform) {
        failure(
          platform,
          null,
          "accounts",
          new Error("계정의 매체가 일치하지 않습니다."),
          "INVALID_RESPONSE",
        );
        continue;
      }
      seenAccounts.add(key);
      try {
        retain(
          platform,
          account.account_id,
          await adapter.getChangeHistory!(
            account.account_id,
            new Date(startMs),
            new Date(endMs),
          ),
        );
        queried.push(key);
      } catch (error) {
        retain(
          platform,
          account.account_id,
          (error as PartialHistoryError).partial_events ?? [],
        );
        failure(platform, account.account_id, "events", error);
      }
    }
    if (!found.length && !errors.some((error) => error.platform === platform))
      failure(
        platform,
        null,
        "accounts",
        new Error("접근 가능한 광고 계정이 없습니다."),
        "NOT_FOUND",
      );
  }
  for (const value of scopeAccounts)
    if (
      ![...seenAccounts].some(
        (key) => value === key || value === key.slice(key.indexOf("/") + 1),
      )
    )
      failure(
        value.includes("/") ? value.split("/")[0] : null,
        value,
        "scope",
        new Error("선택한 계정이 이번 계정 목록에서 확인되지 않았습니다."),
        "NOT_RETURNED",
      );
  events.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const runId = randomUUID().replaceAll("-", "");
  const complete = errors.length === 0;
  const report = {
    run_id: runId,
    record_type: "native_history_query",
    source: "platform_change_log",
    at: new Date().toISOString(),
    range: { start: startText, end: endText, end_exclusive: true },
    scope: {
      platforms: selected ? [...selected].sort() : null,
      accounts: scopeAccounts.size ? [...scopeAccounts].sort() : null,
    },
    capability_status: "PARTIAL",
    status: events.length || complete ? "REVIEW" : "UNKNOWN",
    complete,
    events,
    rows: events.map((event, index) => ({
      ...event,
      key: `native/${runId}/${index}`,
      account: event.account_id,
      actor:
        event.actor?.name ??
        event.actor?.email ??
        event.actor?.id ??
        (Object.keys(event.actor ?? {}).length
          ? JSON.stringify(event.actor)
          : null),
    })),
    errors,
    coverage: {
      requested_count: null,
      fetched_count: events.length,
      queried_accounts: queried,
      failed_requests: errors.length,
      complete,
    },
    message: `변경 기록 ${events.length}개를 조회했습니다. ${errors.length ? "일부 기록을 가져오지 못했습니다. " : ""}매체에서 제공하는 기록만 표시합니다.`,
  };
  application.storage.put("change_events", `native/${runId}`, report);
  return report;
}
