import { executeApplicationQuery, type QueryResponse } from "./query";
export { actualConfiguration, type QueryResponse } from "./query";
import { sha256 } from "./crypto";
const randomUUID = () => crypto.randomUUID();
import {
  createCoverage,
  createEntity,
  type Account,
  type Entity,
  type Json,
  type Settings,
} from "../domain/entities";
import { BrowserStorage as Storage, type StorageSnapshot } from "./storage";

import {
  asPlatformError,
  PlatformError,
  type AdsPlatformAdapter,
} from "../platforms/base";
import { BrowserLayaEngine as LayaEngine } from "./model/engine";
import {
  BrowserPolicyManager as PolicyManager,
} from "./policies";
import { resolveParent } from "../domain/policies/evaluation";
import { QAEngine, RULES } from "../domain/qa/qa";
import { PRODUCT_RULES } from "../domain/qa/product-qa";
import { SnapshotManager, compareSnapshots } from "../domain/history";
import {
  emptyContext,
  type QueryContext,
} from "../domain/query/query";

import { enabledAuditRuleIds } from "../lib/audit-rules";
import { FrequencyAnomalyDetector } from "../domain/qa/anomaly";
import { productCode, productLabel } from "../lib/ad-products";

export type { Scope } from "../contracts/domain";
import type { Scope } from "../contracts/domain";

import { validateSettings } from "./settings";
export { validateScope } from "../domain/scope";
import { selected, scopeKey } from "../domain/scope";
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T> | T): Promise<T> {
    const next = this.tail.catch(() => undefined).then(operation);
    this.tail = next;
    return next;
  }
}
export class BrowserApplication {
  readonly storage: Storage;
  readonly policies: PolicyManager;
  readonly snapshots: SnapshotManager;
  readonly ai: LayaEngine;
  readonly mutex = new Mutex();
  adapters: Record<string, AdsPlatformAdapter>;
  entities: Entity[] = [];
  accounts: Account[] = [];
  catalog = new Map<string, Account>();
  coverage = createCoverage();
  lastSync: string | null = null;
  hydratedRevision = -1;
  source = "";
  private scope = "";
  private loadedScope: Scope = {};
  private timer?: ReturnType<typeof setInterval>;
  private schedulerPending = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private backupRestored = false;
  schedulerError = "";
  constructor(
    readonly settings: Settings,
    options: {
      adapters?: Record<string, AdsPlatformAdapter>;
      storage?: Storage;
      ai?: LayaEngine;
    } = {},
  ) {
    validateSettings(settings);
    if (!options.storage) throw new Error("브라우저 저장소를 먼저 열어 주세요.");
    this.storage = options.storage;
    this.policies = new PolicyManager(this.storage);
    this.snapshots = new SnapshotManager(this.storage);
    this.adapters = options.adapters ?? {};
    if (!options.ai) throw new Error("브라우저 모델 실행기가 필요합니다.");
    this.ai = options.ai;
  }
  async initialize() {
    this.hydratedRevision = this.storage.revision;
    this.catalog.clear(); this.entities = []; this.accounts = []; this.coverage = createCoverage(); this.lastSync = null;
    for (const account of this.storage.list<Account>("ad_accounts")) this.catalog.set(`${account.platform}/${account.account_id}`, account);
    const saved = this.storage.get<Json>("collections", "active");
    if (saved && Array.isArray(saved.entities)) {
      this.entities = saved.entities;
      this.accounts = Array.isArray(saved.accounts) ? saved.accounts : [];
      this.coverage = saved.coverage ?? createCoverage();
      this.lastSync = saved.last_sync ?? null;
      this.loadedScope = saved.scope ?? {};
      this.scope = scopeKey(this.loadedScope);
      this.source = "이 브라우저의 저장 데이터";
    }
  }
  assertAvailable() {
    if (this.backupRestored) throw new Error("백업 복원을 마쳤습니다. 새로고침한 뒤 인증 정보를 다시 연결해 주세요.");
  }
  async restoreBackup(snapshot: StorageSnapshot, signal?: AbortSignal) {
    await this.mutex.run(async () => {
      this.assertAvailable();
      await this.storage.atomic(() => this.storage.replace(snapshot), { signal });
      // Only a committed restore invalidates credentials, query context and active settings.
      this.backupRestored = true;
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      const adapters = Object.values(this.adapters); this.adapters = {};
      await Promise.allSettled(adapters.map(adapter => adapter.close()));
      await this.initialize();
    });
  }
  startScheduler() {
    if (this.backupRestored || this.timer || this.settings.snapshot_interval_seconds <= 0) return;
    this.timer = setInterval(() => {
      if (this.backupRestored || this.closing || this.schedulerPending || !Object.keys(this.adapters).length) return;
      this.schedulerPending = true;
      void this.mutex.run(async () => {
        if (this.backupRestored || this.closing || !Object.keys(this.adapters).length) return;
        try {
          await this.storage.atomic(async () => {
            if (this.hydratedRevision !== this.storage.revision) await this.initialize();
            await this.sync(this.loadedScope, true); this.saveSnapshot();
          });
          this.hydratedRevision = this.storage.revision; this.schedulerError = "";
        } catch {
          this.schedulerError = "자동 저장을 완료하지 못했습니다. 저장 공간과 탭 충돌을 확인해 주세요.";
          await this.storage.reload(); await this.initialize();
        }
      }).catch(() => undefined).finally(() => { this.schedulerPending = false; });
    }, this.settings.snapshot_interval_seconds * 1000);
  }
  async close() {
    if (!this.closePromise) {
      this.closing = true;
      if (this.timer) clearInterval(this.timer);
      this.closePromise = this.mutex.run(async () => {
        try {
          const results = await Promise.allSettled([this.ai, ...Object.values(this.adapters)].map(async resource => resource.close()));
          const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
          if (failures.length)
            throw new AggregateError(failures, "일부 연결을 종료하지 못했습니다.");
        } finally {
          this.storage.close();
        }
      });
    }
    return this.closePromise;
  }
  async sync(scope: Scope = {}, force = false) {
    const coverage = createCoverage(),
      accounts: Account[] = [],
      entities: Entity[] = [],
      cached: boolean[] = [];
    const fail = (message: string) => {
      coverage.complete = false;
      coverage.failed_requests++;
      coverage.failed_count = null;
      coverage.errors.push(message);
    };
    const adapters = Object.entries(this.adapters).filter(
      ([p]) => !scope.platforms?.length || scope.platforms.includes(p),
    );
    if (!adapters.length) {
      // A new tab has no credentials; saved collections remain available offline.
      const active = this.storage.get<Json>("collections", "active");
      if (active && Array.isArray(active.entities)) {
        this.entities = active.entities.filter((entity: Entity) => selected(entity, scope));
        this.accounts = (active.accounts ?? []).filter((account: Account) => selected(account, scope));
        this.coverage = { ...active.coverage, complete: false, errors: ["저장된 자료입니다. 이 탭에서 API를 연결하면 최신 데이터를 받을 수 있습니다."] };
        this.lastSync = active.last_sync ?? null;
      }
      this.source = "이 브라우저의 저장 데이터 · API 재연결 필요";
      return this.entities;
    }
    await Promise.all(
      adapters.map(async ([platform, adapter]) => {
        let found: Account[] = [];
        try {
          found = await adapter.listAccounts();
          const ids = new Set<string>();
          if (found.some(account => account.platform !== platform || !account.account_id || ids.has(account.account_id) || !ids.add(account.account_id)))
            throw new PlatformError("INVALID_RESPONSE", "광고 계정의 출처와 중복을 확인하지 못했습니다.");
        } catch (error) {
          const cause = asPlatformError(error);
          found = cause.partial_accounts.length
            ? cause.partial_accounts
            : cause.partial_entities.filter((e) => e.entity_type === "account");
          fail(`${platform}: 계정 목록 일부 조회 실패 (${cause.kind})`);
        }
        const validAccountIds = new Set<string>();
        found = found.filter(account => {
          if (!account || account.platform !== platform || typeof account.account_id !== "string" || !account.account_id || validAccountIds.has(account.account_id)) { fail(`${platform}: 계정 출처 또는 중복 오류`); return false; }
          validAccountIds.add(account.account_id); return true;
        });
        for (const account of found) {
          this.catalog.set(`${platform}/${account.account_id}`, account);
          if (!selected(account, scope)) continue;
          accounts.push(account);
          this.storage.put("ad_accounts", account.key, account);
          const key = `${platform}/${account.account_id}`,
            cache = force
              ? null
              : this.storage.cacheGet(key, this.settings.cache_ttl_seconds);
          if (cache) {
            entities.push(...cache);
            cached.push(true);
            continue;
          }
          try {
            const fetched = (await adapter.listEntities(account.account_id)).map(createEntity);
            const keys = new Set<string>();
            for (const entity of fetched) {
              if (entity.platform !== platform || entity.account_id !== account.account_id || keys.has(entity.key))
                throw new PlatformError("INVALID_RESPONSE", "광고 설정의 출처와 중복을 확인하지 못했습니다.");
              keys.add(entity.key);
            }
            entities.push(...fetched);
            this.storage.cachePut(key, fetched);
            cached.push(false);
          } catch (error) {
            const cause = asPlatformError(error);
            const partialKeys = new Set<string>();
            const partial: Entity[] = [];
            for (const raw of cause.partial_entities) {
              try {
                const entity = createEntity(raw);
                if (entity.platform !== platform || entity.account_id !== account.account_id || partialKeys.has(entity.key)) continue;
                partialKeys.add(entity.key); partial.push(entity);
              } catch { /* Invalid partial records are never published or persisted. */ }
            }
            entities.push(...partial);
            this.storage.cachePutPartial(key, partial, ["일부 광고 설정을 조회하지 못했습니다."], scope);
            fail(
              `${platform}/${account.account_id}: 일부 설정 조회 실패 (${cause.kind})`,
            );
          }
        }
      }),
    );
    for (const p of scope.platforms ?? [])
      if (!adapters.some(([key]) => key === p))
        fail(`${p}: 계정 연결이 없습니다.`);
    for (const account of scope.accounts ?? [])
      if (
        !accounts.some(
          (e) =>
            account === e.account_id ||
            account === `${e.platform}/${e.account_id}`,
        )
      )
        fail(`${account}: 선택한 계정을 확인하지 못했습니다.`);
    const unique = new Map<string, Entity>();
    for (const e of entities) {
      if (unique.has(e.key))
        fail(
          `${e.platform}/${e.account_id}: 중복된 광고 객체가 반환되었습니다.`,
        );
      unique.set(e.key, e);
    }
    this.entities = [...unique.values()].filter(entity => selected(entity, scope)).sort((a, b) =>
      a.key.localeCompare(b.key),
    );
    this.accounts = accounts.sort((a, b) => a.key.localeCompare(b.key));
    coverage.fetched_count = this.entities.length;
    coverage.requested_count = coverage.complete ? this.entities.length : null;
    this.coverage = coverage;
    this.scope = scopeKey(scope);
    this.loadedScope = structuredClone(scope);
    this.lastSync = new Date().toISOString();
    this.source = cached.length && cached.every(Boolean) ? "이 브라우저의 캐시" : "광고 API";
    // Incomplete collection remains visible but does not replace the last complete generation.
    if (coverage.complete) this.storage.put("collections", "active", {
      complete: true, entities: this.entities, accounts: this.accounts, coverage, last_sync: this.lastSync, scope: this.loadedScope,
    });
    if (!coverage.complete) this.storage.put("collection_attempts", randomUUID(), {
      complete: false, entities: this.entities, accounts: this.accounts, coverage,
      at: this.lastSync, scope: this.loadedScope,
    });
    return this.entities;
  }
  async ensureScope(scope: Scope) {
    const age = this.lastSync ? Date.now() - Date.parse(this.lastSync) : NaN;
    if (!Number.isFinite(age) || age < 0 || age >= this.settings.cache_ttl_seconds * 1000 || this.scope !== scopeKey(scope))
      await this.sync(scope);
  }
  private rowIdentity(entity: Entity, entities = this.entities): Json {
    const ancestors: Entity[] = [entity],
      visited = new Set<string>();
    let current: Entity | null = entity;
    while (current?.parent_id && !visited.has(current.key)) {
      visited.add(current.key);
      current = resolveParent(current, entities);
      if (current) ancestors.push(current);
    }
    const campaign = ancestors.find((item) => item.entity_type === "campaign"),
      group = ancestors.find((item) =>
        ["adgroup", "asset_group"].includes(item.entity_type),
      ),
      campaignId = campaign?.entity_id ?? group?.parent_id ?? "",
      groupId = group?.entity_id ??
        (["ad", "creative", "keyword"].includes(entity.entity_type)
          ? entity.parent_id ?? ""
          : ""),
      embeddedCampaign = group?.platform === "kakao"
        ? group.raw_data.campaign
        : null,
      campaignName = campaign?.name ??
        (embeddedCampaign &&
        String(embeddedCampaign.id) === campaignId &&
        String(embeddedCampaign.adAccountId) === entity.account_id &&
        typeof embeddedCampaign.name === "string"
          ? embeddedCampaign.name
          : "");
    return {
      account: entity.account_id,
      product_type: productCode(entity),
      product: productLabel(entity.platform, productCode(entity)),
      account_id: entity.account_id,
      account_name: this.catalog.get(`${entity.platform}/${entity.account_id}`)?.name ?? "",
      target_type: entity.entity_type,
      type: entity.entity_type,
      campaign_id: campaignId,
      campaign_name: campaignName,
      ad_group_id: groupId,
      ad_group_name: group?.name ?? "",
      campaign: campaignName,
      adgroup: group?.name ?? "",
    };
  }
  rows(entities = this.entities): Json[] {
    return entities.map((e) => {
      return {
        key: e.key,
        platform: e.platform,
        product_type: productCode(e),
        product: productLabel(e.platform, productCode(e)),
        ...this.rowIdentity(e),
        name: e.name,
        id: e.entity_id,
        status: e.status ?? "미조회",
        daily_budget: e.budget.daily ?? "—",
        currency: e.currency,
        fetched_at: e.fetched_at,
        result: "",
        reason: "광고 설정 조회",
      };
    });
  }
  state() {
    const audits = this.storage
      .list<Json>("audit_runs")
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return {
      settings: this.settings,
      scheduler_error: this.schedulerError,
      accounts: [...this.catalog.values()],
      loaded_accounts: this.accounts,
      entities: this.rows(),
      coverage: this.coverage,
      last_sync: this.lastSync,
      source: this.source,
      counts: Object.fromEntries(
        ["campaign", "adgroup", "ad", "keyword", "creative", "asset_group"].map(
          (kind) => [
            kind,
            this.entities.filter((e) => e.entity_type === kind).length,
          ],
        ),
      ),
      latest_audit: audits[0] ?? null,
      recent_audits: audits.slice(0, 20),
      recent_changes: this.storage
        .list<Json>("change_events")
        .flatMap((e) => e.rows ?? [])
        .slice(-10)
        .reverse(),
      policies: this.policies.list(),
      rule_options: { ...RULES, ...Object.fromEntries(Object.entries(PRODUCT_RULES).map(([id, rule]) => [id, rule.label])) },
      audit_rule_configuration: this.policies.auditRules(),
    };
  }
  audit(scope: Scope = {}, policyId?: string, ruleIds?: string[]) {
    const chosenPolicy = policyId ? this.policies.get(policyId) : null;
    const configuration = this.policies.auditRules();
    const entities = this.entities.filter((e) => selected(e, scope)),
      groups = [
        ...new Set(entities.map((e) => `${e.platform}/${e.account_id}`)),
      ],
      results: Json[] = [],
      versions: Json = {};
    for (const group of groups) {
      const [platform, ...id] = group.split("/"),
        account = id.join("/"),
        enabled = new Set(enabledAuditRuleIds(configuration, [platform]));
      const policy = chosenPolicy ?? this.policies.forAccount(platform, account);
      if (policy)
        versions[group] = {
          policy_id: policy.policy_id,
          version: policy.version,
        };
      results.push(
        ...new QAEngine().run(
          entities.filter((e) => `${e.platform}/${e.account_id}` === group),
          policy ?? undefined,
        ).filter(result => Boolean(result.evidence.policy_id) || enabled.has(result.rule_id) || (PRODUCT_RULES[result.rule_id] && enabled.has(PRODUCT_RULES[result.rule_id].base))),
      );
    }
    const filtered = (ruleIds
        ? results.filter((r) => ruleIds.includes(r.rule_id))
        : results).map((result) => this.withResultIdentity(result, entities)),
      counts: Record<string, number> = {};
    for (const r of filtered) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const coverage = {
        ...this.coverage,
        evaluated_count: new Set(filtered.map(result => result.evidence.entity_key)).size,
        unknown_count: new Set(
          filtered
            .filter((r) => r.status === "UNKNOWN")
            .map((r) => `${r.platform}/${r.account_id}/${r.entity_id}`),
        ).size,
      },
      runId = randomUUID(),
      rows = this.auditRows(runId, filtered);
    const record = {
      run_id: runId,
      at: new Date().toISOString(),
      counts,
      coverage,
      mode: this.settings.mode,
      scope,
      policy_versions: versions,
      selected_policy: chosenPolicy ? { policy_id: chosenPolicy.policy_id, name: chosenPolicy.name, version: chosenPolicy.version } : null,
      audit_rule_configuration: configuration,
      message: entities.length && !filtered.length
        ? chosenPolicy ? "선택한 정책에 적용 가능한 활성 조건이 없습니다. 운영 정책의 조건과 적용 범위를 확인해 주세요." : "선택한 검사 항목이 없습니다. 규칙 탭에서 검사 기준을 설정해 주세요."
        : entities.length
        ? `${coverage.evaluated_count}개 광고 설정에서 ${filtered.length}개 검사를 마쳤습니다.${coverage.complete ? "" : " 일부 계정을 조회하지 못해 확인한 설정만 검사했습니다."}`
        : "검사할 광고 설정이 없습니다. 계정 연결과 조회 범위를 확인해 주세요.",
    };
    this.storage.transaction(() => {
      this.storage.put("audit_runs", runId, record);
      this.storage.put("audit_results", runId, {
        run_id: runId,
        results: filtered,
        rows,
      });
    });
    return {
      ...record,
      rows,
      status: !entities.length
        ? "UNKNOWN"
        : !coverage.complete || !filtered.length
          ? "REVIEW"
          : counts.FAIL
            ? "FAIL"
            : counts.UNKNOWN || counts.REVIEW
              ? "REVIEW"
              : counts.WARNING
                ? "WARNING"
                : "PASS",
    };
  }
  private withResultIdentity(result: Json, entities: Entity[]) {
    const entity = entities.find((candidate) =>
      candidate.key === result.evidence?.entity_key &&
      candidate.platform === result.platform &&
      candidate.account_id === result.account_id &&
      candidate.entity_id === result.entity_id,
    );
    return entity
      ? {
          ...result,
          evidence: { ...result.evidence, details: this.rowIdentity(entity, entities) },
        }
      : result;
  }
  auditRows(id: string, results: Json[]) {
    return results.map((r, i) => ({
      key: `${id}/${i}`,
      platform: r.platform,
      account: r.account_id,
      account_id: r.account_id,
      account_name: r.evidence?.details?.account_name,
      target_type: r.evidence?.details?.target_type,
      type: r.evidence?.details?.target_type,
      campaign_id: r.evidence?.details?.campaign_id,
      campaign_name: r.evidence?.details?.campaign_name,
      campaign: r.evidence?.details?.campaign_name,
      ad_group_id: r.evidence?.details?.ad_group_id,
      ad_group_name: r.evidence?.details?.ad_group_name,
      adgroup: r.evidence?.details?.ad_group_name,
      name: r.entity_name,
      id: r.entity_id,
      status: r.status,
      result: r.status,
      rule_id: r.rule_id,
      severity: r.severity,
      expected: r.expected,
      actual: r.actual,
      reason: r.evidence?.rule_description ?? r.rule_id,
      evidence: r.evidence,
      fetched_at: r.checked_at,
    }));
  }
  getAudit(id: string) {
    const run = this.storage.get<Json>("audit_runs", id),
      data = this.storage.get<Json>("audit_results", id);
    if (!run || !data) throw new Error("검사 기록을 찾지 못했습니다.");
    return {
      ...run,
      rows: data.rows ?? this.auditRows(id, data.results ?? []),
    };
  }
  saveSnapshot() {
    const snapshot = this.snapshots.save(this.entities, {
      complete: this.coverage.complete,
      errors: this.coverage.errors,
      timezone: this.settings.timezone,
      scope: this.loadedScope,
    });
    return {
      ...snapshot,
      entity_count: snapshot.entities.length,
      entities: undefined,
    };
  }
  async compareHistory(before: string, after: string, scope: Scope = {}) {
    const previous = this.snapshots.get(before),
      current = this.snapshots.get(after);
    const first = {
        ...previous,
        entities: previous.entities.filter((entity) => selected(entity, { ...scope, products: undefined })),
      },
      second = {
        ...current,
        entities: current.entities.filter((entity) => selected(entity, { ...scope, products: undefined })),
      };
    const report = compareSnapshots(first, second, scope);
    if (!first.entities.length || !second.entities.length)
      report.warnings.push(
        "선택한 범위의 설정이 한쪽 저장 시점에 없습니다. 해당 매체·계정이 포함된 두 시점을 선택하세요.",
      );
    const rows = report.changes.map((c, i) => ({
      ...c,
      key: `${after}/${i}`,
      account: c.account_id,
      name: c.entity_name,
      id: c.entity_id,
      type: c.entity_type,
      result: "REVIEW",
      status: "REVIEW",
      reason: "저장한 설정 비교",
      fetched_at: c.observed_to,
    }));
    const response = {
      ...report,
      rows,
      scope,
      status: "REVIEW",
      message: `${rows.length}개 설정이 달라졌습니다.`,
    };
    const suffix =
      scope.platforms?.length || scope.accounts?.length || scope.products?.length
        ? `/${(await sha256(scopeKey(scope))).slice(0, 16)}`
        : "";
    this.storage.put("change_events", `${before}/${after}${suffix}`, response);
    return response;
  }
  async ask(
    text: string,
    context: QueryContext = emptyContext(),
    scope: Scope = {},
  ): Promise<QueryResponse> {
    return executeApplicationQuery(this, text, context, scope);
  }
  anomalies(scope: Scope) {
    const entities = this.entities.filter((e) => selected(e, scope)),
      findings = new FrequencyAnomalyDetector().run(entities)
        .map((result) => this.withResultIdentity(result, entities)),
      rows = this.auditRows(randomUUID(), findings).map((row) => ({
        ...row,
        reason: "같은 그룹의 다른 광고와 설정이 다릅니다.",
      }));
    return {
      rows,
      message: `같은 그룹에서 설정이 다른 항목 ${rows.length}개를 찾았습니다. 의도한 차이인지 확인해 주세요.`,
      status: "REVIEW",
      coverage: this.coverage,
    };
  }
  clearCache() {
    for (const key of this.storage.keys("cache")) this.storage.delete("cache", key);
    this.lastSync = null;
    return {
      message:
        "조회 데이터를 비웠습니다. 다음 조회에서 최신 설정을 가져옵니다.",
    };
  }
}
