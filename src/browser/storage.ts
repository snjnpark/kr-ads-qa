import { createEntity, type Entity, type Json } from "../domain/entities";

// Credentials, query sessions and model input caches intentionally have no store.
export const TABLES = [
  "ad_accounts", "entity_snapshots", "audit_runs", "audit_results", "policies",
  "policy_versions", "custom_rules", "query_history", "change_events", "cache",
  "settings", "policy_bindings", "audit_configuration", "collection_attempts", "collections",
] as const;
export type StorageTable = typeof TABLES[number];
export type StorageTables = Record<StorageTable, [string, Json][]>;
export type StorageSnapshot = { schema: 1; revision: number; tables: StorageTables };
const STORE = "state", ACTIVE = "active";
const forbiddenFields = new Set([
  "credentials", "accesstoken", "refreshtoken", "apikey", "secretkey", "clientsecret",
  "secret", "password", "authorization", "appsecretproof", "signature", "privatekey",
]);
const safeSettings = new Set([
  "mode", "ai_mode", "database", "policy_directory", "cache_ttl_seconds", "batch_size",
  "semantic_threshold", "timezone", "snapshot_interval_seconds", "preload_model",
  "inference_backend", "onnx_directory", "cpu_threads", "mock_dataset",
]);
export class StorageConflictError extends Error {
  constructor() { super("다른 탭에서 데이터가 변경되었습니다. 최신 상태를 다시 불러온 뒤 시도해 주세요."); this.name = "StorageConflictError"; }
}
function tableName(table: string): StorageTable {
  if (!(TABLES as readonly string[]).includes(table)) throw new Error("지원되지 않는 브라우저 저장소입니다.");
  return table as StorageTable;
}
function record(value: unknown): value is Json { return !!value && typeof value === "object" && !Array.isArray(value); }
function keyName(key: unknown): asserts key is string {
  if (typeof key !== "string" || !key || key.length > 2048 || /[\0\r\n]/.test(key)) throw new Error("저장할 항목의 키를 확인해 주세요.");
}
/** Only JSON data, never accessors, class instances or credential-bearing objects. */
export function validatePersistentValue(value: unknown, allowUndefined = false): asserts value is Json {
  if (!record(value)) throw new Error("저장할 데이터 형식을 확인해 주세요.");
  const pending: { value: unknown; depth: number; exit?: boolean }[] = [{ value, depth: 0 }];
  let count = 0;
  const ancestors = new Set<object>();
  while (pending.length) {
    const item = pending.pop()!, current = item.value;
    if (item.exit) { ancestors.delete(current as object); continue; }
    if (++count > 1_000_000 || item.depth > 80) throw new Error("저장 데이터의 크기 또는 중첩 제한을 초과했습니다.");
    if (current === null || typeof current === "string" || typeof current === "boolean" || (allowUndefined && current === undefined)) continue;
    if (typeof current === "number" && Number.isFinite(current)) continue;
    if (typeof current !== "object") throw new Error("JSON 데이터만 브라우저에 저장할 수 있습니다.");
    if (ancestors.has(current)) throw new Error("순환 참조가 있는 데이터는 저장할 수 없습니다.");
    ancestors.add(current); pending.push({ value: current, depth: item.depth, exit: true });
    if (Object.getOwnPropertySymbols(current).length || (Array.isArray(current) && Object.keys(current).length !== current.length))
      throw new Error("JSON 데이터만 브라우저에 저장할 수 있습니다.");
    if (!Array.isArray(current) && ![Object.prototype, null].includes(Object.getPrototypeOf(current)))
      throw new Error("JSON 데이터만 브라우저에 저장할 수 있습니다.");
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
      if (Array.isArray(current) && key === "length") continue;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error("접근자 속성은 저장할 수 없습니다.");
      if (["__proto__", "prototype", "constructor"].includes(key) || forbiddenFields.has(key.toLowerCase().replace(/[_-]/g, "")))
        throw new Error("인증 정보 또는 허용되지 않은 속성은 브라우저 저장소·백업에 넣을 수 없습니다.");
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
}
function validateValue(table: StorageTable, value: unknown): asserts value is Json {
  validatePersistentValue(value);
  if (table === "settings" && Object.keys(value).some(key => !safeSettings.has(key)))
    throw new Error("허용된 앱 설정만 저장할 수 있습니다.");
}
export function validateStorageSnapshot(input: unknown): asserts input is StorageSnapshot {
  if (!record(input) || input.schema !== 1 || !Number.isSafeInteger(input.revision) || input.revision < 0 || !record(input.tables) ||
      Object.keys(input).some(key => !["schema", "revision", "tables"].includes(key)) ||
      Object.keys(input.tables).length !== TABLES.length || Object.keys(input.tables).some(table => !TABLES.includes(table as StorageTable)))
    throw new Error("지원하지 않는 브라우저 데이터 버전 또는 저장 형식입니다.");
  for (const table of TABLES) {
    const rows = input.tables[table];
    if (!Array.isArray(rows)) throw new Error("저장 테이블 형식을 확인해 주세요.");
    const keys = new Set<string>();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 2) throw new Error("저장 항목 형식을 확인해 주세요.");
      keyName(row[0]);
      if (keys.has(row[0])) throw new Error("저장 항목에 중복된 키가 있습니다.");
      keys.add(row[0]); validateValue(table, row[1]);
    }
  }
}
function empty(): StorageSnapshot {
  return { schema: 1, revision: 0, tables: Object.fromEntries(TABLES.map(table => [table, []])) as unknown as StorageTables };
}
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error("브라우저 저장소를 읽지 못했습니다.")); });
}
function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("브라우저 저장이 취소되었습니다."));
    transaction.onerror = () => { /* abort supplies the final failure and rollback. */ };
  });
}
export class BrowserStorage {
  private state: StorageSnapshot = empty();
  private baseline: StorageSnapshot = empty();
  private dirty = false;
  private closed = false;
  private committing = false;
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private readonly database: IDBDatabase) {
    database.onversionchange = () => this.close();
  }
  static async open(options: { databaseName?: string; factory?: IDBFactory } = {}): Promise<BrowserStorage> {
    const factory = options.factory ?? globalThis.indexedDB;
    if (!factory) throw new Error("이 브라우저에서 IndexedDB를 사용할 수 없습니다. 저장 권한과 개인정보 보호 설정을 확인해 주세요.");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(options.databaseName ?? "laya-ads-qa-production-v1", 1);
      let rejected = false;
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
      request.onsuccess = () => { if (rejected) request.result.close(); else resolve(request.result); };
      request.onerror = () => { rejected = true; reject(request.error ?? new Error("브라우저 저장소를 열지 못했습니다.")); };
      request.onblocked = () => { rejected = true; reject(new Error("다른 탭이 이전 저장소를 사용 중입니다. 해당 탭을 닫은 뒤 다시 시도해 주세요.")); };
    });
    const storage = new BrowserStorage(database);
    try { await storage.reload(); return storage; } catch (error) { storage.close(); throw error; }
  }
  get revision(): number { return this.state.revision; }
  get hasPendingChanges(): boolean { return this.dirty; }
  private writable(): void {
    if (this.closed) throw new Error("브라우저 저장소 연결이 종료되었습니다. 페이지를 다시 열어 주세요.");
    if (this.committing) throw new Error("저장 중에는 데이터를 변경할 수 없습니다.");
  }
  private rows(table: string): [string, Json][] { return this.state.tables[tableName(table)]; }
  put(table: string, key: string, data: Json): void {
    this.writable(); keyName(key); const name = tableName(table);
    // Match the previous JSON persistence contract: optional undefined properties are omitted.
    // Inspect descriptors first, so JSON.stringify cannot invoke a getter or toJSON method.
    validatePersistentValue(data, true);
    const saved: Json = JSON.parse(JSON.stringify(data)); validateValue(name, saved);
    const rows = this.rows(name), index = rows.findIndex(row => row[0] === key);
    if (index === -1) rows.push([key, saved]); else rows[index] = [key, saved];
    this.dirty = true;
  }
  get<T = Json>(table: string, key: string): T | null {
    const row = this.rows(table).find(row => row[0] === key);
    return row ? structuredClone(row[1]) as T : null;
  }
  keys(table: string): string[] { return this.rows(table).map(row => row[0]).sort(); }
  list<T = Json>(table: string): T[] { return [...this.rows(table)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(row => structuredClone(row[1]) as T); }
  delete(table: string, key: string): void {
    this.writable(); const rows = this.rows(table), index = rows.findIndex(row => row[0] === key);
    if (index !== -1) { rows.splice(index, 1); this.dirty = true; }
  }
  transaction<T>(operation: () => T): T {
    this.writable();
    if (operation.constructor.name === "AsyncFunction") throw new Error("동기 저장 트랜잭션에는 async 콜백을 사용할 수 없습니다.");
    const before = structuredClone(this.state), dirty = this.dirty;
    try {
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("동기 저장 트랜잭션에는 async 콜백을 사용할 수 없습니다.");
      return result;
    } catch (error) { this.state = before; this.dirty = dirty; throw error; }
  }
  cacheGet(key: string, ttl: number): Entity[] | null {
    if (!Number.isFinite(ttl) || ttl <= 0) return null;
    const value = this.get("cache", key);
    if (!value || value.complete !== true || typeof value.fetched_at !== "string" || !Array.isArray(value.entities)) return null;
    const age = Date.now() - Date.parse(value.fetched_at);
    if (!Number.isFinite(age) || age < 0 || age >= ttl * 1000) return null;
    try {
      const entities = value.entities.map((entity: Entity) => createEntity(entity));
      const keys = new Set<string>();
      for (const entity of entities) {
        if (`${entity.platform}/${entity.account_id}` !== key || keys.has(entity.key)) return null;
        keys.add(entity.key);
      }
      return entities;
    } catch { return null; }
  }
  cachePut(key: string, entities: Entity[]): void {
    const restored = entities.map(entity => createEntity(entity));
    this.put("cache", key, { fetched_at: new Date().toISOString(), entities: restored, complete: true });
    this.delete("collection_attempts", key);
  }
  /** Partial collections remain separate; they never replace the last complete generation. */
  cachePutPartial(key: string, entities: Entity[], errors: string[], scope: Json = {}): void {
    this.put("collection_attempts", key, { fetched_at: new Date().toISOString(), entities: entities.map(entity => createEntity(entity)), errors, scope, complete: false });
  }
  snapshot(): StorageSnapshot {
    if (this.dirty) throw new Error("진행 중인 저장을 마친 뒤 백업해 주세요.");
    return structuredClone(this.state);
  }
  replace(snapshot: StorageSnapshot): void {
    this.writable(); validateStorageSnapshot(snapshot);
    this.state = { ...structuredClone(snapshot), revision: this.state.revision }; this.dirty = true;
  }
  discard(): void { this.writable(); this.state = structuredClone(this.baseline); this.dirty = false; }
  async reload(): Promise<void> {
    this.writable(); if (this.dirty) throw new Error("저장 중인 변경을 먼저 저장하거나 취소해 주세요.");
    const transaction = this.database.transaction(STORE, "readonly"), done = complete(transaction);
    const [stored] = await Promise.all([requestResult(transaction.objectStore(STORE).get(ACTIVE)), done]);
    const snapshot: unknown = stored ?? empty(); validateStorageSnapshot(snapshot);
    this.state = snapshot; this.baseline = structuredClone(snapshot);
  }
  async commit(options: { signal?: AbortSignal } = {}): Promise<void> {
    this.writable(); if (!this.dirty) return;
    validateStorageSnapshot(this.state);
    const candidate = structuredClone(this.state); candidate.revision++;
    if (!Number.isSafeInteger(candidate.revision)) throw new Error("브라우저 데이터 버전 한도를 초과했습니다.");
    this.committing = true;
    try {
      if (options.signal?.aborted) throw new DOMException("작업이 취소되었습니다.", "AbortError");
      await new Promise<void>((resolve, reject) => {
        const transaction = this.database.transaction(STORE, "readwrite"), store = transaction.objectStore(STORE);
        let failure: unknown;
        const cleanup = () => options.signal?.removeEventListener("abort", abort);
        const abort = () => {
          failure = new DOMException("작업이 취소되었습니다.", "AbortError");
          try { transaction.abort(); } catch { /* A completed transaction is already committed. */ }
        };
        transaction.oncomplete = () => { cleanup(); resolve(); };
        transaction.onerror = () => { /* abort handles quota, disk and request failures. */ };
        transaction.onabort = () => { cleanup(); reject(failure ?? transaction.error ?? new Error("브라우저 저장이 취소되었습니다.")); };
        const request = store.get(ACTIVE);
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
        request.onsuccess = () => {
          try {
            if ((request.result?.revision ?? 0) !== this.baseline.revision) throw new StorageConflictError();
            store.put(candidate, ACTIVE);
          } catch (error) { failure = error; transaction.abort(); }
        };
      });
      this.state = candidate; this.baseline = structuredClone(candidate); this.dirty = false;
    } catch (error) {
      this.state = structuredClone(this.baseline); this.dirty = false; throw error;
    } finally { this.committing = false; }
  }
  /** The app must await this before publishing any mutation result to the UI. */
  atomic<T>(operation: () => T | Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
    const execute = async (): Promise<T> => {
      this.writable();
      if (!this.dirty) await this.reload();
      const cancelled = () => { if (options.signal?.aborted) throw new DOMException("작업이 취소되었습니다.", "AbortError"); };
      try { cancelled(); const result = await operation(); cancelled(); await this.commit({ signal: options.signal }); return result; }
      catch (error) { if (!this.committing) { this.state = structuredClone(this.baseline); this.dirty = false; } throw error; }
    };
    const result = this.queue.then(execute, execute); this.queue = result.catch(() => undefined); return result;
  }
  close(): void { this.database.close(); this.closed = true; }
}
