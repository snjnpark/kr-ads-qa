import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DateTime } from "luxon";
import { DEFAULT_SETTINGS, type Json, type Settings } from "../models";
import { TEST_MODE } from "../../lib/runtime";
import { LEGACY_DATASET_NAMES } from "../../lib/settings-compatibility";

export const SETTINGS_FILE = resolve(
  /* turbopackIgnore: true */ process.env.LAYA_SETTINGS_FILE ||
    (TEST_MODE ? "data/testing/settings.json" : "data/production/settings.json"),
);
export function validateSettings(input: Json): Settings {
  const value = { ...DEFAULT_SETTINGS, ...input } as Settings;
  if (
    !["mock", "live"].includes(value.mode) ||
    !["mock", "laya"].includes(value.ai_mode) ||
    !LEGACY_DATASET_NAMES.includes(value.mock_dataset) ||
    value.inference_backend !== "onnx"
  )
    throw new Error("실행 모드를 확인해 주세요.");
  for (const [key, min, max] of [
    ["cache_ttl_seconds", 0, 86400],
    ["batch_size", 1, 256],
    ["snapshot_interval_seconds", 0, 604800],
    ["cpu_threads", 1, 64],
  ] as const) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max)
      throw new Error(`${key} 설정 범위를 확인해 주세요.`);
  }
  if (
    !Number.isFinite(value.semantic_threshold) ||
    value.semantic_threshold < 0.5 ||
    value.semantic_threshold > 1 ||
    typeof value.preload_model !== "boolean" ||
    !DateTime.now().setZone(value.timezone).isValid
  )
    throw new Error("판단 기준과 시간대 설정을 확인해 주세요.");
  for (const key of ["database", "policy_directory", "onnx_directory"] as const)
    if (
      typeof value[key] !== "string" ||
      !value[key].trim() ||
      value[key].length > 1024
    )
      throw new Error("저장 위치를 확인해 주세요.");
  if (!TEST_MODE && (value.mode !== "live" || value.ai_mode !== "laya"))
    throw new Error("프로덕션에서는 실제 광고 API와 학습 모델만 사용할 수 있습니다.");
  return value;
}
export function readSettings(): Settings {
  const saved = existsSync(SETTINGS_FILE)
    ? JSON.parse(
        readFileSync(/* turbopackIgnore: true */ SETTINGS_FILE, "utf8"),
      )
    : {};
  return validateSettings({
    ...saved,
    inference_backend: "onnx",
    onnx_directory:
      process.env.LAYA_ONNX_DIRECTORY ||
      saved.onnx_directory ||
      DEFAULT_SETTINGS.onnx_directory,
    mode: TEST_MODE ? (process.env.LAYA_MODE || saved.mode || "mock") : "live",
    ai_mode: TEST_MODE ? (process.env.LAYA_AI_MODE || saved.ai_mode || "laya") : "laya",
    ...(process.env.LAYA_MOCK_DATASET
      ? { mock_dataset: process.env.LAYA_MOCK_DATASET }
      : {}),
    ...(process.env.LAYA_DATABASE
      ? { database: process.env.LAYA_DATABASE }
      : {}),
  });
}
export function saveSettings(input: Json, active: Settings) {
  const editable = [
    "mode",
    "ai_mode",
    "mock_dataset",
    "cache_ttl_seconds",
    "batch_size",
    "semantic_threshold",
    "timezone",
    "snapshot_interval_seconds",
    "preload_model",
    "inference_backend",
    "onnx_directory",
    "cpu_threads",
  ];
  if (Object.keys(input).some((key) => !editable.includes(key)))
    throw new Error("변경할 수 없는 설정이 포함되어 있습니다.");
  const pending = existsSync(SETTINGS_FILE)
    ? JSON.parse(
        readFileSync(/* turbopackIgnore: true */ SETTINGS_FILE, "utf8"),
      )
    : {};
  const settings = validateSettings({ ...active, ...pending, ...input });
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
  const temp = `${SETTINGS_FILE}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(settings, null, 2));
    renameSync(temp, SETTINGS_FILE);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  return {
    settings,
    active_settings: active,
    restart_required: JSON.stringify(settings) !== JSON.stringify(active),
    message: "설정을 저장했습니다. 앱을 다시 실행하면 적용됩니다.",
  };
}
