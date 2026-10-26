import {
  createEntity,
  type Entity,
  type FieldState,
  type Json,
  type NativeEvent,
} from "../domain/entities";
import {
  asPlatformError,
  BaseAdapter,
  identity,
  object,
  PartialFetchError,
  PlatformError,
  safeId,
} from "./base";
import {
  decimalValue,
  fieldState,
  ReadOnlyHTTP,
  timestamp,
  validateHistoryRange,
  type FetchLike,
  type OperationSignal,
} from "./http";
import { validateApiEntity } from "./contracts";

export class MetaAdapter extends BaseAdapter {
  platform = "meta" as const;
  capabilities = {
    accounts: "SUPPORTED",
    campaigns: "SUPPORTED",
    adgroups: "SUPPORTED",
    ads: "SUPPORTED",
    creatives: "SUPPORTED",
    targeting: "PARTIAL",
    budget: "SUPPORTED",
    review: "PARTIAL",
    keywords: "UNSUPPORTED",
    asset_groups: "UNSUPPORTED",
    insights: "UNSUPPORTED",
    change_history: "PARTIAL",
  };
  protected methods = [
    "listCampaigns",
    "listAdgroups",
    "listAds",
    "listCreatives",
  ];
  accounts = new Map<string, Entity>();
  campaigns = new Map<string, Entity>();
  readonly http: ReadOnlyHTTP;
  readonly version: string;
  readonly edgeFields: Record<string, string> = {
    account: "id,account_id,name,account_status,currency,timezone_name",
    campaign:
      "id,account_id,name,status,effective_status,objective,daily_budget,lifetime_budget,bid_strategy,start_time,stop_time,created_time,special_ad_categories",
    adgroup:
      "id,account_id,campaign_id,name,status,effective_status,daily_budget,lifetime_budget,bid_strategy,bid_amount,optimization_goal,promoted_object,targeting,start_time,end_time,created_time",
    ad: "id,account_id,campaign_id,adset_id,name,status,effective_status,creative{id},issues_info,created_time",
    creative:
      "id,account_id,name,status,title,body,object_story_spec,asset_feed_spec,object_url,url_tags",
  };
  constructor(
    private token: string,
    options: {
      api_version?: string;
      currency_offset?: number;
      fetch?: FetchLike;
      getSignal?: OperationSignal;
    } = {},
  ) {
    super();
    if (!token)
      throw new PlatformError(
        "AUTHENTICATION",
        "Meta 액세스 토큰이 필요합니다.",
      );
    this.version = options.api_version || "v26.0";
    if (!/^v\d+\.\d+$/.test(this.version))
      throw new Error("잘못된 Meta API 버전입니다.");
    this.currencyOffset = options.currency_offset;
    this.http = new ReadOnlyHTTP(
      {
        "https://graph.facebook.com": [
          [
            "GET",
            new RegExp(
              `^/${this.version.replace(".", "\\.")}/[A-Za-z0-9_-]+(?:/(?:adaccounts|campaigns|adsets|ads|adcreatives|activities))?$`,
            ),
          ],
        ],
      },
      options.fetch,
      undefined,
      options.getSignal,
    );
  }
  private currencyOffset?: number;
  async get(path: string, params: Json = {}) {
    return this.http.request(
      "GET",
      `https://graph.facebook.com/${this.version}/${path}`,
      { params, headers: { Authorization: `Bearer ${this.token}` } },
    );
  }
  private cursor(data: Json): string | null {
    const paging = data.paging == null ? {} : object(data.paging);
    if (paging.next != null && typeof paging.next !== "string")
      throw new PlatformError(
        "INVALID_RESPONSE",
        "Meta 다음 페이지 형식이 올바르지 않습니다.",
      );
    if (!paging.next) return null;
    const after = object(paging.cursors).after;
    if (typeof after !== "string" || !after)
      throw new PlatformError(
        "INVALID_RESPONSE",
        "Meta 페이지 커서의 자료형이 올바르지 않습니다.",
      );
    return after;
  }
  private async list(path: string, kind: string, accountId = "") {
    const output: Entity[] = [],
      seen = new Set<string>(),
      params: Json = { fields: this.edgeFields[kind], limit: 100 };
    try {
      for (;;) {
        const data = object(await this.get(path, params));
        if (!Array.isArray(data.data))
          throw new PlatformError(
            "INVALID_RESPONSE",
            "Meta 목록 응답에 data가 없습니다.",
          );
        for (const row of data.data)
          output.push(this.normalize(row, kind, accountId));
        const after = this.cursor(data);
        if (after === null) return output;
        if (!after || seen.has(after))
          throw new PlatformError(
            "INVALID_RESPONSE",
            "Meta 페이지 커서가 누락되거나 반복되었습니다.",
          );
        seen.add(after);
        params.after = after;
      }
    } catch (error) {
      if (output.length)
        throw new PartialFetchError(output, asPlatformError(error));
      throw asPlatformError(error);
    }
  }
  async listAccounts() {
    const accounts = await this.list("me/adaccounts", "account");
    for (const account of accounts)
      this.accounts.set(account.account_id, account);
    return accounts;
  }
  private async account(id: string) {
    id = safeId(id.replace(/^act_/, ""));
    if (!this.accounts.has(id))
      this.accounts.set(
        id,
        this.normalize(
          await this.get(`act_${id}`, { fields: this.edgeFields.account }),
          "account",
          id,
        ),
      );
    return id;
  }
  async listCampaigns(id: string) {
    id = await this.account(id);
    const rows = await this.list(`act_${id}/campaigns`, "campaign", id);
    for (const row of rows) this.campaigns.set(row.entity_id, row);
    return rows;
  }
  async listAdgroups(id: string) {
    id = await this.account(id);
    const campaigns = new Map(
      (await this.listCampaigns(id)).map((row) => [row.entity_id, row]),
    );
    const rows = await this.list(`act_${id}/adsets`, "adgroup", id);
    for (const row of rows) {
      const parent = campaigns.get(row.parent_id || "");
      if (
        parent &&
        (parent.budget.daily !== null || parent.budget.lifetime !== null)
      ) {
        row.budget = {
          ...parent.budget,
          level: "campaign",
          inherited_from: parent.entity_id,
        };
        for (const path of ["budget.daily", "budget.lifetime"]) {
          row.fields[path] = parent.fields[path] || "NOT_RETURNED";
          row.sources[path] =
            `campaign:${parent.entity_id}.${path.split(".")[1]}_budget`;
        }
      }
    }
    return rows;
  }
  async listAds(id: string) {
    id = await this.account(id);
    return this.list(`act_${id}/ads`, "ad", id);
  }
  async listCreatives(id: string) {
    id = await this.account(id);
    return this.list(`act_${id}/adcreatives`, "creative", id);
  }
  async getEntity(kind: string, id: string, accountId = "") {
    if (!this.edgeFields[kind]) throw new PlatformError("UNSUPPORTED", kind);
    if (accountId) accountId = await this.account(accountId);
    return this.normalize(
      await this.get(safeId(id), { fields: this.edgeFields[kind] }),
      kind,
      accountId,
    );
  }
  normalize(input: unknown, kind: string, accountId = ""): Entity {
    try {
      const row = validateApiEntity(this.platform, input, kind);
      if (!this.edgeFields[kind]) throw new PlatformError("UNSUPPORTED", kind);
      const returnedAccount =
        row.account_id ?? (kind === "account" ? identity(row.id) : accountId);
      if (
        accountId &&
        row.account_id != null &&
        identity(row.account_id).replace(/^act_/, "") !==
          accountId.replace(/^act_/, "")
      )
        throw new PlatformError(
          "INVALID_RESPONSE",
          "Meta 응답의 계정이 요청 계정과 일치하지 않습니다.",
        );
      accountId = String(returnedAccount).replace(/^act_/, "");
      const account = this.accounts.get(accountId),
        currency = kind === "account" ? row.currency : account?.currency,
        zone =
          kind === "account"
            ? row.timezone_name
            : account?.fields.timezone === "PRESENT"
              ? account.timezone
              : null;
      const offset =
          this.currencyOffset ||
          ({ KRW: 1, JPY: 1, USD: 100, EUR: 100 } as Record<string, number>)[
            currency
          ],
        target = row.targeting || {},
        promoted = row.promoted_object || {},
        story = row.object_story_spec || {},
        link = Object.keys(story.link_data || {}).length
          ? story.link_data
          : story.video_data || {};
      const mapping: Record<string, string> = {
        name: "name",
        "budget.daily": "daily_budget",
        "budget.lifetime": "lifetime_budget",
        "bid.amount": "bid_amount",
        "bid.strategy": "bid_strategy",
        "schedule.start": "start_time",
        "schedule.end": kind === "campaign" ? "stop_time" : "end_time",
        targeting: "targeting",
        "optimization.objective": "objective",
        "optimization.goal": "optimization_goal",
        "optimization.event": "promoted_object",
        status: "status",
        effective_status: "effective_status",
        created_at: "created_time",
        text: "body",
      };
      if (kind === "account") mapping.status = "account_status";
      const fields: Record<string, FieldState> = Object.fromEntries(
        Object.entries(mapping).map(([key, source]) => [
          key,
          fieldState(row, source),
        ]),
      );
      if (!row.body && link.message != null) {
        fields.text = fieldState(link, "message");
        mapping.text = `object_story_spec.${Object.keys(story.link_data || {}).length ? "link_data" : "video_data"}.message`;
      }
      mapping["tracking.url"] = row.object_url
        ? "object_url"
        : `object_story_spec.${Object.keys(story.link_data || {}).length ? "link_data" : "video_data"}.link`;
      fields.currency =
        kind === "account"
          ? fieldState(row, "currency")
          : account?.fields.currency || "NOT_RETURNED";
      fields.timezone =
        kind === "account"
          ? fieldState(row, "timezone_name")
          : account?.fields.timezone || "NOT_RETURNED";
      fields["tracking.url"] =
        row.object_url || link.link ? "PRESENT" : "NOT_RETURNED";
      fields["tracking.parameters"] = fieldState(row, "url_tags");
      fields["optimization.event"] =
        "promoted_object" in row
          ? fieldState(promoted, "custom_event_type")
          : "NOT_RETURNED";
      for (const name of [
        "countries",
        "age_min",
        "age_max",
        "custom_audiences",
        "excluded_audiences",
      ])
        fields[`targeting.${name}`] =
          "targeting" in row
            ? fieldState(
                target,
                (
                  {
                    countries: "geo_locations",
                    excluded_audiences: "excluded_custom_audiences",
                  } as Json
                )[name] || name,
              )
            : "NOT_RETURNED";
      if (target.geo_locations && typeof target.geo_locations === "object")
        fields["targeting.countries"] = fieldState(
          target.geo_locations,
          "countries",
        );
      return createEntity({
        platform: this.platform,
        account_id: accountId,
        entity_type: kind,
        entity_id: identity(row.id),
        parent_id:
          kind === "adgroup"
            ? row.campaign_id == null
              ? null
              : String(row.campaign_id)
            : kind === "ad"
              ? row.adset_id == null
                ? null
                : String(row.adset_id)
              : null,
        name: String(row.name || ""),
        status:
          kind === "account" && "account_status" in row
            ? String(row.account_status)
            : (row.status ?? null),
        effective_status: row.effective_status ?? null,
        currency: currency || "UNKNOWN",
        timezone: zone || "UTC",
        budget: {
          daily: decimalValue(row.daily_budget, offset || 1),
          lifetime: decimalValue(row.lifetime_budget, offset || 1),
          level: kind,
          unit: offset ? "major" : "minor",
        },
        bid: {
          strategy: row.bid_strategy ?? null,
          amount: decimalValue(row.bid_amount, offset || 1),
        },
        schedule: {
          start: timestamp(row.start_time, zone),
          end: timestamp(row[mapping["schedule.end"]], zone),
        },
        targeting: {
          countries: target.geo_locations?.countries || [],
          age_min: target.age_min ?? null,
          age_max: target.age_max ?? null,
          custom_audiences: (target.custom_audiences || []).map((x: Json) =>
            identity(x.id),
          ),
          excluded_audiences: (target.excluded_custom_audiences || []).map(
            (x: Json) => identity(x.id),
          ),
        },
        optimization: {
          objective: row.objective ?? null,
          goal: row.optimization_goal ?? null,
          event: promoted.custom_event_type ?? null,
        },
        tracking: {
          url: row.object_url || link.link || null,
          parameters: Object.fromEntries(
            new URLSearchParams(row.url_tags || ""),
          ),
        },
        text: row.body || link.message || null,
        created_at: timestamp(row.created_time, zone),
        fields,
        sources: Object.fromEntries(
          Object.entries(mapping).map(([key, source]) => [
            key,
            `meta.${source}`,
          ]),
        ),
        raw_data: row,
        extensions: {
          api_version: this.version,
          currency_offset: offset ?? null,
          account_metadata_known: !!account || kind === "account",
        },
      });
    } catch (error) {
      throw asPlatformError(error);
    }
  }
  async getChangeHistory(
    id: string,
    start: Date,
    end: Date,
  ): Promise<NativeEvent[]> {
    validateHistoryRange(start, end);
    id = safeId(id.replace(/^act_/, ""));
    const params: Json = {
        fields:
          "event_time,event_type,actor_id,actor_name,application_id,application_name,object_id,object_name,object_type,extra_data,tool,translated_event_type",
        since: Math.floor(+start / 1000),
        until: Math.floor(+end / 1000) + 1,
        limit: 100,
      },
      events: NativeEvent[] = [],
      seen = new Set<string>();
    try {
      for (;;) {
        const data = object(await this.get(`act_${id}/activities`, params));
        if (!Array.isArray(data.data))
          throw new PlatformError(
            "INVALID_RESPONSE",
            "Meta 변경 이력 목록 형식이 잘못되었습니다.",
          );
        for (const input of data.data) {
          const raw = object(input),
            occurred = timestamp(raw.event_time);
          if (!occurred)
            throw new PlatformError(
              "INVALID_RESPONSE",
              "Meta 변경 시각을 확인하지 못했습니다.",
            );
          if (Date.parse(occurred) < +start || Date.parse(occurred) >= +end)
            continue;
          events.push({
            source: "platform_change_log",
            platform: this.platform,
            account_id: id,
            event_id: null,
            timestamp: occurred,
            actor: {
              ...(raw.actor_id != null ? { id: raw.actor_id } : {}),
              ...(raw.actor_name != null ? { name: raw.actor_name } : {}),
            },
            event_type: raw.event_type ?? null,
            description: raw.translated_event_type ?? null,
            tool: raw.tool ?? null,
            entity_type: raw.object_type ?? null,
            entity_id: raw.object_id ?? null,
            entity_name: raw.object_name ?? null,
            application: { id: raw.application_id, name: raw.application_name },
            extra_data: raw.extra_data,
            fields: {
              timestamp: fieldState(raw, "event_time"),
              "actor.id": fieldState(raw, "actor_id"),
              "actor.name": fieldState(raw, "actor_name"),
            },
            raw_data: raw,
          });
        }
        const after = this.cursor(data);
        if (after === null) return events;
        if (!after || seen.has(after))
          throw new PlatformError(
            "INVALID_RESPONSE",
            "Meta 변경 이력 커서가 반복되었습니다.",
          );
        seen.add(after);
        params.after = after;
      }
    } catch (error) {
      const cause = asPlatformError(error),
        failure = new PlatformError(
          events.length ? "PARTIAL_FETCH" : cause.kind,
          "Meta 변경 이력을 완전히 조회하지 못했습니다.",
        );
      failure.partial_events = events;
      failure.cause_kind = cause.kind;
      throw failure;
    }
  }
}
