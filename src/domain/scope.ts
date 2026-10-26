import { PLATFORMS, type Entity, type Json } from "./entities";
import type { Scope } from "../contracts/domain";
import { AD_PRODUCTS, productKey } from "../lib/ad-products";

export function validateScope(input: Json): Scope {
  const scope: Scope = {};
  for (const key of ["platforms", "accounts", "products"] as const) {
    const values = input[key];
    if (values !== undefined && values !== null) {
      if (
        !Array.isArray(values) ||
        values.length > 1000 ||
        values.some((v) => typeof v !== "string" || v.length > 250)
      )
        throw new Error("조회 범위를 확인해 주세요.");
      if (values.length) scope[key] = [...new Set(values)];
    }
  }
  if (
    scope.platforms?.some((p) => !(PLATFORMS as readonly string[]).includes(p))
  )
    throw new Error("플랫폼을 확인해 주세요.");
  if (scope.products?.some(value => !/^(?:naver|kakao|kakao_keyword|google):[A-Z][A-Z0-9_]*$/.test(value)))
    throw new Error("광고상품을 확인해 주세요.");
  if (scope.products?.some(value => {
    const [platform, code] = value.split(":");
    return !Object.hasOwn(AD_PRODUCTS[platform], code) || (scope.platforms && !scope.platforms.includes(platform));
  }))
    throw new Error("선택한 매체와 지원 광고상품을 확인해 주세요.");
  return scope;
}
export const selected = (
  entity: Pick<Entity, "platform" | "account_id"> & Partial<Pick<Entity, "entity_type" | "extensions">>,
  scope: Scope,
) =>
  (!scope.platforms?.length || scope.platforms.includes(entity.platform)) &&
  (!scope.accounts?.length ||
    scope.accounts.includes(entity.account_id) ||
    scope.accounts.includes(`${entity.platform}/${entity.account_id}`)) &&
  (!scope.products?.length || entity.entity_type === "account" || scope.products.includes(productKey(entity) ?? ""));
export const scopeKey = (scope: Scope) =>
  JSON.stringify([
    scope.platforms?.toSorted() ?? [],
    scope.accounts?.toSorted() ?? [],
    scope.products?.toSorted() ?? [],
  ]);
