import { DateTime } from "luxon";
import { DEFAULT_SETTINGS, type Json, type Settings } from "../domain/entities";
import { LEGACY_DATASET_NAMES } from "../lib/settings-compatibility";
import type { BrowserStorage } from "./storage";
export const INTEGER_SETTING_RANGES = {
  cache_ttl_seconds: [0, 86400],
  batch_size: [1, 256],
  snapshot_interval_seconds: [0, 604800],
  cpu_threads: [1, 64],
} as const;
export const SEMANTIC_THRESHOLD_RANGE = [0.5, 1] as const;
export const TIMEZONE_LENGTH_RANGE = [1, 100] as const;
export const SETTINGS_PATH_MAX_LENGTH = 1024;
let storage: BrowserStorage;
export function configureSettings(value: BrowserStorage) { storage = value; }
export function validateSettings(input: Json): Settings {
  const value = { ...DEFAULT_SETTINGS, ...input } as Settings;
  if (
    !["mock", "live"].includes(value.mode) ||
    !["mock", "laya"].includes(value.ai_mode) ||
    !LEGACY_DATASET_NAMES.includes(value.mock_dataset) ||
    value.inference_backend !== "onnx"
  )
    throw new Error("실행 모드를 확인해 주세요.");
  for (const key of ["cache_ttl_seconds", "batch_size", "snapshot_interval_seconds", "cpu_threads"] as const) {
    const [min, max] = INTEGER_SETTING_RANGES[key];
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max)
      throw new Error(`${key} 설정 범위를 확인해 주세요.`);
  }
  if (
    !Number.isFinite(value.semantic_threshold) ||
    value.semantic_threshold < SEMANTIC_THRESHOLD_RANGE[0] ||
    value.semantic_threshold > SEMANTIC_THRESHOLD_RANGE[1] ||
    typeof value.preload_model !== "boolean" ||
    typeof value.timezone !== "string" ||
    value.timezone.length < TIMEZONE_LENGTH_RANGE[0] || value.timezone.length > TIMEZONE_LENGTH_RANGE[1] ||
    !DateTime.now().setZone(value.timezone).isValid
  )
    throw new Error("판단 기준과 시간대 설정을 확인해 주세요.");
  for (const key of ["database", "policy_directory", "onnx_directory"] as const)
    if (
      typeof value[key] !== "string" ||
      !value[key].trim() ||
      value[key].length > SETTINGS_PATH_MAX_LENGTH
    )
      throw new Error("저장 위치를 확인해 주세요.");
  if (value.mode !== "live" || value.ai_mode !== "laya")
    throw new Error("프로덕션에서는 실제 광고 API와 학습 모델만 사용할 수 있습니다.");
  return value;
}
export function readSettings(): Settings {
  return validateSettings({ ...storage?.get<Json>("settings", "preferences"), mode: "live", ai_mode: "laya", database: "IndexedDB", policy_directory: "이 브라우저", onnx_directory: "브라우저 모델 캐시" });
}
export function saveSettings(input: Json, active: Settings) {
  const allowed = new Set(["mode", "ai_mode", "cache_ttl_seconds", "batch_size", "semantic_threshold", "timezone", "snapshot_interval_seconds", "preload_model", "inference_backend", "onnx_directory", "cpu_threads"]);
  if (Object.keys(input).some(k => !allowed.has(k))) throw new Error("변경할 수 없는 설정입니다.");
  const settings = validateSettings({ ...active, ...input, mode: "live", ai_mode: "laya" });
  storage.put("settings", "preferences", settings);
  return { settings, active_settings: active, restart_required: JSON.stringify(settings) !== JSON.stringify(active), message: "이 브라우저에 저장했습니다. 새로고침하면 적용됩니다." };
}
