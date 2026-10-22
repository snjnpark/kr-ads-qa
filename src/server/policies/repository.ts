import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { stringify } from "yaml";
import { PLATFORMS, type Platform } from "../../contracts/domain";
import type { Policy } from "../../contracts/policy";
import { defaultAuditRules, auditRulesSchema, type AuditRuleConfiguration } from "../../lib/audit-rules";
import { loadPolicy, loadYaml, policyYaml } from "./schema";

export class PolicyManager {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = resolve(/* turbopackIgnore: true */ directory);
    mkdirSync(this.directory, { recursive: true });
  }
  private path(id: string): string {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(id) || id === "bindings")
      throw new Error("올바른 정책 ID가 필요합니다.");
    return join(this.directory, `${id}.yaml`);
  }
  private write(path: string, text: string): void {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  private nextVersion(id: string): number {
    this.path(id);
    const directory = join(this.directory, "versions", id);
    return existsSync(directory)
      ? Math.max(
          0,
          ...readdirSync(/* turbopackIgnore: true */ directory)
            .filter((name) => /^[1-9]\d*\.yaml$/.test(name))
            .map((name) => Number(name.slice(0, -5))),
        ) + 1
      : 1;
  }
  private persist(policy: Policy): Policy {
    const directory = join(this.directory, "versions", policy.policy_id);
    mkdirSync(directory, { recursive: true });
    const yaml = policyYaml(policy);
    const versionPath = join(directory, `${policy.version}.yaml`);
    const descriptor = openSync(versionPath, "wx", 0o600);
    try {
      try {
        writeFileSync(descriptor, yaml, { encoding: "utf8" });
      } finally {
        closeSync(descriptor);
      }
      this.write(this.path(policy.policy_id), yaml);
    } catch (error) {
      unlinkSync(versionPath);
      throw error;
    }
    return structuredClone(policy);
  }
  load(source: string | Record<string, unknown> | Policy): Policy {
    return loadPolicy(source);
  }
  validate(source: string | Record<string, unknown> | Policy): Policy {
    return loadPolicy(source);
  }
  yaml(policy: Policy): string {
    return policyYaml(policy);
  }
  create(source: Policy | Record<string, unknown>): Policy {
    const policy = loadPolicy(source);
    if (existsSync(this.path(policy.policy_id)))
      throw new Error("같은 ID의 정책이 이미 있습니다.");
    policy.version = this.nextVersion(policy.policy_id);
    return this.persist(policy);
  }
  get(id: string, version?: number): Policy {
    const current = this.path(id);
    if (
      version !== undefined &&
      (!Number.isSafeInteger(version) || version < 1)
    )
      throw new Error("버전은 1 이상의 정수여야 합니다.");
    const path =
      version === undefined
        ? current
        : join(this.directory, "versions", id, `${version}.yaml`);
    if (!existsSync(path))
      throw new Error("선택한 정책 또는 버전을 찾을 수 없습니다.");
    return loadPolicy(readFileSync(/* turbopackIgnore: true */ path, "utf8"));
  }
  list(): Policy[] {
    return readdirSync(/* turbopackIgnore: true */ this.directory)
      .filter((name) => name.endsWith(".yaml") && name !== "bindings.yaml")
      .sort()
      .map((name) => this.get(name.slice(0, -5)));
  }
  versions(id: string): Policy[] {
    this.path(id);
    const directory = join(this.directory, "versions", id);
    return existsSync(directory)
      ? readdirSync(/* turbopackIgnore: true */ directory)
          .filter((name) => /^[1-9]\d*\.yaml$/.test(name))
          .map((name) => Number(name.slice(0, -5)))
          .sort((a, b) => b - a)
          .map((version) => this.get(id, version))
      : [];
  }
  update(source: Policy | Record<string, unknown>): Policy {
    const policy = loadPolicy(source);
    const previous = this.get(policy.policy_id);
    if (policy.version !== previous.version)
      throw new Error("정책이 변경되었습니다. 최신 버전을 다시 불러와 주세요.");
    policy.version = this.nextVersion(policy.policy_id);
    return this.persist(policy);
  }
  clone(id: string, newId: string, name?: string): Policy {
    const policy = this.get(id);
    return this.create({
      ...policy,
      policy_id: newId,
      name: name ?? policy.name,
      version: 1,
    });
  }
  delete(id: string): void {
    const path = this.path(id);
    if (!existsSync(path)) throw new Error("삭제할 정책을 찾을 수 없습니다.");
    const previous = this.bindings();
    const bindings = Object.fromEntries(
      Object.entries(previous).filter(([, value]) => value !== id),
    );
    this.write(join(this.directory, "bindings.yaml"), stringify(bindings));
    try {
      unlinkSync(path);
    } catch (error) {
      try { this.write(join(this.directory, "bindings.yaml"), stringify(previous)); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "정책 삭제를 취소하지 못했습니다. 계정 연결을 확인해 주세요."); }
      throw error;
    }
  }
  bindings(): Record<string, string> {
    const path = join(this.directory, "bindings.yaml");
    if (!existsSync(path)) return {};
    const data = loadYaml(
      readFileSync(/* turbopackIgnore: true */ path, "utf8"),
    );
    if (Object.values(data).some((value) => typeof value !== "string"))
      throw new Error("계정 정책 연결 파일을 확인해 주세요.");
    return data as Record<string, string>;
  }
  auditRules(): AuditRuleConfiguration {
    const file = join(this.directory, "audit-checks.json");
    return existsSync(file)
      ? auditRulesSchema.parse(JSON.parse(readFileSync(/* turbopackIgnore: true */ file, "utf8")))
      : defaultAuditRules();
  }
  saveAuditRules(input: unknown): AuditRuleConfiguration {
    const configuration = auditRulesSchema.parse(input);
    if (configuration.version !== this.auditRules().version)
      throw new Error("검사 항목이 변경되었습니다. 최신 설정을 다시 불러와 주세요.");
    const saved = { ...configuration, version: configuration.version + 1 };
    this.write(join(this.directory, "audit-checks.json"), JSON.stringify(saved, null, 2));
    return saved;
  }
  bind(platform: string, accountId: string, policyId: string): void {
    const policy = this.get(policyId);
    if (
      !PLATFORMS.includes(platform as Platform) ||
      !accountId.trim() ||
      accountId.includes("/") ||
      /[\r\n\0]/.test(accountId)
    )
      throw new Error("플랫폼과 원본 계정 ID를 확인해 주세요.");
    if (
      !policy.platforms.includes(platform as Platform) ||
      (policy.account_ids.length > 0 && !policy.account_ids.includes(accountId))
    )
      throw new Error("이 정책의 적용 범위에 포함되지 않은 계정입니다.");
    this.write(
      join(this.directory, "bindings.yaml"),
      stringify({ ...this.bindings(), [`${platform}/${accountId}`]: policyId }),
    );
  }
  forAccount(platform: string, accountId: string): Policy | null {
    const id = this.bindings()[`${platform}/${accountId}`];
    return id ? this.get(id) : null;
  }
}

