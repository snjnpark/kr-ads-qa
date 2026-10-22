import {
  createEntity,
  type Entity,
  type FieldState,
  type Json,
} from "../models";
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
  type FetchLike,
} from "./http";
import { validateApiEntity } from "./contracts";

export class KakaoAdapter extends BaseAdapter {
  platform = "kakao" as const;
  capabilities = {
    accounts: "SUPPORTED",
    campaigns: "SUPPORTED",
    adgroups: "SUPPORTED",
    ads: "PARTIAL",
    creatives: "SUPPORTED",
    budget: "PARTIAL",
    targeting: "PARTIAL",
    review: "PARTIAL",
    keywords: "UNSUPPORTED",
    asset_groups: "UNSUPPORTED",
    insights: "UNSUPPORTED",
    change_history: "UNSUPPORTED",
    token_refresh: "UNSUPPORTED",
  };
  readonly http: ReadOnlyHTTP;
  private paths: Record<string, string> = {
    account: "adAccounts",
    campaign: "campaigns",
    adgroup: "adGroups",
    creative: "creatives",
  };
  constructor(
    private token: string,
    options: { fetch?: FetchLike } = {},
  ) {
    super();
    this.http = new ReadOnlyHTTP(
      {
        "https://apis.moment.kakao.com": [
          [
            "GET",
            /^\/openapi\/v4\/(?:adAccounts\/pages|(?:adAccounts|campaigns|adGroups|creatives)(?:\/[A-Za-z0-9_-]+)?)$/,
          ],
        ],
        "https://kapi.kakao.com": [["GET", /^\/v1\/business\/tokeninfo$/]],
        "https://kauth.kakao.com": [["POST", /^\/oauth\/business\/token$/]],
      },
      options.fetch,
    );
  }
  async get(path: string, accountId = "", params: Json = {}) {
    if (!this.token)
      throw new PlatformError(
        "AUTHENTICATION",
        "카카오 비즈니스 토큰이 필요합니다.",
      );
    return this.http.request(
      "GET",
      `https://apis.moment.kakao.com/openapi/v4/${path}`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(accountId ? { adAccountId: safeId(accountId) } : {}),
        },
        params,
      },
    );
  }
  async validateCredentials() {
    const data = await this.http.request(
      "GET",
      "https://kapi.kakao.com/v1/business/tokeninfo",
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    if (
      !(data.biz_agreements || []).some(
        (a: Json) =>
          String(a.group).toUpperCase() === "MOMENT" &&
          a.scope?.includes("moment_management"),
      )
    )
      throw new PlatformError(
        "PERMISSION_DENIED",
        "카카오모먼트 운영 조회 동의가 필요합니다.",
      );
    return true;
  }
  async exchangeAuthorizationCode(
    clientId: string,
    code: string,
    redirectUri: string,
    clientSecret?: string,
  ) {
    const data = await this.http.request(
      "POST",
      "https://kauth.kakao.com/oauth/business/token",
      {
        form: {
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          redirect_uri: redirectUri,
          ...(clientSecret ? { client_secret: clientSecret } : {}),
        },
      },
    );
    if (!data.access_token)
      throw new PlatformError(
        "AUTHENTICATION",
        "카카오 비즈니스 토큰을 발급받지 못했습니다.",
      );
    this.token = data.access_token;
    return data;
  }
  private content(data: unknown): Json[] {
    const value = object(data);
    if (!Array.isArray(value.content))
      throw new PlatformError(
        "INVALID_RESPONSE",
        "카카오 목록 응답에 content가 없습니다.",
      );
    return value.content;
  }
  async listAccounts() {
    const rows: Entity[] = [];
    try {
      for (let page = 0; page <= 10000; page++) {
        const data = await this.get("adAccounts/pages", "", {
          page,
          size: 100,
        });
        for (const row of this.content(data))
          rows.push(this.normalize(row, "account", identity(row.id)));
        if (!Number.isInteger(data.totalPages) || data.totalPages < 0)
          throw new PlatformError(
            "INVALID_RESPONSE",
            "카카오 계정 페이지 수가 없습니다.",
          );
        if (page + 1 >= data.totalPages) return rows;
      }
      throw new PlatformError(
        "INVALID_RESPONSE",
        "카카오 계정 페이지가 과도하게 반복되었습니다.",
      );
    } catch (error) {
      if (rows.length)
        throw new PartialFetchError(rows, asPlatformError(error));
      throw asPlatformError(error);
    }
  }
  private async hydrate(
    kind: string,
    accountId: string,
    params: Json = {},
    parent?: Entity,
  ) {
    const rows = this.content(
        await this.get(this.paths[kind], accountId, params),
      ),
      output: Entity[] = [], errors: PlatformError[] = [];
    for (const row of rows) {
      try {
        const entity = this.normalize(
          await this.get(
            `${this.paths[kind]}/${safeId(identity(row.id))}`,
            accountId,
          ),
          kind,
          accountId,
        );
        if (entity.parent_id == null && parent) {
          entity.parent_id = parent.entity_id;
          entity.fields.parent_id = "PRESENT";
          entity.sources.parent_id = "kakao.list_request_parent_id";
        }
        if (!entity.extensions.product_type && parent?.extensions.product_type) {
          entity.extensions.product_type = parent.extensions.product_type;
          entity.extensions.campaign_type = parent.extensions.product_type;
          entity.sources["extensions.product_type"] = `parent:${parent.entity_id}.extensions.product_type`;
        }
        output.push(entity);
      } catch (error) { errors.push(asPlatformError(error)); }
    }
    if (errors.length) throw new PartialFetchError(output, errors[0], rows.length);
    return output;
  }
  async listCampaigns(id: string) {
    return this.hydrate("campaign", id);
  }
  private async children(
    kind: string,
    accountId: string,
    parents: Entity[],
    parameter: string,
  ) {
    const output: Entity[] = [], errors: PlatformError[] = [];
    for (const parent of parents) {
      try {
        output.push(
          ...(await this.hydrate(
            kind,
            accountId,
            { [parameter]: parent.entity_id },
            parent,
          )),
        );
      } catch (error) {
        const cause = asPlatformError(error);
        output.push(...cause.partial_entities);
        errors.push(error instanceof PartialFetchError ? error.cause : cause);
      }
    }
    if (errors.length) throw new PartialFetchError(output, errors[0]);
    return output;
  }
  async listAdgroups(id: string) {
    return this.children(
      "adgroup",
      id,
      await this.listCampaigns(id),
      "campaignId",
    );
  }
  async listCreatives(id: string) {
    return this.children(
      "creative",
      id,
      await this.listAdgroups(id),
      "adGroupId",
    );
  }
  async listAds(id: string) {
    return this.listCreatives(id);
  }
  async getEntity(kind: string, id: string, accountId = "") {
    if (!this.paths[kind]) throw new PlatformError("UNSUPPORTED", kind);
    if (!accountId) throw new Error("카카오 광고계정 ID가 필요합니다.");
    return this.normalize(
      await this.get(`${this.paths[kind]}/${safeId(id)}`, accountId),
      kind,
      accountId,
    );
  }
  normalize(input: unknown, kind: string, accountId: string): Entity {
    try {
      if (!this.paths[kind]) throw new PlatformError("UNSUPPORTED", kind);
      const row = validateApiEntity(this.platform, input, kind),
        parent =
          kind === "adgroup"
            ? row.campaign?.id
            : kind === "creative"
              ? row.adGroupId
              : null,
        schedule = row.schedule || {},
        goal = row.campaignTypeGoal || row.campaign?.campaignTypeGoal || {},
        objective = row.objective || {},
        mapping: Record<string, string> = {
          name: "name",
          "budget.daily": "dailyBudgetAmount",
          "budget.lifetime": "totalBudget",
          "bid.amount": "bidAmount",
          "bid.strategy": "bidStrategy",
          status: "config",
          effective_status: "status",
          targeting: "targeting",
          created_at: "createdDate",
          "tracking.url": "rspvLandingUrl",
        },
        fields: Record<string, FieldState> = Object.fromEntries(
          Object.entries(mapping).map(([key, value]) => [
            key,
            fieldState(row, value),
          ]),
        );
      fields.currency = fields.timezone = "PRESENT";
      fields["schedule.start"] =
        "schedule" in row ? fieldState(schedule, "beginDate") : "NOT_RETURNED";
      fields["schedule.end"] =
        "schedule" in row ? fieldState(schedule, "endDate") : "NOT_RETURNED";
      for (const part of [
        "countries",
        "age_min",
        "age_max",
        "custom_audiences",
        "excluded_audiences",
      ])
        fields[`targeting.${part}`] = "NOT_RETURNED";
      fields["optimization.objective"] = fieldState(objective, "type");
      fields["optimization.goal"] = fieldState(goal, "goal");
      fields["optimization.event"] = "NOT_RETURNED";
      const url =
        row.rspvLandingUrl || row.pcLandingUrl || row.mobileLandingUrl || null;
      const systemStops = new Set(["SYSTEM_CONFIG_ADMIN_STOP", "SYSTEM_CONFIG_VOID", "ADMIN_STOP", "VOID", "EXTERNAL_SERVICE_STOP"]);
      const indicators = [...(Array.isArray(row.status) ? row.status : []), row.creativeStatus, row.systemConfig];
      const rejected = row.reviewStatus === "REJECTED" || indicators.includes("MONITORING_REJECTED");
      const systemStopped = indicators.some((value) => systemStops.has(value));
      const effectiveSource = row.reviewStatus === "REJECTED" ? "reviewStatus"
        : systemStops.has(row.systemConfig) ? "systemConfig"
          : systemStops.has(row.creativeStatus) || row.creativeStatus === "MONITORING_REJECTED" ? "creativeStatus"
            : Array.isArray(row.status) ? "status" : row.creativeStatus != null ? "creativeStatus" : "systemConfig";
      fields.effective_status = fieldState(row, effectiveSource);
      fields["tracking.url"] = url ? "PRESENT" : ["rspvLandingUrl", "pcLandingUrl", "mobileLandingUrl"].some((key) => key in row) ? "NOT_SET" : "NOT_RETURNED";
      if (
        ["TALK_CHANNEL", "PERSONAL_MESSAGE"].includes(goal.campaignType) &&
        kind === "campaign"
      )
        fields["budget.daily"] = "NOT_APPLICABLE";
      const scheduled = (prefix: string) =>
        schedule[`${prefix}Date`]
          ? timestamp(
              `${schedule[`${prefix}Date`]}T${schedule[`${prefix}Time`] || (prefix === "end" ? "23:59:59" : "00:00:00")}`,
              "Asia/Seoul",
            )
          : null;
      if (row.adAccountId != null && identity(row.adAccountId) !== accountId)
        throw new PlatformError(
          "INVALID_RESPONSE",
          "카카오 응답의 광고계정이 요청 계정과 일치하지 않습니다.",
        );
      return createEntity({
        platform: this.platform,
        account_id: String(row.adAccountId ?? accountId),
        entity_type: kind,
        entity_id: identity(row.id),
        parent_id: parent == null ? null : String(parent),
        name: String(row.name || ""),
        status:
          ({ ON: "ACTIVE", OFF: "PAUSED", DEL: "DELETED" } as Json)[
            row.config
          ] ||
          row.config ||
          null,
        effective_status: rejected ? "DISAPPROVED" : systemStopped ? "SYSTEM_STOPPED"
          : Array.isArray(row.status) ? row.status.join(",") : (row.creativeStatus ?? row.systemConfig ?? null),
        currency: "KRW",
        timezone: "Asia/Seoul",
        budget: {
          unit: "major",
          daily: decimalValue(row.dailyBudgetAmount),
          lifetime: decimalValue(row.totalBudget),
          level: kind,
        },
        bid: {
          strategy: row.bidStrategy ?? null,
          amount: decimalValue(row.bidAmount),
        },
        schedule: { start: scheduled("begin"), end: scheduled("end") },
        optimization: {
          objective: objective.type ?? null,
          goal: goal.goal ?? null,
        },
        tracking: { url },
        text:
          ["title", "description", "altText"]
            .map((key) => row[key])
            .filter(Boolean)
            .join(" ") || null,
        created_at: timestamp(row.createdDate, "Asia/Seoul"),
        fields,
        sources: { ...Object.fromEntries(
          Object.entries(mapping).map(([key, value]) => [
            key,
            `kakao.${value}`,
          ]),
        ), effective_status: `kakao.${effectiveSource}` },
        raw_data: row,
        extensions: {
          api_version: "v4",
          product_type: goal.campaignType ?? null,
          campaign_type: goal.campaignType,
          operating_statuses: Array.isArray(row.status) ? row.status : null,
          landing_urls: [
            ["rspvLandingUrl", "UNSPECIFIED"], ["pcLandingUrl", "PC"], ["mobileLandingUrl", "MOBILE"],
          ].flatMap(([key, device]) => row[key] ? [{ device, url: row[key], source: `kakao.${key}` }] : []),
          targeting: row.targeting,
          schedule: row.schedule,
          placements: row.placements,
          system_config: row.systemConfig,
          review_status: row.reviewStatus,
          rejected_reason: row.rejectedReason,
          pixel_sdk_id: row.trackId,
          status_description: row.statusDescription,
          message: row.messageElement,
        },
      });
    } catch (error) {
      throw asPlatformError(error);
    }
  }
}
