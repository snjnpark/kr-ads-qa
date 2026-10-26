import type { Account, Entity, Json, NativeEvent, Platform } from "../domain/entities";
export class PlatformError extends Error {
  partial_entities: Entity[] = [];
  partial_accounts: Account[] = [];
  partial_rows: Json[] = [];
  partial_events: NativeEvent[] = [];
  cause_kind?: string;
  constructor(
    public kind: string,
    message: string,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}
export class PartialFetchError extends PlatformError {
  constructor(
    entities: Entity[],
    public cause: PlatformError,
    public requested_count: number | null = null,
  ) {
    super(
      "PARTIAL_FETCH",
      `일부 광고 항목을 가져오지 못했습니다. ${cause.message}`,
    );
    this.partial_entities = entities;
    this.partial_accounts = entities.every((e) => e.entity_type === "account")
      ? entities
      : [];
    this.cause_kind = cause.kind;
  }
}
export interface AdsPlatformAdapter {
  platform: Platform;
  listAccounts(): Promise<Account[]>;
  listEntities(accountId: string): Promise<Entity[]>;
  getEntity(kind: string, id: string, accountId?: string): Promise<Entity>;
  getCapabilities(): Promise<Json>;
  getChangeHistory(
    accountId: string,
    start: Date,
    end: Date,
  ): Promise<NativeEvent[]>;
  validateCredentials(): Promise<boolean>;
  close(): Promise<void>;
}
export abstract class BaseAdapter implements AdsPlatformAdapter {
  abstract platform: Platform;
  abstract capabilities: Json;
  abstract listAccounts(): Promise<Account[]>;
  abstract listCampaigns(accountId: string): Promise<Entity[]>;
  abstract listAdgroups(accountId: string): Promise<Entity[]>;
  abstract listAds(accountId: string): Promise<Entity[]>;
  abstract getEntity(
    kind: string,
    id: string,
    accountId?: string,
  ): Promise<Entity>;
  protected methods = ["listCampaigns", "listAdgroups", "listAds"];
  async listEntities(accountId: string): Promise<Entity[]> {
    const output: Entity[] = [];
    try {
      for (const name of this.methods)
        output.push(
          ...(await (
            this as unknown as Record<string, (id: string) => Promise<Entity[]>>
          )[name](accountId)),
        );
    } catch (error) {
      const cause = asPlatformError(error);
      throw new PartialFetchError(
        [...output, ...cause.partial_entities],
        error instanceof PartialFetchError ? error.cause : cause,
      );
    }
    return output;
  }
  async validateCredentials() {
    await this.listAccounts();
    return true;
  }
  async getCapabilities() {
    return { ...this.capabilities };
  }
  async getChangeHistory(
    _accountId: string,
    _start: Date,
    _end: Date,
  ): Promise<NativeEvent[]> {
    throw new PlatformError(
      "UNSUPPORTED",
      "현재 연결에서는 매체의 원본 변경 이력을 조회할 수 없습니다.",
    );
  }
  async close() {}
}
export const asPlatformError = (error: unknown) =>
  error instanceof PlatformError
    ? error
    : new PlatformError(
        "INVALID_RESPONSE",
        "가져온 광고 설정을 읽지 못했습니다. 다시 조회해 주세요.",
      );
export function safeId(value: unknown) {
  const text = identity(value);
  if (!/^[A-Za-z0-9_-]+$/.test(text))
    throw new Error("광고 항목 ID를 확인해 주세요.");
  return text;
}
export function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PlatformError(
      "INVALID_RESPONSE",
      "광고 설정을 읽지 못했습니다. 다시 조회해 주세요.",
    );
  return value as Json;
}
export function identity(value: unknown): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" &&
      (!Number.isSafeInteger(value) || value < 0)) ||
    !String(value).trim() ||
    /\s/.test(String(value))
  )
    throw new PlatformError(
      "INVALID_RESPONSE",
      "광고 항목을 구분할 정보가 없습니다. 다시 조회해 주세요.",
    );
  return String(value);
}
