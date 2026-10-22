import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createEntity, type Entity, type Json } from "./models";

export const DATA_DIR = resolve(
  /* turbopackIgnore: true */ process.env.LAYA_DATA_DIR || "data",
);
export const TABLES = [
  "platform_connections",
  "ad_accounts",
  "entity_snapshots",
  "audit_runs",
  "audit_results",
  "policies",
  "policy_versions",
  "custom_rules",
  "query_sessions",
  "query_history",
  "change_events",
  "model_evaluations",
  "cache",
] as const;
export class Storage {
  readonly database: DatabaseSync;
  constructor(path = "data/laya_ads_qa.db") {
    if (path !== ":memory:")
      mkdirSync(dirname(resolve(/* turbopackIgnore: true */ path)), {
        recursive: true,
      });
    this.database = new DatabaseSync(path, { timeout: 5000 });
    this.database.exec("PRAGMA journal_mode = WAL");
    for (const table of TABLES)
      this.database.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY NOT NULL, data JSON NOT NULL)`,
      );
  }
  private table(table: string) {
    if (!(TABLES as readonly string[]).includes(table))
      throw new Error("지원되지 않는 저장소입니다.");
    return table;
  }
  put(table: string, key: string, data: Json) {
    this.database
      .prepare(
        `INSERT INTO ${this.table(table)} (key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data`,
      )
      .run(key, JSON.stringify(data));
  }
  get<T = Json>(table: string, key: string): T | null {
    const row = this.database
      .prepare(`SELECT data FROM ${this.table(table)} WHERE key=?`)
      .get(key);
    return row ? (JSON.parse(String(row.data)) as T) : null;
  }
  list<T = Json>(table: string): T[] {
    return this.database
      .prepare(`SELECT data FROM ${this.table(table)} ORDER BY key`)
      .all()
      .map((row) => JSON.parse(String(row.data)) as T);
  }
  delete(table: string, key: string) {
    this.database
      .prepare(`DELETE FROM ${this.table(table)} WHERE key=?`)
      .run(key);
  }
  /** The callback must be synchronous: commit happens before this method returns. */
  transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "저장을 취소하지 못했습니다. 저장소 상태를 확인해 주세요.",
        );
      }
      throw error;
    }
  }
  cacheGet(key: string, ttl: number): Entity[] | null {
    if (!Number.isFinite(ttl) || ttl <= 0) return null;
    let record: Json | null;
    try {
      record = this.get("cache", key);
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
    if (
      !record ||
      record.complete === false ||
      typeof record.fetched_at !== "string" ||
      !Number.isFinite(Date.parse(record.fetched_at)) ||
      !Array.isArray(record.entities)
    )
      return null;
    const age = Date.now() - Date.parse(record.fetched_at);
    if (age < 0 || age >= ttl * 1000) return null;
    try {
      return record.entities.map((item: Entity) => createEntity(item));
    } catch {
      return null;
    }
  }
  cachePut(key: string, entities: Entity[]) {
    this.put("cache", key, {
      fetched_at: new Date().toISOString(),
      entities,
      complete: true,
    });
  }
  close() {
    this.database.close();
  }
}
