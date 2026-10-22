import type { Settings } from "@/contracts/api";
export const NUMBER_SETTINGS = {
  cache_ttl_seconds: {
    label: "조회 데이터 재사용 시간",
    min: 0,
    max: 86400,
    step: 1,
    unit: "초",
    hint: "0초로 설정하면 매번 새로 조회합니다.",
  },
  snapshot_interval_seconds: {
    label: "자동 저장 간격",
    min: 0,
    max: 604800,
    step: 1,
    unit: "초",
    hint: "앱이 켜져 있을 때 저장합니다. 0초면 자동 저장을 끕니다.",
  },
  semantic_threshold: {
    label: "해석 기준값",
    min: 0.5,
    max: 1,
    step: 0.01,
    unit: "",
    hint: "점수가 기준에 못 미치면 판단을 보류합니다.",
  },
  batch_size: {
    label: "한 번에 판단할 항목 수",
    min: 1,
    max: 256,
    step: 1,
    unit: "",
    hint: "",
  },
  cpu_threads: {
    label: "CPU 스레드 수",
    min: 1,
    max: 64,
    step: 1,
    unit: "",
    hint: "",
  },
} as const;
export type NumberSetting = keyof typeof NUMBER_SETTINGS;
export type SettingsDraft = Omit<Settings, NumberSetting> &
  Record<NumberSetting, string>;
export function toSettingsDraft(settings: Settings): SettingsDraft {
  const value = { ...settings } as unknown as SettingsDraft;
  for (const key of Object.keys(NUMBER_SETTINGS) as NumberSetting[])
    value[key] = String(settings[key]);
  return value;
}
export function numberProblem(key: NumberSetting, input: string): string {
  const rule = NUMBER_SETTINGS[key],
    value = Number(input);
  if (!input.trim()) return `${rule.label}을 입력해 주세요.`;
  if (
    !Number.isFinite(value) ||
    value < rule.min ||
    value > rule.max ||
    (rule.step === 1 && !Number.isInteger(value))
  )
    return `${rule.min}~${rule.max}${rule.step === 1 ? " 사이의 정수" : " 사이의 수"}를 입력해 주세요.`;
  return "";
}
export function parseSettingsDraft(draft: SettingsDraft): Settings {
  const value = { ...draft } as unknown as Settings;
  for (const key of Object.keys(NUMBER_SETTINGS) as NumberSetting[]) {
    const error = numberProblem(key, draft[key]);
    if (error) throw new Error(error);
    value[key] = Number(draft[key]);
  }
  if (!draft.timezone.trim()) throw new Error("기준 시간대를 입력해 주세요.");
  try {
    new Intl.DateTimeFormat("ko-KR", { timeZone: draft.timezone.trim() });
  } catch {
    throw new Error("올바른 시간대를 입력해 주세요. 예: Asia/Seoul");
  }
  if (!draft.onnx_directory.trim())
    throw new Error("모델 폴더를 입력해 주세요.");
  return {
    ...value,
    timezone: draft.timezone.trim(),
    onnx_directory: draft.onnx_directory.trim(),
  };
}
export function credentialValues(
  platform: string,
  draft: Record<string, string>,
): Record<string, string> {
  const values: Record<string, string> = Object.fromEntries(
    Object.entries(draft)
      .map(([key, value]) => [key, value.trim()])
      .filter(([, value]) => value),
  );
  if (!Object.keys(values).length)
    throw new Error("저장할 인증 정보를 입력해 주세요.");
  if (Object.values(values).some((value) => /[\r\n\0]/.test(value)))
    throw new Error("인증 정보에 줄바꿈을 포함할 수 없습니다.");
  const required =
    platform === "meta"
      ? ["access_token"]
      : platform === "naver"
        ? ["api_key", "secret_key", "customer_id"]
        : platform === "kakao" || platform === "kakao_keyword"
          ? ["business_token"]
          : platform === "google"
            ? values.access_token
              ? []
              : ["client_id", "client_secret", "refresh_token"]
            : null;
  if (required === null) throw new Error("연결 플랫폼을 선택해 주세요.");
  if (required.some((key) => !values[key]))
    throw new Error(
      platform === "google"
        ? "액세스 토큰 또는 클라이언트 ID·비밀 키·갱신 토큰을 모두 입력해 주세요."
        : "선택한 플랫폼의 인증 항목을 모두 입력해 주세요.",
    );
  return values;
}
