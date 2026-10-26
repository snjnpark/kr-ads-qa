import { PLATFORMS, type Platform } from "../contracts/domain";
import type { Policy } from "../contracts/policy";
import { defaultAuditRules, auditRulesSchema, type AuditRuleConfiguration } from "../lib/audit-rules";
import { loadPolicy, policyYaml } from "../domain/policies/schema";
import type { BrowserStorage } from "./storage";

/** Policy writes join the surrounding BrowserStorage.atomic commit. */
export class BrowserPolicyManager {
  readonly directory = "브라우저 IndexedDB";
  constructor(readonly storage: BrowserStorage) {}
  private id(id: string): string {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(id) || id === "bindings") throw new Error("올바른 정책 ID가 필요합니다.");
    return id;
  }
  private nextVersion(id: string): number { return Math.max(0, ...this.versions(id).map(policy => policy.version)) + 1; }
  private persist(policy: Policy): Policy {
    this.id(policy.policy_id);
    this.storage.transaction(() => {
      const versionKey = `${policy.policy_id}/${policy.version}`;
      if (this.storage.get("policy_versions", versionKey)) throw new Error("같은 정책 버전이 이미 있습니다.");
      this.storage.put("policy_versions", versionKey, policy);
      this.storage.put("policies", policy.policy_id, policy);
    });
    return structuredClone(policy);
  }
  load(source: string | Record<string, unknown> | Policy): Policy { return loadPolicy(source); }
  validate(source: string | Record<string, unknown> | Policy): Policy { return loadPolicy(source); }
  yaml(policy: Policy): string { return policyYaml(policy); }
  create(source: Policy | Record<string, unknown>): Policy {
    const policy = loadPolicy(source);
    if (this.storage.get("policies", this.id(policy.policy_id))) throw new Error("같은 ID의 정책이 이미 있습니다.");
    policy.version = this.nextVersion(policy.policy_id); return this.persist(policy);
  }
  get(id: string, version?: number): Policy {
    this.id(id);
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw new Error("버전은 1 이상의 정수여야 합니다.");
    const value = this.storage.get(version === undefined ? "policies" : "policy_versions", version === undefined ? id : `${id}/${version}`);
    if (!value) throw new Error("선택한 정책 또는 버전을 찾을 수 없습니다.");
    return loadPolicy(value);
  }
  list(): Policy[] { return this.storage.keys("policies").map(id => this.get(id)); }
  versions(id: string): Policy[] {
    this.id(id);
    return this.storage.keys("policy_versions").filter(key => key.startsWith(`${id}/`))
      .map(key => loadPolicy(this.storage.get("policy_versions", key)!)).sort((a, b) => b.version - a.version);
  }
  update(source: Policy | Record<string, unknown>): Policy {
    const policy = loadPolicy(source), previous = this.get(policy.policy_id);
    if (policy.version !== previous.version) throw new Error("정책이 변경되었습니다. 최신 버전을 다시 불러와 주세요.");
    policy.version = this.nextVersion(policy.policy_id); return this.persist(policy);
  }
  clone(id: string, newId: string, name?: string): Policy {
    const policy = this.get(id); return this.create({ ...policy, policy_id: newId, name: name ?? policy.name, version: 1 });
  }
  delete(id: string): void {
    this.get(id);
    this.storage.transaction(() => {
      const bindings = Object.fromEntries(Object.entries(this.bindings()).filter(([, value]) => value !== id));
      this.storage.put("policy_bindings", "current", bindings); this.storage.delete("policies", id);
    });
  }
  bindings(): Record<string, string> {
    const value = this.storage.get("policy_bindings", "current") ?? {};
    if (Object.values(value).some(value => typeof value !== "string")) throw new Error("계정 정책 연결을 확인해 주세요.");
    return value as Record<string, string>;
  }
  auditRules(): AuditRuleConfiguration {
    const value = this.storage.get("audit_configuration", "current"); return value ? auditRulesSchema.parse(value) : defaultAuditRules();
  }
  saveAuditRules(input: unknown): AuditRuleConfiguration {
    const configuration = auditRulesSchema.parse(input);
    if (configuration.version !== this.auditRules().version) throw new Error("검사 항목이 변경되었습니다. 최신 설정을 다시 불러와 주세요.");
    const saved = { ...configuration, version: configuration.version + 1 };
    this.storage.put("audit_configuration", "current", saved); return saved;
  }
  bind(platform: string, accountId: string, policyId: string): void {
    const policy = this.get(policyId);
    if (!PLATFORMS.includes(platform as Platform) || !accountId.trim() || accountId.includes("/") || /[\r\n\0]/.test(accountId))
      throw new Error("플랫폼과 원본 계정 ID를 확인해 주세요.");
    if (!policy.platforms.includes(platform as Platform) || (policy.account_ids.length > 0 && !policy.account_ids.includes(accountId)))
      throw new Error("이 정책의 적용 범위에 포함되지 않은 계정입니다.");
    this.storage.put("policy_bindings", "current", { ...this.bindings(), [`${platform}/${accountId}`]: policyId });
  }
  forAccount(platform: string, accountId: string): Policy | null { const id = this.bindings()[`${platform}/${accountId}`]; return id ? this.get(id) : null; }
}
