import type { LegacyDataset } from "../lib/settings-compatibility";

export const PLATFORMS = ["meta", "naver", "kakao", "google", "kakao_keyword"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const FIELD_STATES = [
  "PRESENT",
  "NOT_SET",
  "NOT_SUPPORTED",
  "NOT_RETURNED",
  "PERMISSION_DENIED",
  "FETCH_FAILED",
  "NOT_APPLICABLE",
] as const;
export type FieldState = (typeof FIELD_STATES)[number];
export type ResultStatus =
  | "PASS"
  | "FAIL"
  | "WARNING"
  | "REVIEW"
  | "UNKNOWN"
  | "NOT_APPLICABLE";
export type Json = Record<string, any>;
export interface Budget {
  daily: string | null;
  lifetime: string | null;
  level: string;
  inherited_from: string | null;
  unit: string;
}
export interface Entity {
  key: string;
  platform: Platform;
  account_id: string;
  entity_type: string;
  entity_id: string;
  parent_id: string | null;
  name: string;
  status: string | null;
  effective_status: string | null;
  currency: string;
  timezone: string;
  budget: Budget;
  bid: { strategy: string | null; amount: string | null };
  schedule: { start: string | null; end: string | null };
  targeting: {
    countries: string[];
    age_min: number | null;
    age_max: number | null;
    custom_audiences: string[];
    excluded_audiences: string[];
  };
  tracking: { url: string | null; parameters: Record<string, string> };
  optimization: {
    objective: string | null;
    goal: string | null;
    event: string | null;
  };
  text: string | null;
  created_at: string | null;
  fields: Record<string, FieldState>;
  sources: Record<string, string>;
  raw_data: Json;
  extensions: Json;
  fetched_at: string;
}
export type Account = Entity;
export type EntityInput = Partial<
  Omit<
    Entity,
    "budget" | "bid" | "schedule" | "targeting" | "tracking" | "optimization"
  >
> &
  Pick<Entity, "platform" | "account_id" | "entity_type" | "entity_id"> & {
    budget?: Partial<Entity["budget"]>;
    bid?: Partial<Entity["bid"]>;
    schedule?: Partial<Entity["schedule"]>;
    targeting?: Partial<Entity["targeting"]>;
    tracking?: Partial<Entity["tracking"]>;
    optimization?: Partial<Entity["optimization"]>;
  };
export type Scope = { platforms?: string[]; accounts?: string[]; products?: string[] };
export interface Settings {
  mode: "mock" | "live";
  ai_mode: "mock" | "laya";
  database: string;
  policy_directory: string;
  cache_ttl_seconds: number;
  batch_size: number;
  semantic_threshold: number;
  timezone: string;
  snapshot_interval_seconds: number;
  preload_model: boolean;
  inference_backend: "onnx";
  onnx_directory: string;
  cpu_threads: number;
  mock_dataset: LegacyDataset;
}
export interface Coverage {
  requested_count: number | null;
  fetched_count: number;
  evaluated_count: number;
  failed_count: number | null;
  failed_requests: number;
  skipped_count: number;
  unknown_count: number;
  complete: boolean;
  errors: string[];
}
export interface NativeEvent extends Json {
  source: "platform_change_log";
  platform: Platform;
  account_id: string;
  timestamp: string;
  actor: Json;
  raw_data: Json;
}
