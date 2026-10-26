import {
  createEntity,
  type Entity,
  type FieldState,
  type Json,
  type NativeEvent,
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
  validateHistoryRange,
  zonedParts,
  type FetchLike,
  type OperationSignal,
} from "./http";
import { validateApiEntity, validateGoogleAccount } from "./contracts";

// Field names follow the v26 reporting reference; keep type-specific data with its ad.
const AD_FORMAT_FIELDS: Record<string, string[]> = {
  responsive_search_ad: ["headlines", "descriptions"],
  responsive_display_ad: ["headlines", "long_headline", "descriptions", "business_name", "marketing_images", "square_marketing_images", "logo_images", "square_logo_images", "youtube_videos"],
  video_ad: ["video.asset", "in_feed.headline", "in_feed.description1", "in_feed.description2", "in_stream.action_headline", "bumper.action_headline", "non_skippable.action_headline", "out_stream.headline", "out_stream.description"],
  video_responsive_ad: ["headlines", "long_headlines", "descriptions", "videos", "logo_images", "companion_banners", "business_name"],
  demand_gen_multi_asset_ad: ["headlines", "descriptions", "business_name", "marketing_images", "square_marketing_images", "portrait_marketing_images", "logo_images"],
  demand_gen_video_responsive_ad: ["headlines", "long_headlines", "descriptions", "business_name", "videos", "logo_images", "companion_banners"],
  demand_gen_carousel_ad: ["headline", "description", "business_name", "carousel_cards", "logo_image"],
  app_ad: ["headlines", "descriptions", "mandatory_ad_text", "images", "youtube_videos", "html5_media_bundles", "app_deep_link"],
  app_engagement_ad: ["headlines", "descriptions", "images", "videos"],
  app_pre_registration_ad: ["headlines", "descriptions", "images", "youtube_videos"],
  expanded_text_ad: ["headline_part1", "headline_part2", "headline_part3", "description", "description2"],
  expanded_dynamic_search_ad: ["description", "description2"],
  text_ad: ["headline", "description1", "description2"],
  image_ad: ["image_asset.asset", "image_url", "mime_type"],
  smart_campaign_ad: ["headlines", "descriptions"],
  local_ad: ["headlines", "descriptions", "marketing_images", "logo_images", "videos"],
};
const CAMPAIGN_SETTINGS_FIELDS = [
  "app_campaign_setting.app_id", "app_campaign_setting.app_store", "app_campaign_setting.bidding_strategy_goal_type",
  "shopping_setting.merchant_id", "shopping_setting.feed_label", "shopping_setting.campaign_priority", "shopping_setting.enable_local", "shopping_setting.disable_product_feed",
  "hotel_setting.hotel_center_id", "hotel_setting.disable_hotel_setting", "travel_campaign_settings.travel_account_id",
  "dynamic_search_ads_setting.domain_name", "dynamic_search_ads_setting.language_code", "dynamic_search_ads_setting.use_supplied_urls_only",
  "local_campaign_setting.location_source_type", "local_services_campaign_settings.category_bids",
  "video_campaign_settings.video_ad_sequence", "video_campaign_settings.video_ad_format_control", "video_campaign_settings.video_ad_inventory_control",
  "demand_gen_campaign_settings.upgraded_targeting", "pmax_campaign_settings.brand_targeting_overrides",
  "pmax_campaign_settings.local_services_enabled", "pmax_campaign_settings.local_services_pmax_campaign_settings", "asset_automation_settings",
  "target_cpa.target_cpa_micros", "target_roas.target_roas", "maximize_conversions.target_cpa_micros", "maximize_conversion_value.target_roas",
  "tracking_url_template", "final_url_suffix", "url_custom_parameters",
];
const camel = (value: string) => value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
const referenceId = (value: unknown, accountId: string, resource: string): string => {
  if (typeof value !== "string" || !new RegExp(`^customers/${accountId}/${resource}/[A-Za-z0-9_~.-]+$`).test(value))
    throw new PlatformError("INVALID_RESPONSE", "Google 광고 항목의 연결 정보가 올바르지 않습니다.");
  return value.split("/").at(-1)!;
};
type Landing = { device: "PC" | "MOBILE" | "UNSPECIFIED"; url: string; source: string };
type Collected<T> = { rows: T[]; state: FieldState };
type Collector = <T>(operation: () => Promise<T[]>, partial: "partial_rows" | "partial_entities") => Promise<Collected<T>>;
function landingUrls(values: Json, source: string): Landing[] {
  const output: Landing[] = [];
  for (const [field, device] of [["finalUrls", "UNSPECIFIED"], ["finalMobileUrls", "MOBILE"]] as const) {
    const urls = values[field];
    if (urls == null) continue;
    if (!Array.isArray(urls) || urls.some(url => typeof url !== "string"))
      throw new PlatformError("INVALID_RESPONSE", "Google 도착 URL 목록의 자료형이 올바르지 않습니다.");
    output.push(...urls.map((url: string) => ({ device, url, source: `${source}.${field}` })));
  }
  return output;
}
function trackingParameters(values: Json): Record<string, string> {
  const custom = Object.fromEntries((values.urlCustomParameters || []).map((item: Json) => [item.key, item.value]));
  const output: Record<string, string> = {};
  for (const field of ["finalUrlSuffix", "trackingUrlTemplate"] as const) {
    const value = values[field];
    if (value == null) continue;
    if (typeof value !== "string") throw new PlatformError("INVALID_RESPONSE", "Google URL 추적 설정의 자료형이 올바르지 않습니다.");
    const query = field === "finalUrlSuffix" ? value : value.includes("?") ? value.slice(value.indexOf("?") + 1) : "";
    for (const [key, item] of new URLSearchParams(query.split("#")[0]))
      output[key] = item.replace(/\{_([A-Za-z0-9_]+)\}/g, (_, name: string) => Object.hasOwn(custom, name) ? custom[name] : "");
  }
  return output;
}
function creativeData(values: Json) {
  const formats: Json = {}, texts: string[] = [], assets = new Set<string>();
  const textKeys = /^(?:text|headline|headlinePart[123]|headlines|longHeadline|longHeadlines|description[12]?|descriptions|mandatoryAdText|businessName|actionHeadline)$/;
  const visit = (value: unknown, key = "") => {
    if (value == null) return;
    if (typeof value === "string") {
      if (key === "asset") assets.add(value);
      else if (textKeys.test(key)) texts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (typeof value !== "object")
      throw new PlatformError("INVALID_RESPONSE", "Google 소재 필드의 자료형이 올바르지 않습니다.");
    for (const [name, item] of Object.entries(value)) visit(item, name);
  };
  for (const format of Object.keys(AD_FORMAT_FIELDS)) {
    const name = camel(format);
    if (values[name] == null) continue;
    const data = object(values[name]);
    formats[name] = data;
    visit(data);
  }
  return { formats, text: texts.join(" ") || null, assets: [...assets] };
}
function validateAsset(raw: Json, accountId: string) {
  const asset = object(raw.asset);
  referenceId(asset.resourceName, accountId, "assets");
  if (identity(asset.id) !== asset.resourceName.split("/").at(-1) || typeof asset.type !== "string") throw new PlatformError("INVALID_RESPONSE", "Google 애셋 식별자를 읽지 못했습니다.");
  for (const [name, fields] of Object.entries({
    textAsset: ["text"], imageAsset: ["fullSize.url"], youtubeVideoAsset: ["youtubeVideoId", "youtubeVideoTitle"],
    demandGenCarouselCardAsset: ["headline", "marketingImageAsset", "squareMarketingImageAsset"],
    hotelPropertyAsset: ["hotelName", "hotelAddress", "placeId"], mobileAppAsset: ["appId", "appStore"], appDeepLinkAsset: ["appDeepLinkUri"],
  })) {
    if (asset[name] == null) continue;
    const data = object(asset[name]);
    for (const field of fields) {
      const value = field.split(".").reduce((current, key) => current?.[key], data);
      if (value != null && typeof value !== "string") throw new PlatformError("INVALID_RESPONSE", "Google 애셋 필드의 자료형이 올바르지 않습니다.");
    }
  }
  landingUrls(asset, "google.asset");
  return asset;
}
export class GoogleAdapter extends BaseAdapter {
  platform = "google" as const;
  capabilities = {
    accounts: "SUPPORTED",
    manager_hierarchy: "SUPPORTED",
    campaigns: "SUPPORTED",
    adgroups: "SUPPORTED",
    ads: "SUPPORTED",
    keywords: "SUPPORTED",
    asset_groups: "SUPPORTED",
    assets: "PARTIAL",
    budget: "SUPPORTED",
    targeting: "PARTIAL",
    conversion_goals: "PARTIAL",
    product_settings: "PARTIAL",
    review: "PARTIAL",
    insights: "UNSUPPORTED",
    change_history: "PARTIAL",
  };
  protected methods = [
    "listCampaigns",
    "listAdgroups",
    "listAds",
    "listKeywords",
    "listAssetGroups",
  ];
  readonly queries: Record<string, string> = {
    campaign:
      `SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, campaign.bidding_strategy_type, campaign.start_date_time, campaign.end_date_time, campaign.campaign_budget, campaign_budget.amount_micros, campaign_budget.total_amount_micros, campaign_budget.explicitly_shared, ${CAMPAIGN_SETTINGS_FIELDS.map(field => `campaign.${field}`).join(", ")}, customer.currency_code, customer.time_zone, customer.final_url_suffix, customer.tracking_url_template FROM campaign`,
    adgroup:
      "SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.primary_status, ad_group.type, ad_group.cpc_bid_micros, ad_group.campaign, ad_group.final_url_suffix, ad_group.tracking_url_template, ad_group.url_custom_parameters, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, customer.currency_code, customer.time_zone FROM ad_group",
    ad: `SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.primary_status, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.final_mobile_urls, ad_group_ad.ad.final_url_suffix, ad_group_ad.ad.tracking_url_template, ad_group_ad.ad.url_custom_parameters, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status, ad_group_ad.policy_summary.policy_topic_entries, ${Object.entries(AD_FORMAT_FIELDS).flatMap(([format, fields]) => fields.map(field => `ad_group_ad.ad.${format}.${field}`)).join(", ")}, ad_group.id, ad_group.campaign, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, customer.currency_code, customer.time_zone FROM ad_group_ad`,
    keyword:
      "SELECT ad_group_criterion.criterion_id, ad_group_criterion.resource_name, ad_group_criterion.status, ad_group_criterion.negative, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.cpc_bid_micros, ad_group_criterion.final_urls, ad_group_criterion.final_mobile_urls, ad_group_criterion.final_url_suffix, ad_group_criterion.tracking_url_template, ad_group_criterion.url_custom_parameters, ad_group.id, ad_group.campaign, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, customer.currency_code, customer.time_zone FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD'",
    asset_group:
      "SELECT asset_group.id, asset_group.name, asset_group.status, asset_group.primary_status, asset_group.campaign, asset_group.final_urls, asset_group.final_mobile_urls, asset_group.tracking_url_template, asset_group.url_custom_parameters, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, customer.currency_code, customer.time_zone FROM asset_group",
  };
  readonly http: ReadOnlyHTTP;
  readonly version: string;
  readonly accountLogins = new Map<string, string>();
  readonly accountTimezones = new Map<string, string>();
  readonly campaigns = new Map<string, Map<string, Entity>>();
  private accessToken: string;
  private expiresAt: number;
  private loginCustomerId: string;
  constructor(
    private credentials: Record<string, string>,
    options: { fetch?: FetchLike; api_version?: string; getSignal?: OperationSignal } = {},
  ) {
    super();
    if (
      !credentials.access_token &&
      !(
        credentials.client_id &&
        credentials.client_secret &&
        credentials.refresh_token
      )
    )
      throw new PlatformError(
        "AUTHENTICATION",
        "Google 계정 연결 정보를 입력해 주세요. 액세스 토큰 또는 클라이언트 ID·비밀 키·갱신 토큰이 필요합니다.",
      );
    this.version = safeId(options.api_version || "v26");
    if (!/^v\d+$/.test(this.version))
      throw new Error("Google 연결 설정의 API 버전을 확인해 주세요.");
    this.accessToken = credentials.access_token || "";
    this.expiresAt = this.accessToken ? Date.now() + 3500000 : 0;
    this.loginCustomerId = (credentials.login_customer_id || "").replace(
      /-/g,
      "",
    );
    this.http = new ReadOnlyHTTP(
      {
        "https://googleads.googleapis.com": [
          [
            "GET",
            new RegExp(`^/${this.version}/customers:listAccessibleCustomers$`),
          ],
          [
            "POST",
            new RegExp(`^/${this.version}/customers/[0-9]+/googleAds:search$`),
          ],
        ],
        "https://oauth2.googleapis.com": [["POST", /^\/token$/]],
      },
      options.fetch,
      undefined,
      options.getSignal,
    );
  }
  async refreshAccessToken() {
    const c = this.credentials;
    if (!(c.client_id && c.client_secret && c.refresh_token))
      throw new PlatformError(
        "AUTHENTICATION",
        "Google 연결 정보를 다시 입력해 주세요. 클라이언트 ID·비밀 키·갱신 토큰이 필요합니다.",
      );
    const data = await this.http.request(
      "POST",
      "https://oauth2.googleapis.com/token",
      {
        form: {
          grant_type: "refresh_token",
          client_id: c.client_id,
          client_secret: c.client_secret,
          refresh_token: c.refresh_token,
        },
      },
    );
    if (!data.access_token)
      throw new PlatformError(
        "AUTHENTICATION",
        "Google 계정 연결을 갱신하지 못했습니다. 인증 정보를 확인해 주세요.",
      );
    this.accessToken = data.access_token;
    this.expiresAt =
      Date.now() + Math.max(Number(data.expires_in || 3600) - 60, 0) * 1000;
  }
  private async request(
    method: string,
    path: string,
    body?: Json,
    login?: string,
  ): Promise<any> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() >= this.expiresAt) await this.refreshAccessToken();
      const selectedLogin = login ?? this.loginCustomerId;
      try {
        return await this.http.request(
          method,
          `https://googleads.googleapis.com/${this.version}/${path}`,
          {
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              ...(selectedLogin
                ? { "login-customer-id": safeId(selectedLogin) }
                : {}),
            },
            ...(body ? { json: body } : {}),
          },
        );
      } catch (error) {
        if (
          error instanceof PlatformError &&
          error.kind === "AUTHENTICATION" &&
          !attempt &&
          this.credentials.refresh_token
        ) {
          await this.refreshAccessToken();
          continue;
        }
        throw error;
      }
    }
    throw new PlatformError(
      "AUTHENTICATION",
      "Google 계정에 연결하지 못했습니다. 인증 정보를 확인해 주세요.",
    );
  }
  async search(
    accountId: string,
    query: string,
    login?: string,
  ): Promise<Json[]> {
    accountId = safeId(accountId.replace(/-/g, ""));
    if (!/^\d+$/.test(accountId))
      throw new Error("Google 광고 계정 ID는 숫자로 입력해 주세요.");
    const rows: Json[] = [],
      seen = new Set<string>();
    let body: Json = { query };
    for (;;) {
      try {
        const data = object(
          await this.request(
            "POST",
            `customers/${accountId}/googleAds:search`,
            body,
            login ?? this.accountLogins.get(accountId) ?? this.loginCustomerId,
          ),
        );
        if (data.results !== undefined && !Array.isArray(data.results))
          throw new PlatformError(
            "INVALID_RESPONSE",
            "Google 광고 설정을 읽지 못했습니다. 다시 조회해 주세요.",
          );
        rows.push(...(data.results || []));
        if (
          data.nextPageToken != null &&
          typeof data.nextPageToken !== "string"
        )
          throw new PlatformError(
            "INVALID_RESPONSE",
            "Google 광고 설정의 다음 목록을 가져오지 못했습니다. 다시 조회해 주세요.",
          );
        if (!data.nextPageToken) return rows;
        if (seen.has(data.nextPageToken))
          throw new PlatformError(
            "INVALID_RESPONSE",
            "Google에서 같은 광고 목록이 반복되어 조회를 멈췄습니다. 다시 조회해 주세요.",
          );
        seen.add(data.nextPageToken);
        body = { query, pageToken: data.nextPageToken };
      } catch (error) {
        const cause = asPlatformError(error);
        cause.partial_rows = rows;
        throw cause;
      }
    }
  }
  async listAccounts() {
    const data = object(
      await this.request(
        "GET",
        "customers:listAccessibleCustomers",
        undefined,
        "",
      ),
    );
    if (
      !Array.isArray(data.resourceNames) ||
      data.resourceNames.some(
        (name: unknown) =>
          typeof name !== "string" || !/^customers\/\d+$/.test(name),
      )
    )
      throw new PlatformError(
        "INVALID_RESPONSE",
        "Google 광고 계정 목록을 읽지 못했습니다. 계정 연결을 확인해 주세요.",
      );
    const pending: [string, string][] = data.resourceNames.map(
        (name: string) => [name.split("/").at(-1)!, ""],
      ),
      seen = new Set<string>(),
      accounts: Entity[] = [],
      query =
        "SELECT customer_client.id, customer_client.client_customer, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.level, customer_client.status FROM customer_client WHERE customer_client.level <= 1";
    try {
      while (pending.length) {
        const [id, login] = pending.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const row of await this.search(id, query, login)) {
          const client = validateGoogleAccount(row.customerClient),
            identifier = identity(client.id);
          this.accountLogins.set(
            identifier,
            this.loginCustomerId || login || id,
          );
          if (client.timeZone)
            this.accountTimezones.set(identifier, client.timeZone);
          if (!accounts.some((a) => a.entity_id === identifier))
            accounts.push(
              createEntity({
                platform: this.platform,
                account_id: identifier,
                entity_type: "account",
                entity_id: identifier,
                name: client.descriptiveName || "",
                status: client.status ?? null,
                currency: client.currencyCode || "UNKNOWN",
                timezone: client.timeZone || "UTC",
                fields: {
                  currency: fieldState(client, "currencyCode"),
                  timezone: fieldState(client, "timeZone"),
                },
                raw_data: row,
                extensions: {
                  manager: client.manager,
                  login_customer_id: login || id,
                  parent_manager_id: client.level ? id : null,
                },
              }),
            );
          if (client.manager && client.level === 1)
            pending.push([identifier, login || id]);
        }
      }
    } catch (error) {
      throw new PartialFetchError(accounts, asPlatformError(error));
    }
    return accounts;
  }
  private async list(kind: string, id: string): Promise<Entity[]> {
    const output: Entity[] = [];
    try {
      for (const row of await this.search(id, this.queries[kind]))
        output.push(this.normalize(row, kind, id));
      return output;
    } catch (error) {
      const cause = asPlatformError(error);
      for (const row of cause.partial_rows) {
        try {
          output.push(this.normalize(row, kind, id));
        } catch (normalizationError) {
          throw new PartialFetchError(
            output,
            asPlatformError(normalizationError),
          );
        }
      }
      if (output.length) throw new PartialFetchError(output, cause);
      throw cause;
    }
  }
  async listCampaigns(id: string) {
    const rows = await this.list("campaign", id);
    this.campaigns.set(id, new Map(rows.map((row) => [row.entity_id, row])));
    return rows;
  }
  async listAdgroups(id: string) {
    const campaigns =
      this.campaigns.get(id) ||
      new Map(
        (await this.listCampaigns(id)).map((row) => [row.entity_id, row]),
      );
    const rows = await this.list("adgroup", id);
    for (const row of rows) {
      const parent = campaigns.get(row.parent_id || "");
      if (parent) {
        row.budget = { ...parent.budget, inherited_from: parent.entity_id };
        row.fields["budget.daily"] =
          parent.fields["budget.daily"] || "NOT_RETURNED";
        row.fields["budget.lifetime"] =
          parent.fields["budget.lifetime"] || "NOT_RETURNED";
        row.sources["budget.daily"] =
          `campaign:${parent.entity_id}.campaign_budget.amount_micros`;
      }
    }
    return rows;
  }
  async listAds(id: string) {
    return this.list("ad", id);
  }
  async listKeywords(id: string) {
    return this.list("keyword", id);
  }
  async listAssetGroups(id: string) {
    return this.list("asset_group", id);
  }
  async listAssets(id: string, references?: string[]) {
    const names = references?.map(reference => {
      referenceId(reference, id, "assets");
      return `'${reference}'`;
    });
    return this.search(
      id,
      "SELECT asset.resource_name, asset.id, asset.name, asset.type, asset.text_asset.text, asset.image_asset.full_size.url, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels, asset.youtube_video_asset.youtube_video_id, asset.youtube_video_asset.youtube_video_title, asset.final_urls, asset.final_mobile_urls, asset.final_url_suffix, asset.url_custom_parameters, asset.demand_gen_carousel_card_asset.headline, asset.demand_gen_carousel_card_asset.marketing_image_asset, asset.demand_gen_carousel_card_asset.square_marketing_image_asset, asset.hotel_property_asset.hotel_name, asset.hotel_property_asset.hotel_address, asset.hotel_property_asset.place_id, asset.mobile_app_asset.app_id, asset.mobile_app_asset.app_store, asset.app_deep_link_asset.app_deep_link_uri, asset.policy_summary.approval_status, asset.policy_summary.review_status FROM asset" + (names?.length ? ` WHERE asset.resource_name IN (${names.join(", ")})` : ""),
    );
  }
  async listAssetGroupAssets(id: string) {
    return this.search(
      id,
      "SELECT asset_group_asset.resource_name, asset_group_asset.asset_group, asset_group_asset.asset, asset_group_asset.field_type, asset_group_asset.status, asset_group_asset.source, asset_group_asset.primary_status, asset_group_asset.policy_summary.approval_status, asset_group_asset.policy_summary.review_status, asset_group_asset.policy_summary.policy_topic_entries FROM asset_group_asset",
    );
  }
  async getTargeting(id: string) {
    return this.search(
      id,
      "SELECT campaign.id, campaign_criterion.resource_name, campaign_criterion.campaign, campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.status, campaign_criterion.negative, campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant, campaign_criterion.device.type, campaign_criterion.age_range.type, campaign_criterion.gender.type, campaign_criterion.user_list.user_list, campaign_criterion.ad_schedule.day_of_week, campaign_criterion.ad_schedule.start_hour, campaign_criterion.ad_schedule.start_minute, campaign_criterion.ad_schedule.end_hour, campaign_criterion.ad_schedule.end_minute, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion",
    );
  }
  async listEntities(id: string): Promise<Entity[]> {
    id = safeId(id.replace(/-/g, ""));
    if (!/^\d+$/.test(id)) throw new Error("Google 광고 계정 ID는 숫자로 입력해 주세요.");
    this.campaigns.delete(id);
    const output: Entity[] = [], failures: PlatformError[] = [];
    const collect = async <T>(operation: () => Promise<T[]>, partial: "partial_rows" | "partial_entities"): Promise<{ rows: T[]; state: FieldState }> => {
      try { return { rows: await operation(), state: "PRESENT" }; }
      catch (error) {
        const cause = asPlatformError(error);
        failures.push(cause);
        return { rows: cause[partial] as T[], state: (cause.cause_kind || cause.kind) === "PERMISSION_DENIED" ? "PERMISSION_DENIED" : "FETCH_FAILED" };
      }
    };
    for (const name of this.methods) {
      const fetched = await collect(() => (this as unknown as Record<string, (account: string) => Promise<Entity[]>>)[name](id), "partial_entities");
      output.push(...fetched.rows);
    }
    const campaigns = new Map(output.filter(entity => entity.entity_type === "campaign").map(entity => [entity.entity_id, entity]));
    const adgroups = new Map(output.filter(entity => entity.entity_type === "adgroup").map(entity => [entity.entity_id, entity]));
    const groups = output.filter(entity => entity.entity_type === "asset_group");
    const campaignOf = (entity: Entity): Entity | undefined => entity.entity_type === "campaign" ? entity : campaigns.get(
      ["adgroup", "asset_group"].includes(entity.entity_type) ? entity.parent_id || "" : adgroups.get(entity.parent_id || "")?.parent_id || "",
    );
    for (const entity of output) {
      const campaign = campaignOf(entity);
      if (!campaign) continue;
      for (const field of ["product_type", "product_subtype"] as const) {
        entity.extensions[field] = campaign.extensions[field];
        entity.fields[`extensions.${field}`] = campaign.fields[`extensions.${field}`] || "NOT_RETURNED";
      }
      if (entity.entity_type === "asset_group") {
        entity.budget = { ...campaign.budget, inherited_from: campaign.entity_id };
        for (const field of ["daily", "lifetime"] as const) {
          entity.fields[`budget.${field}`] = campaign.fields[`budget.${field}`];
          entity.sources[`budget.${field}`] = `campaign:${campaign.entity_id}.campaign_budget`;
        }
      }
    }
    if (!output.length) {
      if (failures.length) throw new PartialFetchError(output, failures[0]);
      return output;
    }
    const linked = groups.length ? await collect(() => this.listAssetGroupAssets(id), "partial_rows") : { rows: [] as Json[], state: "PRESENT" as FieldState };
    const links: Json[] = [];
    for (const raw of linked.rows) {
      try {
        const link = object(raw.assetGroupAsset);
        referenceId(link.assetGroup, id, "assetGroups");
        referenceId(link.asset, id, "assets");
        if (typeof link.fieldType !== "string" || typeof link.status !== "string") throw new PlatformError("INVALID_RESPONSE", "Google 애셋 연결 상태를 읽지 못했습니다.");
        links.push(link);
      } catch (error) { failures.push(asPlatformError(error)); linked.state = "FETCH_FAILED"; }
    }
    const references = [...new Set([...links.map(link => link.asset), ...output.flatMap(entity => entity.extensions.creative_assets || [])])] as string[];
    const assets = new Map<string, Json>();
    let assetState: FieldState = "PRESENT";
    for (let offset = 0; offset < references.length; offset += 500) {
      const fetched = await collect(() => this.listAssets(id, references.slice(offset, offset + 500)), "partial_rows");
      if (fetched.state !== "PRESENT") assetState = fetched.state;
      for (const raw of fetched.rows) {
        try {
          const asset = validateAsset(raw, id);
          assets.set(asset.resourceName, asset);
        } catch (error) { failures.push(asPlatformError(error)); assetState = "FETCH_FAILED"; }
      }
    }
    for (const entity of output) {
      const entityLinks = entity.entity_type === "asset_group" ? links.filter(link => link.assetGroup === `customers/${id}/assetGroups/${entity.entity_id}`) : [];
      const names: string[] = [...new Set<string>(entity.entity_type === "asset_group" ? entityLinks.map(link => link.asset) : entity.extensions.creative_assets || [])];
      if (entity.entity_type !== "asset_group" && !names.length) continue;
      const attached = names.map(name => ({ resource_name: name, asset: assets.get(name) || null, links: entityLinks.filter(link => link.asset === name) }));
      const missing = names.some(name => !assets.has(name));
      if (missing && assetState === "PRESENT") failures.push(new PlatformError("NOT_RETURNED", "연결된 Google 애셋 일부가 조회되지 않았습니다."));
      const state = linked.state !== "PRESENT" && entity.entity_type === "asset_group" ? linked.state : assetState !== "PRESENT" ? assetState : missing ? "NOT_RETURNED" : "PRESENT";
      entity.extensions.assets = attached;
      entity.fields["extensions.assets"] = state;
      entity.sources["extensions.assets"] = "google.asset_group_asset|ad_group_ad.ad -> google.asset";
      entity.raw_data = { ...entity.raw_data, linked_assets: attached };
      const active = attached.filter(item => entity.entity_type !== "asset_group" || item.links.some(link => link.status !== "REMOVED"));
      const texts = active.map(item => item.asset?.textAsset?.text || item.asset?.demandGenCarouselCardAsset?.headline).filter(value => typeof value === "string");
      if (texts.length) {
        entity.text = [entity.text, ...texts].filter(Boolean).join(" ");
        entity.fields.text = "PRESENT";
        entity.sources.text = "google.asset.text_asset.text|asset.demand_gen_carousel_card_asset.headline";
      } else if (entity.entity_type === "asset_group") {
        const feedDriven = !!campaignOf(entity)?.extensions.product_settings?.shoppingSetting?.merchantId;
        entity.fields.text = state !== "PRESENT" ? state : feedDriven ? "NOT_SUPPORTED" : "NOT_SET";
        if (!entity.tracking.url && feedDriven) {
          entity.fields["tracking.url"] = "NOT_SUPPORTED";
          entity.fields["extensions.landing_urls"] = "NOT_SUPPORTED";
        }
      }
      const landings = active.flatMap(item => item.asset ? landingUrls(item.asset, "google.asset") : []);
      entity.extensions.landing_urls.push(...landings);
      if (landings.length) entity.fields["extensions.landing_urls"] = "PRESENT";
    }
    for (const entity of output) {
      const campaign = campaignOf(entity);
      const group = ["ad", "keyword"].includes(entity.entity_type) ? adgroups.get(entity.parent_id || "") : undefined;
      const levels = [campaign?.extensions.account_tracking, campaign?.extensions, group?.extensions, entity.extensions].filter(Boolean) as Json[];
      const parameters: Record<string, string> = {};
      let suffix = "", template = "", observed = false;
      for (const level of levels) {
        if (typeof level.final_url_suffix === "string") { suffix = level.final_url_suffix || suffix; observed = true; }
        if (typeof level.tracking_template === "string") { template = level.tracking_template || template; observed = true; }
        if (Array.isArray(level.url_custom_parameters)) {
          Object.assign(parameters, Object.fromEntries(level.url_custom_parameters.map((value: Json) => [value.key, value.value])));
          observed = true;
        }
      }
      entity.tracking.parameters = trackingParameters({ finalUrlSuffix: suffix, trackingUrlTemplate: template, urlCustomParameters: Object.entries(parameters).map(([key, value]) => ({ key, value })) });
      if (observed) entity.fields["tracking.parameters"] = "PRESENT";
      entity.extensions.effective_final_url_suffix = suffix;
      entity.extensions.effective_tracking_template = template;
      entity.sources["tracking.parameters"] = "google final_url_suffix|tracking_url_template with inherited url_custom_parameters";
    }
    if (groups.length) {
      const listing = await collect(() => this.search(id, "SELECT asset_group_listing_group_filter.resource_name, asset_group_listing_group_filter.asset_group, asset_group_listing_group_filter.id, asset_group_listing_group_filter.type, asset_group_listing_group_filter.listing_source, asset_group_listing_group_filter.parent_listing_group_filter, asset_group_listing_group_filter.case_value.product_brand.value, asset_group_listing_group_filter.case_value.product_category.category_id, asset_group_listing_group_filter.case_value.product_category.level, asset_group_listing_group_filter.case_value.product_item_id.value, asset_group_listing_group_filter.case_value.product_type.value, asset_group_listing_group_filter.case_value.product_type.level, asset_group_listing_group_filter.case_value.product_custom_attribute.index, asset_group_listing_group_filter.case_value.product_custom_attribute.value, asset_group_listing_group_filter.case_value.product_channel.channel, asset_group_listing_group_filter.case_value.product_condition.condition FROM asset_group_listing_group_filter"), "partial_rows");
      const byGroup = new Map<string, Json[]>();
      for (const raw of listing.rows) {
        try {
          const value = object(raw.assetGroupListingGroupFilter);
          const group = referenceId(value.assetGroup, id, "assetGroups");
          if (typeof value.type !== "string") throw new PlatformError("INVALID_RESPONSE", "Google 상품 그룹 필터의 유형을 읽지 못했습니다.");
          if (!byGroup.has(group)) byGroup.set(group, []);
          byGroup.get(group)!.push(value);
        } catch (error) { failures.push(asPlatformError(error)); listing.state = "FETCH_FAILED"; }
      }
      for (const group of groups) {
        group.extensions.listing_group_filters = byGroup.get(group.entity_id) || [];
        group.fields["extensions.listing_group_filters"] = listing.state;
        group.sources["extensions.listing_group_filters"] = "google.asset_group_listing_group_filter";
      }
    }
    await this.enrichSettings(id, output, campaigns, adgroups, collect, failures);
    await this.enrichShoppingProducts(id, campaigns, collect, failures);
    if (failures.length) throw new PartialFetchError(output, failures[0]);
    return output;
  }
  private async enrichShoppingProducts(id: string, campaigns: Map<string, Entity>, collect: Collector, failures: PlatformError[]) {
    for (const campaign of campaigns.values()) {
      const type = campaign.extensions.product_type, setting = campaign.extensions.product_settings?.shoppingSetting;
      const feed = setting?.merchantId != null && setting.disableProductFeed !== true;
      campaign.extensions.shopping_products = [];
      campaign.sources["extensions.shopping_products"] = "google.shopping_product (campaign scope; status/issues can lag up to 24 hours)";
      if (type !== "SHOPPING" && !(feed && ["PERFORMANCE_MAX", "DEMAND_GEN", "VIDEO"].includes(type))) {
        campaign.fields["extensions.shopping_products"] = type === "MULTI_CHANNEL" ? "NOT_SUPPORTED" : "NOT_APPLICABLE";
        continue;
      }
      const campaignResource = `customers/${id}/campaigns/${campaign.entity_id}`;
      const result = await collect(async () => {
        referenceId(campaignResource, id, "campaigns");
        if (!/^\d+$/.test(campaign.entity_id) || BigInt(campaign.entity_id) <= 0n) throw new PlatformError("INVALID_RESPONSE", "Google 쇼핑 캠페인 ID가 올바르지 않습니다.");
        return this.search(id, `SELECT shopping_product.resource_name, shopping_product.campaign, shopping_product.merchant_center_id, shopping_product.channel, shopping_product.language_code, shopping_product.feed_label, shopping_product.item_id, shopping_product.status, shopping_product.issues FROM shopping_product WHERE shopping_product.campaign = '${campaignResource}'`);
      }, "partial_rows");
      const products: Json[] = [], seen = new Set<string>();
      for (const raw of result.rows) {
        try {
          const product = object(raw.shoppingProduct), merchant = identity(product.merchantCenterId);
          if (!/^\d+$/.test(merchant) || BigInt(merchant) <= 0n || product.campaign !== campaignResource || typeof product.resourceName !== "string" || !new RegExp(`^customers/${id}/shoppingProducts/${merchant}~[^~]+~[^~]+~[^~]*~.+$`).test(product.resourceName) || /[\r\n\0]/.test(product.resourceName))
            throw new PlatformError("INVALID_RESPONSE", "Google 쇼핑 상품의 계정·판매자·캠페인 연결이 올바르지 않습니다.");
          if (typeof product.itemId !== "string" || !product.itemId || ["channel", "languageCode", "feedLabel", "status"].some(field => product[field] != null && typeof product[field] !== "string"))
            throw new PlatformError("INVALID_RESPONSE", "Google 쇼핑 상품 필드의 자료형이 올바르지 않습니다.");
          if (product.issues != null && (!Array.isArray(product.issues) || product.issues.some((issue: unknown) => !issue || typeof issue !== "object" || Array.isArray(issue))))
            throw new PlatformError("INVALID_RESPONSE", "Google 쇼핑 상품의 문제 목록을 읽지 못했습니다.");
          if (seen.has(product.resourceName)) throw new PlatformError("INVALID_RESPONSE", "Google 쇼핑 상품이 조회 페이지에서 반복되었습니다.");
          seen.add(product.resourceName);
          products.push(product);
        } catch (error) { failures.push(asPlatformError(error)); result.state = "FETCH_FAILED"; }
      }
      campaign.extensions.shopping_products = products;
      campaign.fields["extensions.shopping_products"] = result.state;
    }
  }
  private async enrichSettings(id: string, entities: Entity[], campaigns: Map<string, Entity>, adgroups: Map<string, Entity>, collect: Collector, failures: PlatformError[]) {
    const campaignCriteria = await collect(() => this.getTargeting(id), "partial_rows");
    const groupCriteria = adgroups.size ? await collect(() => this.search(id,
      "SELECT ad_group.id, ad_group_criterion.resource_name, ad_group_criterion.ad_group, ad_group_criterion.criterion_id, ad_group_criterion.type, ad_group_criterion.status, ad_group_criterion.negative, ad_group_criterion.age_range.type, ad_group_criterion.gender.type, ad_group_criterion.user_list.user_list, ad_group_criterion.custom_audience.custom_audience, ad_group_criterion.audience.audience, ad_group_criterion.combined_audience.combined_audience, ad_group_criterion.location.geo_target_constant, ad_group_criterion.listing_group.type, ad_group_criterion.listing_group.case_value.product_brand.value, ad_group_criterion.listing_group.case_value.product_item_id.value, ad_group_criterion.listing_group.case_value.product_channel.channel, ad_group_criterion.listing_group.case_value.product_condition.condition FROM ad_group_criterion WHERE ad_group_criterion.type != 'KEYWORD'"), "partial_rows") : { rows: [], state: "PRESENT" as FieldState };
    const byCampaign = new Map<string, Json[]>(), byGroup = new Map<string, Json[]>();
    const readCriteria = (data: Collected<Json>, field: "campaignCriterion" | "adGroupCriterion", resource: "campaigns" | "adGroups", target: Map<string, Json[]>) => {
      for (const raw of data.rows) {
        try {
          const criterion = object(raw[field]);
          const parent = referenceId(criterion[field === "campaignCriterion" ? "campaign" : "adGroup"], id, resource);
          if (typeof criterion.type !== "string" || (criterion.negative != null && typeof criterion.negative !== "boolean")) throw new PlatformError("INVALID_RESPONSE", "Google 타겟 설정의 자료형이 올바르지 않습니다.");
          for (const [name, key] of [["userList", "userList"], ["customAudience", "customAudience"], ["audience", "audience"], ["combinedAudience", "combinedAudience"], ["location", "geoTargetConstant"], ["ageRange", "type"], ["gender", "type"]]) {
            if (criterion[name] == null) continue;
            const value = object(criterion[name])[key];
            if (value != null && typeof value !== "string") throw new PlatformError("INVALID_RESPONSE", "Google 타겟 식별자의 자료형이 올바르지 않습니다.");
          }
          if (criterion.status === "REMOVED") continue;
          if (!target.has(parent)) target.set(parent, []);
          target.get(parent)!.push(criterion);
        } catch (error) { failures.push(asPlatformError(error)); data.state = "FETCH_FAILED"; }
      }
    };
    readCriteria(campaignCriteria, "campaignCriterion", "campaigns", byCampaign);
    readCriteria(groupCriteria, "adGroupCriterion", "adGroups", byGroup);
    const geoReferences = [...new Set([...byCampaign.values(), ...byGroup.values()].flat().map(criterion => criterion.location?.geoTargetConstant).filter(Boolean))] as string[];
    const geo = new Map<string, Json>();
    let geoState: FieldState = "PRESENT";
    for (let offset = 0; offset < geoReferences.length; offset += 500) {
      const names = geoReferences.slice(offset, offset + 500);
      if (names.some(name => !/^geoTargetConstants\/\d+$/.test(name))) { failures.push(new PlatformError("INVALID_RESPONSE", "Google 지역 타겟 식별자가 올바르지 않습니다.")); geoState = "FETCH_FAILED"; continue; }
      const result = await collect(() => this.search(id, `SELECT geo_target_constant.resource_name, geo_target_constant.country_code, geo_target_constant.target_type, geo_target_constant.name FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${names.map(name => `'${name}'`).join(", ")})`), "partial_rows");
      if (result.state !== "PRESENT") geoState = result.state;
      for (const raw of result.rows) {
        try {
          const value = object(raw.geoTargetConstant);
          if (!names.includes(value.resourceName) || typeof value.countryCode !== "string" || typeof value.targetType !== "string") throw new PlatformError("INVALID_RESPONSE", "Google 지역 정보를 읽지 못했습니다.");
          geo.set(value.resourceName, value);
        } catch (error) { failures.push(asPlatformError(error)); geoState = "FETCH_FAILED"; }
      }
    }
    if (geoState === "PRESENT" && geoReferences.some(name => !geo.has(name))) {
      geoState = "NOT_RETURNED";
      failures.push(new PlatformError("NOT_RETURNED", "Google 지역 타겟 일부의 상세 정보를 조회하지 못했습니다."));
    }
    for (const entity of entities) {
      const group = ["ad", "creative", "keyword"].includes(entity.entity_type) ? adgroups.get(entity.parent_id || "") : entity.entity_type === "adgroup" ? entity : undefined;
      const campaignId = entity.entity_type === "campaign" ? entity.entity_id : group?.parent_id || (["adgroup", "asset_group"].includes(entity.entity_type) ? entity.parent_id : null);
      const own = group ? byGroup.get(group.entity_id) || [] : [];
      const criteria = [...campaignId ? byCampaign.get(campaignId) || [] : [], ...own];
      const state = !campaignId ? "NOT_RETURNED" : campaignCriteria.state !== "PRESENT" ? campaignCriteria.state : group && groupCriteria.state !== "PRESENT" ? groupCriteria.state : "PRESENT";
      entity.extensions.targeting_criteria = criteria;
      entity.extensions.geo_targets = criteria.filter(criterion => criterion.location).map(criterion => ({ criterion, location: geo.get(criterion.location.geoTargetConstant) || null }));
      entity.fields["extensions.targeting_criteria"] = state;
      entity.fields["extensions.geo_targets"] = state !== "PRESENT" ? state : geoState;
      entity.sources["extensions.targeting_criteria"] = "google.campaign_criterion|ad_group_criterion";
      const audienceOf = (criterion: Json) => criterion.userList?.userList || criterion.customAudience?.customAudience || criterion.audience?.audience || criterion.combinedAudience?.combinedAudience;
      const audienceCriteria = criteria.filter(criterion => audienceOf(criterion));
      const missingAudience = criteria.some(criterion => ["USER_LIST", "CUSTOM_AUDIENCE", "AUDIENCE", "COMBINED_AUDIENCE"].includes(criterion.type) && !audienceOf(criterion));
      for (const [field, negative] of [["custom_audiences", false], ["excluded_audiences", true]] as const) {
        entity.targeting[field] = [...new Set(audienceCriteria.filter(criterion => criterion.negative === negative).map(audienceOf))];
        entity.fields[`targeting.${field}`] = state !== "PRESENT" ? state : missingAudience || audienceCriteria.some(criterion => criterion.negative == null) ? "NOT_RETURNED" : "PRESENT";
        entity.sources[`targeting.${field}`] = "google.campaign_criterion|ad_group_criterion (negative respected)";
      }
      const locations = criteria.filter(criterion => criterion.type === "LOCATION");
      const resolved = locations.filter(criterion => criterion.negative === false).map(criterion => geo.get(criterion.location?.geoTargetConstant));
      const countryOnly = resolved.every(location => location?.targetType === "Country") && locations.every(criterion => criterion.negative === false);
      if (state !== "PRESENT" || geoState !== "PRESENT") entity.fields["targeting.countries"] = state !== "PRESENT" ? state : geoState;
      else if (locations.length && !countryOnly) entity.fields["targeting.countries"] = "NOT_SUPPORTED";
      else {
        entity.targeting.countries = resolved.map(location => location!.countryCode);
        entity.fields["targeting.countries"] = locations.length ? "PRESENT" : "NOT_SET";
      }
      entity.sources["targeting.countries"] = "google.campaign_criterion|ad_group_criterion.location -> geo_target_constant (country-only targets)";
      // Disjoint age bands and exclusions do not have a faithful min/max representation.
      for (const field of ["age_min", "age_max"] as const) {
        entity.fields[`targeting.${field}`] = state !== "PRESENT" ? state : "NOT_SUPPORTED";
        entity.sources[`targeting.${field}`] = "google.campaign_criterion|ad_group_criterion.age_range (see targeting_criteria)";
      }
    }
    const customerGoals = await collect(() => this.search(id, "SELECT customer_conversion_goal.resource_name, customer_conversion_goal.category, customer_conversion_goal.origin, customer_conversion_goal.biddable FROM customer_conversion_goal"), "partial_rows");
    const campaignGoals = await collect(() => this.search(id, "SELECT campaign_conversion_goal.campaign, campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable FROM campaign_conversion_goal"), "partial_rows");
    const configs = await collect(() => this.search(id, "SELECT conversion_goal_campaign_config.campaign, conversion_goal_campaign_config.custom_conversion_goal, conversion_goal_campaign_config.goal_config_level FROM conversion_goal_campaign_config"), "partial_rows");
    const customGoals = configs.rows.some(raw => raw.conversionGoalCampaignConfig?.customConversionGoal) ? await collect(() => this.search(id, "SELECT custom_conversion_goal.resource_name, custom_conversion_goal.name, custom_conversion_goal.status, custom_conversion_goal.conversion_actions FROM custom_conversion_goal"), "partial_rows") : { rows: [] as Json[], state: "PRESENT" as FieldState };
    const configByCampaign = new Map<string, Json>(), goalsByCampaign = new Map<string, Json[]>(), customByName = new Map<string, Json>(), customerValues: Json[] = [];
    for (const [result, field] of [[configs, "conversionGoalCampaignConfig"], [campaignGoals, "campaignConversionGoal"], [customerGoals, "customerConversionGoal"], [customGoals, "customConversionGoal"]] as const) {
      for (const raw of result.rows) {
        try {
          const value = object(raw[field]);
          if (field === "conversionGoalCampaignConfig") configByCampaign.set(referenceId(value.campaign, id, "campaigns"), value);
          else if (field === "campaignConversionGoal") {
            const campaignId = referenceId(value.campaign, id, "campaigns");
            if (!goalsByCampaign.has(campaignId)) goalsByCampaign.set(campaignId, []);
            goalsByCampaign.get(campaignId)!.push(value);
          } else if (field === "customConversionGoal") {
            referenceId(value.resourceName, id, "customConversionGoals");
            customByName.set(value.resourceName, value);
          } else customerValues.push(value);
        } catch (error) { failures.push(asPlatformError(error)); result.state = "FETCH_FAILED"; }
      }
    }
    for (const campaign of campaigns.values()) {
      try {
        const config = configByCampaign.get(campaign.entity_id), campaignValues = goalsByCampaign.get(campaign.entity_id) || [], custom = customByName.get(config?.customConversionGoal);
        if (config && ((config.goalConfigLevel != null && typeof config.goalConfigLevel !== "string") || (config.customConversionGoal != null && typeof config.customConversionGoal !== "string"))) throw new PlatformError("INVALID_RESPONSE", "Google 전환 목표의 적용 범위를 읽지 못했습니다.");
        if (custom && ((custom.name != null && typeof custom.name !== "string") || (custom.conversionActions != null && (!Array.isArray(custom.conversionActions) || custom.conversionActions.some((value: unknown) => typeof value !== "string"))))) throw new PlatformError("INVALID_RESPONSE", "Google 맞춤 전환 목표를 읽지 못했습니다.");
        const effective = config?.goalConfigLevel === "CUSTOMER" ? customerValues : config?.goalConfigLevel === "CAMPAIGN" ? campaignValues : null;
        const needed = [configs, ...(config?.customConversionGoal ? [customGoals] : config?.goalConfigLevel === "CUSTOMER" ? [customerGoals] : [campaignGoals])];
        let state: FieldState = needed.find(result => result.state !== "PRESENT")?.state || "PRESENT";
        if (effective?.some(value => (value.category != null && typeof value.category !== "string") || (value.origin != null && typeof value.origin !== "string") || (value.biddable != null && typeof value.biddable !== "boolean"))) throw new PlatformError("INVALID_RESPONSE", "Google 전환 목표의 자료형이 올바르지 않습니다.");
        if (state === "PRESENT" && effective?.some(value => value.category == null || value.origin == null || value.biddable == null)) state = "NOT_RETURNED";
        if (!config || (!effective && !custom)) state = state === "PRESENT" ? "NOT_RETURNED" : state;
        const active = (effective || []).filter(value => value.biddable);
        campaign.extensions.conversion_configuration = { configuration: config || null, campaign_goals: campaignValues, customer_goals: customerValues, custom_goal: custom || null, effective_goals: config?.customConversionGoal ? null : effective };
        campaign.fields["extensions.conversion_configuration"] = state;
        campaign.sources["extensions.conversion_configuration"] = "google.conversion_goal_campaign_config|campaign_conversion_goal|customer_conversion_goal|custom_conversion_goal";
        campaign.fields["optimization.objective"] = "NOT_SUPPORTED";
        if (state !== "PRESENT") campaign.fields["optimization.goal"] = state;
        else if (config?.customConversionGoal) { campaign.optimization.goal = custom?.name || null; campaign.fields["optimization.goal"] = custom?.name ? "PRESENT" : "NOT_RETURNED"; }
        else { campaign.optimization.goal = active.length === 1 ? active[0].category : null; campaign.fields["optimization.goal"] = active.length === 1 ? "PRESENT" : active.length ? "NOT_SUPPORTED" : "NOT_SET"; }
        campaign.sources["optimization.goal"] = "google.conversion_goal_campaign_config + biddable conversion goals";
      } catch (error) { failures.push(asPlatformError(error)); campaign.fields["extensions.conversion_configuration"] = "FETCH_FAILED"; campaign.fields["optimization.goal"] = "FETCH_FAILED"; }
    }
    const smart = [...campaigns.values()].some(campaign => campaign.extensions.product_type === "SMART") ? await collect(() => this.search(id, "SELECT smart_campaign_setting.campaign, smart_campaign_setting.business_name, smart_campaign_setting.final_url, smart_campaign_setting.advertising_language_code, smart_campaign_setting.business_profile_location, smart_campaign_setting.phone_number.phone_number, smart_campaign_setting.phone_number.country_code FROM smart_campaign_setting"), "partial_rows") : { rows: [] as Json[], state: "PRESENT" as FieldState };
    for (const raw of smart.rows) {
      try {
        const value = object(raw.smartCampaignSetting);
        const campaign = campaigns.get(referenceId(value.campaign, id, "campaigns"));
        if (!campaign) continue;
        if (value.finalUrl != null && typeof value.finalUrl !== "string") throw new PlatformError("INVALID_RESPONSE", "Google 스마트 캠페인의 도착 URL을 읽지 못했습니다.");
        campaign.extensions.product_settings.smartCampaignSetting = value;
        campaign.fields["extensions.product_settings.smartCampaignSetting"] = "PRESENT";
        campaign.sources["extensions.product_settings.smartCampaignSetting"] = "google.smart_campaign_setting";
        if (value.finalUrl) {
          campaign.extensions.landing_urls.push({ device: "UNSPECIFIED", url: value.finalUrl, source: "google.smart_campaign_setting.final_url" });
          campaign.fields["extensions.landing_urls"] = "PRESENT";
        }
      } catch (error) { failures.push(asPlatformError(error)); smart.state = "FETCH_FAILED"; }
    }
    for (const entity of entities) {
      const campaign = entity.entity_type === "campaign" ? entity : campaigns.get(adgroups.get(entity.parent_id || "")?.parent_id || entity.parent_id || "");
      if (!campaign) continue;
      if (campaign.extensions.product_type === "SMART" && smart.state !== "PRESENT") campaign.fields["extensions.product_settings.smartCampaignSetting"] = smart.state;
      if (entity === campaign) continue;
      entity.extensions.product_settings = campaign.extensions.product_settings;
      entity.extensions.conversion_configuration = campaign.extensions.conversion_configuration;
      entity.fields["extensions.conversion_configuration"] = campaign.fields["extensions.conversion_configuration"] || "NOT_RETURNED";
      entity.sources["extensions.conversion_configuration"] = campaign.sources["extensions.conversion_configuration"];
      entity.optimization = { ...campaign.optimization };
      for (const field of ["objective", "goal", "event"] as const) entity.fields[`optimization.${field}`] = campaign.fields[`optimization.${field}`];
      const smartUrl = campaign.extensions.product_settings?.smartCampaignSetting?.finalUrl;
      if (entity.entity_type === "ad" && !entity.tracking.url && typeof smartUrl === "string") {
        entity.tracking.url = smartUrl;
        entity.fields["tracking.url"] = "PRESENT";
        entity.extensions.landing_urls.push({ device: "UNSPECIFIED", url: smartUrl, source: "google.smart_campaign_setting.final_url" });
        entity.fields["extensions.landing_urls"] = "PRESENT";
        entity.sources["tracking.url"] = "google.smart_campaign_setting.final_url";
      }
    }
  }
  async getEntity(kind: string, id: string, accountId = "") {
    if (!this.queries[kind])
      throw new PlatformError(
        "UNSUPPORTED",
        "Google에서 조회할 수 없는 광고 항목입니다.",
      );
    if (!accountId || !/^\d+$/.test(id))
      throw new Error(
        "Google 광고 계정과 광고 항목 ID를 확인해 주세요. 항목 ID는 숫자여야 합니다.",
      );
    const [resource, field] = (
      {
        campaign: ["campaign", "id"],
        adgroup: ["ad_group", "id"],
        ad: ["ad_group_ad.ad", "id"],
        keyword: ["ad_group_criterion", "criterion_id"],
        asset_group: ["asset_group", "id"],
      } as Record<string, string[]>
    )[kind];
    const query =
      this.queries[kind] +
      (this.queries[kind].includes(" WHERE ") ? " AND " : " WHERE ") +
      `${resource}.${field} = ${id}`;
    const rows = await this.search(accountId, query);
    if (!rows.length)
      throw new PlatformError(
        "NOT_FOUND",
        "Google 광고 항목을 찾지 못했습니다. 다시 조회해 주세요.",
      );
    if (rows.length > 1)
      throw new PlatformError(
        "AMBIGUOUS_ID",
        "같은 ID의 광고 항목이 여러 개입니다. 상위 광고그룹을 함께 선택해 주세요.",
      );
    return this.normalize(rows[0], kind, accountId);
  }
  normalize(input: unknown, kind: string, accountId: string): Entity {
    try {
      const raw = validateApiEntity(this.platform, input, kind),
        key = (
          {
            campaign: "campaign",
            adgroup: "adGroup",
            ad: "adGroupAd",
            keyword: "adGroupCriterion",
            asset_group: "assetGroup",
          } as Record<string, string>
        )[kind];
      if (!key)
        throw new PlatformError(
          "UNSUPPORTED",
          "Google에서 조회할 수 없는 광고 항목입니다.",
        );
      const row = object(raw[key]),
        values = kind === "ad" ? row.ad || {} : row,
        account = raw.customer || {},
        budget = raw.campaignBudget || {},
        zone = account.timeZone,
        id = identity(kind === "keyword" ? row.criterionId : values.id),
        parent = ["ad", "keyword"].includes(kind)
          ? raw.adGroup?.id
          : String(row.campaign || "")
              .split("/")
              .at(-1) || null;
      for (const [path, value] of Object.entries({
        campaign: row.campaign,
        resource: row.resourceName,
        budget: row.campaignBudget,
      }))
        if (
          value != null &&
          (typeof value !== "string" ||
            !value.startsWith(`customers/${accountId.replace(/-/g, "")}/`) ||
            (path === "campaign" &&
              !/^customers\/\d+\/campaigns\/\d+$/.test(value)))
        )
          throw new PlatformError(
            "INVALID_RESPONSE",
            "Google 광고 항목의 계정 또는 상위 항목 정보가 올바르지 않습니다. 다시 조회해 주세요.",
          );
      const fields: Record<string, FieldState> = {
        name:
          values.name != null
            ? fieldState(values, "name")
            : kind === "keyword" && row.keyword?.text != null
              ? "PRESENT"
              : "NOT_RETURNED",
        currency: fieldState(account, "currencyCode"),
        timezone: fieldState(account, "timeZone"),
        "budget.daily": fieldState(budget, "amountMicros"),
        "budget.lifetime": fieldState(budget, "totalAmountMicros"),
        "bid.amount": fieldState(row, "cpcBidMicros"),
        "bid.strategy": fieldState(row, "biddingStrategyType"),
        status: fieldState(row, "status"),
        effective_status: fieldState(row, "primaryStatus"),
        "schedule.start": fieldState(row, "startDateTime"),
        "schedule.end": fieldState(row, "endDateTime"),
        "optimization.objective": "NOT_RETURNED",
        "optimization.goal": "NOT_RETURNED",
        "optimization.event": "NOT_RETURNED",
        "tracking.url": fieldState(values, "finalUrls"),
        "tracking.parameters": fieldState(values, "urlCustomParameters"),
      };
      for (const part of [
        "countries",
        "age_min",
        "age_max",
        "custom_audiences",
        "excluded_audiences",
      ])
        fields[`targeting.${part}`] = "NOT_RETURNED";
      const landings = landingUrls(values, `google.${key}${kind === "ad" ? ".ad" : ""}`),
        creative = creativeData(values),
        text = creative.text || row.keyword?.text || null,
        campaign = kind === "campaign" ? row : raw.campaign || {},
        unsupportedText = ["IMAGE_AD", "SHOPPING_PRODUCT_AD", "SHOPPING_SMART_AD", "HOTEL_AD", "TRAVEL_AD"].includes(values.type);
      fields.text = text != null ? "PRESENT" : unsupportedText ? "NOT_SUPPORTED" : "NOT_RETURNED";
      if (kind === "ad" && !landings.length && ((unsupportedText && values.type !== "IMAGE_AD") || ["APP_AD", "APP_ENGAGEMENT_AD", "APP_PRE_REGISTRATION_AD"].includes(values.type)))
        fields["tracking.url"] = "NOT_SUPPORTED";
      fields["extensions.landing_urls"] = landings.length ? "PRESENT" : fields["tracking.url"];
      fields["extensions.product_type"] = fieldState(campaign, "advertisingChannelType");
      fields["extensions.product_subtype"] = fieldState(campaign, "advertisingChannelSubType");
      if (["urlCustomParameters", "finalUrlSuffix", "trackingUrlTemplate"].some(field => Object.hasOwn(values, field))) fields["tracking.parameters"] = "PRESENT";
      for (const field of CAMPAIGN_SETTINGS_FIELDS) {
        const name = camel(field.split(".")[0]);
        if (kind === "campaign") fields[`extensions.product_settings.${name}`] = fieldState(row, name);
      }
      return createEntity({
        platform: this.platform,
        account_id: accountId.replace(/-/g, ""),
        entity_type: kind,
        entity_id: id,
        parent_id: parent == null ? null : String(parent),
        name: values.name || row.keyword?.text || id,
        status: row.status === "ENABLED" ? "ACTIVE" : (row.status ?? null),
        effective_status: row.primaryStatus ?? null,
        currency: account.currencyCode || "UNKNOWN",
        timezone: zone || "UTC",
        budget: {
          unit: "major",
          daily: decimalValue(budget.amountMicros, 1000000),
          lifetime: decimalValue(budget.totalAmountMicros, 1000000),
          level: kind,
        },
        bid: {
          strategy: row.biddingStrategyType ?? null,
          amount: decimalValue(row.cpcBidMicros, 1000000),
        },
        schedule: {
          start: timestamp(row.startDateTime, zone),
          end: timestamp(row.endDateTime, zone),
        },
        tracking: {
          url: landings[0]?.url || null,
          parameters: trackingParameters(values),
        },
        text,
        fields,
        sources: {
          ...(kind === "campaign" ? Object.fromEntries([...new Set(CAMPAIGN_SETTINGS_FIELDS.map(field => field.split(".")[0]))].map(field => [`extensions.product_settings.${camel(field)}`, `google.campaign.${field}`])) : {}),
          "budget.daily": "google.campaign_budget.amount_micros / 1000000",
          "budget.lifetime":
            "google.campaign_budget.total_amount_micros / 1000000",
          status: `google.${key}.status`,
          effective_status: `google.${key}.primary_status`,
          "schedule.start": "google.campaign.start_date_time",
          "schedule.end": "google.campaign.end_date_time",
          "tracking.url": `google.${key}.final_urls`,
          "tracking.parameters": `google.${key}.final_url_suffix|tracking_url_template with url_custom_parameters`,
          text: kind === "ad" ? `google.ad_group_ad.ad.${Object.keys(creative.formats).join("|") || "type"}` : `google.${key}.keyword.text`,
          "extensions.landing_urls": `google.${key}.final_urls|final_mobile_urls`,
          "extensions.product_type": "google.campaign.advertising_channel_type",
          "extensions.product_subtype": "google.campaign.advertising_channel_sub_type",
        },
        raw_data: raw,
        extensions: {
          api_version: this.version,
          resource_name: row.resourceName,
          campaign_type: campaign.advertisingChannelType,
          campaign_subtype: campaign.advertisingChannelSubType,
          product_type: campaign.advertisingChannelType,
          product_subtype: campaign.advertisingChannelSubType,
          ...(kind === "campaign" ? { product_settings: Object.fromEntries([...new Set(CAMPAIGN_SETTINGS_FIELDS.map(field => camel(field.split(".")[0])))].filter(name => row[name] !== undefined).map(name => [name, row[name]])) } : {}),
          creative_formats: creative.formats,
          creative_assets: creative.assets,
          app_deep_link: values.appAd?.appDeepLink,
          account_tracking: { final_url_suffix: account.finalUrlSuffix, tracking_template: account.trackingUrlTemplate },
          url_custom_parameters: values.urlCustomParameters,
          ...(kind === "asset_group" ? { creative_container: true } : {}),
          budget_resource: row.campaignBudget,
          shared_budget: budget.explicitlyShared,
          keyword_match_type: row.keyword?.matchType,
          negative: row.negative,
          policy_summary: row.policySummary,
          tracking_template: values.trackingUrlTemplate,
          final_urls: values.finalUrls || [],
          landing_urls: landings,
          final_url_suffix: values.finalUrlSuffix,
        },
      });
    } catch (error) {
      throw asPlatformError(error);
    }
  }
  async getChangeHistory(
    accountId: string,
    start: Date,
    end: Date,
  ): Promise<NativeEvent[]> {
    validateHistoryRange(start, end, 30);
    accountId = safeId(accountId.replace(/-/g, ""));
    let zone = this.accountTimezones.get(accountId);
    if (!zone) {
      const rows = await this.search(
        accountId,
        "SELECT customer.time_zone FROM customer LIMIT 1",
      );
      zone = rows[0]?.customer?.timeZone;
    }
    if (!zone)
      throw new PlatformError(
        "NOT_RETURNED",
        "Google 계정의 시간대를 확인하지 못해 변경 시각을 표시할 수 없습니다. 계정 연결을 확인해 주세요.",
      );
    this.accountTimezones.set(accountId, zone);
    const literal = (instant: number) => {
      const p = zonedParts(instant, zone!);
      return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${String(p.second).padStart(2, "0")}`;
    };
    const query = `SELECT change_event.resource_name, change_event.change_date_time, change_event.change_resource_name, change_event.user_email, change_event.client_type, change_event.change_resource_type, change_event.old_resource, change_event.new_resource, change_event.resource_change_operation, change_event.changed_fields FROM change_event WHERE change_event.change_date_time >= '${literal(Math.floor(+start / 1000) * 1000)}' AND change_event.change_date_time < '${literal(Math.ceil(+end / 1000) * 1000)}' ORDER BY change_event.change_date_time DESC LIMIT 10000`;
    let rows: Json[] = [],
      failure: PlatformError | null = null;
    const events: NativeEvent[] = [];
    try {
      rows = await this.search(accountId, query);
    } catch (error) {
      failure = asPlatformError(error);
      rows = failure.partial_rows;
    }
    try {
      for (const row of rows) {
        const raw = object(row.changeEvent),
          id = identity(raw.resourceName),
          occurred = timestamp(raw.changeDateTime, zone);
        if (!occurred)
          throw new PlatformError(
            "INVALID_RESPONSE",
            "Google 변경 기록에 시각이 없습니다. 다시 조회해 주세요.",
          );
        if (Date.parse(occurred) < +start || Date.parse(occurred) >= +end)
          continue;
        const changed =
          typeof raw.changedFields === "string"
            ? raw.changedFields.split(",").filter(Boolean)
            : (raw.changedFields?.paths ?? raw.changedFields);
        events.push({
          source: "platform_change_log",
          platform: this.platform,
          account_id: accountId,
          event_id: id,
          timestamp: occurred,
          actor: raw.userEmail ? { email: raw.userEmail } : {},
          event_type: raw.resourceChangeOperation ?? null,
          entity_type: raw.changeResourceType ?? null,
          entity_id: raw.changeResourceName ?? null,
          client_type: raw.clientType ?? null,
          changed_fields: changed,
          old_resource: raw.oldResource,
          new_resource: raw.newResource,
          fields: {
            timestamp: fieldState(raw, "changeDateTime"),
            "actor.email": fieldState(raw, "userEmail"),
            old_resource: fieldState(raw, "oldResource"),
            new_resource: fieldState(raw, "newResource"),
          },
          raw_data: raw,
        });
      }
    } catch (error) {
      failure = asPlatformError(error);
    }
    if (rows.length >= 10000)
      failure = new PlatformError(
        "RESULT_LIMIT",
        "Google 변경 이력이 10,000개 한도에 도달했습니다. 기간을 더 좁혀 주세요.",
      );
    if (failure) {
      const error = new PlatformError(
        events.length ? "PARTIAL_FETCH" : failure.kind,
        "Google 변경 이력을 끝까지 가져오지 못했습니다. 기간을 좁혀 다시 조회해 주세요.",
      );
      error.partial_events = events;
      error.cause_kind = failure.kind;
      throw error;
    }
    return events;
  }
}
