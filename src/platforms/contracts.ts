/** Validate observed API fields before coercion; omitted/null fields stay distinct. */
import type { Json, Platform } from "../domain/entities";
import { identity, object, PlatformError } from "./base";
import { decimalValue } from "./http";

type Check = (value: unknown) => boolean;
const string: Check = (value) => typeof value === "string";
const integer: Check = (value) =>
  typeof value === "number" && Number.isSafeInteger(value);
const boolean: Check = (value) => typeof value === "boolean";
const timezone: Check = (value) => {
  if (typeof value !== "string") return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};
const currency: Check = (value) =>
  typeof value === "string" && /^[A-Z]{3}$/.test(value);
const record: Check = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const array =
  (item: Check): Check =>
  (value) =>
    Array.isArray(value) && value.every(item);
const identifier: Check = (value) => {
  identity(value);
  return true;
};
const money: Check = (value) => {
  const result = decimalValue(value);
  return result != null && /^\d+$/.test(result);
};
const audience: Check = (value) =>
  record(value) && identifier((value as Json).id);
const kakaoTarget: Check = (value) => {
  if (!record(value)) return false;
  check(value as Json, { id: identifier, inclusionType: string });
  return true;
};
function check(raw: Json, rules: Record<string, Check>) {
  for (const [path, predicate] of Object.entries(rules)) {
    let value: unknown = raw;
    for (const key of path.split(".")) {
      if (value == null) break;
      value = (value as Json)[key];
    }
    if (value != null && !predicate(value))
      throw new PlatformError(
        "INVALID_RESPONSE",
        `광고 API 필드의 자료형이 올바르지 않습니다 (${path}).`,
      );
  }
}
const rules = (names: string[], predicate: Check) =>
  Object.fromEntries(names.map((name) => [name, predicate]));

export function validateGoogleAccount(input: unknown): Json {
  const row = object(input);
  check(row, {
    id: identifier,
    manager: boolean,
    level: integer,
    ...rules(["descriptiveName", "status", "clientCustomer"], string),
    currencyCode: currency,
    timeZone: timezone,
  });
  return row;
}

export function validateApiEntity(
  platform: Platform,
  input: unknown,
  kind: string,
): Json {
  const row = object(input);
  if (platform === "meta") {
    check(row, {
      ...rules(["id", "account_id", "campaign_id", "adset_id"], identifier),
      ...rules(
        [
          "name",
          "status",
          "effective_status",
          "objective",
          "optimization_goal",
          "bid_strategy",
          "body",
          "object_url",
          "url_tags",
          "created_time",
          "start_time",
          "end_time",
          "stop_time",
          "promoted_object.custom_event_type",
          "object_story_spec.link_data.message",
          "object_story_spec.link_data.link",
          "object_story_spec.video_data.message",
          "object_story_spec.video_data.link",
        ],
        string,
      ),
      ...rules(["daily_budget", "lifetime_budget", "bid_amount"], money),
      ...rules(
        [
          "targeting",
          "targeting.geo_locations",
          "promoted_object",
          "object_story_spec",
          "object_story_spec.link_data",
          "object_story_spec.video_data",
          "asset_feed_spec",
          "creative",
        ],
        record,
      ),
      ...rules(
        ["targeting.age_min", "targeting.age_max", "account_status"],
        integer,
      ),
      currency,
      timezone_name: timezone,
      "targeting.geo_locations.countries": array(string),
      "targeting.custom_audiences": array(audience),
      "targeting.excluded_custom_audiences": array(audience),
    });
  } else if (platform === "naver") {
    check(row, {
      ...rules(
        [
          "nccCampaignId",
          "nccAdgroupId",
          "nccAdId",
          "nccKeywordId",
          "customerId",
        ],
        identifier,
      ),
      ...rules(
        [
          "name",
          "keyword",
          "status",
          "statusReason",
          "periodStartDt",
          "periodEndDt",
          "regTm",
          "editTm",
        ],
        string,
      ),
      ...rules(
        ["userLock", "useDailyBudget", "usePeriod", "useGroupBidAmt"],
        boolean,
      ),
      ...rules(["dailyBudget", "bidAmt"], money),
      ...rules(
        ["ad", "links", "ad.pc", "ad.mobile", "links.pc", "links.mobile"],
        record,
      ),
      ...rules(
        [
          "ad.headline",
          "ad.description",
          "ad.pcUrl",
          "ad.mobileUrl",
          "ad.pc.final",
          "links.pc.final",
        ],
        string,
      ),
      targets: array(record),
    });
  } else if (platform === "kakao_keyword") {
    check(row, {
      ...rules(["id", "creativeLinkId", "campaignId", "adGroupId", "creativeId", "bizChannelId", "adAccountId"], identifier),
      ...rules(["name", "text", "title", "description", "config", "reviewStatus", "bidStrategy.type", "landingInfo.rspvLandingUrl", "landingInfo.pcLandingUrl", "landingInfo.mobileLandingUrl", "schedule.beginDate", "schedule.endDate"], string),
      ...rules(["bidStrategy", "landingInfo", "schedule"], record),
      ...rules(["dailyBudgetAmount", "bidAmount", "bidStrategy.bidAmount"], money),
      status: array(string),
      ...rules(["assets", "license", "creative"], record),
      ...rules(["useKeywordExtension", "traceUrl"], boolean),
      ...rules(["placements", "deviceTypes", "exceptionKeywords"], array(string)),
      ...rules(["mobileBidWeight", "pcBidWeight"], integer),
    });
  } else if (platform === "kakao") {
    check(row, {
      ...rules(["id", "adAccountId", "adGroupId", "campaign.id"], identifier),
      ...rules(
        [
          "name",
          "config",
          "systemConfig",
          "creativeStatus",
          "bidStrategy",
          "title",
          "description",
          "altText",
          "rspvLandingUrl",
          "pcLandingUrl",
          "mobileLandingUrl",
          "createdDate",
          "objective.type",
          "objective.detailType",
          "campaignTypeGoal.campaignType",
          "campaignTypeGoal.goal",
          "campaign.objective.type",
          "campaign.objective.detailType",
          "campaign.campaignTypeGoal.campaignType",
          "campaign.campaignTypeGoal.goal",
          "schedule.beginDate",
          "schedule.beginTime",
          "schedule.endDate",
          "schedule.endTime",
        ],
        string,
      ),
      ...rules(
        [
          "campaign",
          "campaignTypeGoal",
          "campaign.campaignTypeGoal",
          "campaign.objective",
          "objective",
          "targeting",
          "schedule",
          "messageElement",
        ],
        record,
      ),
      ...rules(["dailyBudgetAmount", "totalBudget", "bidAmount"], money),
      ...rules(["status", "placements", "deviceTypes"], array(string)),
      ...rules(
        [
          "targeting.trackerTargetings",
          "targeting.customerDataTargetings",
          "targeting.cohortTargetings",
        ],
        array(kakaoTarget),
      ),
    });
  } else {
    const key = (
      {
        campaign: "campaign",
        adgroup: "adGroup",
        ad: "adGroupAd",
        keyword: "adGroupCriterion",
        asset_group: "assetGroup",
      } as Record<string, string>
    )[kind];
    if (!key) throw new PlatformError("UNSUPPORTED", kind);
    check(row, rules([key, "customer", "campaignBudget", "adGroup"], record));
    const entity = object(row[key]);
    check(entity, {
      ...rules(["appCampaignSetting", "shoppingSetting", "hotelSetting", "travelCampaignSettings", "localCampaignSetting", "localServicesCampaignSettings", "pmaxCampaignSettings"], record),
      ...rules(["appCampaignSetting.appId", "appCampaignSetting.appStore"], string),
      ...rules(["shoppingSetting.merchantId", "hotelSetting.hotelCenterId"], identifier),
      ...rules(["id", "criterionId"], identifier),
      ...rules(
        [
          "name",
          "status",
          "primaryStatus",
          "resourceName",
          "campaign",
          "biddingStrategyType",
          "startDateTime",
          "endDateTime",
          "keyword.text",
          "keyword.matchType",
        ],
        string,
      ),
      ...rules(["ad", "keyword"], record),
      negative: boolean,
      cpcBidMicros: money,
    });
    check(row, {
      "customer.currencyCode": currency,
      "customer.timeZone": timezone,
      "campaignBudget.amountMicros": money,
      "campaignBudget.totalAmountMicros": money,
      "campaignBudget.explicitlyShared": boolean,
    });
    const values = kind === "ad" ? object(entity.ad) : entity;
    check(values, {
      ...rules(["id"], identifier),
      ...rules(["name", "trackingUrlTemplate"], string),
      finalUrls: array(string),
      urlCustomParameters: array(
        (value) =>
          record(value) &&
          string((value as Json).key) &&
          string((value as Json).value),
      ),
      responsiveSearchAd: record,
      "responsiveSearchAd.headlines": array(
        (value) => record(value) && string((value as Json).text),
      ),
      "responsiveSearchAd.descriptions": array(
        (value) => record(value) && string((value as Json).text),
      ),
    });
  }
  return row;
}
