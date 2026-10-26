import { createEntity, type Entity, type FieldState, type Json } from "../domain/entities";
import { asPlatformError, identity, object, PlatformError } from "./base";
import { decimalValue, fieldState, timestamp } from "./http";
import { validateApiEntity } from "./contracts";

// Field names follow the v26 reporting reference; keep type-specific data with its ad.
export const AD_FORMAT_FIELDS: Record<string, string[]> = {
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

export const CAMPAIGN_SETTINGS_FIELDS = [
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

export const referenceId = (value: unknown, accountId: string, resource: string): string => {
  if (typeof value !== "string" || !new RegExp(`^customers/${accountId}/${resource}/[A-Za-z0-9_~.-]+$`).test(value))
    throw new PlatformError("INVALID_RESPONSE", "Google 광고 항목의 연결 정보가 올바르지 않습니다.");
  return value.split("/").at(-1)!;
};

type Landing = { device: "PC" | "MOBILE" | "UNSPECIFIED"; url: string; source: string };

export function landingUrls(values: Json, source: string): Landing[] {
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

export function trackingParameters(values: Json): Record<string, string> {
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

export function validateAsset(raw: Json, accountId: string) {
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

export function normalizeGoogleEntity(input: unknown, kind: string, accountId: string, platform: "google", version: string): Entity {
  try {
    const raw = validateApiEntity(platform, input, kind),
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
      platform: platform,
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
        api_version: version,
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
