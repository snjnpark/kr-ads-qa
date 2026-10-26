import { resolveParent } from "../../domain/policies/evaluation";
import { productCode, productLabel } from "../../lib/ad-products";
import type { Entity, Account, Json } from "../../domain/entities";

type RowApplication = { entities: Entity[]; catalog: ReadonlyMap<string, Account> };

function rowIdentity(application: RowApplication, entity: Entity, entities = application.entities): Json {
  const ancestors: Entity[] = [entity],
    visited = new Set<string>();
  let current: Entity | null = entity;
  while (current?.parent_id && !visited.has(current.key)) {
    visited.add(current.key);
    current = resolveParent(current, entities);
    if (current) ancestors.push(current);
  }
  const campaign = ancestors.find((item) => item.entity_type === "campaign"),
    group = ancestors.find((item) =>
      ["adgroup", "asset_group"].includes(item.entity_type),
    ),
    campaignId = campaign?.entity_id ?? group?.parent_id ?? "",
    groupId = group?.entity_id ??
      (["ad", "creative", "keyword"].includes(entity.entity_type)
        ? entity.parent_id ?? ""
        : ""),
    embeddedCampaign = group?.platform === "kakao"
      ? group.raw_data.campaign
      : null,
    campaignName = campaign?.name ??
      (embeddedCampaign &&
      String(embeddedCampaign.id) === campaignId &&
      String(embeddedCampaign.adAccountId) === entity.account_id &&
      typeof embeddedCampaign.name === "string"
        ? embeddedCampaign.name
        : "");
  return {
    account: entity.account_id,
    product_type: productCode(entity),
    product: productLabel(entity.platform, productCode(entity)),
    account_id: entity.account_id,
    account_name: application.catalog.get(`${entity.platform}/${entity.account_id}`)?.name ?? "",
    target_type: entity.entity_type,
    type: entity.entity_type,
    campaign_id: campaignId,
    campaign_name: campaignName,
    ad_group_id: groupId,
    ad_group_name: group?.name ?? "",
    campaign: campaignName,
    adgroup: group?.name ?? "",
  };
}

export function entityRows(application: RowApplication, entities: Entity[]): Json[] {
  return entities.map((e) => {
    return {
      key: e.key,
      platform: e.platform,
      product_type: productCode(e),
      product: productLabel(e.platform, productCode(e)),
      ...rowIdentity(application, e),
      name: e.name,
      id: e.entity_id,
      status: e.status ?? "미조회",
      daily_budget: e.budget.daily ?? "—",
      currency: e.currency,
      fetched_at: e.fetched_at,
      result: "",
      reason: "광고 설정 조회",
    };
  });
}

export function withResultIdentity(application: RowApplication, result: Json, entities: Entity[]) {
  const entity = entities.find((candidate) =>
    candidate.key === result.evidence?.entity_key &&
    candidate.platform === result.platform &&
    candidate.account_id === result.account_id &&
    candidate.entity_id === result.entity_id,
  );
  return entity
    ? {
        ...result,
        evidence: { ...result.evidence, details: rowIdentity(application, entity, entities) },
      }
    : result;
}

export function auditRows(id: string, results: Json[]) {
  return results.map((r, i) => ({
    key: `${id}/${i}`,
    platform: r.platform,
    account: r.account_id,
    account_id: r.account_id,
    account_name: r.evidence?.details?.account_name,
    target_type: r.evidence?.details?.target_type,
    type: r.evidence?.details?.target_type,
    campaign_id: r.evidence?.details?.campaign_id,
    campaign_name: r.evidence?.details?.campaign_name,
    campaign: r.evidence?.details?.campaign_name,
    ad_group_id: r.evidence?.details?.ad_group_id,
    ad_group_name: r.evidence?.details?.ad_group_name,
    adgroup: r.evidence?.details?.ad_group_name,
    name: r.entity_name,
    id: r.entity_id,
    status: r.status,
    result: r.status,
    rule_id: r.rule_id,
    severity: r.severity,
    expected: r.expected,
    actual: r.actual,
    reason: r.evidence?.rule_description ?? r.rule_id,
    evidence: r.evidence,
    fetched_at: r.checked_at,
  }));
}
