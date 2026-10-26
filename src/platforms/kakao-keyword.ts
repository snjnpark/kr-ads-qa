import { createEntity, type Entity, type FieldState, type Json } from "../domain/entities";
import { asPlatformError, BaseAdapter, identity, object, PartialFetchError, PlatformError } from "./base";
import { validateApiEntity } from "./contracts";
import { decimalValue, fieldState, ReadOnlyHTTP, timestamp, type FetchLike, type OperationSignal } from "./http";

const paths: Record<string, string> = {
  account: "adAccounts",
  campaign: "campaigns",
  adgroup: "adGroups",
  keyword: "keywords",
  creative: "creatives/basic",
  ad: "creativeLinks",
};
const kakaoId = (value: unknown) => {
  const id = identity(value);
  if (!/^\d+$/.test(id))
    throw new PlatformError("INVALID_RESPONSE", "카카오 키워드광고 ID를 확인해 주세요.");
  return id;
};
const partial = (rows: Entity[], error: unknown, requested: number | null = null) => {
  const cause = asPlatformError(error), entities = new Map(rows.map((row) => [row.key, row]));
  for (const row of cause.partial_entities) entities.set(row.key, row);
  return new PartialFetchError([...entities.values()], error instanceof PartialFetchError ? error.cause : cause, requested);
};

/** Premium Link only: reports and Talk Channel Search endpoints are deliberately absent. */
export class KakaoKeywordAdapter extends BaseAdapter {
  platform = "kakao_keyword" as const;
  capabilities = {
    accounts: "SUPPORTED", campaigns: "SUPPORTED", adgroups: "SUPPORTED",
    ads: "SUPPORTED", creatives: "SUPPORTED", keywords: "SUPPORTED",
    budget: "PARTIAL", targeting: "PARTIAL", review: "PARTIAL",
    asset_groups: "UNSUPPORTED", insights: "UNSUPPORTED", change_history: "UNSUPPORTED",
    token_refresh: "UNSUPPORTED",
  };
  readonly http: ReadOnlyHTTP;
  private allowedAccounts: Set<string> | null = null;

  constructor(private token: string, options: { fetch?: FetchLike; getSignal?: OperationSignal } = {}) {
    super();
    this.http = new ReadOnlyHTTP({
      "https://api.keywordad.kakao.com": [["GET", /^\/openapi\/v1\/(?:adAccounts\/pages|(?:adAccounts|campaigns|adGroups|keywords|creativeLinks)(?:\/\d+)?|creatives\/basic(?:\/\d+)?)$/]],
      "https://kapi.kakao.com": [["GET", /^\/v1\/business\/tokeninfo$/]],
      "https://kauth.kakao.com": [["POST", /^\/oauth\/business\/token$/]],
    }, options.fetch, undefined, options.getSignal);
  }

  private requireToken() {
    if (!this.token || /[\r\n]/.test(this.token))
      throw new PlatformError("AUTHENTICATION", "카카오 키워드광고 비즈니스 토큰이 필요합니다.");
  }

  async get(path: string, accountId = "", params: Json = {}) {
    this.requireToken();
    if (path !== "adAccounts/pages" && !accountId)
      throw new PlatformError("INVALID_RESPONSE", "카카오 키워드광고 계정 ID가 필요합니다.");
    const account = accountId ? kakaoId(accountId) : "";
    if (account && this.allowedAccounts && !this.allowedAccounts.has(account))
      throw new PlatformError("PERMISSION_DENIED", "이 비즈니스 토큰으로 조회할 수 없는 키워드광고 계정입니다.");
    return this.http.request("GET", `https://api.keywordad.kakao.com/openapi/v1/${path}`, {
      headers: { Authorization: `Bearer ${this.token}`, ...(account ? { adAccountId: account } : {}) }, params,
    });
  }

  async validateCredentials() {
    this.requireToken();
    const data = object(await this.http.request("GET", "https://kapi.kakao.com/v1/business/tokeninfo", {
      headers: { Authorization: `Bearer ${this.token}` },
    }));
    if (data.status !== "ACTIVE")
      throw new PlatformError("AUTHENTICATION", "활성 카카오 비즈니스 토큰이 필요합니다.");
    if (!Array.isArray(data.biz_agreements))
      throw new PlatformError("PERMISSION_DENIED", "카카오 키워드광고 운영 조회 동의가 필요합니다.");
    const agreements = data.biz_agreements.filter((value: unknown) => {
      const row = object(value);
      return String(row.group).toLowerCase() === "keyword" && Array.isArray(row.scope) && row.scope.includes("keyword_management");
    });
    if (!agreements.length)
      throw new PlatformError("PERMISSION_DENIED", "카카오 키워드광고 운영 조회 동의가 필요합니다.");
    const ids = new Set<string>();
    let unrestricted = false, specified = false;
    for (const row of agreements) {
      if (row.ad_account_ids === undefined) continue;
      if (!Array.isArray(row.ad_account_ids))
        throw new PlatformError("INVALID_RESPONSE", "비즈니스 토큰의 광고계정 권한을 읽지 못했습니다.");
      specified = true;
      for (const id of row.ad_account_ids) {
        if (id === "*") unrestricted = true;
        else ids.add(kakaoId(id));
      }
    }
    this.allowedAccounts = unrestricted || !specified ? null : ids;
    return true;
  }

  async exchangeAuthorizationCode(clientId: string, code: string, redirectUri: string, clientSecret?: string) {
    const data = await this.http.request("POST", "https://kauth.kakao.com/oauth/business/token", {
      form: { grant_type: "authorization_code", client_id: clientId, code, redirect_uri: redirectUri, ...(clientSecret ? { client_secret: clientSecret } : {}) },
    });
    if (typeof data.access_token !== "string" || !data.access_token || /[\r\n]/.test(data.access_token))
      throw new PlatformError("AUTHENTICATION", "카카오 비즈니스 토큰을 발급받지 못했습니다.");
    this.token = data.access_token;
    this.allowedAccounts = null;
    return data;
  }

  private array(data: unknown): Json[] {
    if (!Array.isArray(data))
      throw new PlatformError("INVALID_RESPONSE", "카카오 키워드광고 목록 응답이 배열이 아닙니다.");
    return data;
  }

  private async pages(path: string, accountId: string, kind: string, params: Json = {}) {
    const output: Entity[] = [], seen = new Set<string>();
    for (let page = 0; ; page++) {
      try {
        const data = object(await this.get(path, accountId, { ...params, page, [kind === "account" ? "size" : "limit"]: 100 }));
        if (!Array.isArray(data.content))
          throw new PlatformError("INVALID_RESPONSE", "카카오 키워드광고 페이지에 content가 없습니다.");
        const metadata = kind === "account" ? data : object(data.page);
        const pageNumber = kind === "account" ? metadata.page : metadata.number;
        if (!Number.isSafeInteger(metadata.totalPages) || metadata.totalPages < 0 || metadata.totalPages > 10000 || (metadata.totalPages === 0 && data.content.length > 0) || (pageNumber != null && pageNumber !== page))
          throw new PlatformError("INVALID_RESPONSE", "카카오 키워드광고 페이지 정보가 올바르지 않습니다.");
        for (const input of data.content) {
          const row = this.normalize(input, kind, kind === "account" ? kakaoId(object(input).id) : accountId);
          if (seen.has(row.entity_id))
            throw new PlatformError("INVALID_RESPONSE", "카카오 키워드광고 페이지에 같은 항목이 반복됩니다.");
          seen.add(row.entity_id);
          output.push(row);
        }
        if (page + 1 >= metadata.totalPages) return output;
        if (!data.content.length)
          throw new PlatformError("INVALID_RESPONSE", "카카오 키워드광고 목록이 마지막 페이지 전에 중단되었습니다.");
      } catch (error) {
        if (output.length) throw partial(output, error);
        throw asPlatformError(error);
      }
    }
  }

  async listAccounts() {
    return this.pages("adAccounts/pages", "", "account");
  }

  private async listing(kind: string, accountId: string, params: Json = {}, parentId?: string) {
    const output: Entity[] = [], seen = new Set<string>();
    try {
      for (const input of this.array(await this.get(paths[kind], accountId, params))) {
        const entity = this.normalize(input, kind, accountId);
        if (seen.has(entity.entity_id))
          throw new PlatformError("INVALID_RESPONSE", "카카오 키워드광고 목록에 같은 항목이 반복됩니다.");
        seen.add(entity.entity_id);
        if (parentId && entity.parent_id != null && entity.parent_id !== parentId)
          throw new PlatformError("INVALID_RESPONSE", "카카오 키워드광고의 상위 항목이 요청과 일치하지 않습니다.");
        if (parentId && entity.parent_id == null) {
          entity.parent_id = parentId;
          entity.fields.parent_id = "PRESENT";
          entity.sources.parent_id = "kakao_keyword.list_request_parent_id";
        }
        output.push(entity);
      }
      return output;
    } catch (error) {
      if (output.length) throw partial(output, error);
      throw asPlatformError(error);
    }
  }

  async listCampaigns(accountId: string) {
    return this.listing("campaign", accountId);
  }

  private async collect(tasks: (() => Promise<Entity[]>)[]) {
    const output: Entity[] = [], errors: PlatformError[] = [];
    for (const task of tasks) {
      try { output.push(...await task()); }
      catch (error) {
        const cause = asPlatformError(error);
        output.push(...cause.partial_entities);
        errors.push(error instanceof PartialFetchError ? error.cause : cause);
      }
    }
    if (errors.length) {
      const cause = errors.length === 1 ? errors[0] : new PlatformError(errors[0].kind,
        `광고 조회 ${errors.length}건을 완료하지 못했습니다. ${[...new Set(errors.map((error) => error.message))].join(" / ")}`);
      throw partial(output, cause);
    }
    return output;
  }

  private async children(kind: string, accountId: string, parents: Entity[], parameter: string) {
    return this.collect(parents.map((parent) => async () => {
      let rows: Entity[], error: unknown;
      try {
        rows = await this.listing(kind, accountId, { [parameter]: kakaoId(parent.entity_id) }, parent.entity_id);
      } catch (cause) {
        error = cause;
        rows = asPlatformError(cause).partial_entities;
      }
        if (kind === "keyword") for (const row of rows) {
          if (row.bid.strategy === "AD_GROUP") {
            row.bid.amount = parent.bid.amount;
            row.fields["bid.amount"] = parent.fields["bid.amount"];
            row.sources["bid.amount"] = `adgroup:${parent.entity_id}.bid.amount`;
          }
        }
      if (error) throw partial(rows, error);
      return rows;
    }));
  }

  async listAdgroups(accountId: string) {
    return this.children("adgroup", accountId, await this.listCampaigns(accountId), "campaignId");
  }

  async listKeywords(accountId: string) {
    return this.children("keyword", accountId, await this.listAdgroups(accountId), "adGroupId");
  }

  private async creatives(accountId: string, campaigns: Entity[]) {
    const channels = new Set<string>();
    return this.collect(campaigns.map((campaign) => async () => {
        const channel = campaign.extensions.biz_channel_id;
        if (channel == null)
          throw new PlatformError("INVALID_RESPONSE", "키워드광고 캠페인의 비즈채널 정보가 없습니다.");
        const id = kakaoId(channel);
        if (channels.has(id)) return [];
        channels.add(id);
        const summaries = await this.pages("creatives/basic", accountId, "creative", { bizChannelId: id });
        return this.collect(summaries.map((summary) => async () => {
          try {
            const detail = await this.getEntity("creative", summary.entity_id, accountId);
            if ((summary.extensions.biz_channel_id != null && kakaoId(summary.extensions.biz_channel_id) !== id) || (detail.extensions.biz_channel_id != null && kakaoId(detail.extensions.biz_channel_id) !== id))
              throw new PlatformError("INVALID_RESPONSE", "키워드광고 소재의 비즈채널이 요청과 일치하지 않습니다.");
            return [this.normalize({ ...summary.raw_data, ...detail.raw_data }, "creative", accountId)];
          }
          catch (error) {
            for (const field of ["tracking.url", "text"]) summary.fields[field] = "FETCH_FAILED";
            throw partial([summary], error);
          }
        }));
    }));
  }

  async listCreatives(accountId: string) {
    return this.creatives(accountId, await this.listCampaigns(accountId));
  }

  private async ads(accountId: string, groups: Entity[], creatives: Entity[] = []) {
    const originals = new Map(creatives.map((row) => [row.entity_id, row]));
    return this.collect(groups.map((group) => async () => {
        const links = await this.listing("ad", accountId, { adGroupId: kakaoId(group.entity_id) }, group.entity_id);
        return this.collect(links.map((link) => async () => {
          const creativeId = kakaoId(link.extensions.creative_id);
          let creative = originals.get(creativeId);
          if (!creative) {
            try {
              creative = await this.getEntity("creative", creativeId, accountId);
              originals.set(creativeId, creative);
            } catch (error) {
              link.fields["tracking.url"] = link.fields.text = "FETCH_FAILED";
              throw partial([link], error);
            }
          }
          const connected = this.normalize({ ...link.raw_data, creative: creative.raw_data }, "ad", accountId);
          for (const field of ["tracking.url", "text"]) connected.fields[field] = creative.fields[field];
          return [connected];
        }));
    }));
  }

  async listAds(accountId: string) {
    return this.ads(accountId, await this.listAdgroups(accountId));
  }

  async listEntities(accountId: string) {
    let campaigns: Entity[] = [], groups: Entity[] = [], creatives: Entity[] = [];
    const remember = async (task: () => Promise<Entity[]>, save: (rows: Entity[]) => void) => {
      try { const rows = await task(); save(rows); return rows; }
      catch (error) { save(asPlatformError(error).partial_entities); throw error; }
    };
    return this.collect([
      () => remember(() => this.listCampaigns(accountId), (rows) => { campaigns = rows; }),
      () => remember(() => this.children("adgroup", accountId, campaigns, "campaignId"), (rows) => { groups = rows; }),
      () => this.children("keyword", accountId, groups, "adGroupId"),
      () => remember(() => this.creatives(accountId, campaigns), (rows) => { creatives = rows; }),
      () => this.ads(accountId, groups, creatives),
    ]);
  }

  async getEntity(kind: string, id: string, accountId = ""): Promise<Entity> {
    if (!paths[kind]) throw new PlatformError("UNSUPPORTED", kind);
    const requested = kakaoId(id);
    const row = this.normalize(await this.get(`${paths[kind]}/${requested}`, accountId), kind, accountId);
    if (row.entity_id !== requested)
      throw new PlatformError("INVALID_RESPONSE", "카카오 키워드광고 항목 ID가 요청과 일치하지 않습니다.");
    if (kind !== "ad") return row;
    const creative = await this.getEntity("creative", kakaoId(row.extensions.creative_id), accountId);
    return this.normalize({ ...row.raw_data, creative: creative.raw_data }, kind, accountId);
  }

  normalize(input: unknown, kind: string, accountId: string): Entity {
    try {
      if (!paths[kind]) throw new PlatformError("UNSUPPORTED", kind);
      const row = validateApiEntity(this.platform, input, kind), account = kakaoId(accountId);
      if (row.adAccountId != null && kakaoId(row.adAccountId) !== account)
        throw new PlatformError("INVALID_RESPONSE", "키워드광고 응답 계정이 요청 계정과 일치하지 않습니다.");
      const id = kakaoId(kind === "ad" ? row.creativeLinkId : row.id);
      const creative = kind === "ad" && row.creative != null ? validateApiEntity(this.platform, row.creative, "creative") : null;
      if (creative && (kakaoId(creative.id) !== kakaoId(row.creativeId) || (creative.adAccountId != null && kakaoId(creative.adAccountId) !== account)))
        throw new PlatformError("INVALID_RESPONSE", "키워드광고 소재연결 정보가 원본 소재와 일치하지 않습니다.");
      const source = creative || row, schedule = row.schedule || {}, landing = source.landingInfo || {};
      const reviewStatus = row.reviewStatus ?? creative?.reviewStatus;
      const operatingStatuses: string[] | null = Array.isArray(row.status) ? row.status : null;
      const stopped = new Set(["OFF_BY_AD_ACCOUNT_ADMIN_STOP", "OFF_BY_BIZ_CHANNEL_ADMIN", "OFF_BY_AD_ACCOUNT_USER_BALANCE", "OFF_BY_NOT_CONNECTED_BIZ_WALLET"]);
      const effectiveStatus = reviewStatus === "REJECTED" ? "DISAPPROVED"
        : operatingStatuses?.some((status) => stopped.has(status)) ? "SYSTEM_STOPPED"
          : operatingStatuses?.join(",") ?? null;
      const parent = kind === "adgroup" ? row.campaignId : ["keyword", "ad"].includes(kind) ? row.adGroupId : null;
      const bid = kind === "keyword" ? row.bidStrategy || {} : row;
      const mappings: Record<string, string> = {
        name: kind === "keyword" ? "text" : "name", status: "config", effective_status: "status",
        "budget.daily": "dailyBudgetAmount", "bid.amount": kind === "keyword" ? "bidStrategy.bidAmount" : "bidAmount",
        "bid.strategy": "bidStrategy.type", "schedule.start": "schedule.beginDate", "schedule.end": "schedule.endDate",
        "optimization.event": "trackId",
      };
      const observed = (value: Json, path: string): FieldState => {
        let current = value;
        const parts = path.split(".");
        for (const part of parts.slice(0, -1)) {
          if (!(part in current)) return "NOT_RETURNED";
          if (current[part] == null) return "NOT_SET";
          current = object(current[part]);
        }
        return fieldState(current, parts.at(-1)!);
      };
      const fields: Record<string, FieldState> = Object.fromEntries(Object.entries(mappings).map(([field, path]) => [field, observed(row, path)]));
      const landingUrls: { device: "PC" | "MOBILE" | "UNSPECIFIED"; url: string; source: string }[] = [];
      const collectUrls = (value: unknown, path: string, depth = 0) => {
        if (value == null || depth > 8) return;
        if (Array.isArray(value)) { for (const [index, item] of value.entries()) collectUrls(item, `${path}.${index}`, depth + 1); return; }
        const item = object(value);
        for (const [key, entry] of Object.entries(item)) {
          if (["rspvLandingUrl", "pcLandingUrl", "mobileLandingUrl"].includes(key)) {
            if (entry != null && typeof entry !== "string")
              throw new PlatformError("INVALID_RESPONSE", "키워드광고 랜딩 URL의 자료형이 올바르지 않습니다.");
            if (entry) landingUrls.push({ device: key === "pcLandingUrl" ? "PC" : key === "mobileLandingUrl" ? "MOBILE" : "UNSPECIFIED", url: entry, source: `kakao_keyword.${creative ? "creative." : ""}${path}.${key}` });
          } else if (entry && typeof entry === "object") collectUrls(entry, `${path}.${key}`, depth + 1);
        }
      };
      collectUrls(source.landingInfo, "landingInfo");
      collectUrls(source.assets, "assets");
      const url = landing.rspvLandingUrl || landing.pcLandingUrl || landing.mobileLandingUrl || null;
      fields["tracking.url"] = url ? "PRESENT" : source.landingInfo === null ? "NOT_SET" : source.landingInfo ? "NOT_SET" : "NOT_RETURNED";
      const textParts = kind === "keyword" ? [row.text] : [source.title, source.description, source.assets?.additionalTitle];
      const text = textParts.filter((value) => typeof value === "string" && value).join(" ") || null;
      fields.text = text ? "PRESENT" : ["title", "description", "text"].some((key) => key in source) ? "NOT_SET" : "NOT_RETURNED";
      fields.name = observed(source, kind === "keyword" ? "text" : "name");
      if (reviewStatus === "REJECTED") fields.effective_status = "PRESENT";
      fields.currency = fields.timezone = "PRESENT";
      fields["budget.lifetime"] = "NOT_SUPPORTED";
      if (!["campaign", "adgroup"].includes(kind)) fields["budget.daily"] = "NOT_APPLICABLE";
      if (!["adgroup", "keyword"].includes(kind)) fields["bid.amount"] = fields["bid.strategy"] = "NOT_APPLICABLE";
      if (kind !== "adgroup") fields["schedule.start"] = fields["schedule.end"] = "NOT_APPLICABLE";
      const sources = Object.fromEntries(Object.entries(mappings).map(([field, path]) => [field, `kakao_keyword.${path}`]));
      sources.name = `kakao_keyword.${creative ? "creative." : ""}${kind === "keyword" ? "text" : "name"}`;
      sources.text = `kakao_keyword.${creative ? "creative." : ""}${kind === "keyword" ? "text" : "title,description,assets.additionalTitle"}`;
      sources["tracking.url"] = `kakao_keyword.${creative ? "creative." : ""}landingInfo`;
      sources["extensions.product_type"] = "kakao_keyword.premium_link_settings_api";
      if (reviewStatus === "REJECTED") sources.effective_status = row.reviewStatus != null ? "kakao_keyword.reviewStatus" : "kakao_keyword.creative.reviewStatus";
      sources.parent_id = `kakao_keyword.${kind === "adgroup" ? "campaignId" : "adGroupId"}`;
      return createEntity({
        platform: this.platform, account_id: account, entity_type: kind, entity_id: id,
        parent_id: parent == null ? null : kakaoId(parent), name: String((kind === "keyword" ? source.text : source.name) || ""),
        status: ({ ON: "ACTIVE", OFF: "PAUSED", DEL: "DELETED" } as Json)[row.config] || row.config || null,
        effective_status: effectiveStatus,
        currency: "KRW", timezone: "Asia/Seoul",
        budget: { daily: decimalValue(row.dailyBudgetAmount), lifetime: null, unit: "major", level: kind },
        bid: { amount: decimalValue(kind === "keyword" ? bid.bidAmount : row.bidAmount), strategy: kind === "keyword" ? bid.type ?? null : null },
        schedule: {
          start: schedule.beginDate ? timestamp(`${schedule.beginDate}T00:00:00`, "Asia/Seoul") : null,
          end: schedule.endDate ? timestamp(`${schedule.endDate}T23:59:59`, "Asia/Seoul") : null,
        },
        tracking: { url }, text, fields, sources, raw_data: row,
        optimization: { event: row.trackId ?? null },
        extensions: {
          api_version: "v1", product_type: "PREMIUM_LINK", campaign_type: "PREMIUM_LINK",
          biz_channel_id: row.bizChannelId ?? creative?.bizChannelId ?? null,
          creative_id: kind === "ad" ? kakaoId(row.creativeId) : kind === "creative" ? id : null,
          creative_link_id: kind === "ad" ? id : null,
          creative_status: creative?.config ?? null, review_status: reviewStatus,
          operating_statuses: operatingStatuses,
          landing_urls: landingUrls, landing_info: source.landingInfo,
          pc_landing_urls: [landing.pcLandingUrl || landing.rspvLandingUrl].filter(Boolean),
          mobile_landing_urls: [landing.mobileLandingUrl || landing.rspvLandingUrl].filter(Boolean),
          assets: source.assets, placements: row.placements, device_types: row.deviceTypes,
          schedule: row.schedule, use_keyword_extension: row.useKeywordExtension,
          exception_keywords: row.exceptionKeywords, bid_strategy: row.bidStrategy,
          mobile_bid_weight: row.mobileBidWeight, pc_bid_weight: row.pcBidWeight,
          trace_url: row.traceUrl, member_type: row.memberType,
        },
      });
    } catch (error) { throw asPlatformError(error); }
  }
}
