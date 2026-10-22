import type { DataRow } from "../contracts/api";

const groupTypes = new Set(["adgroup", "adset", "asset_group"]);

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

export function resultHierarchy(row: DataRow) {
  const type = text(row.target_type || row.type || row.entity_type);
  const isGroup = groupTypes.has(type);
  return {
    type,
    campaign: {
      name: text(
        row.campaign_name || row.campaign || (type === "campaign" ? row.name : ""),
      ),
      id: text(row.campaign_id || (type === "campaign" ? row.id : "")),
      inapplicable: type === "account",
    },
    group: {
      name: text(
        row.ad_group_name || row.adgroup || (isGroup ? row.name : ""),
      ),
      id: text(row.ad_group_id || (isGroup ? row.id : "")),
      inapplicable: type === "account" || type === "campaign",
    },
    target: {
      name: text(row.name),
      id: text(row.id),
      inapplicable: type === "account" || type === "campaign" || isGroup,
    },
  };
}

export function resultSearchText(row: DataRow, ruleName?: string): string {
  return [
    row.name,
    row.id,
    row.account,
    row.account_name,
    row.account_id,
    row.platform,
    row.product,
    row.product_type,
    row.target_type,
    row.type,
    row.entity_type,
    row.campaign_name,
    row.campaign,
    row.campaign_id,
    row.ad_group_name,
    row.adgroup,
    row.ad_group_id,
    row.rule_id,
    row.reason,
    ruleName,
  ]
    .map(text)
    .join(" ")
    .toLocaleLowerCase();
}
