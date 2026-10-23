import { PLATFORMS } from "../contracts/domain";
import { auditRulesSchema } from "../lib/audit-rules";
import { createEntity } from "../server/models";
import { loadPolicy } from "../server/policies/schema";
import { BrowserStorage, validateStorageSnapshot, type StorageSnapshot } from "./storage";

export const BACKUP_FORMAT = "laya-browser-backup";
const MAX_BYTES = 100 * 1024 * 1024;
type Backup = { format: typeof BACKUP_FORMAT; version: 1; created_at: string; sha256: string; data: StorageSnapshot };
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function digest(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("안전한 연결에서 백업을 사용할 수 있습니다. HTTPS 또는 localhost로 열어 주세요.");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}
function validScope(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, entries]) => ["platforms", "accounts", "products"].includes(key) && Array.isArray(entries) && entries.length <= 1000 &&
    entries.every(entry => typeof entry === "string" && entry.trim() && (key !== "platforms" || PLATFORMS.includes(entry as typeof PLATFORMS[number]))));
}
/** Validate semantic references too; a self-consistent hash alone is not trusted input. */
function validateContents(snapshot: StorageSnapshot): void {
  const policyVersions = new Map(snapshot.tables.policy_versions);
  const current = new Map(snapshot.tables.policies);
  for (const [key, raw] of snapshot.tables.policies) {
    const policy = loadPolicy(raw);
    if (key !== policy.policy_id || policy.policy_id === "bindings") throw new Error("백업의 정책 ID가 일치하지 않습니다.");
    const version = policyVersions.get(`${key}/${policy.version}`);
    if (!version || stable(loadPolicy(version)) !== stable(policy)) throw new Error("백업의 현재 정책과 버전 기록이 일치하지 않습니다.");
  }
  for (const [key, raw] of snapshot.tables.policy_versions) {
    const policy = loadPolicy(raw);
    if (key !== `${policy.policy_id}/${policy.version}` || policy.policy_id === "bindings") throw new Error("백업의 정책 버전을 확인해 주세요.");
  }
  for (const [key, bindings] of snapshot.tables.policy_bindings) {
    if (key !== "current") throw new Error("백업의 계정 연결 형식을 확인해 주세요.");
    for (const [account, policyId] of Object.entries(bindings)) {
      const slash = account.indexOf("/"), platform = account.slice(0, slash), accountId = account.slice(slash + 1);
      if (slash < 1 || !PLATFORMS.includes(platform as typeof PLATFORMS[number]) || !accountId.trim() || /[\r\n\0/]/.test(accountId) || typeof policyId !== "string" || !current.has(policyId))
        throw new Error("백업의 계정 정책 연결을 확인해 주세요.");
      const policy = loadPolicy(current.get(policyId)!);
      if (!policy.platforms.includes(platform as typeof PLATFORMS[number]) || (policy.account_ids.length && !policy.account_ids.includes(accountId)))
        throw new Error("백업의 정책 적용 범위와 계정 연결이 일치하지 않습니다.");
    }
  }
  for (const [key, configuration] of snapshot.tables.audit_configuration) {
    if (key !== "current") throw new Error("백업의 검사 설정을 확인해 주세요.");
    auditRulesSchema.parse(configuration);
  }
  for (const [key, entity] of snapshot.tables.ad_accounts) {
    validateEntities([entity]);
    if (createEntity(entity as Parameters<typeof createEntity>[0]).key !== key) throw new Error("백업의 계정 키가 일치하지 않습니다.");
  }
  for (const [key, value] of snapshot.tables.entity_snapshots) {
    if (key !== value.snapshot_id || typeof value.complete !== "boolean" || !Array.isArray(value.errors) || value.errors.some(item => typeof item !== "string") ||
        typeof value.created_at !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(value.created_at) || !Number.isFinite(Date.parse(value.created_at)) || !validScope(value.scope))
      throw new Error("백업의 스냅샷 범위와 완료 상태를 확인해 주세요.");
    validateEntities(value.entities);
  }
  for (const [, value] of snapshot.tables.cache) {
    if (value.complete !== true || !Number.isFinite(Date.parse(value.fetched_at))) throw new Error("백업의 정상 조회 캐시를 확인해 주세요.");
    validateEntities(value.entities);
  }
  for (const [key, value] of snapshot.tables.collections) {
    if (key !== "active" || value.complete !== true || !validScope(value.scope) || !Array.isArray(value.accounts) ||
        !value.coverage || value.coverage.complete !== true)
      throw new Error("백업의 마지막 정상 조회 범위와 완료 상태를 확인해 주세요.");
    validateEntities(value.entities); validateEntities(value.accounts);
  }
  for (const [, value] of snapshot.tables.collection_attempts) {
    if (value.complete !== false || !validScope(value.scope) || !Array.isArray(value.errors) || value.errors.some(item => typeof item !== "string"))
      throw new Error("백업의 부분 조회 범위와 상태를 확인해 주세요.");
    validateEntities(value.entities);
  }
}
function validateEntities(input: unknown): void {
  if (!Array.isArray(input)) throw new Error("백업의 광고 목록을 확인해 주세요.");
  const keys = new Set<string>();
  for (const raw of input) {
    const entity = createEntity(raw);
    if (stable(entity) !== stable(raw)) throw new Error("백업에 정규화되지 않은 광고 객체가 있습니다.");
    if (keys.has(entity.key)) throw new Error("백업의 광고 목록에 중복된 객체가 있습니다.");
    keys.add(entity.key);
  }
}
export async function exportBrowserBackup(storage: BrowserStorage): Promise<string> {
  const data = storage.snapshot(); validateStorageSnapshot(data); validateContents(data);
  const backup: Backup = { format: BACKUP_FORMAT, version: 1, created_at: new Date().toISOString(), sha256: await digest(stable(data)), data };
  const text = JSON.stringify(backup);
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error("백업 파일이 100 MiB 제한을 초과했습니다.");
  return text;
}
export async function parseBrowserBackup(text: string): Promise<StorageSnapshot> {
  if (typeof text !== "string" || text.length > MAX_BYTES || new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error("백업 파일이 100 MiB 제한을 초과했습니다.");
  let backup: Backup;
  try { backup = JSON.parse(text); } catch { throw new Error("올바른 JSON 백업 파일을 선택해 주세요."); }
  if (!backup || typeof backup !== "object" || Array.isArray(backup) || backup.format !== BACKUP_FORMAT || backup.version !== 1 ||
      typeof backup.created_at !== "string" || !Number.isFinite(Date.parse(backup.created_at)) || typeof backup.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(backup.sha256) ||
      Object.keys(backup).some(key => !["format", "version", "created_at", "sha256", "data"].includes(key)))
    throw new Error("지원하지 않는 백업 형식 또는 버전입니다.");
  validateStorageSnapshot(backup.data); validateContents(backup.data);
  if (await digest(stable(backup.data)) !== backup.sha256) throw new Error("백업 파일의 무결성 검증에 실패했습니다. 원본 파일을 다시 선택해 주세요.");
  return structuredClone(backup.data);
}
export async function importBrowserBackup(storage: BrowserStorage, text: string): Promise<void> {
  const snapshot = await parseBrowserBackup(text);
  await storage.atomic(() => storage.replace(snapshot));
}
