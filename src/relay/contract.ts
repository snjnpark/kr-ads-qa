/** Shared, data-free allowlist. Never accept an upstream URL from a caller. */
export type RelayPlatform = "naver" | "kakao_keyword";
export type RelayRequest = {
  platform: RelayPlatform;
  operation: string;
  id?: string;
  params?: Record<string, string>;
  auth: Record<string, string>;
};
type Rule = { path: string; detail?: boolean; params?: Record<string, RegExp>; required?: string[] };
const naverId = /^[A-Za-z0-9_-]{1,128}$/;
const kakaoId = /^\d{1,30}$/;
const pageSize = /^(?:[1-9]\d{0,2}|1000)$/;
const page = /^(?:0|[1-9]\d{0,3})$/;
const pagination = { recordSize: pageSize, selector: /^NEXT$/, baseSearchId: naverId };
const naver: Record<string, Rule> = {
  "campaigns.list": { path: "/ncc/campaigns", params: pagination },
  "adgroups.list": { path: "/ncc/adgroups", params: { ...pagination, nccCampaignId: naverId } },
  "ads.list": { path: "/ncc/ads", params: { nccAdgroupId: naverId } },
  "keywords.list": { path: "/ncc/keywords", params: { ...pagination, nccAdgroupId: naverId } },
  "ad-extensions.list": { path: "/ncc/ad-extensions", params: { ownerId: naverId } },
  "channels.list": { path: "/ncc/channels" },
  "product-groups.list": { path: "/ncc/product-groups" },
  "time-contracts.list": { path: "/ncc/time-contracts" },
  "brand-new-contracts.list": { path: "/ncc/brand-new/contracts" },
  "targets.list": { path: "/ncc/targets", params: { ownerId: naverId }, required: ["ownerId"] },
  "customer-links.list": { path: "/customer-links", params: { type: /^MYCLIENTS$/ }, required: ["type"] },
};
for (const name of ["campaigns", "adgroups", "ads", "keywords", "ad-extensions", "channels", "product-groups", "time-contracts"])
  naver[`${name}.get`] = { path: `/ncc/${name}`, detail: true };
const keyword: Record<string, Rule> = {
  "accounts.list": { path: "/openapi/v1/adAccounts/pages", params: { page, size: /^(?:[1-9]\d?|100)$/ } },
  "campaigns.list": { path: "/openapi/v1/campaigns" },
  "adgroups.list": { path: "/openapi/v1/adGroups", params: { campaignId: kakaoId }, required: ["campaignId"] },
  "keywords.list": { path: "/openapi/v1/keywords", params: { adGroupId: kakaoId }, required: ["adGroupId"] },
  "creatives.list": { path: "/openapi/v1/creatives/basic", params: { bizChannelId: kakaoId, page, limit: /^(?:[1-9]\d?|100)$/ }, required: ["bizChannelId"] },
  "ads.list": { path: "/openapi/v1/creativeLinks", params: { adGroupId: kakaoId }, required: ["adGroupId"] },
};
for (const [name, path] of Object.entries({ accounts: "adAccounts", campaigns: "campaigns", adgroups: "adGroups", keywords: "keywords", creatives: "creatives/basic", ads: "creativeLinks" }))
  keyword[`${name}.get`] = { path: `/openapi/v1/${path}`, detail: true };
const rules = { naver, kakao_keyword: keyword };
export class RelayInputError extends Error {
  constructor() { super("INVALID_RELAY_REQUEST"); }
}
const invalid = (): never => { throw new RelayInputError(); };
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return invalid();
  return input as Record<string, unknown>;
}
function exact(input: Record<string, unknown>, keys: string[]) {
  if (Object.keys(input).some((key) => !keys.includes(key))) invalid();
}
function credential(value: unknown, max = 8192): string {
  // oxlint-disable-next-line no-control-regex -- Reject header injection and control bytes before fetch.
  if (typeof value !== "string" || !value || value.length > max || /[\s\x00-\x1f\x7f]/.test(value)) return invalid();
  return value;
}
/** Construct one read request. No IO, credentials or responses are retained. */
export function buildRelayRequest(input: unknown, now = Date.now()): { url: URL; headers: Record<string, string> } {
  const body = record(input);
  exact(body, ["platform", "operation", "id", "params", "auth"]);
  if (body.platform !== "naver" && body.platform !== "kakao_keyword") return invalid();
  const platform = body.platform;
  if (typeof body.operation !== "string" || !Object.hasOwn(rules[platform], body.operation)) return invalid();
  const rule = rules[platform][body.operation];
  const idPattern = platform === "naver" ? naverId : kakaoId;
  if (rule.detail ? typeof body.id !== "string" || !idPattern.test(body.id) : body.id !== undefined) return invalid();
  const params = body.params === undefined ? {} : record(body.params);
  for (const [key, value] of Object.entries(params))
    if (!Object.hasOwn(rule.params || {}, key) || typeof value !== "string" || !rule.params![key].test(value)) invalid();
  for (const key of rule.required || []) if (!Object.hasOwn(params, key)) invalid();
  const auth = record(body.auth);
  const url = new URL(`${platform === "naver" ? "https://api.searchad.naver.com" : "https://api.keywordad.kakao.com"}${rule.path}${rule.detail ? `/${body.id}` : ""}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  if (platform === "naver") {
    exact(auth, ["api_key", "customer_id", "timestamp", "signature"]);
    const key = credential(auth.api_key, 2048), customer = credential(auth.customer_id, 128);
    const stamp = credential(auth.timestamp, 13), signature = credential(auth.signature, 44);
    if (!naverId.test(customer) || !/^\d{13}$/.test(stamp) || Math.abs(now - Number(stamp)) > 300000 || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return invalid();
    return { url, headers: { "X-API-KEY": key, "X-Customer": customer, "X-Timestamp": stamp, "X-Signature": signature } };
  }
  exact(auth, ["business_token", "account_id"]);
  const token = credential(auth.business_token);
  const account = auth.account_id === undefined ? "" : credential(auth.account_id, 30);
  if (account && !kakaoId.test(account)) return invalid();
  if (body.operation !== "accounts.list" && !account) return invalid();
  return { url, headers: { Authorization: `Bearer ${token}`, ...(account ? { adAccountId: account } : {}) } };
}
/** Browser adapter transport converts its already-allowlisted URL to an operation. */
export function relayOperation(platform: RelayPlatform, pathname: string): { operation: string; id?: string } {
  for (const [operation, rule] of Object.entries(rules[platform])) {
    if (!rule.detail && pathname === rule.path) return { operation };
    if (rule.detail && pathname.startsWith(`${rule.path}/`)) {
      const id = pathname.slice(rule.path.length + 1);
      if ((platform === "naver" ? naverId : kakaoId).test(id)) return { operation, id };
    }
  }
  return invalid();
}
