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

const PAGE_SIZE = 1000;
const WITHOUT_KEYWORDS = new Set(["SHOPPING", "CATALOG", "PLACE", "LOCAL_AD", "DOOH"]);
const NON_TEXT_ADS = new Set(["SHOPPING_PRODUCT_AD", "CATALOG_AD", "PLACE_AD", "LOCAL_AD", "DOOH_AD", "ADVOOST_PLACE_AD"]);
type Landing = { device: "PC" | "MOBILE" | "UNSPECIFIED"; url: string; source: string };
function jsonObject(value: unknown): Json {
  if (value == null) return {};
  return object(typeof value === "string" ? JSON.parse(value) : value);
}
function creativeParts(value: unknown, path = "ad", depth = 0): { text: string[]; textSources: string[]; urls: Landing[]; textObserved: boolean } {
  const result = { text: [] as string[], textSources: [] as string[], urls: [] as Landing[], textObserved: false };
  if (depth > 16 || !value || typeof value !== "object") return result;
  for (const [key, item] of Object.entries(value)) {
    const source = `${path}.${key}`;
    if (/^(headline|description|title|text|body)$/i.test(key)) {
      result.textObserved = true;
      if (typeof item === "string" && item.trim()) {
        result.text.push(item);
        result.textSources.push(`naver.${source}`);
      }
    }
    if (/^(final|url|linkUrl|pcUrl|mobileUrl|landingUrl|pcLandingUrl|mobileLandingUrl)$/i.test(key)) {
      if (item != null && typeof item !== "string" && typeof item !== "object") throw new PlatformError("INVALID_RESPONSE", "NAVER 소재 링크 형식이 올바르지 않습니다.");
      if (typeof item === "string" && item)
        result.urls.push({ device: /mobile/i.test(source) ? "MOBILE" : /(?:^|\.)pc(?:\.|url|landing)/i.test(source) ? "PC" : "UNSPECIFIED", url: item, source: `naver.${source}` });
    }
    if (item && typeof item === "object") {
      const nested = creativeParts(item, source, depth + 1);
      result.text.push(...nested.text);
      result.textSources.push(...nested.textSources);
      result.urls.push(...nested.urls);
      result.textObserved ||= nested.textObserved;
    }
  }
  return result;
}

export async function generateSignature(
  stamp: string,
  method: string,
  uri: string,
  secret: string,
) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    "HMAC", key, encoder.encode(`${stamp}.${method.toUpperCase()}.${uri}`),
  ));
  return btoa(String.fromCharCode(...bytes));
}
export class NaverAdapter extends BaseAdapter {
  platform = "naver" as const;
  capabilities = {
    accounts: "PARTIAL",
    campaigns: "SUPPORTED",
    adgroups: "SUPPORTED",
    ads: "SUPPORTED",
    creatives: "PARTIAL",
    keywords: "SUPPORTED",
    budget: "SUPPORTED",
    targeting: "PARTIAL",
    review: "PARTIAL",
    asset_groups: "UNSUPPORTED",
    gfa: "UNSUPPORTED",
    insights: "UNSUPPORTED",
    change_history: "UNSUPPORTED",
    product_settings: "PARTIAL",
    ad_extensions: "SUPPORTED",
    business_channels: "SUPPORTED",
    contracts: "SUPPORTED",
  };
  protected methods = [
    "listCampaigns",
    "listAdgroups",
    "listAds",
    "listKeywords",
  ];
  readonly http: ReadOnlyHTTP;
  private paths: Record<string, string> = {
    campaign: "campaigns",
    adgroup: "adgroups",
    ad: "ads",
    keyword: "keywords",
    ad_extension: "ad-extensions",
    business_channel: "channels",
    product_group: "product-groups",
    time_contract: "time-contracts",
    brand_new_contract: "brand-new/contracts",
  };
  private ids: Record<string, string> = {
    campaign: "nccCampaignId",
    adgroup: "nccAdgroupId",
    ad: "nccAdId",
    keyword: "nccKeywordId",
    ad_extension: "nccAdExtensionId",
    business_channel: "nccBusinessChannelId",
    product_group: "nccProductGroupId",
    time_contract: "nccTimeContractId",
    brand_new_contract: "brandNewContractId",
  };
  constructor(
    private apiKey: string,
    private secretKey: string,
    readonly customerId: string,
    options: { fetch?: FetchLike } = {},
  ) {
    super();
    if (!apiKey || !secretKey || !customerId)
      throw new PlatformError(
        "AUTHENTICATION",
        "NAVER API 키, 비밀 키, 고객 ID가 필요합니다.",
      );
    safeId(customerId);
    this.http = new ReadOnlyHTTP(
      {
        "https://api.searchad.naver.com": [
          [
            "GET",
            /^\/ncc\/(?:campaigns|adgroups|ads|keywords|ad-extensions|channels|product-groups|time-contracts)(?:\/[A-Za-z0-9_-]+)?$/,
          ],
          ["GET", /^\/ncc\/targets$/],
          ["GET", /^\/ncc\/brand-new\/contracts$/],
          ["GET", /^\/customer-links$/],
        ],
      },
      options.fetch,
    );
  }
  async get(path: string, accountId: string, params: Json = {}) {
    const stamp = String(Date.now());
    return this.http.request("GET", `https://api.searchad.naver.com${path}`, {
      params,
      headers: {
        "X-Timestamp": stamp,
        "X-API-KEY": this.apiKey,
        "X-Customer": safeId(accountId),
        "X-Signature": await generateSignature(stamp, "GET", path, this.secretKey),
      },
    });
  }
  private async rows(kind: string, accountId: string, params: Json = {}, parent?: Entity) {
    const output: Entity[] = [];
    const paged = ["campaign", "adgroup", "keyword"].includes(kind), seen = new Set<string>();
    let cursor: string | undefined;
    try {
      for (let page = 0; page < 10000; page++) {
        const data = await this.get(`/ncc/${this.paths[kind]}`, accountId, { ...params, ...(paged ? { recordSize: PAGE_SIZE, selector: "NEXT", ...(cursor ? { baseSearchId: cursor } : {}) } : {}) });
        if (!Array.isArray(data) || (paged && data.length > PAGE_SIZE))
          throw new PlatformError("INVALID_RESPONSE", "NAVER 목록 응답 또는 페이지 크기가 올바르지 않습니다.");
        for (const row of data) {
          const entity = this.normalize(row, kind, accountId, parent);
          if (seen.has(entity.key)) throw new PlatformError("INVALID_RESPONSE", "NAVER 목록 페이지에 중복된 항목이 있습니다.");
          seen.add(entity.key);
          output.push(entity);
        }
        if (!paged || data.length < PAGE_SIZE) return output;
        cursor = output.at(-1)!.entity_id;
      }
      throw new PlatformError("INVALID_RESPONSE", "NAVER 목록 페이지가 과도하게 반복되었습니다.");
    } catch (error) {
      if (output.length)
        throw new PartialFetchError(output, asPlatformError(error));
      throw asPlatformError(error);
    }
  }
  async listAccounts() {
    const probe = await this.get("/ncc/campaigns", this.customerId, { recordSize: 1 });
    if (!Array.isArray(probe)) throw new PlatformError("INVALID_RESPONSE", "NAVER 계정 조회 응답이 배열이 아닙니다.");
    for (const row of probe) this.normalize(row, "campaign", this.customerId);
    return [
      createEntity({
        platform: this.platform,
        account_id: this.customerId,
        entity_type: "account",
        entity_id: this.customerId,
        name: `NAVER ${this.customerId}`,
        currency: "KRW",
        timezone: "Asia/Seoul",
        fields: {
          name: "NOT_RETURNED",
          currency: "PRESENT",
          timezone: "PRESENT",
        },
        extensions: { configured_customer: true, account_discovery: "PARTIAL" },
      }),
    ];
  }
  async listCustomerLinks() {
    return this.get("/customer-links", this.customerId, { type: "MYCLIENTS" });
  }
  async listCampaigns(id: string) {
    return this.rows("campaign", id);
  }
  async listAdgroups(id: string) {
    const output: Entity[] = [], errors: PlatformError[] = [];
    const campaigns = await this.collect(() => this.listCampaigns(id), errors);
    for (const campaign of campaigns)
      output.push(...await this.collect(() => this.rows("adgroup", id, { nccCampaignId: campaign.entity_id }, campaign), errors));
    if (errors.length) throw new PartialFetchError(output, errors[0]);
    return output;
  }
  private keywordApplicable(group: Entity) {
    return !WITHOUT_KEYWORDS.has(group.extensions.product_subtype);
  }
  private async collect(request: () => Promise<Entity[]>, errors: PlatformError[]) {
    try { return await request(); }
    catch (error) {
      const cause = asPlatformError(error);
      errors.push(error instanceof PartialFetchError ? error.cause : cause);
      return cause.partial_entities;
    }
  }
  private async children(kind: string, accountId: string) {
    const output: Entity[] = [], errors: PlatformError[] = [];
    const groups = await this.collect(() => this.listAdgroups(accountId), errors);
    for (const group of groups) {
      if (kind === "keyword" && !this.keywordApplicable(group)) continue;
      output.push(...await this.collect(() => this.rows(kind, accountId, { nccAdgroupId: group.entity_id }, group), errors));
    }
    if (errors.length) throw new PartialFetchError(output, errors[0]);
    return output;
  }
  async listAds(id: string) {
    return this.children("ad", id);
  }
  async listKeywords(id: string) {
    return this.children("keyword", id);
  }
  async listEntities(accountId: string) {
    const errors: PlatformError[] = [];
    const campaigns = await this.collect(() => this.listCampaigns(accountId), errors), groups: Entity[] = [];
    const output = [...campaigns];
    for (const campaign of campaigns)
      groups.push(...await this.collect(() => this.rows("adgroup", accountId, { nccCampaignId: campaign.entity_id }, campaign), errors));
    output.push(...groups);
    for (const group of groups) {
      output.push(...await this.collect(() => this.rows("ad", accountId, { nccAdgroupId: group.entity_id }, group), errors));
      group.fields["extensions.keywords"] = this.keywordApplicable(group) ? "PRESENT" : "NOT_APPLICABLE";
      if (this.keywordApplicable(group)) {
        const before = errors.length;
        output.push(...await this.collect(() => this.rows("keyword", accountId, { nccAdgroupId: group.entity_id }, group), errors));
        if (errors.length > before) group.fields["extensions.keywords"] = errors.at(-1)!.kind === "PERMISSION_DENIED" ? "PERMISSION_DENIED" : "FETCH_FAILED";
      }
      try {
        const targets = await this.get("/ncc/targets", accountId, { ownerId: group.entity_id });
        if (!Array.isArray(targets)) throw new PlatformError("INVALID_RESPONSE", "NAVER 타겟 응답이 배열이 아닙니다.");
        const validated: Json[] = [];
        group.extensions.targets = validated;
        for (const target of targets) {
          const row = object(target);
          identity(row.nccTargetId);
          if (row.ownerId !== group.entity_id) throw new PlatformError("INVALID_RESPONSE", "NAVER 타겟의 소유 그룹이 다릅니다.");
          validated.push(row);
        }
        group.fields["extensions.targets"] = "PRESENT";
        group.sources["extensions.targets"] = `naver.GET /ncc/targets?ownerId=${group.entity_id}`;
      } catch (error) {
        const cause = asPlatformError(error);
        errors.push(cause);
        group.fields["extensions.targets"] = cause.kind === "PERMISSION_DENIED" ? "PERMISSION_DENIED" : "FETCH_FAILED";
      }
    }
    for (const owner of [...campaigns, ...groups])
      output.push(...await this.collect(() => this.rows("ad_extension", accountId, { ownerId: owner.entity_id }, owner), errors));
    if (groups.length)
      output.push(...await this.collect(() => this.rows("business_channel", accountId), errors));
    if (groups.some(group => group.extensions.product_type === "SHOPPING" || group.raw_data.productGroup != null))
      output.push(...await this.collect(() => this.rows("product_group", accountId), errors));
    if (groups.some(group => group.extensions.product_type === "BRAND_SEARCH" && group.extensions.product_subtype !== "BRAND_NEW"))
      output.push(...await this.collect(() => this.rows("time_contract", accountId), errors));
    if (groups.some(group => group.extensions.product_subtype === "BRAND_NEW"))
      output.push(...await this.collect(() => this.rows("brand_new_contract", accountId), errors));
    const groupIndex = new Map(groups.map(group => [group.entity_id, group]));
    for (const entity of output) {
      const parent = entity.parent_id ? groupIndex.get(entity.parent_id) : null;
      if (parent && !entity.extensions.product_type) this.productContext(entity, parent);
    }
    if (errors.length) throw new PartialFetchError(output, errors[0]);
    return output;
  }
  private productContext(entity: Entity, parent: Entity) {
    for (const key of ["product_type", "product_subtype"])
      if (entity.extensions[key] == null && parent.extensions[key] != null) {
        entity.extensions[key] = parent.extensions[key];
        entity.sources[`extensions.${key}`] = `${parent.entity_type}:${parent.entity_id}.${key}`;
      }
  }
  async getEntity(kind: string, id: string, accountId = this.customerId) {
    if (!this.paths[kind] || kind === "brand_new_contract") throw new PlatformError("UNSUPPORTED", "이 유형은 목록 조회에서만 확인할 수 있습니다.");
    const entity = this.normalize(
      await this.get(`/ncc/${this.paths[kind]}/${safeId(id)}`, accountId),
      kind,
      accountId,
    );
    if (entity.entity_id !== id) throw new PlatformError("INVALID_RESPONSE", "NAVER 상세 응답의 항목 ID가 요청과 일치하지 않습니다.");
    return entity;
  }
  normalize(input: unknown, kind: string, accountId: string, context?: Entity): Entity {
    try {
      if (!this.ids[kind]) throw new PlatformError("UNSUPPORTED", kind);
      const raw = object(input), parsed = { ...raw };
      for (const key of ["ad", "links", "adAttr", "adExtension", "businessInfo", "adgroupAttrJson"])
        if (raw[key] != null) parsed[key] = jsonObject(raw[key]);
      const row = validateApiEntity(this.platform, parsed, kind),
        mapping: Record<string, string> = {
          name: "name",
          "budget.daily": "dailyBudget",
          "bid.amount": "bidAmt",
          "schedule.start": "periodStartDt",
          "schedule.end": "periodEndDt",
          status: "userLock",
          effective_status: "status",
          targeting: "targets",
          created_at: "regTm",
        },
        fields: Record<string, FieldState> = Object.fromEntries(
          Object.entries(mapping).map(([key, value]) => [
            key,
            fieldState(row, value),
          ]),
        );
      const bid = row.bidAmt ?? row.adAttr?.bidAmt,
        groupBid = row.useGroupBidAmt ?? row.adAttr?.useGroupBidAmt;
      if (groupBid != null && typeof groupBid !== "boolean") throw new PlatformError("INVALID_RESPONSE", "NAVER 그룹 입찰 설정이 올바르지 않습니다.");
      if (row.bidAmt == null && row.adAttr && "bidAmt" in row.adAttr) {
        fields["bid.amount"] = fieldState(row.adAttr, "bidAmt");
        mapping["bid.amount"] = "adAttr.bidAmt";
      }
      const contract = kind === "time_contract" || kind === "brand_new_contract";
      if (contract) {
        mapping.name = "contractName";
        mapping["schedule.start"] = "contractStartDt";
        mapping["schedule.end"] = "contractEndDt";
        mapping.effective_status = "contractStatus";
        for (const key of ["name", "schedule.start", "schedule.end", "effective_status"])
          fields[key] = fieldState(row, mapping[key]);
      }
      if (!("name" in row) && "keyword" in row) {
        fields.name = fieldState(row, "keyword");
        mapping.name = "keyword";
      }
      fields.currency = fields.timezone = "PRESENT";
      fields["budget.lifetime"] = "NOT_SUPPORTED";
      if (row.useDailyBudget === false)
        fields["budget.daily"] = "NOT_APPLICABLE";
      if (row.usePeriod === false)
        fields["schedule.start"] = fields["schedule.end"] = "NOT_APPLICABLE";
      const parent =
          kind === "adgroup"
            ? row.nccCampaignId
            : ["ad", "keyword"].includes(kind)
              ? row.nccAdgroupId
              : kind === "ad_extension" ? row.ownerId
                : contract ? row.nccAdgroupId : null,
        creative = row.ad || row.adExtension || {},
        parts = creativeParts(creative, kind === "ad_extension" ? "adExtension" : "ad"),
        links = creativeParts(row.links || {}, "links");
      if (row.assets != null) {
        if (!Array.isArray(row.assets)) throw new PlatformError("INVALID_RESPONSE", "NAVER 소재 자산 목록이 올바르지 않습니다.");
        for (const [index, asset] of row.assets.entries()) {
          const item = object(asset), data = item.assetData;
          let text: string | null = null;
          if (typeof data === "string") {
            if (data.trim().startsWith("{")) {
              const assetParts = creativeParts(jsonObject(data), `assets.${index}.assetData`);
              parts.text.push(...assetParts.text);
              parts.textSources.push(...assetParts.textSources);
              parts.urls.push(...assetParts.urls);
            } else text = data;
          } else if (data != null) {
            const assetParts = creativeParts(object(data), `assets.${index}.assetData`);
            parts.text.push(...assetParts.text);
            parts.textSources.push(...assetParts.textSources);
            parts.urls.push(...assetParts.urls);
          }
          if (text?.trim()) {
            parts.text.push(text);
            parts.textSources.push(`naver.assets.${index}.assetData`);
          }
          parts.textObserved ||= data != null;
        }
      }
      const landingUrls = [...parts.urls, ...links.urls],
        landing = landingUrls.find(item => item.device === "PC") ?? landingUrls[0],
        url = landing?.url ?? null,
        text = typeof row.keyword === "string" ? row.keyword : [...new Set(parts.text)].join(" ") || null;
      fields["tracking.url"] = url ? "PRESENT" : "NOT_RETURNED";
      fields.text = text ? "PRESENT" : NON_TEXT_ADS.has(row.type) ? "NOT_APPLICABLE" : parts.textObserved || "keyword" in row ? "NOT_SET" : "NOT_RETURNED";
      if (row.customerId != null && identity(row.customerId) !== accountId)
        throw new PlatformError(
          "INVALID_RESPONSE",
          "NAVER 응답의 고객이 요청 계정과 일치하지 않습니다.",
        );
      if (context && parent != null && String(parent) !== context.entity_id)
        throw new PlatformError("INVALID_RESPONSE", "NAVER 응답의 상위 항목이 요청 범위와 일치하지 않습니다.");
      if (context && (context.platform !== this.platform || context.account_id !== accountId))
        throw new PlatformError("INVALID_RESPONSE", "NAVER 상위 항목의 계정이 요청과 일치하지 않습니다.");
      if (context?.entity_type === "adgroup" && row.nccCampaignId != null && context.parent_id != null && String(row.nccCampaignId) !== context.parent_id)
        throw new PlatformError("INVALID_RESPONSE", "NAVER 하위 항목의 캠페인이 요청과 일치하지 않습니다.");
      if (row.campaignTp != null && typeof row.campaignTp !== "string") throw new PlatformError("INVALID_RESPONSE", "NAVER 캠페인 유형이 올바르지 않습니다.");
      if (row.adgroupType != null && typeof row.adgroupType !== "string") throw new PlatformError("INVALID_RESPONSE", "NAVER 광고그룹 유형이 올바르지 않습니다.");
      if (row.type != null && typeof row.type !== "string") throw new PlatformError("INVALID_RESPONSE", "NAVER 소재 유형이 올바르지 않습니다.");
      const entity = createEntity({
        platform: this.platform,
        account_id: String(row.customerId ?? accountId),
        entity_type: kind,
        entity_id: identity(row[this.ids[kind]]),
        parent_id: parent == null ? context?.entity_id ?? null : String(parent),
        name: String(row.name ?? row.keyword ?? row.contractName ?? row[this.ids[kind]]),
        status:
          row.userLock == null ? null : row.userLock ? "PAUSED" : "ACTIVE",
        effective_status: row.status ?? row.contractStatus ?? null,
        currency: "KRW",
        timezone: "Asia/Seoul",
        budget: {
          unit: "major",
          daily:
            row.useDailyBudget === false ? null : decimalValue(row.dailyBudget),
          level: kind,
        },
        bid: {
          strategy: groupBid
            ? "GROUP"
            : bid != null
              ? "MANUAL"
              : null,
          amount: decimalValue(bid),
        },
        schedule: {
          start:
            row.usePeriod === false
              ? null
              : timestamp(contract ? row.contractStartDt : row.periodStartDt, "Asia/Seoul"),
          end:
            row.usePeriod === false
              ? null
              : timestamp(contract ? row.contractEndDt : row.periodEndDt, "Asia/Seoul"),
        },
        tracking: { url },
        text,
        created_at: timestamp(row.regTm, "Asia/Seoul"),
        fields,
        sources: Object.fromEntries(
          Object.entries(mapping).map(([key, value]) => [
            key,
            `naver.${value}`,
          ]),
        ),
        raw_data: raw,
        extensions: {
          campaign_type: row.campaignTp,
          product_type: row.campaignTp,
          product_subtype: row.adgroupType,
          ad_type: row.type,
          landing_urls: landingUrls,
          creative_data: creative,
          assets: row.assets,
          ad_attributes: row.adAttr,
          adgroup_attributes: row.adgroupAttrJson,
          targets: row.targets,
          inspect_status: row.inspectStatus,
          status_reason: row.statusReason,
          use_group_bid: groupBid,
          use_daily_budget: row.useDailyBudget,
        },
      });
      if (row.campaignTp != null) entity.sources["extensions.product_type"] = "naver.campaignTp";
      if (row.adgroupType != null) entity.sources["extensions.product_subtype"] = "naver.adgroupType";
      if (landing) entity.sources["tracking.url"] = landing.source;
      entity.sources.text = typeof row.keyword === "string" ? "naver.keyword" : [...new Set(parts.textSources)].join(",") || "naver.ad/adExtension/assets";
      if (context && parent == null) entity.sources.parent_id = `naver.list_request_parent:${context.entity_id}`;
      if (context) this.productContext(entity, context);
      return entity;
    } catch (error) {
      throw asPlatformError(error);
    }
  }
}
