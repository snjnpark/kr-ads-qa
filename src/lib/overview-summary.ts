import { productLabel } from "./ad-products";
import { POLICY_PLATFORMS } from "./policy-conditions";
import type { Account, AppState, AuditRun, DataRow, Scope } from "../contracts/api";

export function scopeDescription(scope: Scope, accounts: readonly Account[], names: Record<string, string>): string {
  const media = scope.platforms?.length ? scope.platforms.map(platform => names[platform] ?? platform).join(" · ") : "전체 매체";
  const selected = scope.accounts?.map(value => {
    const candidates = new Map(accounts.filter(account =>
      (value === `${account.platform}/${account.account_id}` || value === account.account_id) &&
      (!scope.platforms?.length || scope.platforms.includes(account.platform)),
    ).map(account => [`${account.platform}/${account.account_id}`, account]));
    return candidates.size === 1 ? [...candidates.values()][0].name || value : value;
  });
  const products = scope.products?.map(value => {
    const [platform, code] = value.split(":");
    return code ? `${names[platform] ?? platform} ${productLabel(platform, code)}` : value;
  });
  return `${media} · ${selected?.length ? selected.join(" · ") : "전체 계정"}${products?.length ? ` · ${products.join(" · ")}` : ""}`;
}

const verdicts = ["FAIL", "WARNING", "REVIEW", "UNKNOWN", "PASS", "NOT_APPLICABLE"] as const;
const attentionVerdicts: readonly string[] = verdicts.slice(0, 4);
const sortedUnique = (values: readonly string[] = []) => [...new Set(values)].sort();
const accountKey = (account: Account) => `${account.platform}/${account.account_id}`;

function qualifiedAccount(value: string, scope: Scope, accounts: readonly Account[]) {
  if (POLICY_PLATFORMS.some(platform => value.startsWith(`${platform}/`))) return value;
  const candidates = sortedUnique(accounts
    .filter(account => account.account_id === value && (!scope.platforms?.length || scope.platforms.includes(account.platform)))
    .map(accountKey));
  return candidates.length === 1 ? candidates[0] : null;
}

function scopeKey(scope: Scope, accounts: readonly Account[]) {
  const platforms = sortedUnique(scope.platforms);
  const selectedAccounts = sortedUnique(scope.accounts);
  if (!selectedAccounts.length) return JSON.stringify(["platforms", platforms]);
  const qualified = selectedAccounts.map(value => qualifiedAccount(value, scope, accounts));
  if (qualified.every((value): value is string => value !== null && (!platforms.length || platforms.includes(value.split("/")[0]))))
    return JSON.stringify(["accounts", sortedUnique(qualified)]);
  // Legacy bare IDs can collide across media; preserve their scope without choosing an account.
  return JSON.stringify(["unresolved", platforms, selectedAccounts]);
}

export function overviewRecentAudits(
  state: Pick<AppState, "latest_audit" | "recent_audits" | "accounts">,
  scope: Scope,
) {
  const key = JSON.stringify([scopeKey(scope, state.accounts), sortedUnique(scope.products)]);
  const runs = [state.latest_audit, ...state.recent_audits].filter((run): run is AuditRun => run !== null);
  const unique = [...new Map(runs.map(run => [run.run_id, run])).values()];
  const time = (run: AuditRun) => Number.isFinite(Date.parse(run.at)) ? Date.parse(run.at) : -Infinity;
  return unique.filter(run => JSON.stringify([scopeKey(run.scope, state.accounts), sortedUnique(run.scope.products)]) === key).sort((a, b) => time(b) - time(a));
}

export function matchingOverviewAudit(
  state: Pick<AppState, "latest_audit" | "recent_audits" | "accounts">,
  scope: Scope,
) {
  return overviewRecentAudits(state, scope)[0] ?? null;
}

export function overviewScopeData(state: Pick<AppState, "accounts" | "entities">, scope: Scope) {
  const selectedAccounts = scope.accounts?.length
    ? new Set(scope.accounts.map(value => qualifiedAccount(value, scope, state.accounts)).filter(value => value !== null))
    : null;
  const selected = (platform: string, id: string) =>
    (!scope.platforms?.length || scope.platforms.includes(platform)) &&
    (!selectedAccounts || selectedAccounts.has(`${platform}/${id}`));
  const accounts = [...new Map(state.accounts.filter(account => selected(account.platform, account.account_id)).map(account => [accountKey(account), account])).values()];
  const entities = state.entities.filter(row => selected(String(row.platform ?? ""), String(row.account_id ?? row.account ?? "")) && (!scope.products?.length || scope.products.includes(`${row.platform}:${row.product_type}`)));
  const platforms = (scope.platforms?.length ? sortedUnique(scope.platforms) : [...POLICY_PLATFORMS])
    .filter(platform => !selectedAccounts || [...selectedAccounts].some(key => key.startsWith(`${platform}/`)));
  return { accounts, entities, platforms };
}

function rowVerdict(row: DataRow): string {
  const verdict = String(row.result || row.status || "UNKNOWN");
  return verdicts.includes(verdict as typeof verdicts[number]) ? verdict : "UNKNOWN";
}

function targetKey(row: DataRow) {
  const evidence = row.evidence;
  if (evidence && typeof evidence === "object" && "entity_key" in evidence && typeof evidence.entity_key === "string" && evidence.entity_key.trim())
    return evidence.entity_key;
  const type = row.target_type ?? row.type ?? row.entity_type;
  const identity = [row.platform, row.account_id ?? row.account, type, row.id ?? row.entity_id];
  if (!identity.every(value => typeof value === "string" && value.trim()) ||
    !["account", "campaign", "adgroup", "ad", "keyword", "creative", "asset_group"].includes(String(type))) return null;
  return JSON.stringify(identity);
}

export type OverviewAuditState = "unrun" | "empty" | "incomplete" | "issues" | "unknown" | "clear";

export function overviewAuditSummary(run: AuditRun | null, rows?: readonly DataRow[]) {
  const counts: Record<string, number> = Object.fromEntries(verdicts.map(verdict => [verdict, 0]));
  if (run) {
    if (rows) {
      for (const row of rows) counts[rowVerdict(row)] += 1;
    } else {
      for (const verdict of verdicts) {
        const count = run.counts[verdict];
        counts[verdict] = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
      }
    }
  }
  const checkCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const attentionCount = attentionVerdicts.reduce((sum, verdict) => sum + counts[verdict], 0);
  const knownCount = counts.PASS + counts.NOT_APPLICABLE;
  const issueRows = run && rows ? rows.filter(row => attentionVerdicts.includes(rowVerdict(row)))
    .sort((a, b) => attentionVerdicts.indexOf(rowVerdict(a)) - attentionVerdicts.indexOf(rowVerdict(b))) : [];
  const identities = issueRows.map(targetKey);
  const targetCount = rows && run && identities.every(key => key !== null) ? new Set(identities).size : null;
  let state: OverviewAuditState = "unrun";
  if (run) {
    state = !checkCount ? "empty"
      : !run.coverage.complete || run.coverage.failed_requests > 0 ? "incomplete"
      : counts.FAIL + counts.WARNING + counts.REVIEW > 0 ? "issues"
      : counts.UNKNOWN > 0 || (run.coverage.unknown_count ?? 0) > 0 ? "unknown"
      : "clear";
  }
  return { checkCount, attentionCount, knownCount, counts, targetCount, state, issueRows };
}
