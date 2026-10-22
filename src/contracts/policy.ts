import type { Platform } from "./domain";

export const OPERATORS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "not_contains",
  "in",
  "not_in",
  "regex",
  "is_empty",
  "is_not_empty",
  "exists",
] as const;
export type Operator = (typeof OPERATORS)[number];
export type Predicate = {
  field?: string;
  operator?: Operator;
  value?: unknown;
  all?: Predicate[];
  any?: Predicate[];
  not?: Predicate;
};
export type Rule = {
  rule_id: string;
  name: string;
  entity: string;
  platforms: Platform[];
  account_ids: string[];
  enabled: boolean;
  severity: "critical" | "error" | "warning" | "review" | "info";
  when?: Predicate;
  check: Predicate;
  exclude?: Predicate;
};
export type PolicySettings = {
  daily_budget_max?: string | null;
  lifetime_budget_max?: string | null;
  bid_max?: string | null;
  currency?: string | null;
  allowed_countries: string[];
  age_min?: number | null;
  age_max?: number | null;
  required_utm: string[];
  approved_audiences: string[];
  require_promotion_end: boolean;
};
export type Policy = {
  policy_id: string;
  name: string;
  version: number;
  platforms: Platform[];
  account_ids: string[];
  evaluation_mode?: "conditions";
  settings: PolicySettings;
  rules: Rule[];
};
