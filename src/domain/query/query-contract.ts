import { z } from "../../lib/validation";
import { PLATFORMS } from "../entities";

export const fields = ["budget.daily", "budget.lifetime", "status", "schedule.end", "name", "created_at", "entity_id"] as const;
export const fieldPaths: Record<string, typeof fields[number]> = { daily: "budget.daily", lifetime: "budget.lifetime", status: "status", end: "schedule.end", name: "name", created: "created_at", id: "entity_id" };
const filterSchema = z.strictObject({
  field: z.enum(fields),
  operator: z.enum(["is_empty", "is_not_empty", "eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "not_contains", "between"]),
  value: z.union([z.string().min(1).max(256), z.array(z.string().max(64)).max(16), z.tuple([z.number().finite(), z.number().finite()])]).optional(),
});
export const queryPlanSchema = z.strictObject({
  platforms: z.array(z.enum(PLATFORMS)).max(PLATFORMS.length),
  entity: z.enum(["campaign", "adgroup", "ad", "creative", "keyword", "asset_group"]),
  operation: z.enum(["find", "count", "compare", "audit", "policy", "history", "create_rule"]),
  filters: z.array(filterSchema).max(7), logical_operator: z.enum(["AND", "OR"]),
  previous: z.boolean(), children: z.boolean(),
  semantic: z.enum(["retarget", "purchase_mismatch", "branding"]).nullable(),
  currency: z.enum(["KRW", "USD"]).nullable(),
});
export type QueryPlan = z.infer<typeof queryPlanSchema>;
