import type { Scope, Settings } from "./domain";
import type { Policy } from "./policy";
import type { Coverage as EntityCoverage } from "./domain";
export type { Settings, Scope } from "./domain";
import type { AuditRuleConfiguration } from "../lib/audit-rules";
export type DataRow = {
  key?: string;
  platform?: string;
  account?: string;
  name?: string;
  id?: string;
  result?: string;
  status?: string;
  reason?: string;
  [key: string]: unknown;
};
export type Account = {
  platform: string;
  account_id: string;
  name: string;
  currency: string;
  timezone: string;
};
export type Coverage = Pick<EntityCoverage, "complete" | "fetched_count" | "failed_requests" | "errors">
  & Partial<Pick<EntityCoverage, "evaluated_count" | "unknown_count">>;
export type AuditRun = {
  run_id: string;
  at: string;
  counts: Record<string, number>;
  message: string;
  scope: Scope;
  selected_policy?: { policy_id: string; name: string; version: number } | null;
  coverage: Coverage;
};
export type AppState = {
  audit_rule_configuration: AuditRuleConfiguration;
  settings: Settings;
  accounts: Account[];
  entities: DataRow[];
  coverage: Coverage;
  last_sync: string | null;
  source: string;
  counts: Record<string, number>;
  latest_audit: AuditRun | null;
  recent_audits: AuditRun[];
  recent_changes: DataRow[];
  policies: Policy[];
  rule_options: Record<string, string>;
  csrf_token: string;
};
export type SettingComparison = {
  field: string;
  values: Record<
    string,
    { value: unknown; state: string; currency?: string | null }
  >;
};
export type Result = {
  selected_policy?: { policy_id: string; name: string; version: number } | null;
  message: string;
  rows: DataRow[];
  result_type?: "entities" | "audit" | "history";
  comparison?: SettingComparison[];
  warnings?: string[];
  complete?: boolean;
  comparable?: boolean;
  status?: string;
  count?: number;
  unknown_count?: number;
  coverage?: Coverage;
  counts?: Record<string, number>;
  run_id?: string;
  semantic_decisions?: Record<string, Record<string, unknown>>;
  intent?: Record<string, unknown>;
};
